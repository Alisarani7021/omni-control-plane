import { getConnection, getValidCloudflareAuth, upsertTxtRecord } from "./cloudflare-api";
import { audit } from "./db";
import { HttpError } from "./http";
import { escapeHtml, nowIso } from "./security";
import type { DeploymentRow, Env, SessionPrincipal } from "./types";

/**
 * «خواب‌نت» (sleeper) — the time-scheduled network idea, translated.
 *
 * A sleeper deployment stays SILENT towards the control plane. Once a day,
 * inside a window derived deterministically from the deployment id (anchor
 * hour ±9 minutes jitter), the VPS agent reads ONE read-only TXT beacon from
 * the tenant's own zone (the same DNS dead-drop machinery WhiteHole uses),
 * executes at most one queued command, appends everything to a local log the
 * user can inspect, and sleeps again.
 *
 * Property: even if the whole Worker is blocked or stopped, a live agent can
 * still receive commands, and the "command server" load is ~zero because
 * there is no inbound at all — the beacon is plain DNS in the user's own zone.
 *
 * The three ethical constraints are enforced in code, not just prose:
 *  1. only the owner's own server (ownership check + role change is an owner action),
 *  2. with the node's own credentials (the beacon carries no secret; commands
 *     are authenticated by the agent token on the next report),
 *  3. one visible wake/sleep switch in the bot plus a full local log under
 *     /var/lib/v13-agent the user can read. Without these three, the feature
 *     must not be built — setDeploymentRole refuses consent-less sleeper.
 */

export const SLEEPER_WINDOW_MINUTES = 60;
export const SLEEPER_JITTER_MINUTES = 9;
export const SLEEPER_DEFAULT_ANCHOR_HOUR = 3;
export const BEACON_RECORD_PREFIX = "_v13beacon";
export type SleeperCommand = "report-now" | "wake";
export const SLEEPER_COMMANDS: readonly SleeperCommand[] = ["report-now", "wake"];

export const SLEEPER_ETHICS: readonly string[] = [
  "۱) فقط روی سرور خود کاربر و با اعتبارنامهٔ خودش اجرا می‌شود.",
  "۲) یک دکمهٔ بیدارباش/خواب فوری در ربات همیشه در دست مالک است.",
  "۳) لاگ کامل محلی در /var/lib/v13-agent/sleeper.log برای کاربر قابل دیدن است.",
];

/** Deterministic 32-bit FNV-1a — jitter only, no security property. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface SleeperWindow {
  startMinute: number;
  endMinute: number;
  jitter: number;
}

/** Pure daily window: anchor hour ±9 minutes jitter, 60-minute span. */
export function sleeperWindowFor(deploymentId: string, anchorHour: number, day: string): SleeperWindow {
  const span = SLEEPER_JITTER_MINUTES * 2 + 1;
  const jitter = (fnv1a(`${deploymentId}|${day}`) % span) - SLEEPER_JITTER_MINUTES;
  const raw = anchorHour * 60 + jitter;
  const startMinute = ((raw % 1440) + 1440) % 1440;
  const endMinute = (startMinute + SLEEPER_WINDOW_MINUTES) % 1440;
  return { startMinute, endMinute, jitter };
}

