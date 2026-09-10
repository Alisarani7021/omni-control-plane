import { audit } from "./db";
import {
  cloudflareApi,
  disconnectConnectionIfIdle,
  getConnection,
  getValidCloudflareAuth,
  uploadWorkerScript,
} from "./cloudflare-api";
import { DATA_PLANE_SOURCE } from "./data-plane-source";
import { HttpError, json, readJson } from "./http";
import { buildReadyBundle } from "./profiles";
import {
  addSecondsIso,
  decryptJson,
  encryptJson,
  nowIso,
  parsePositiveInt,
  randomToken,
  sha256,
} from "./security";
import type { ConnectionRow, DeploymentRow, Env, SecretBundle, SessionPrincipal, WorkflowParams } from "./types";
import { validateCreateDeployment } from "./validation";

function assertConnectionResourceBoundary(connection: ConnectionRow, accountId: string, zoneId: string): void {
  if (connection.auth_type !== "api_token") return;
  if (connection.resource_account_id !== accountId || connection.resource_zone_id !== zoneId) {
    throw new HttpError(403, "cloudflare_resource_mismatch", "Selected resources are outside this token's stored boundary");
  }
}

async function startWorkflow(env: Env, params: WorkflowParams): Promise<string> {
  const instance = await env.PROVISION_WORKFLOW.create({
    id: `${params.action}-${params.deploymentId}-${Date.now()}`,
    params,
  });
  await env.DB.prepare("UPDATE deployments SET workflow_instance_id = ?, updated_at = ? WHERE id = ?")
    .bind(instance.id, nowIso(), params.deploymentId).run();
  return instance.id;
}

function bootstrapInstructions(env: Env, token: string, deploymentId: string): Record<string, unknown> {
  const endpoint = `${new URL(env.PUBLIC_BASE_URL).origin}/api/v1/agent/bootstrap`;
  return {
    expiresInSeconds: parsePositiveInt(env.BOOTSTRAP_TTL_SECONDS, 3600, 86_400),
    token,
    downloadCommand: `curl --fail --show-error --silent --proto '=https' --tlsv1.2 -H 'Authorization: Bearer ${token}' '${endpoint}' -o 'v13-bootstrap-${deploymentId}.sh'`,
    inspectCommand: `if command -v less >/dev/null 2>&1; then sed -E "s/^(BOOTSTRAP_TOKEN=).*/\\1'<redacted>'/" 'v13-bootstrap-${deploymentId}.sh' | less; else sed -E "s/^(BOOTSTRAP_TOKEN=).*/\\1'<redacted>'/" 'v13-bootstrap-${deploymentId}.sh' | sed -n '1,360p'; fi`,
    executeCommand: `sudo bash 'v13-bootstrap-${deploymentId}.sh'`,
    eraseCommand: `shred -u 'v13-bootstrap-${deploymentId}.sh' || rm -f 'v13-bootstrap-${deploymentId}.sh'`,
  };
}

