import { getConnection } from "./cloudflare-api";
import {
  createDeployment,
  deleteDeployment,
  getDeployment,
  listDeployments,
  retryDeployment,
  revokeDeployment,
  rotateBootstrapToken,
  rotateSubscriptionToken,
} from "./deployments";
import { disconnectCloudflareConnection, listCloudflareConnections } from "./oauth";
import type { Env, SessionPrincipal } from "./types";
import type { CreateDeploymentInput } from "./validation";

/**
 * Data layer for the Telegram bot. It reuses the exact same handlers as the
 * HTTPS panel (single code path) by synthesizing an internal JSON request for
 * the handlers that read a body. Origin/CSRF checks live in the HTTP router,
 * not in these handlers, so a bot principal is safe here: ownership is still
 * enforced per tenant inside every handler.
 */

export function botPrincipal(tenantId: string, telegramUserId: string, displayName: string): SessionPrincipal {
  return {
    tenantId,
    telegramUserId,
    displayName,
    isAdmin: false,
    sessionHash: "telegram-bot",
  };
}

function internalJsonRequest(body: unknown): Request {
  return new Request("https://internal.local/bot-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function readResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface BotDeploymentSummary {
  id: string;
  worker_name: string;
  worker_hostname: string;
  node_hostname: string;
  vps_ipv4: string;
  status: string;
  status_detail: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotConnectionSummary {
  id: string;
  auth_type: string;
  scopes: string | null;
  expires_at: string | null;
  resource_account_id: string | null;
  resource_account_name: string | null;
  resource_zone_id: string | null;
  resource_zone_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotDeploymentDetail {
  deployment: {
    id: string;
    workerName: string;
    workerHostname: string;
    nodeHostname: string;
    vpsIpv4: string;
    status: string;
    statusDetail: string | null;
    lastSeenAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  subscriptions: Record<string, string> | null;
}

export interface BotBootstrap {
  expiresInSeconds: number;
  token: string;
  downloadCommand: string;
  inspectCommand: string;
  executeCommand: string;
  eraseCommand: string;
}

export async function botListDeployments(env: Env, principal: SessionPrincipal): Promise<BotDeploymentSummary[]> {
  const body = await readResponse<{ deployments: BotDeploymentSummary[] }>(await listDeployments(env, principal));
  return body.deployments;
}

export async function botGetDeployment(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<BotDeploymentDetail> {
  return readResponse<BotDeploymentDetail>(await getDeployment(env, principal, deploymentId));
}

export async function botCreateDeployment(
  env: Env,
  principal: SessionPrincipal,
  input: CreateDeploymentInput,
): Promise<{ deploymentId: string; workflowInstanceId: string; status: string; bootstrap: BotBootstrap }> {
  return readResponse(await createDeployment(internalJsonRequest(input), env, principal));
}

export async function botRetryDeployment(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<{ ok: boolean; action: string; workflowInstanceId: string }> {
  return readResponse(await retryDeployment(internalJsonRequest({}), env, principal, deploymentId));
}

export async function botRevokeDeployment(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<{ ok: boolean; status: string; workflowInstanceId?: string }> {
  return readResponse(await revokeDeployment(internalJsonRequest({}), env, principal, deploymentId));
}

export async function botDeleteDeployment(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<{ ok: boolean; deleted: string }> {
  return readResponse(await deleteDeployment(env, principal, deploymentId));
}

export async function botRotateBootstrap(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<{ bootstrap: BotBootstrap }> {
  return readResponse(await rotateBootstrapToken(internalJsonRequest({}), env, principal, deploymentId));
}

export async function botRotateSubscription(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<{ ok: boolean; subscriptions: Record<string, string> }> {
  return readResponse(await rotateSubscriptionToken(internalJsonRequest({}), env, principal, deploymentId));
}

export async function botListConnections(env: Env, principal: SessionPrincipal): Promise<BotConnectionSummary[]> {
  const body = await readResponse<{ connections: BotConnectionSummary[] }>(
    await listCloudflareConnections(env, principal),
  );
  return body.connections;
}

export async function botDisconnectConnection(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
): Promise<void> {
  await disconnectCloudflareConnection(internalJsonRequest({}), env, principal, connectionId);
}

export interface BotConnectionBoundary {
  connectionId: string;
  connectionName: string;
  accountId: string;
  accountName: string;
  zoneId: string;
  zoneName: string;
}

export async function botConnectionBoundary(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
): Promise<BotConnectionBoundary> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  if (
    connection.auth_type !== "api_token" ||
    !connection.resource_account_id ||
    !connection.resource_account_name ||
    !connection.resource_zone_id ||
    !connection.resource_zone_name
  ) {
    throw new Error("Cloudflare connection resource binding is unavailable");
  }
  return {
    connectionId: connection.id,
    connectionName: connection.resource_zone_name,
    accountId: connection.resource_account_id,
    accountName: connection.resource_account_name,
    zoneId: connection.resource_zone_id,
    zoneName: connection.resource_zone_name,
  };
}
