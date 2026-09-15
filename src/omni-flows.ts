/**
 * Bot-level Omni flows: create / list / vip-user / recover / delete.
 *
 * The Telegram bot is the UI for tenant nodes: a node has no panel of its
 * own (headless bundle), so everything a tenant does — create a user, get
 * the subscription link, recover the password — happens here, over the
 * agent channel, with the tenant's own scoped token doing the provisioning.
 */
import { getConnection, getValidCloudflareAuth } from "./cloudflare-api";
import { audit } from "./db";
import { deleteOmniNode, omniAgent, provisionOmniNode } from "./omni-engine";
import { decryptJson, encryptJson, nowIso, randomToken } from "./security";
import type { Env, SessionPrincipal } from "./types";

export interface OmniNodeRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  account_id: string;
  worker_name: string;
  d1_id: string;
  base_url: string;
  agent_key_enc: string;
  created_at: string;
}

export async function listOmniNodes(env: Env, principal: SessionPrincipal): Promise<OmniNodeRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM kaveh_nodes WHERE tenant_id = ? ORDER BY created_at DESC").bind(principal.tenantId).all<OmniNodeRow>();
  return results;
}

async function agentKeyOf(env: Env, row: OmniNodeRow): Promise<string> {
  try {
    return (await decryptJson<{ key: string }>(row.agent_key_enc, env.TOKEN_ENCRYPTION_KEY, `omni:${row.id}`)).key;
  } catch {
    return (await decryptJson<{ key: string }>(row.agent_key_enc, env.TOKEN_ENCRYPTION_KEY, `kaveh:${row.id}`)).key;
  }
}

export interface OmniCreateResult {
  node: OmniNodeRow;
  baseUrl: string | null;
  vip: { username: string; sub: string; uri: string } | null;
}

/**
 * Kaveh web panel integration — safe worker-name suffix.
 * Cloudflare Workers names must match `^[a-z0-9-]{1,62}$` and be strictly
 * lowercase. `crypto.randomUUID()` is hex-only and always lowercase, unlike
 * Base64Url (`randomToken`) which emits A-Z and breaks with code 10016.
 * See docs/KAVEH-WEB-FA.md §3 and fix 4efd463.
 */
export function generateOmniWorkerSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 6);
}
export function generateOmniWorkerName(): string {
  return `omni-${generateOmniWorkerSuffix()}`;
}