export function minuteLabel(minute: number): string {
  const hour = Math.floor(minute / 60) % 24;
  const min = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function beaconRecordName(deployment: DeploymentRow): string {
  return `${BEACON_RECORD_PREFIX}.${deployment.tunnel_hostname ?? deployment.worker_hostname}`;
}

export function beaconContent(window: SleeperWindow, command: string): string {
  return `v13b1 ${window.startMinute} ${window.endMinute} ${command}`;
}

export async function pendingSleeperCommand(env: Env, deploymentId: string): Promise<SleeperCommand | null> {
  const row = await env.DB.prepare(
    "SELECT id, command FROM sleeper_commands WHERE deployment_id = ? AND consumed_at IS NULL ORDER BY queued_at DESC LIMIT 1",
  ).bind(deploymentId).first<{ id: string; command: SleeperCommand }>();
  return row?.command ?? null;
}

async function loadOwnedDeployment(env: Env, principal: SessionPrincipal, deploymentId: string): Promise<DeploymentRow> {
  const deployment = await env.DB.prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(deploymentId, principal.tenantId).first<DeploymentRow>();
  if (!deployment) throw new HttpError(404, "deployment_not_found", "Deployment not found");
  return deployment;
}

export async function setDeploymentRole(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
  role: "standard" | "sleeper",
  consent: boolean,
): Promise<DeploymentRow> {
  const deployment = await loadOwnedDeployment(env, principal, deploymentId);
  if (role === "sleeper" && !consent) {
    throw new HttpError(400, "consent_required", "Sleeper mode requires explicit consent to the three ethical constraints");
  }
  const anchor = deployment.sleeper_anchor_hour ?? SLEEPER_DEFAULT_ANCHOR_HOUR;
  await env.DB.prepare(
    `UPDATE deployments SET role = ?, sleeper_anchor_hour = ?, sleeper_consented_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(role, anchor, role === "sleeper" ? nowIso() : null, nowIso(), deploymentId).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: `deployment.role.${role}`,
    resourceType: "deployment",
    resourceId: deploymentId,
    outcome: "success",
  });
  return { ...deployment, role, sleeper_anchor_hour: anchor };
}

export async function queueSleeperCommand(env: Env, principal: SessionPrincipal, deploymentId: string, command: SleeperCommand): Promise<void> {
  const deployment = await loadOwnedDeployment(env, principal, deploymentId);
  if (deployment.role !== "sleeper") throw new HttpError(409, "invalid_deployment_state", "Deployment is not in sleeper role");
  await env.DB.prepare("INSERT INTO sleeper_commands (id, deployment_id, command, queued_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), deploymentId, command, nowIso()).run();
  await publishSleeperBeacon(env, principal, deploymentId);
}

/** Publish (or refresh) the read-only TXT beacon in the tenant's own zone. */
export async function publishSleeperBeacon(env: Env, principal: SessionPrincipal, deploymentId: string): Promise<string> {
  const deployment = await loadOwnedDeployment(env, principal, deploymentId);
  const connection = await getConnection(env, deployment.oauth_connection_id, principal.tenantId);
  if (connection.resource_zone_id !== deployment.zone_id) {
    throw new HttpError(409, "cloudflare_reconnect_required", "Connection zone is missing; reconnect the Cloudflare connection");
  }
  const auth = await getValidCloudflareAuth(env, connection);
  const day = nowIso().slice(0, 10);
  const window = sleeperWindowFor(deployment.id, deployment.sleeper_anchor_hour ?? SLEEPER_DEFAULT_ANCHOR_HOUR, day);
  const pending = await pendingSleeperCommand(env, deployment.id);
  const name = beaconRecordName(deployment);
  await upsertTxtRecord(auth, deployment.zone_id, name, beaconContent(window, pending ?? "none"), 120);
  if (pending) {
    await env.DB.prepare("UPDATE sleeper_commands SET consumed_at = ? WHERE deployment_id = ? AND consumed_at IS NULL")
      .bind(nowIso(), deploymentId).run();
  }
  await env.DB.prepare("UPDATE deployments SET beacon_published_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowIso(), nowIso(), deploymentId).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "sleeper.beacon.publish",
    resourceType: "deployment",
    resourceId: deploymentId,
    outcome: "success",
    metadata: { command: pending ?? "none" },
  });
  return name;
}

export interface SleeperCardInput {
  deployment: DeploymentRow;
  pending: SleeperCommand | null;
  beaconName: string;
}

export function sleeperCard(input: SleeperCardInput): string {
  const { deployment } = input;
  const day = nowIso().slice(0, 10);
  const window = sleeperWindowFor(deployment.id, deployment.sleeper_anchor_hour ?? SLEEPER_DEFAULT_ANCHOR_HOUR, day);
  if (deployment.role !== "sleeper") {
    return [
      "😴 <b>خواب‌نت (sleeper)</b>",
      "",
      "این استقرار در حالت استاندارد است (گزارش هر ۵ دقیقه).",
      "حالت sleeper تماس مداوم را خاموش می‌کند و فقط در پنجرهٔ روزانه یک beacon فقط‌خواندنی از zone خودتان می‌خواند.",
      "",
      "⚖️ سه قید اخلاقی (بدون این‌ها این قابلیت ساخته نمی‌شود):",
      ...SLEEPER_ETHICS,
    ].join("\n");
  }
  return [
    "😴 <b>خواب‌نت (sleeper)</b> — فعال",
    "",
    `🕰 پنجرهٔ بیداری امروز (${day}): ${minuteLabel(window.startMinute)} تا ${minuteLabel(window.endMinute)} (jitter ${window.jitter >= 0 ? "+" : ""}${window.jitter} دقیقه)`,
    `📡 beacon: TXT <code>${escapeHtml(input.beaconName)}</code> در zone خودتان · فقط‌خواندنی`,
    deployment.beacon_published_at ? `🕓 آخرین انتشار beacon: ${escapeHtml(deployment.beacon_published_at)}` : "🕓 beacon هنوز منتشر نشده",
    input.pending ? `⏳ فرمان صف‌شده: <code>${input.pending}</code>` : "⏳ فرمانی در صف نیست",
    "",
    "⚖️ قیدهای اخلاقی این حالت:",
    ...SLEEPER_ETHICS,
  ].join("\n");
}
