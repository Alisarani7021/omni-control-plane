/**
 * «🚀 دیپلوی پنل جدید» — the panel-only deploy path.
 *
 * The worker asked for a Cloudflare API token in chat, then a worker name and a
 * panel password, and created everything itself (KV or D1, bindings, the seeded
 * panel password, the workers.dev route, and a final link check). This module
 * performs the same steps with the same per-panel rules, but takes the token
 * from the tenant's stored Cloudflare connection instead of a chat message, and
 * writes one `panel_deployments` row per attempt so the list and the audit trail
 * tell the truth about what is running.
 */
import { cloudflareApi, getConnection, getValidCloudflareAuth, type CloudflareAuth } from "./cloudflare-api";
import { DATA_PLANE_SOURCE } from "./data-plane-source";
import { audit } from "./db";
import { findPanel, panelLoginNote, type PanelSpec } from "./panel-catalog";
import { fetchPanelSource, transformPanelSource } from "./panel-source";
import { nowIso, randomToken, redactError, sha256 } from "./security";
import type { ConnectionRow, Env, SessionPrincipal } from "./types";

/** Third-party panels are plain Workers modules; keep the worker's compat date. */
export const PANEL_COMPATIBILITY_DATE = "2024-03-01";
export const PANEL_PROBE_ATTEMPTS = 3;
export const PANEL_PROBE_DELAY_MS = 2500;

export type PanelDeployStatus = "provisioning" | "live" | "verifying" | "failed";

export interface PanelDeploymentRow {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  account_id: string;
  worker_name: string;
  worker_domain: string;
  panel_key: string;
  panel_name: string;
  panel_path: string;
  panel_url: string;
  source_host: string;
  source_sha256: string;
  status: PanelDeployStatus;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface PanelDeployInput {
  panelKey: string;
  workerName: string;
  password: string;
  connectionId?: string;
}

export interface PanelDeployOptions {
  /** Skips the live link check — used by tests and by retries that already probed. */
  probe?: boolean;
  probeDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const PANEL_SELECT = `SELECT id, tenant_id, connection_id, account_id, worker_name, worker_domain,
       panel_key, panel_name, panel_path, panel_url, source_host, source_sha256,
       status, detail, created_at, updated_at
  FROM panel_deployments`;

export async function deployPanel(
  env: Env,
  principal: SessionPrincipal,
  input: PanelDeployInput,
  options: PanelDeployOptions = {},
): Promise<PanelDeploymentRow> {
  const panel = findPanel(input.panelKey);
  if (!panel) throw new Error("چنین پنلی در کاتالوگ نداریم.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const connection = await pickConnection(env, principal, input.connectionId);
  const auth = await getValidCloudflareAuth(env, connection);
  const accountId = connection.resource_account_id ?? (await firstAccountId(auth));
  if (!accountId) throw new Error("حساب Cloudflare این اتصال مشخص نیست؛ از «🔌 اتصال Cloudflare» دوباره وصل کنید.");
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u.test(input.workerName)) {
    throw new Error("نام Worker فقط حرف کوچک انگلیسی، عدد و خط‌تیره؛ حداقل ۳ نویسه.");
  }

  const subdomain = await ensureWorkersSubdomain(auth, accountId, input.workerName);
  if (!subdomain) {
    throw new Error("ساب‌دامینهٔ Workers در این حساب فعال نیست. یک بار در dash.cloudflare.com نام آن را تأیید کنید و دوباره تلاش کنید.");
  }
  const workerDomain = `${input.workerName}.${subdomain}.workers.dev`;
  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO panel_deployments
      (id, tenant_id, connection_id, account_id, worker_name, worker_domain, panel_key, panel_name,
       panel_path, panel_url, source_host, source_sha256, status, detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'provisioning', ?, ?, ?)`,
  ).bind(
    id, principal.tenantId, connection.id, accountId, input.workerName, workerDomain,
    panel.key, panel.name, panel.path, `https://${workerDomain}${panel.path}`,
    "در حال ساخت منابع و آپلود ورکر…", now, now,
  ).run();

