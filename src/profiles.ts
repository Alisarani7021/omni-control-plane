import type { DeploymentRow, SecretBundle } from "./types";

export interface DataPlaneBundle {
  schemaVersion: 1;
  status: "pending" | "ready";
  label: string;
  uris: string[];
  profiles: {
    vless: Record<string, unknown> | null;
    hysteria2: Record<string, unknown> | null;
  };
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
    generatedAt: new Date().toISOString(),
    singBoxVersion: "1.14.0",
  };
}

function baseClientConfig(outbound: Record<string, unknown>): Record<string, unknown> {
  return {
    log: { level: "warn", timestamp: true },
    inbounds: [
      {
        type: "mixed",
        tag: "mixed-in",
        listen: "127.0.0.1",
        listen_port: 2080,
      },
    ],
    outbounds: [outbound],
    route: { final: "proxy" },
  };
}

export function buildReadyBundle(deployment: DeploymentRow, secrets: SecretBundle): DataPlaneBundle {
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
  return {
    schemaVersion: 1,
    status: "ready",
    label,
    uris: [vlessUri, hy2Uri],
    profiles: {
      vless: baseClientConfig(vlessOutbound),
      hysteria2: baseClientConfig(hysteria2Outbound),
    },
    generatedAt: new Date().toISOString(),
    singBoxVersion: "1.14.0",
  };
}
