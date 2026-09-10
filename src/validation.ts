import { HttpError } from "./http";
import {
  isValidCloudflareId,
  isValidEmail,
  isValidHostname,
  isPublicIpv4,
  isValidWorkerName,
} from "./security";

export interface CreateDeploymentInput {
  connectionId: string;
  accountId: string;
  zoneId: string;
  workerName: string;
  workerHostname: string;
  nodeHostname: string;
  vpsIpv4: string;
  acmeEmail: string;
  realityServerName: string;
  enableUfw?: boolean;
}

function requiredString(value: unknown, field: string, max = 253): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new HttpError(400, "invalid_input", `${field} is invalid`);
  }
  return value.trim().toLowerCase();
}

export function validateCreateDeployment(input: unknown): CreateDeploymentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_input", "Expected an object");
  const body = input as Record<string, unknown>;
  const connectionId = requiredString(body.connectionId ?? body.oauthConnectionId, "connectionId", 36);
  const accountId = requiredString(body.accountId, "accountId", 32);
  const zoneId = requiredString(body.zoneId, "zoneId", 32);
  const workerName = requiredString(body.workerName, "workerName", 64);
  const workerHostname = requiredString(body.workerHostname, "workerHostname");
  const nodeHostname = requiredString(body.nodeHostname, "nodeHostname");
  const vpsIpv4 = requiredString(body.vpsIpv4, "vpsIpv4", 15);
  const acmeEmail = requiredString(body.acmeEmail, "acmeEmail", 254);
  const realityServerName = requiredString(body.realityServerName, "realityServerName");
  if (!/^[0-9a-f-]{36}$/u.test(connectionId)) throw new HttpError(400, "invalid_input", "connectionId is invalid");
  if (!isValidCloudflareId(accountId) || !isValidCloudflareId(zoneId)) throw new HttpError(400, "invalid_input", "Cloudflare IDs are invalid");
  if (!isValidWorkerName(workerName)) throw new HttpError(400, "invalid_input", "workerName must use lowercase letters, digits and hyphens");
  if (!isValidHostname(workerHostname) || !isValidHostname(nodeHostname) || !isValidHostname(realityServerName)) {
    throw new HttpError(400, "invalid_input", "Hostnames are invalid");
  }
  if (workerHostname === nodeHostname) throw new HttpError(400, "invalid_input", "Worker and node hostnames must differ");
  if (!isPublicIpv4(vpsIpv4)) throw new HttpError(400, "invalid_input", "Only a globally routable public IPv4 address is accepted in this release");
  if (!isValidEmail(acmeEmail)) throw new HttpError(400, "invalid_input", "ACME email is invalid");
  return {
    connectionId,
    accountId,
    zoneId,
    workerName,
    workerHostname,
    nodeHostname,
    vpsIpv4,
    acmeEmail,
    realityServerName,
    enableUfw: body.enableUfw === true,
  };
}

export function assertAgentCompletePayload(input: unknown): asserts input is {
  deploymentId: string;
  agentToken: string;
  singBoxVersion: string;
  vlessUuid: string;
  realityPublicKey: string;
  realityShortId: string;
  hysteria2Password: string;
  configSha256: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "invalid_input", "Expected an object");
  const body = input as Record<string, unknown>;
  const patterns: Record<string, RegExp> = {
    deploymentId: /^[0-9a-f-]{36}$/u,
    agentToken: /^[A-Za-z0-9_-]{43,128}$/u,
    singBoxVersion: /^1\.14\.0$/u,
    vlessUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    realityPublicKey: /^[A-Za-z0-9_-]{43}$/u,
    realityShortId: /^[0-9a-f]{16}$/u,
    hysteria2Password: /^[A-Za-z0-9_-]{32,128}$/u,
    configSha256: /^[0-9a-f]{64}$/u,
  };
  for (const [field, pattern] of Object.entries(patterns)) {
    if (typeof body[field] !== "string" || !pattern.test(body[field])) {
      throw new HttpError(400, "invalid_input", `${field} is invalid`);
    }
  }
}
