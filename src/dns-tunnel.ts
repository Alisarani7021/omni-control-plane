import { getConnection, getValidCloudflareAuth, upsertARecord, upsertNsRecord } from "./cloudflare-api";
import { audit } from "./db";
import { HttpError } from "./http";
import { escapeHtml, nowIso } from "./security";
import type { DeploymentRow, Env, SessionPrincipal } from "./types";

/**
 * Automatic slipnet/DNSTT DNS-tunnel provisioning on the user's OWN VPS.
 *
 * Thin line of this section:
 *  1. `t.<zone>` delegation (NS + glue A) through the tenant's scoped token —
 *     one API call pair, DNS Edit permission only.
 *  2. The bootstrap script installs dnstt-server + slipstream-server as
 *     systemd units; keypairs are generated ON the VPS and only the PUBLIC
 *     material (dnstt pubkey, slipstream cert SPKI pin) returns to the
 *     control plane in the agent complete payload.
 *  3. The bot card hands over a slipnet:// URI, a copy button, an app guide,
 *     the measured MTU and a TXT round-trip liveness proof.
 *
 * Supply chain: dnstt is installed from its upstream Go module
 * (www.bamsoftware.com/git/dnstt.git, the module path used by upstream docs)
 * and slipstream from github.com/getlantern/slipstream pinned to commit
 * 3e15c2d877b2a575a64ffc60da18123f6e6b259d; both resolve through the Go module
 * proxy with the public checksum database enforced (GONOSUMDB is never set).
 * The Go toolchain tarball is sha256-verified; a mismatch aborts bootstrap
 * loudly instead of installing anything.
 */

export const DNSTT_MODULE = "www.bamsoftware.com/git/dnstt.git";
export const DNSTT_PIN = "latest"; // upstream documents @latest; pin a pseudo-version after first deploy
export const SLIPSTREAM_MODULE = "github.com/getlantern/slipstream";
export const SLIPSTREAM_PIN = "3e15c2d877b2a575a64ffc60da18123f6e6b259d";
export const GO_VERSION = "1.27.1";
// Official go.dev/dl checksums for the go1.27.1 linux tarballs, transcribed from
// https://go.dev/dl/?mode=json on 2026-09-13. The bootstrap verifies the downloaded
// tarball with sha256sum and fails loudly on any mismatch.
export const GO_AMD64_SHA256 = "63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445";
export const GO_ARM64_SHA256 = "3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec";

export const TUNNEL_DEFAULT_MTU = 1232;
export const TUNNEL_MTU_SIZES: readonly number[] = [512, 768, 1024, 1180, 1400];
export const SLIPSTREAM_LISTEN_PORT = 4443;

export function tunnelHostnameFor(zoneName: string): string {
  return `t.${zoneName.toLowerCase()}`;
}

export interface DnsTunnelEnableResult {
  tunnelHostname: string;
  nsRecordId: string;
  glueRecordId: string;
}

/** Owner action: delegate t.<zone> to the VPS (NS + glue) and flag the deployment. */
export async function enableDnsTunnel(env: Env, principal: SessionPrincipal, deploymentId: string): Promise<DnsTunnelEnableResult> {
  const deployment = await env.DB.prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(deploymentId, principal.tenantId).first<DeploymentRow>();
  if (!deployment) throw new HttpError(404, "deployment_not_found", "Deployment not found");
  if (deployment.status !== "ready") throw new HttpError(409, "invalid_deployment_state", "Deployment is not ready");
  if (deployment.dns_tunnel_enabled === 1 && deployment.tunnel_hostname) {
    return { tunnelHostname: deployment.tunnel_hostname, nsRecordId: "existing", glueRecordId: "existing" };
  }
  const connection = await getConnection(env, deployment.oauth_connection_id, principal.tenantId);
  const zoneName = connection.resource_zone_name;
  if (!zoneName || connection.resource_zone_id !== deployment.zone_id) {
    throw new HttpError(409, "cloudflare_reconnect_required", "Connection zone is missing; reconnect the Cloudflare connection");
  }
  const auth = await getValidCloudflareAuth(env, connection);
  const tunnel = tunnelHostnameFor(zoneName);
  const glueName = `ns1.${tunnel}`;
  const nsRecordId = await upsertNsRecord(auth, deployment.zone_id, tunnel, [glueName]);
  const glueRecordId = await upsertARecord(auth, deployment.zone_id, glueName, deployment.vps_ipv4);
  await env.DB.prepare(
    "UPDATE deployments SET dns_tunnel_enabled = 1, tunnel_hostname = ?, updated_at = ? WHERE id = ?",
  ).bind(tunnel, nowIso(), deploymentId).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "dns_tunnel.enable",
    resourceType: "deployment",
    resourceId: deploymentId,
    outcome: "success",
    metadata: { tunnelHostname: tunnel },
  });
  return { tunnelHostname: tunnel, nsRecordId, glueRecordId };
}

