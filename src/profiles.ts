import type { DeploymentRow, SecretBundle } from "./types";

/**
 * Client profile generation (the "pack" layer).
 *
 * Every profile ships the same honest routing policy:
 *  - .ir + IRNIC/RIPE ranges (remote sing-box rule-set served by this control
 *    plane) + the DoH bootstrap name  -> DIRECT ( «مستقیم داخل کشور» ),
 *  - everything else                  -> the tunnel/proxy outbound,
 *  - the worker hostname itself is pinned to a Cloudflare edge anycast
 *    address with override_address so resolving the tunnel name never
 *    depends on the national DNS ("hosts" without a hosts file).
 *
 * The dns block resolves foreign names through the tenant's OWN DoH endpoint
 * on their own worker domain (poisoning-resistant, filter-safe) and domestic
 * names through a national resolver directly (fast, no tunnel round-trip).
 *
 * Three sniff/fakedns states are emitted per protocol, labelled, because the
 * right choice depends on the client build (bug-test driven).
 */

export const CF_EDGE_PIN_IPV4 = "104.16.0.1"; // Cloudflare edge anycast; SNI/Host selects the tenant worker
export const NATIONAL_RESOLVER_IPV4 = "178.22.122.100";

export interface ProfileOptions {
  subscriptionToken?: string;
  controlOrigin?: string;
}

export interface DataPlaneBundle {
  schemaVersion: 1;
  status: "pending" | "ready";
  label: string;
  uris: string[];
  profiles: {
    vless: Record<string, unknown> | null;
    hysteria2: Record<string, unknown> | null;
  };
  profileVariants: Record<string, Record<string, unknown>>;
  clashYaml: string | null;
  generatedAt: string;
  singBoxVersion: "1.14.0";
}

export function buildPendingBundle(deployment: DeploymentRow): DataPlaneBundle {
  return {
    schemaVersion: 1,
    status: "pending",
    label: deployment.worker_name,
    uris: [],
    profiles: { vless: null, hysteria2: null },
    profileVariants: {},
    clashYaml: null,
    generatedAt: new Date().toISOString(),
    singBoxVersion: "1.14.0",
  };
}

function dnsSection(deployment: DeploymentRow, subscriptionToken: string): Record<string, unknown> {
  const dohAddress = `https://${deployment.worker_hostname}/dns-query?k=${subscriptionToken}`;
  return {
    servers: [
      { tag: "doh-own", address: dohAddress, address_resolver: "clean-pin", detour: "proxy" },
      { tag: "clean-pin", address: `tcp://1.1.1.1`, detour: "direct" },
      { tag: "ir-direct", address: `tcp://${NATIONAL_RESOLVER_IPV4}`, detour: "direct" },
    ],
    rules: [
      { rule_set: "geoip-ir", server: "ir-direct" },
      { domain_suffix: ".ir", server: "ir-direct" },
      { domain: deployment.worker_hostname, server: "clean-pin" },
      { outbound: "any", server: "ir-direct" },
    ],
    final: "doh-own",
  };
}

function routeSection(deployment: DeploymentRow, controlOrigin: string): Record<string, unknown> {
  return {
    rules: [
      { ip_is_private: true, outbound: "direct" },
      { rule_set: "geoip-ir", outbound: "direct" },
      { rule_set: "race-direct", outbound: "direct" },
      { domain_suffix: ".ir", outbound: "direct" },
      // Pin the tunnel/DoH hostname to a fixed edge address: no national DNS
      // is consulted for the tunnel's own name (hosts-style, SNI preserved).
      {
        domain: deployment.worker_hostname,
        action: "route",
        override_address: CF_EDGE_PIN_IPV4,
        override_port: 443,
        outbound: "direct",
      },
    ],
    rule_set: [
      {
        tag: "geoip-ir",
        type: "remote",
        url: `${controlOrigin}/api/v1/geoip-ir.json`,
        download_detour: "proxy",
      },
      {
        tag: "race-direct",
        type: "remote",
        url: `${controlOrigin}/api/v1/race-direct.json`,
        download_detour: "proxy",
      },
    ],
    final: "proxy",
  };
}

function baseClientConfig(
  deployment: DeploymentRow,
  outbound: Record<string, unknown>,
  options: ProfileOptions,
  sniff: boolean,
  fakedns: boolean,
): Record<string, unknown> {
  const dns = dnsSection(deployment, options.subscriptionToken ?? "");
  if (fakedns) {
    (dns.servers as Record<string, unknown>[]).push({ tag: "fakeip", address: "fakeip" });
    (dns.rules as Record<string, unknown>[]).unshift({ query_type: ["A", "AAAA"], server: "fakeip" });
  }
  return {
    log: { level: "warn", timestamp: true },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
    dns,
    outbounds: [outbound, { type: "direct", tag: "direct" }],
    route: { ...routeSection(deployment, options.controlOrigin ?? ""), sniff },
  };
}