export async function createDeployment(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
): Promise<Response> {
  const input = validateCreateDeployment(await readJson<unknown>(request));
  const connection = await getConnection(env, input.connectionId, principal.tenantId);
  assertConnectionResourceBoundary(connection, input.accountId, input.zoneId);
  const auth = await getValidCloudflareAuth(env, connection);
  const zone = await cloudflareApi<{ id: string; name: string; status: string; account: { id: string } }>(
    auth,
    `/zones/${input.zoneId}`,
  );
  if (zone.status !== "active" || zone.account.id !== input.accountId) {
    throw new HttpError(400, "zone_mismatch", "Zone is not active in the selected account");
  }
  const zoneSuffix = `.${zone.name.toLowerCase()}`;
  if (!input.workerHostname.endsWith(zoneSuffix) || !input.nodeHostname.endsWith(zoneSuffix)) {
    throw new HttpError(400, "hostname_zone_mismatch", "Both hostnames must be subdomains of the selected zone");
  }
  if (input.realityServerName === input.nodeHostname) {
    throw new HttpError(400, "invalid_reality_target", "Reality handshake target must not point back to this VPS");
  }
  const conflict = await env.DB.prepare(
    `SELECT id, status FROM deployments
     WHERE (account_id = ? AND worker_name = ?) OR worker_hostname = ? OR node_hostname = ?
     LIMIT 1`,
  ).bind(input.accountId, input.workerName, input.workerHostname, input.nodeHostname)
    .first<{ id: string; status: string }>();
  if (conflict) {
    throw new HttpError(
      409,
      "deployment_resource_conflict",
      `Worker name or hostname is already assigned to an existing ${conflict.status} deployment`,
    );
  }

  const deploymentId = crypto.randomUUID();
  const subscriptionToken = randomToken(32);
  const bootstrapToken = randomToken(32);
  const now = nowIso();
  const secretBundle: SecretBundle = { subscriptionToken };
  const encryptedBundle = await encryptJson(secretBundle, env.TOKEN_ENCRYPTION_KEY, `deployment:${deploymentId}`);
  const bootstrapTtl = parsePositiveInt(env.BOOTSTRAP_TTL_SECONDS, 3600, 86_400);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO deployments
        (id, tenant_id, oauth_connection_id, account_id, zone_id, worker_name, worker_hostname,
         node_hostname, vps_ipv4, acme_email, reality_server_name, enable_ufw, status,
         subscription_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).bind(
      deploymentId,
      principal.tenantId,
      connection.id,
      input.accountId,
      input.zoneId,
      input.workerName,
      input.workerHostname,
      input.nodeHostname,
      input.vpsIpv4,
      input.acmeEmail,
      input.realityServerName,
      input.enableUfw ? 1 : 0,
      await sha256(subscriptionToken),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO deployment_secrets (deployment_id, bundle_enc, version, updated_at) VALUES (?, ?, 1, ?)",
    ).bind(deploymentId, encryptedBundle, now),
    env.DB.prepare(
      "INSERT INTO bootstrap_tokens (token_hash, deployment_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256(bootstrapToken), deploymentId, addSecondsIso(bootstrapTtl), now),
  ]);

  let workflowInstanceId: string;
  try {
    workflowInstanceId = await startWorkflow(env, { action: "prepare", deploymentId });
  } catch (error) {
    await env.DB.prepare("UPDATE deployments SET status = 'failed', status_detail = 'workflow_start_failed', updated_at = ? WHERE id = ?")
      .bind(nowIso(), deploymentId).run();
    try {
      await disconnectConnectionIfIdle(env, connection.id, deploymentId);
    } catch {
      // Expiry cleanup remains the final safety net for temporary scoped API tokens.
    }
    throw error;
  }
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "deployment.create",
    resourceType: "deployment",
    resourceId: deploymentId,
    outcome: "success",
    request,
    metadata: { workerHostname: input.workerHostname, nodeHostname: input.nodeHostname },
  });
  return json({
    deploymentId,
    workflowInstanceId,
    status: "queued",
    bootstrap: bootstrapInstructions(env, bootstrapToken, deploymentId),
  }, 202);
}

export async function listDeployments(env: Env, principal: SessionPrincipal): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, worker_name, worker_hostname, node_hostname, vps_ipv4, status, status_detail,
            last_seen_at, created_at, updated_at
     FROM deployments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(principal.tenantId).all();
  return json({ deployments: result.results });
}

async function ownedDeployment(env: Env, principal: SessionPrincipal, deploymentId: string): Promise<DeploymentRow> {
  const deployment = await env.DB.prepare("SELECT * FROM deployments WHERE id = ? AND tenant_id = ?")
    .bind(deploymentId, principal.tenantId).first<DeploymentRow>();
  if (!deployment) throw new HttpError(404, "deployment_not_found", "Deployment not found");
  return deployment;
}

async function requestedConnectionId(request: Request): Promise<string | null> {
  const body = await readJson<{ connectionId?: unknown; oauthConnectionId?: unknown }>(request);
  const connectionId = body.connectionId ?? body.oauthConnectionId;
  if (connectionId === undefined || connectionId === "") return null;
  if (typeof connectionId !== "string" || !/^[0-9a-f-]{36}$/u.test(connectionId)) {
    throw new HttpError(400, "invalid_connection", "Cloudflare connection ID is invalid");
  }
  return connectionId;
}