/** Provision a node on the connection's account and seed a VIP user. */
export async function createOmniNode(env: Env, principal: SessionPrincipal, connectionId: string): Promise<OmniCreateResult> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  const auth = await getValidCloudflareAuth(env, connection);
  const accountId = connection.resource_account_id;
  if (!accountId) throw new Error("connection has no stored account boundary");
  const suffix = generateOmniWorkerSuffix();
  const workerName = `omni-${suffix}`;
  const agentKey = randomToken(24);
  const plan = { accountId, workerName, d1Name: `omni-${suffix}`, agentKey, signingSecret: randomToken(32) };
  const made = await provisionOmniNode(auth, plan);
  const baseUrl = made.baseUrl || `https://${workerName}.workers.dev`;
  const id = randomToken(16);
  const node: OmniNodeRow = {
    id,
    tenant_id: principal.tenantId,
    connection_id: connectionId,
    account_id: accountId,
    worker_name: workerName,
    d1_id: made.d1Id,
    base_url: baseUrl,
    agent_key_enc: await encryptJson({ key: agentKey }, env.TOKEN_ENCRYPTION_KEY, `omni:${id}`),
    created_at: nowIso(),
  };
  await env.DB.prepare("INSERT INTO kaveh_nodes (id, tenant_id, connection_id, account_id, worker_name, d1_id, base_url, agent_key_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, node.tenant_id, connectionId, accountId, workerName, made.d1Id, baseUrl, node.agent_key_enc, node.created_at).run();
  await audit(env, { tenantId: principal.tenantId, actorType: "telegram", actorId: principal.telegramUserId, action: "omni.create", outcome: "success", metadata: { worker: workerName, account: accountId } });

  // Seed the VIP user through the agent channel (the node needs a few seconds
  // to propagate; retry briefly before giving up and leaving it to the bot).
  let vip: OmniCreateResult["vip"] = null;
  for (let attempt = 0; attempt < 5 && !vip; attempt += 1) {
    try {
      const created = await omniAgent<{ user: { username: string; sub_token: string }; configs: { uris: string[] } }>(
        baseUrl, agentKey, "/api/agent/users",
        { method: "POST", body: JSON.stringify({ username: "vip", quota_gb: 100, expiry_days: 365, device_limit: 5 }) },
      );
      vip = { username: "vip", sub: `${baseUrl}/s/${created.user.sub_token}`, uri: created.configs.uris[0] || "" };
    } catch {
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return { node, baseUrl, vip };
}

export async function omniNewUser(env: Env, principal: SessionPrincipal, nodeId: string, username: string, quotaGb: number, days: number) {
  const row = (await listOmniNodes(env, principal)).find((n) => n.id === nodeId);
  if (!row) throw new Error("node not found");
  const key = await agentKeyOf(env, row);
  const made = await omniAgent<{ user: { username: string; sub_token: string; uuid: string }; configs: { uris: string[] } }>(
    row.base_url, key, "/api/agent/users",
    { method: "POST", body: JSON.stringify({ username, quota_gb: quotaGb, expiry_days: days }) },
  );
  return { ...made, sub: `${row.base_url.replace(/\/$/u, "")}/s/${made.user.sub_token}` };
}

export async function omniListUsers(env: Env, principal: SessionPrincipal, nodeId: string) {
  const row = (await listOmniNodes(env, principal)).find((n) => n.id === nodeId);
  if (!row) throw new Error("node not found");
  const key = await agentKeyOf(env, row);
  return omniAgent<{ users: { username: string; status: string; used_bytes: number; quota_gb: number }[]; total: number }>(row.base_url, key, "/api/agent/users");
}

/** «بازیابی رمز»: wipe the admin hash so the next visit sets a new password. */
/**
 * Rotate the node's admin password and hand the owner the new value in chat.
 *
 * Honest scope: bot-deployed OMNI nodes are *headless* (dist-headless has no
 * [assets]), so `/<base>/panel` does not exist and nothing in the bot links to
 * it. The password this sets is the node's own admin credential (agent/API and
 * any UI built on top of the node), and it invalidates every open session.
 */
export async function omniIssueLoginToken(env: Env, principal: SessionPrincipal, nodeId: string): Promise<{ token: string; url: string }> {
  const row = (await listOmniNodes(env, principal)).find((n) => n.id === nodeId);
  if (!row) throw new Error("node not found");
  if (!row.base_url) throw new Error("این نود آدرس عمومی ندارد؛ اول دامنه یا ساب‌دامین وصل کنید.");
  const key = await agentKeyOf(env, row);
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  await omniAgent<{ ok: boolean }>(row.base_url, key, "/api/agent/admin/password", { method: "POST", body: JSON.stringify({ password: token }) });
  await audit(env, { tenantId: principal.tenantId, actorType: "telegram", actorId: principal.telegramUserId, action: "omni.login_token", outcome: "success", metadata: { worker: row.worker_name } });
  return { token, url: row.base_url };
}

export async function omniRecover(env: Env, principal: SessionPrincipal, nodeId: string): Promise<string> {
  const row = (await listOmniNodes(env, principal)).find((n) => n.id === nodeId);
  if (!row) throw new Error("node not found");
  const key = await agentKeyOf(env, row);
  await omniAgent<unknown>(row.base_url, key, "/api/agent/admin/reset", { method: "POST" });
  await audit(env, { tenantId: principal.tenantId, actorType: "telegram", actorId: principal.telegramUserId, action: "omni.recover", outcome: "success", metadata: { worker: row.worker_name } });
  return row.base_url;
}

export async function deleteOmniNodeFlow(env: Env, principal: SessionPrincipal, nodeId: string): Promise<void> {
  const row = (await listOmniNodes(env, principal)).find((n) => n.id === nodeId);
  if (!row) throw new Error("node not found");
  const connection = await getConnection(env, row.connection_id, principal.tenantId);
  const auth = await getValidCloudflareAuth(env, connection);
  await deleteOmniNode(auth, row.account_id, row.worker_name, row.d1_id);
  await env.DB.prepare("DELETE FROM kaveh_nodes WHERE id = ?").bind(nodeId).run();
  await audit(env, { tenantId: principal.tenantId, actorType: "telegram", actorId: principal.telegramUserId, action: "omni.delete", outcome: "success", metadata: { worker: row.worker_name } });
}