  try {
    const kvId = panel.db === "kv" ? await ensureKvNamespace(auth, accountId, input.workerName) : null;
    if (panel.db === "kv" && !kvId) {
      throw new Error("ساخت فضای KV نشد. توکن باید دسترسی «Account → Workers KV Storage → Edit» روی All accounts داشته باشد.");
    }
    const d1Id = panel.db === "d1" ? await ensureD1Database(auth, accountId, input.workerName) : null;
    if (panel.db === "d1" && !d1Id) throw new Error("ساخت D1 نشد؛ توکن باید دسترسی D1 → Edit داشته باشد.");

    const bundle = await resolvePanelSource(panel, input, fetchImpl);
    const finalPath = panelFinalPath(panel, bundle.uuid, bundle.subKey);
    if (panel.key === "bpb" && kvId) await seedKvValue(auth, accountId, kvId, "pwd", input.password);

    const bindings = panelBindings(panel, { kvId, d1Id, accountId, auth, ...bundle, password: input.password });
    await uploadPanelScript(auth, accountId, input.workerName, bundle.source, bindings, fetchImpl);
    await enableWorkerSubdomain(auth, accountId, input.workerName);
    if (kvId) await repairKvBindings(auth, accountId, input.workerName, panel, kvId);

    const panelUrl = `https://${workerDomain}${finalPath}`;
    const probe = options.probe === false ? null : await probePanel(panelUrl, options.probeDelayMs ?? PANEL_PROBE_DELAY_MS, fetchImpl);
    const status: PanelDeployStatus = probe === null ? "verifying" : probe.ok ? "live" : "verifying";
    const detail = probe === null
      ? bundle.note
      : probe.ok
        ? `تست لینک: سالم (${probe.status}). ${bundle.note}`
        : `تست لینک: ${probe.status === null ? "جوابی نگرفتم" : `کد ${probe.status}`} — تازه دیپلوی شده، چند ثانیه دیگر دوباره باز کنید. ${bundle.note}`;
    await updatePanelDeployment(env, id, { panelPath: finalPath, panelUrl, status, detail });
    await audit(env, {
      tenantId: principal.tenantId,
      actorType: "telegram",
      actorId: principal.telegramUserId,
      action: "panel-deploy.succeeded",
      resourceType: "panel_deployment",
      resourceId: id,
      outcome: "success",
      metadata: { panel: panel.key, worker: input.workerName, source: bundle.host, sha256: bundle.sha256 },
    });
    const row = await getPanelDeployment(env, principal, id);
    if (!row) throw new Error("رکورد استقرار نوشته شد اما خوانده نشد.");
    return row;
  } catch (error) {
    const detail = redactError(error);
    await updatePanelDeployment(env, id, { status: "failed", detail });
    await audit(env, {
      tenantId: principal.tenantId,
      actorType: "telegram",
      actorId: principal.telegramUserId,
      action: "panel-deploy.failed",
      resourceType: "panel_deployment",
      resourceId: id,
      outcome: "failure",
      metadata: { panel: panel.key, worker: input.workerName },
    });
    throw new Error(detail);
  }
}

export function panelDeployText(row: PanelDeploymentRow, panel: PanelSpec | null): string {
  const lines = [
    row.status === "failed" ? `❌ استقرار ${row.panel_name} کامل نشد` : `✅ دیپلوی انجام شد — ${row.panel_name}`,
    "",
    `🌐 <code>${row.worker_domain}</code>`,
    `🔓 <code>${row.panel_url}</code>`,
    `🧾 منبع: ${row.source_host === "repo" ? "سورس خود ریپو" : row.source_host} · sha256 <code>${row.source_sha256.slice(0, 16)}</code>`,
  ];
  if (row.detail) lines.push(`📋 ${row.detail}`);
  if (row.status !== "failed") {
    lines.push("🔑 رمز پنل فقط در همین گفت‌وگو نوشته شد و در دیتابیس ذخیره نمی‌شود.");
    if (panel) lines.push(panelLoginNote(panel));
  }
  return lines.join("\n");
}

export async function listPanelDeployments(env: Env, tenantId: string, limit = 10): Promise<PanelDeploymentRow[]> {
  const result = await env.DB.prepare(`${PANEL_SELECT} WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(tenantId, limit).all<PanelDeploymentRow>();
  return result.results ?? [];
}

export async function getPanelDeployment(
  env: Env,
  principal: SessionPrincipal,
  id: string,
): Promise<PanelDeploymentRow | null> {
  return await env.DB.prepare(`${PANEL_SELECT} WHERE id = ? AND tenant_id = ?`)
    .bind(id, principal.tenantId).first<PanelDeploymentRow>();
}

/** Record-only delete, same rule as the 7-step deployments: only dead rows. */
export async function deletePanelDeployment(
  env: Env,
  principal: SessionPrincipal,
  id: string,
): Promise<{ deleted: boolean; reason?: string }> {
  const row = await getPanelDeployment(env, principal, id);
  if (!row) return { deleted: false, reason: "not-found" };
  if (row.status !== "failed") return { deleted: false, reason: "deletable-only-failed" };
  await env.DB.prepare("DELETE FROM panel_deployments WHERE id = ? AND tenant_id = ?").bind(id, principal.tenantId).run();
  await audit(env, {
    tenantId: principal.tenantId,
    actorType: "telegram",
    actorId: principal.telegramUserId,
    action: "panel-deploy.record-deleted",
    resourceType: "panel_deployment",
    resourceId: id,
    outcome: "success",
    metadata: { worker: row.worker_name, panel: row.panel_key },
  });
  return { deleted: true };
}

async function updatePanelDeployment(
  env: Env,
  id: string,
  patch: { panelPath?: string; panelUrl?: string; status?: PanelDeployStatus; detail?: string },
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const values: Array<string> = [nowIso()];
  if (patch.panelPath !== undefined) { sets.push("panel_path = ?"); values.push(patch.panelPath); }
  if (patch.panelUrl !== undefined) { sets.push("panel_url = ?"); values.push(patch.panelUrl); }
  if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
  if (patch.detail !== undefined) { sets.push("detail = ?"); values.push(patch.detail); }
  await env.DB.prepare(`UPDATE panel_deployments SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
}

async function pickConnection(env: Env, principal: SessionPrincipal, connectionId?: string): Promise<ConnectionRow> {
  if (connectionId) return await getConnection(env, connectionId, principal.tenantId);
  const row = await env.DB.prepare(
    `SELECT * FROM oauth_connections
      WHERE tenant_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(principal.tenantId).first<ConnectionRow>();
  if (!row) throw new Error("اتصال Cloudflare ندارید. اول «🔌 اتصال Cloudflare» را کامل کنید.");
  return row;
}

async function firstAccountId(auth: CloudflareAuth): Promise<string | null> {
  try {
    const accounts = await cloudflareApi<Array<{ id: string }>>(auth, "/accounts");
    return accounts?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureWorkersSubdomain(auth: CloudflareAuth, accountId: string, workerName: string): Promise<string> {
  try {
    const current = await cloudflareApi<{ subdomain?: string } | null>(auth, `/accounts/${accountId}/workers/subdomain`);
    if (current?.subdomain) return current.subdomain;
  } catch {
    // Not configured yet — try to create it once, like the worker did.
  }
  const wanted = `${workerName}-${randomToken(2)}`.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 32);
  try {
    const created = await cloudflareApi<{ subdomain?: string } | null>(
      auth,
      `/accounts/${accountId}/workers/subdomain`,
      { method: "PUT", body: JSON.stringify({ subdomain: wanted }) },
    );
    return created?.subdomain ?? wanted;
  } catch {
    return "";
  }
}

async function ensureKvNamespace(auth: CloudflareAuth, accountId: string, workerName: string): Promise<string | null> {
  const title = `${workerName}_KV`;
  try {
    const created = await cloudflareApi<{ id?: string } | null>(
      auth,
      `/accounts/${accountId}/storage/kv/namespaces`,
      { method: "POST", body: JSON.stringify({ title }) },
    );
    if (created?.id) return created.id;
  } catch {
    // Fall through to a reuse lookup: a namespace with this title may exist already.
  }
  try {
    const list = await cloudflareApi<Array<{ id: string; title: string }>>(
      auth,
      `/accounts/${accountId}/storage/kv/namespaces?per_page=50`,
    );
    return list?.find((entry) => entry.title === title)?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureD1Database(auth: CloudflareAuth, accountId: string, workerName: string): Promise<string | null> {
  const name = `${workerName}_db`;
  try {
    const created = await cloudflareApi<{ uuid?: string; id?: string } | null>(
      auth,
      `/accounts/${accountId}/d1/database`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
    const id = created?.uuid ?? created?.id;
    if (id) return id;
  } catch {
    // Fall through to a reuse lookup.
  }
  try {
    const list = await cloudflareApi<Array<{ uuid: string; name: string }>>(auth, `/accounts/${accountId}/d1/database`);
    return list?.find((entry) => entry.name === name)?.uuid ?? null;
  } catch {
    return null;
  }
}

interface ResolvedSource {
  source: string;
  sha256: string;
  host: string;
  note: string;
  uuid: string;
  subKey: string;
}

async function resolvePanelSource(
  panel: PanelSpec,
  input: PanelDeployInput,
  fetchImpl: typeof fetch,
): Promise<ResolvedSource> {
  const uuid = crypto.randomUUID();
  const subKey = randomToken(6);
  if (!panel.sourceUrl) {
    return {
      source: DATA_PLANE_SOURCE,
      sha256: await sha256(DATA_PLANE_SOURCE),
      host: "repo",
      note: "سورس از ریپو برداشته شد",
      uuid,
      subKey,
    };
  }
  const downloaded = await fetchPanelSource(panel.sourceUrl, fetchImpl);
  const transformed = transformPanelSource(panel.key, downloaded.source, {
    password: input.password,
    domain: downloaded.host,
  });
  return {
    source: transformed.source,
    sha256: await sha256(transformed.source),
    host: downloaded.host,
    note: `${transformed.note} · ${downloaded.bytes} بایت`,
    uuid,
    subKey,
  };
}

export function panelFinalPath(panel: PanelSpec, uuid: string, subKey: string): string {
  if (panel.key === "nova" || panel.key === "edgetunnel") return `/${subKey}`;
  if (panel.key === "vless_core") return `/${uuid}`;
  return panel.path;
}

export function panelBindings(
  panel: PanelSpec,
  ctx: {
    kvId: string | null;
    d1Id: string | null;
    accountId: string;
    auth: CloudflareAuth;
    uuid: string;
    subKey: string;
    password: string;
  },
): Array<Record<string, string>> {
  const bindings: Array<Record<string, string>> = [];
  for (const name of panel.kvNames) {
    if (ctx.kvId) bindings.push({ type: "kv_namespace", name, namespace_id: ctx.kvId });
  }
  for (const name of panel.d1Names) {
    if (ctx.d1Id) bindings.push({ type: "d1", name, id: ctx.d1Id });
  }
  const vars: Record<string, string> = {};
  if (panel.key === "bpb") {
    vars["UUID"] = ctx.uuid;
    vars["TR_PASS"] = ctx.subKey;
  } else if (panel.key === "nova" || panel.key === "edgetunnel") {
    vars["UUID"] = ctx.uuid;
    vars["PASSWORD"] = ctx.password;
    vars["KEY"] = ctx.subKey;
    vars["PROXYIP"] = "cdn-all.xn--b6gac.eu.org";
  } else if (panel.key === "vless_core") {
    vars["UUID"] = ctx.uuid;
    vars["PROXYIP"] = "cdn-all.xn--b6gac.eu.org";
  } else if (panel.key === "omni_pro") {
    vars["PASSWORD"] = ctx.password;
    vars["PANEL_NAME"] = panel.name;
  } else if (panel.key === "zeus") {
    vars["CF_ACCOUNT_ID"] = ctx.accountId;
    vars["WORKER_NAME"] = panel.key;
  }
  for (const [name, text] of Object.entries(vars)) bindings.push({ type: "plain_text", name, text });
  if (panel.key === "zeus") {
    // The worker put the API token in plain_text; keep the panel working but keep
    // the token out of the readable variables.
    bindings.push({ type: "secret_text", name: "CF_API_TOKEN", text: ctx.auth.token });
  }
  return bindings;
}

async function uploadPanelScript(
  auth: CloudflareAuth,
  accountId: string,
  scriptName: string,
  source: string,
  bindings: Array<Record<string, string>>,
  fetchImpl: typeof fetch,
): Promise<void> {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: PANEL_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    bindings,
  };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("worker.js", new Blob([source], { type: "application/javascript+module" }), "worker.js");
  const headers = new Headers({ Authorization: `Bearer ${auth.token}` });
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
    { method: "PUT", headers, body: form },
  );
  if (!response.ok) throw new Error("آپلود ورکر پنل ناموفق بود.");
  const body = await response.json<{ success?: boolean; errors?: Array<{ message?: string }> }>().catch(() => null);
  if (body && body.success === false) {
    throw new Error(body.errors?.[0]?.message ? `کلادفلر: ${body.errors[0].message}` : "آپلود ورکر پنل ناموفق بود.");
  }
}

async function enableWorkerSubdomain(auth: CloudflareAuth, accountId: string, scriptName: string): Promise<void> {
  try {
    await cloudflareApi<unknown>(
      auth,
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      { method: "POST", body: JSON.stringify({ enabled: true }) },
    );
  } catch {
    // Route already on, or the account prefers custom domains: the link line below tells the truth.
  }
}

/** Panels read KV bindings by an exact name; if the upload dropped one, PATCH it back. */
async function repairKvBindings(
  auth: CloudflareAuth,
  accountId: string,
  scriptName: string,
  panel: PanelSpec,
  kvId: string,
): Promise<void> {
  const path = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;
  type Settings = { bindings?: Array<{ type?: string; name?: string }> } | null;
  let current: Array<{ type?: string; name?: string }> = [];
  try {
    const settings = await cloudflareApi<Settings>(auth, path);
    current = settings?.bindings ?? [];
  } catch {
    return;
  }
  const missing = panel.kvNames.filter((name) => !current.some((b) => b?.type === "kv_namespace" && b?.name === name));
  if (missing.length === 0) return;
  const keep = current.filter((b) => !(b?.type === "kv_namespace" && panel.kvNames.includes(b?.name ?? "")));
  try {
    await cloudflareApi<unknown>(auth, path, {
      method: "PATCH",
      body: JSON.stringify({ bindings: [...keep, ...missing.map((name) => ({ type: "kv_namespace", name, namespace_id: kvId }))] }),
    });
  } catch {
    // The deploy still stands; the panel will report the missing binding itself.
  }
}

async function seedKvValue(
  auth: CloudflareAuth,
  accountId: string,
  namespaceId: string,
  key: string,
  value: string,
): Promise<boolean> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: new Headers({ Authorization: `Bearer ${auth.token}`, "Content-Type": "text/plain" }),
      body: value,
    },
  ).catch(() => null);
  return response?.ok === true;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
}

async function probePanel(url: string, delayMs: number, fetchImpl: typeof fetch): Promise<ProbeResult> {
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt < PANEL_PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      lastStatus = response.status;
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok || response.status === 302) return { ok: true, status: response.status };
    } catch {
      lastStatus = null;
    }
  }
  return { ok: false, status: lastStatus };
}