async function ensureActiveDeploymentConnection(
  env: Env,
  principal: SessionPrincipal,
  deployment: DeploymentRow,
  replacementConnectionId: string | null,
): Promise<void> {
  try {
    await getConnection(env, deployment.oauth_connection_id, principal.tenantId);
    return;
  } catch {
    // A temporary Cloudflare credential is intentionally erased after a terminal task.
  }
  if (!replacementConnectionId) {
    throw new HttpError(409, "cloudflare_reconnect_required", "Reconnect Cloudflare and select the new connection first");
  }
  let replacement: Awaited<ReturnType<typeof getConnection>>;
  try {
    replacement = await getConnection(env, replacementConnectionId, principal.tenantId);
  } catch {
    throw new HttpError(400, "invalid_connection", "The selected Cloudflare connection is unavailable");
  }
  assertConnectionResourceBoundary(replacement, deployment.account_id, deployment.zone_id);
  const auth = await getValidCloudflareAuth(env, replacement);
  const zone = await cloudflareApi<{ account: { id: string }; status: string }>(auth, `/zones/${deployment.zone_id}`);
  if (zone.status !== "active" || zone.account.id !== deployment.account_id) {
    throw new HttpError(403, "cloudflare_resource_mismatch", "The new Cloudflare connection cannot manage this deployment's zone");
  }
  await env.DB.prepare("UPDATE deployments SET oauth_connection_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(replacement.id, nowIso(), deployment.id, principal.tenantId).run();
}

function subscriptionUrls(deployment: DeploymentRow, subscriptionToken: string): Record<string, string> {
  const base = `https://${deployment.worker_hostname}/sub/${encodeURIComponent(subscriptionToken)}`;
  return {
    uri: base,
    singBoxVless: `${base}?format=sing-box&profile=vless`,
    singBoxHysteria2: `${base}?format=sing-box&profile=hysteria2`,
  };
}

export async function getDeployment(
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<Response> {
  const deployment = await ownedDeployment(env, principal, deploymentId);
  let subscriptions: Record<string, string> | null = null;
  if (deployment.status === "ready") {
    const row = await env.DB.prepare("SELECT bundle_enc FROM deployment_secrets WHERE deployment_id = ?")
      .bind(deployment.id).first<{ bundle_enc: string }>();
    if (row) {
      const secrets = await decryptJson<SecretBundle>(row.bundle_enc, env.TOKEN_ENCRYPTION_KEY, `deployment:${deployment.id}`);
      subscriptions = subscriptionUrls(deployment, secrets.subscriptionToken);
    }
  }
  return json({
    deployment: {
      id: deployment.id,
      workerName: deployment.worker_name,
      workerHostname: deployment.worker_hostname,
      nodeHostname: deployment.node_hostname,
      vpsIpv4: deployment.vps_ipv4,
      status: deployment.status,
      statusDetail: deployment.status_detail,
      lastSeenAt: deployment.last_seen_at,
      createdAt: deployment.created_at,
      updatedAt: deployment.updated_at,
    },
    subscriptions,
  });
}

export async function rotateBootstrapToken(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<Response> {
  const deployment = await ownedDeployment(env, principal, deploymentId);
  if (!["queued", "preparing", "awaiting_agent", "failed"].includes(deployment.status)) {
    throw new HttpError(409, "invalid_deployment_state", "A bootstrap token cannot be issued in this state");
  }
  const rawToken = randomToken(32);
  const ttl = parsePositiveInt(env.BOOTSTRAP_TTL_SECONDS, 3600, 86_400);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO bootstrap_tokens (token_hash, deployment_id, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(deployment_id) DO UPDATE SET
       token_hash = excluded.token_hash, expires_at = excluded.expires_at, consumed_at = NULL, created_at = excluded.created_at`,
  ).bind(await sha256(rawToken), deployment.id, addSecondsIso(ttl), now).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "bootstrap.rotate",
    resourceType: "deployment",
    resourceId: deployment.id,
    outcome: "success",
    request,
  });
  return json({ bootstrap: bootstrapInstructions(env, rawToken, deployment.id) });
}

export async function rotateSubscriptionToken(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<Response> {
  const deployment = await ownedDeployment(env, principal, deploymentId);
  if (deployment.status !== "ready" || !deployment.agent_token_hash) {
    throw new HttpError(409, "invalid_deployment_state", "Subscription credentials can only be rotated for a ready deployment");
  }
  await ensureActiveDeploymentConnection(env, principal, deployment, await requestedConnectionId(request));
  const current = await ownedDeployment(env, principal, deploymentId);
  const row = await env.DB.prepare("SELECT bundle_enc FROM deployment_secrets WHERE deployment_id = ?")
    .bind(current.id).first<{ bundle_enc: string }>();
  if (!row) throw new Error("Deployment secret bundle is missing");

  const secrets = await decryptJson<SecretBundle>(row.bundle_enc, env.TOKEN_ENCRYPTION_KEY, `deployment:${current.id}`);
  const subscriptionToken = randomToken(32);
  const subscriptionTokenHash = await sha256(subscriptionToken);
  const rotatedSecrets: SecretBundle = { ...secrets, subscriptionToken };
  const rotatedBundleEnc = await encryptJson(rotatedSecrets, env.TOKEN_ENCRYPTION_KEY, `deployment:${current.id}`);
  const connection = await getConnection(env, current.oauth_connection_id, principal.tenantId);
  const auth = await getValidCloudflareAuth(env, connection);

  await uploadWorkerScript(auth, current.account_id, current.worker_name, DATA_PLANE_SOURCE, {
    SUB_TOKEN_HASH: subscriptionTokenHash,
    CONFIG_BUNDLE: JSON.stringify(buildReadyBundle(current, rotatedSecrets)),
  });
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE deployment_secrets SET bundle_enc = ?, version = version + 1, updated_at = ? WHERE deployment_id = ?")
      .bind(rotatedBundleEnc, now, current.id),
    env.DB.prepare("UPDATE deployments SET subscription_token_hash = ?, updated_at = ? WHERE id = ?")
      .bind(subscriptionTokenHash, now, current.id),
  ]);
  await audit(env, {
    tenantId: current.tenant_id,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "subscription.rotate",
    resourceType: "deployment",
    resourceId: current.id,
    outcome: "success",
    request,
  });
  try {
    await disconnectConnectionIfIdle(env, current.oauth_connection_id, current.id);
  } catch {
    // The expiry cron remains the final cleanup safety net.
  }
  return json({ ok: true, subscriptions: subscriptionUrls(current, subscriptionToken) });
}

export async function retryDeployment(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<Response> {
  const deployment = await ownedDeployment(env, principal, deploymentId);
  if (!["agent_ready", "failed"].includes(deployment.status)) {
    throw new HttpError(409, "invalid_deployment_state", "This deployment is not in a retryable state");
  }
  await ensureActiveDeploymentConnection(env, principal, deployment, await requestedConnectionId(request));
  const action = deployment.agent_token_hash ? "finalize" : "prepare";
  const workflowInstanceId = await startWorkflow(env, { action, deploymentId: deployment.id });
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: `deployment.${action}.retry`,
    resourceType: "deployment",
    resourceId: deployment.id,
    outcome: "success",
    request,
  });
  return json({ ok: true, action, workflowInstanceId }, 202);
}

export async function revokeDeployment(
  request: Request,
  env: Env,
  principal: SessionPrincipal,
  deploymentId: string,
): Promise<Response> {
  const deployment = await ownedDeployment(env, principal, deploymentId);
  if (deployment.status === "revoked") return json({ ok: true, status: "revoked" });
  if (deployment.status === "revoking") throw new HttpError(409, "invalid_deployment_state", "Revocation is already running");
  await ensureActiveDeploymentConnection(env, principal, deployment, await requestedConnectionId(request));
  await env.DB.prepare("UPDATE deployments SET status = 'revoking', status_detail = NULL, updated_at = ? WHERE id = ?")
    .bind(nowIso(), deployment.id).run();
  let workflowInstanceId: string;
  try {
    workflowInstanceId = await startWorkflow(env, { action: "revoke", deploymentId: deployment.id });
  } catch (error) {
    await env.DB.prepare("UPDATE deployments SET status = ?, status_detail = 'revoke_workflow_start_failed', updated_at = ? WHERE id = ?")
      .bind(deployment.status, nowIso(), deployment.id).run();
    throw error;
  }
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "user",
    actorId: principal.telegramUserId,
    action: "deployment.revoke.request",
    resourceType: "deployment",
    resourceId: deployment.id,
    outcome: "success",
    request,
  });
  return json({ ok: true, status: "revoking", workflowInstanceId }, 202);
}