/**
 * SlipNet deep-link in the app's official import format: `slipnet://` +
 * base64 of the pipe-delimited v16 profile, exactly what SlipGate's
 * `generate_slipnet_url` and dnstm-setup emit (verified against
 * anonvector/SlipNet ConfigImporter.kt). The old `d=…&k=…` query form was
 * never a real SlipNet scheme and imported nowhere.
 */
export function slipnetUri(
  tunnelHostname: string,
  publicKey: string | null,
  mtu: number,
  options: { transport?: "dnstt" | "ss"; resolverIp?: string; socksUser?: string; socksPass?: string } = {},
): string {
  const transport = options.transport ?? "dnstt";
  const resolver = `${options.resolverIp ?? "8.8.8.8"}:53:0`;
  const authMode = options.socksUser && options.socksPass ? "1" : "0";
  const socksUser = options.socksUser ?? "";
  const socksPass = options.socksPass ?? "";
  void mtu; // MTU is a server-side setting; the SlipNet URI carries no MTU field.
  const data =
    `16|${transport}|${tunnelHostname}|${tunnelHostname}|${resolver}|${authMode}|5000|bbr|1080|127.0.0.1|0|` +
    `${publicKey ?? ""}|${socksUser}|${socksPass}|0|||22|0|127.0.0.1|0||udp|password|||0|0|443|||0||0|0|`;
  return `slipnet://${btoa(data)}`;
}

export const TUNNEL_EXPECTATIONS = [
  "📉 انتظارات صادقانه: DNSTT حدود چند ده تا چند صد kbit/s می‌دهد؛ Slipstream (QUIC-over-DNS) چند برابر آن.",
  "✉️ مناسب: پیام/متن/پروتکل‌های سبک و VPN سبک؛ جایگزین پهنای‌باند کامل نیست.",
  "🧯 در قطع کامل DNS، این مسیر هم می‌میرد؛ برای همان حالت DoH دامنهٔ خودتان و مسیر مستقیم UDP/53 کنارش گذاشته شده.",
];

export const TUNNEL_SAFETY = [
  "🔒 ایمنی عملیاتی: سرور تونل فقط authoritative است — بدون recursion، بدون ANY، با rate-limit سیستمی و drop هر پاسخ پرسروصدا؛",
  "   یعنی به‌عنوان amplifier قابل سوءاستفاده نیست (نگه‌داشتن همین خط واجب است).",
];

export interface DnsTunnelCardInput {
  deployment: DeploymentRow;
  mtuSuggestion: number | null;
  tunnelTxtRttMs: number | null;
  tunnelStatus: string | null;
}

export function dnsTunnelCard(input: DnsTunnelCardInput): string {
  const { deployment } = input;
  if (deployment.dns_tunnel_enabled !== 1 || !deployment.tunnel_hostname) {
    return [
      "🛰️ <b>تونل DNS (slipnet/dnstt)</b>",
      "",
      "هنوز فعال نیست. با «فعال‌سازی delegation» رکورد NS و glue روی zone خودتان ساخته می‌شود (یک API call با همان توکن scoped).",
    ].join("\n");
  }
  const mtu = deployment.tunnel_mtu ?? input.mtuSuggestion ?? TUNNEL_DEFAULT_MTU;
  const uri = slipnetUri(deployment.tunnel_hostname, deployment.dnstt_public_key, mtu);
  const rttLine = input.tunnelTxtRttMs !== null
    ? `🩺 round-trip TXT از مسیر ملی: ${input.tunnelTxtRttMs}ms (ثابت زنده‌بودن DNS کاربر)`
    : "🩺 round-trip TXT: هنوز گزارش نشده (agent پس از نصب تونل می‌سنجد)";
  return [
    "🛰️ <b>تونل DNS (slipnet/dnstt)</b>",
    "",
    `دامنهٔ تونل: <code>${escapeHtml(deployment.tunnel_hostname)}</code> (NS/glue روی zone خودتان)`,
    `🔑 کلید عمومی dnstt: <code>${escapeHtml((deployment.dnstt_public_key ?? "—").slice(0, 16))}…</code> · کلید خصوصی هرگز از VPS بیرون نرفته`,
    `📐 MTU: ${mtu}${deployment.tunnel_mtu ? " (اندازه‌گیری agent)" : input.mtuSuggestion ? " (پیشنهاد crowd)" : " (پیش‌فرض)"}`,
    "",
    `📎 <code>${escapeHtml(uri)}</code>`,
    "📋 کپی کنید و در اپ «کدام اپ، کدام فیلد»: SlipNet/dnstt-xyz → پروفایل جدید → Domain + Public key + MTU.",
    rttLine,
    input.tunnelStatus ? `🚦 وضعیت تونل از دید agent: <code>${escapeHtml(input.tunnelStatus)}</code>` : undefined,
    "",
    ...TUNNEL_EXPECTATIONS,
    ...TUNNEL_SAFETY,
  ].filter(Boolean).join("\n");
}