export function buildReadyBundle(deployment: DeploymentRow, secrets: SecretBundle, options: ProfileOptions = {}): DataPlaneBundle {
  if (
    !secrets.vlessUuid
    || !secrets.realityPublicKey
    || !secrets.realityShortId
    || !secrets.hysteria2Password
    || !secrets.hysteria2CertSha256
    || !secrets.hysteria2SpkiSha256
  ) {
    throw new Error("Agent credentials are incomplete");
  }
  const label = deployment.worker_name;
  const vlessPort = secrets.vlessPort ?? 443;
  const vlessQuery = new URLSearchParams({
    encryption: "none",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: deployment.reality_server_name,
    fp: "chrome",
    pbk: secrets.realityPublicKey,
    sid: secrets.realityShortId,
    type: "tcp",
  });
  const vlessUri = `vless://${secrets.vlessUuid}@${deployment.node_hostname}:${vlessPort}?${vlessQuery.toString()}#${encodeURIComponent(`${label}-reality`)}`;
  const hy2Query = new URLSearchParams({
    sni: deployment.node_hostname,
    insecure: "1",
    pinSHA256: secrets.hysteria2CertSha256,
  });
  const hy2Uri = `hysteria2://${encodeURIComponent(secrets.hysteria2Password)}@${deployment.node_hostname}:443/?${hy2Query.toString()}#${encodeURIComponent(`${label}-hy2`)}`;

  const vlessOutbound = {
    type: "vless",
    tag: "proxy",
    server: deployment.node_hostname,
    server_port: vlessPort,
    uuid: secrets.vlessUuid,
    flow: "xtls-rprx-vision",
    network: "tcp",
    tls: {
      enabled: true,
      server_name: deployment.reality_server_name,
      utls: { enabled: true, fingerprint: "chrome" },
      reality: {
        enabled: true,
        public_key: secrets.realityPublicKey,
        short_id: secrets.realityShortId,
      },
    },
  };
  const hysteria2Outbound = {
    type: "hysteria2",
    tag: "proxy",
    server: deployment.node_hostname,
    server_port: 443,
    password: secrets.hysteria2Password,
    tls: {
      enabled: true,
      server_name: deployment.node_hostname,
      insecure: true,
      certificate_public_key_sha256: [secrets.hysteria2SpkiSha256],
    },
    bbr_profile: "standard",
  };

  const variants: Record<string, Record<string, unknown>> = {};
  for (const [protocol, outbound] of [["vless", vlessOutbound], ["hysteria2", hysteria2Outbound]] as const) {
    variants[`${protocol} · sniff خاموش`] = baseClientConfig(deployment, outbound, options, false, false);
    variants[`${protocol} · fakedns روشن`] = baseClientConfig(deployment, outbound, options, true, true);
  }

  return {
    schemaVersion: 1,
    status: "ready",
    label,
    uris: [vlessUri, hy2Uri],
    profiles: {
      vless: baseClientConfig(deployment, vlessOutbound, options, true, false),
      hysteria2: baseClientConfig(deployment, hysteria2Outbound, options, true, false),
    },
    profileVariants: variants,
    clashYaml: buildClashYaml(deployment, secrets, options),
    generatedAt: new Date().toISOString(),
    singBoxVersion: "1.14.0",
  };
}

/** Minimal Clash Meta YAML with the same honest routing policy. */
export function buildClashYaml(deployment: DeploymentRow, secrets: SecretBundle, options: ProfileOptions = {}): string {
  const vlessPort = secrets.vlessPort ?? 443;
  const doh = `https://${deployment.worker_hostname}/dns-query?k=${options.subscriptionToken ?? ""}`;
  const lines = [
    "mixed-port: 2080",
    "allow-lan: false",
    "mode: rule",
    "hosts:",
    `  ${deployment.worker_hostname}: ${CF_EDGE_PIN_IPV4}`,
    "dns:",
    "  enable: true",
    "  default-nameserver: [1.1.1.1]",
    `  nameserver: ['${doh}#PROXY']`,
    "proxies:",
    `  - name: ${deployment.worker_name}-reality`,
    "    type: vless",
    `    server: ${deployment.node_hostname}`,
    `    port: ${vlessPort}`,
    `    uuid: ${secrets.vlessUuid ?? ""}`,
    "    flow: xtls-rprx-vision",
    "    tls: true",
    `    servername: ${deployment.reality_server_name}`,
    "    client-fingerprint: chrome",
    "    reality-opts:",
    `      public-key: ${secrets.realityPublicKey ?? ""}`,
    `      short-id: ${secrets.realityShortId ?? ""}`,
    `  - name: ${deployment.worker_name}-hy2`,
    "    type: hysteria2",
    `    server: ${deployment.node_hostname}`,
    "    port: 443",
    `    password: ${secrets.hysteria2Password ?? ""}`,
    `    sni: ${deployment.node_hostname}`,
    "    skip-cert-verify: true",
    "proxy-groups:",
    "  - name: PROXY",
    "    type: select",
    "    proxies:",
    `      - ${deployment.worker_name}-reality`,
    `      - ${deployment.worker_name}-hy2`,
    "rules:",
    `  - DOMAIN,${deployment.worker_hostname},DIRECT`,
    "  - DOMAIN-SUFFIX,ir,DIRECT",
    "  - GEOIP,IR,DIRECT",
    "  - MATCH,PROXY",
  ];
  return `${lines.join("\n")}\n`;
}
