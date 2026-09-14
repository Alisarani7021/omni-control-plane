import { rateLimit } from "./db";
import { HttpError } from "./http";
import type { Env } from "./types";

/**
 * dnstt DNS-tunnel helper, ported from the retired standalone `worker.js`
 * (button 🌪️ تونل DNS (dnstt)). The bot walks the user through VPS IP +
 * tunnel subdomain, prints the DNS records and the client commands, and
 * GET /api/v1/dnstt/server.sh renders the reviewed auto-install script.
 * The script header still warns to review before running as root.
 */

const VPS_IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/u;
const TUNNEL_DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/u;

export function isValidVpsIpv4(value: string): boolean {
  if (!VPS_IP_RE.test(value)) return false;
  return value.split(".").every((octet) => Number(octet) <= 255);
}

export function normalizeDnsttDomain(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/^https?:\/\//u, "").split("/")[0]?.trim() ?? "";
  if (!TUNNEL_DOMAIN_RE.test(cleaned) || cleaned.length > 253) return null;
  return cleaned;
}

export function renderDnsttIntroText(): string {
  return [
    "🌪️ <b>تونل DNS با dnstt</b>",
    "",
    "تنها روشی که در قطعی کامل فوریهٔ ۲۰۲۶ جواب داد (UDP پورت ۵۳).",
    "نیاز داری به:",
    "1️⃣ یه VPS خارج (اوبونتو)",
    "2️⃣ یه دامنه که NS یه ساب‌دامنه‌ش رو به VPS بدی",
    "",
    "👇 <b>اول IP عددی VPS رو بفرست:</b>",
  ].join("\n");
}

export function renderDnsttPackageText(vps: string, domain: string, baseUrl: string): string {
  const parts = domain.split(".");
  const parent = parts.length > 2 ? parts.slice(-2).join(".") : domain;
  const scriptUrl = `${baseUrl}/api/v1/dnstt/server.sh?vps=${encodeURIComponent(vps)}&domain=${encodeURIComponent(domain)}`;
  return [
    "🌪️ <b>پکیج dnstt آماده شد!</b>",
    "",
    `🖥️ VPS: <code>${vps}</code>`,
    `🌐 تونل: <code>${domain}</code>`,
    "",
    "<b>قدم ۱ — رکوردهای DNS دامنه:</b>",
    `<code>A tns.${parent} → ${vps}</code>`,
    `<code>NS ${domain} → tns.${parent}</code>`,
    "",
    "<b>قدم ۲ — روی VPS (اوبونتو، روت):</b>",
    `<code>curl -sSL ${scriptUrl} | sudo bash</code>`,
    "آخرش کلید عمومی (server.pub) و دستور کلاینت رو چاپ می‌کنه.",
    "",
    "<b>قدم ۳ — روی کلاینت:</b>",
    `<code>./dnstt-client -udp ${vps}:53 -pubkey-file server.pub ${domain} 127.0.0.1:8000</code>`,
    "<code>ssh -N -D 127.0.0.1:7000 -p 8000 user@127.0.0.1</code>",
    "بعد اپ‌ها: <code>socks5h://127.0.0.1:7000</code>",
    "",
    "⚠️ حالت udp رمز روی سیم نداره (قابل تشخیصه) ولی محتوا end-to-end رمزنگاریه. اگه جواب نگرفتی سرور رو با <code>-mtu 512</code> امتحان کن.",
  ].join("\n");
}

export function dnsttServerScript(vps: string, domain: string): string {
  const S = [
    "#!/bin/bash",
    "# OMNI dnstt tunnel server auto-install (Ubuntu/Debian). Review before running as root!",
    "# Docs: https://www.bamsoftware.com/software/dnstt/",
    `# VPS: ${vps} | Tunnel: ${domain}`,
    "set -e",
    `VPS_IP="${vps}"`,
    `TUN="${domain}"`,
    'DNSTT_VER="20260501"',
    'echo "==> [1/7] deps..."',
    "apt-get update -y",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y golang-go git curl unzip iptables iproute2 dnsutils",
    'echo "==> [2/7] dnstt source..."',
    "cd /tmp && rm -rf dnstt-src && mkdir -p dnstt-src && cd dnstt-src",
    '(curl -sSL -o dnstt.zip "https://www.bamsoftware.com/software/dnstt/dnstt-${DNSTT_VER}.zip" && unzip -q -o dnstt.zip) || git clone https://www.bamsoftware.com/git/dnstt.git dnstt-git',
    "SRCDIR=$(find . -maxdepth 3 -type d -name dnstt-server | head -1)",
    '[ -z "$SRCDIR" ] && { echo "source not found"; exit 1; }',
    'echo "==> [3/7] build..."',
    '(cd "$SRCDIR" && go build -o /usr/local/bin/dnstt-server .)',
    "chmod +x /usr/local/bin/dnstt-server",
    'echo "==> [4/7] keys..."',
    "mkdir -p /etc/dnstt && cd /etc/dnstt",
    "/usr/local/bin/dnstt-server -gen-key -privkey-file server.key -pubkey-file server.pub",
    "chmod 600 server.key",
    'echo "==> [5/7] systemd..."',
    "cat > /etc/systemd/system/dnstt.service <<EOF",
    "[Unit]",
    "Description=dnstt DNS tunnel server",
    "After=network.target",
    "[Service]",
    "ExecStart=/usr/local/bin/dnstt-server -udp :5300 -privkey-file /etc/dnstt/server.key ${TUN} 127.0.0.1:22",
    "Restart=always",
    "User=root",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOF",
    "systemctl daemon-reload && systemctl enable --now dnstt",
    'echo "==> [6/7] firewall 53/udp -> 5300..."',
    'if ss -lun | grep -qE "[: ]53 "; then echo "!! udp/53 busy:"; ss -lun | grep -E "[: ]53 " || true; fi',
    "iptables -I INPUT -p udp --dport 5300 -j ACCEPT || true",
    "iptables -t nat -I PREROUTING -p udp --dport 53 -j REDIRECT --to-ports 5300 || true",
    "mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4 || true",
    "(ufw allow 53/udp) >/dev/null 2>&1 || true",
    "sleep 2",
    'systemctl is-active --quiet dnstt && echo "dnstt: ACTIVE" || (echo "dnstt FAILED:"; journalctl -u dnstt --no-pager -n 20 || true)',
    'echo "==> [7/7] DONE. server.pub (copy to clients):"',
    'echo "================ server.pub ================"',
    "cat /etc/dnstt/server.pub",
    'echo "============================================"',
    'echo "Client:"',
    'echo "./dnstt-client -udp ${VPS_IP}:53 -pubkey-file server.pub ${TUN} 127.0.0.1:8000"',
    'echo "Then: ssh -N -D 127.0.0.1:7000 -p 8000 user@127.0.0.1   (SOCKS5 on 127.0.0.1:7000)"',
  ];
  return S.join("\n");
}

export async function serveDnsttScript(request: Request, env: Env): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await rateLimit(env, `dnstt-sh:${clientIp}`, 60, 3600))) {
    throw new HttpError(429, "rate_limited", "Too many requests");
  }
  const url = new URL(request.url);
  const vps = url.searchParams.get("vps") ?? "";
  const domain = (url.searchParams.get("domain") ?? "").toLowerCase();
  if (!isValidVpsIpv4(vps) || !normalizeDnsttDomain(domain)) {
    return new Response("# bad vps/domain params", { status: 400, headers: { "Content-Type": "text/plain" } });
  }
  return new Response(dnsttServerScript(vps, domain), {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}
