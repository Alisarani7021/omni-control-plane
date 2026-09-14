/**
 * Omni engine — provision/manage Omni tenant nodes on a tenant's OWN
 * Cloudflare account, through the tenant's scoped API token.
 *
 * A Omni node is a single headless Worker (dist-headless bundle, pinned in
 * ./omni-source.ts) plus its own D1 + SQLite Durable Objects + cron. No VPS,
 * no assets: the Telegram bot / control plane IS the UI, talking to the node
 * over the agent channel (X-Omni-Agent).
 *
 * Everything here stays inside the connection's stored resource boundary —
 * the same rule the rest of the control plane obeys.
 */
import { cloudflareApi, type CloudflareAuth } from "./cloudflare-api";
import { OMNI_SOURCE } from "./omni-source";

export const OMNI_COMPATIBILITY_DATE = "2026-05-01";
export const OMNI_DEFAULT_CRON = "*/10 * * * *";

export interface OmniPlan {
  accountId: string;
  workerName: string;
  d1Name: string;
  agentKey: string;
  signingSecret?: string;
  cron?: string;
}

/** Pure: the multipart upload metadata for a Omni node. Unit-tested. */
export function omniUploadMetadata(plan: Pick<OmniPlan, "agentKey" | "signingSecret" | "cron">, d1Id: string): Record<string, unknown> {
  const bindings: Record<string, unknown>[] = [
    { type: "d1", name: "DB", id: d1Id },
    { type: "durable_object_namespace", name: "LEDGER", class_name: "Ledger" },
    { type: "durable_object_namespace", name: "GUARD", class_name: "Guard" },
    { type: "secret_text", name: "AGENT_KEY", text: plan.agentKey },
  ];
  if (plan.signingSecret) bindings.push({ type: "secret_text", name: "SECRET", text: plan.signingSecret });
  for (const [name, text] of [
    ["PANEL_NAME", "Omni"],
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
    main_module: "omni.mjs",
    compatibility_date: OMNI_COMPATIBILITY_DATE,
    compatibility_flags: [],
    bindings,
    // SQLite-backed DOs: the only kind new accounts can create since 2026-07.
    migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger", "Guard"] }],
    triggers: { crons: [plan.cron || OMNI_DEFAULT_CRON] },
  };
}

/** Idempotent D1: reuse a same-named database instead of failing the deploy. */
export async function findOrCreateD1(auth: CloudflareAuth, accountId: string, name: string): Promise<{ id: string; created: boolean }> {
  // cloudflareApi unwraps the envelope: T is the `result` payload itself.
  // The D1 list API returns `uuid`; older docs said `id`. Accept both so a
  // renamed API field can never surface as "undefined" mid-provision.
  const existing = await cloudflareApi<{ id?: string; uuid?: string; name: string }[]>(auth, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`);
  const hit = existing?.find((d) => d.name === name);
  if (hit) {
    const foundId = hit.uuid ?? hit.id;
    if (!foundId) throw new Error(`D1 list returned "${name}" without an id`);
    return { id: foundId, created: false };
  }
  // On failure cloudflareApi itself throws with the real Cloudflare code and
  // message, so reaching here means the database exists in `made`.
  const made = await cloudflareApi<{ uuid?: string; id?: string }>(auth, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const newId = made?.uuid ?? made?.id;
  if (!newId) throw new Error(`D1 create for "${name}" returned no id`);
  return { id: newId, created: true };
}

export async function uploadKavehWorker(auth: CloudflareAuth, plan: OmniPlan, d1Id: string): Promise<void> {
  const metadata = omniUploadMetadata(plan, d1Id);
  const body = new FormData();
  body.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  body.set("omni.mjs", new Blob([OMNI_SOURCE], { type: "application/javascript+module" }), "omni.mjs");
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
    const sub = await cloudflareApi<{ subdomain: string }>(auth, `/accounts/${accountId}/workers/subdomain`);
    return `https://${workerName}.${sub.subdomain}.workers.dev`;
  } catch {
    return null;
  }
}

export async function provisionOmniNode(auth: CloudflareAuth, plan: OmniPlan): Promise<{ d1Id: string; d1Created: boolean; baseUrl: string | null }> {
  const d1 = await findOrCreateD1(auth, plan.accountId, plan.d1Name);
  await uploadKavehWorker(auth, plan, d1.id);
  const baseUrl = await enableWorkersDev(auth, plan.accountId, plan.workerName);
  return { d1Id: d1.id, d1Created: d1.created, baseUrl };
}

export async function deleteOmniNode(auth: CloudflareAuth, accountId: string, workerName: string, d1Id: string): Promise<void> {
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, { method: "DELETE" }).catch(() => null);
  await cloudflareApi<unknown>(auth, `/accounts/${accountId}/d1/database/${d1Id}`, { method: "DELETE" }).catch(() => null);
}

/**
 * Agent-channel auth headers. The control plane and the node must agree on
 * this name, and the node is a *pinned artifact* sitting in the tenant's own
 * Cloudflare account — renaming a header here cannot rename the bundles that
 * are already deployed out there.
 *
 * The Kaveh→OMNI rebrand renamed the outbound header (`X-Omni-Agent`) while
 * omni-panel/dist-headless kept reading `x-kaveh-agent`, so every agent call
 * answered `403 «کلید عامل نامعتبر است»`: panel login tokens were never set,
 * user lists/creation failed and the VIP seed silently gave up. Both names go
 * out on every request, which is what the node reads today and what a bundle
 * rebuilt after the rebrand will read tomorrow.
 */
export const OMNI_AGENT_HEADER = "X-Omni-Agent";
export const OMNI_AGENT_LEGACY_HEADER = "X-Kaveh-Agent";

/** The agent channel: src/api/agent.js on the node. Throws on non-ok. */
export async function omniAgent<T>(baseUrl: string, agentKey: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set(OMNI_AGENT_HEADER, agentKey);
  headers.set(OMNI_AGENT_LEGACY_HEADER, agentKey);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${baseUrl.replace(/\/$/u, "")}${path}`, { ...init, headers });
  const json = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) throw new Error(json.error || `agent ${res.status}`);
  return json;
}
