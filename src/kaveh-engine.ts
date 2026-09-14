/**
 * Kaveh engine — provision/manage Kaveh tenant nodes on a tenant's OWN
 * Cloudflare account, through the tenant's scoped API token.
 *
 * A Kaveh node is a single headless Worker (dist-headless bundle, pinned in
 * ./kaveh-source.ts) plus its own D1 + SQLite Durable Objects + cron. No VPS,
 * no assets: the Telegram bot / control plane IS the UI, talking to the node
 * over the agent channel (X-Kaveh-Agent).
 *
 * Everything here stays inside the connection's stored resource boundary —
 * the same rule the rest of the control plane obeys.
 */
import { cloudflareApi, type CloudflareAuth } from "./cloudflare-api";
import { KAVEH_SOURCE } from "./kaveh-source";

export const KAVEH_COMPATIBILITY_DATE = "2026-05-01";
export const KAVEH_DEFAULT_CRON = "*/10 * * * *";

export interface KavehPlan {
  accountId: string;
  workerName: string;
  d1Name: string;
  agentKey: string;
  signingSecret?: string;
  cron?: string;
}

/** Pure: the multipart upload metadata for a Kaveh node. Unit-tested. */
export function kavehUploadMetadata(plan: Pick<KavehPlan, "agentKey" | "signingSecret" | "cron">, d1Id: string): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = [
    { type: "d1", name: "DB", id: d1Id },
    { type: "durable_object_namespace", name: "LEDGER", class_name: "Ledger" },
    { type: "durable_object_namespace", name: "GUARD", class_name: "Guard" },
    { type: "secret_text", name: "AGENT_KEY", text: plan.agentKey },
  ];
  if (plan.signingSecret) bindings.push({ type: "secret_text", name: "SECRET", text: plan.signingSecret });
  for (const [name, text] of [
    ["PANEL_NAME", "Kaveh"],
    ["DEFAULT_QUOTA_GB", "50"],
    ["DEFAULT_EXPIRY_DAYS", "30"],
    ["SUB_PATH_PREFIX", "s"],
    ["FRAGMENT_PRESET", "mci"],
    ["LOG_LEVEL", "info"],
    ["DEBUG_ERRORS", "0"],
  ]) {
    bindings.push({ type: "plain_text", name, text });
  }
  return {
    main_module: "kaveh.mjs",
    compatibility_date: KAVEH_COMPATIBILITY_DATE,
    compatibility_flags: [],
    bindings,
    // SQLite-backed DOs: the only kind new accounts can create since 2026-07.
    migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger", "Guard"] }],
    triggers: { crons: [plan.cron || KAVEH_DEFAULT_CRON] },
  };
}

/** Idempotent D1: reuse a same-named database instead of failing the deploy. */
export async function findOrCreateD1(auth: CloudflareAuth, accountId: string, name: string): Promise<{ id: string; created: boolean }> {
  const existing = await cloudflareApi<{ result: { id: string; name: string }[] }>(auth, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`);
  const hit = existing.result?.find((d) => d.name === name);
  if (hit) return { id: hit.id, created: false };
  const made = await cloudflareApi<{ result: { uuid: string } }>(auth, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return { id: made.result.uuid, created: true };
}

export async function uploadKavehWorker(auth: CloudflareAuth, plan: KavehPlan, d1Id: string): Promise<void> {
  const metadata = kavehUploadMetadata(plan, d1Id);
  const body = new FormData();
  body.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.set("kaveh.mjs", new Blob([KAVEH_SOURCE], { type: "application/javascript+module" }), "kaveh.mjs");
  await cloudflareApi<unknown>(auth, `/accounts/${plan.accountId}/workers/scripts/${encodeURIComponent(plan.workerName)}`, {
    method: "PUT",
    body,
  });
}

/** Best-effort workers.dev route; returns null when the account refuses it. */
export async function enableWorkersDev(auth: CloudflareAuth, accountId: string, workerName: string): Promise<string | null> {
  try {
    await cloudflareApi<unknown>(auth, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`, {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    const sub = await cloudflareApi<{ result: { subdomain: string } }>(auth, `/accounts/${accountId}/workers/subdomain`);
    return `https://${workerName}.${sub.result.subdomain}.workers.dev`;
  } catch {
    return null;
  }
}

export async function provisionKavehNode(auth: CloudflareAuth, plan: KavehPlan): Promise<{ d1Id: string; d1Created: boolean; baseUrl: string | null }> {
  const d1 = await findOrCreateD1(auth, plan.accountId, plan.d1Name);
  await uploadKavehWorker(auth, plan, d1.id);
  const baseUrl = await enableWorkersDev(auth, plan.accountId, plan.workerName);
  return { d1Id: d1.id, d1Created: d1.created, baseUrl };
}

export async function deleteKavehNode(auth: CloudflareAuth, accountId: string, workerName: string, d1Id: string): Promise<void> {
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "DELETE" }).catch(() => null);
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/d1/database/${d1Id}`, { method: "DELETE" }).catch(() => null);
}

/** The agent channel: src/api/agent.js on the node. Throws on non-ok. */
export async function kavehAgent<T>(baseUrl: string, agentKey: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-Kaveh-Agent", agentKey);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${baseUrl.replace(/\/$/u, "")}${path}`, { ...init, headers });
  const json = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) throw new Error(json.error || `agent ${res.status}`);
  return json;
}
