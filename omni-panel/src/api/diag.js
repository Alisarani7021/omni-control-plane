import { ok, json, readJson } from "../core/http.js";
import { badRequest } from "../core/errors.js";
import { probeProxy, parseProxy } from "../proxy/upstream.js";
import { rankPool } from "../config/cleanip.js";
import { presetList, fingerprintList, CF_TLS_PORTS, CF_HTTP_PORTS } from "../config/fragment.js";
import { runMaintenance } from "../core/maintenance.js";
import { audit } from "../db/index.js";
import { doStub } from "../core/env.js";

/**
 * Diagnostics.
 *
 * Zeus embeds scanner *source code* as copy-paste strings for the user to run
 * on their own machine, then paste results back. Kaveh runs the probe from the
 * edge — which is the only place the measurement is meaningful anyway, because
 * what matters is whether *Cloudflare* can reach the node, not whether your
 * laptop can.
 */

export async function probeNode(request, E, ctx) {
  const body = await readJson(request);
  const spec = String(body.proxy || "");
  if (!parseProxy(spec)) throw badRequest("فرمت پروکسی نامعتبر است. نمونه: user:pass@1.2.3.4:1080");
  const result = await probeProxy(spec, { target: body.target || "https://cp.cloudflare.com" });
  return ok({ spec, ...result });
}

export async function rankIps(request, E, ctx) {
  const body = await readJson(request);
  const pool = Array.isArray(body.ips) ? body.ips.slice(0, 200) : [];
  const host = String(body.host || E.config.panelName);
  if (!pool.length) throw badRequest("لیست آی‌پی خالی است");
  const ranked = await rankPool(pool, { sni: host, concurrency: Number(body.concurrency || 10) });
  return ok({ total: pool.length, healthy: ranked.length, ips: ranked });
}

/**
 * Edge-side latency probe. Runs from the Worker, so the number you see is
 * Cloudflare → target, which is what your users' traffic actually experiences.
 */
export async function ping(request, E, ctx) {
  const target = ctx.url.searchParams.get("target") || "https://cp.cloudflare.com";
  if (!/^https?:\/\//.test(target)) throw badRequest("target باید http(s) باشد");
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(target, { method: "HEAD", signal: AbortSignal.timeout(4000) });
      samples.push({ ms: Date.now() - t0, status: res.status });
    } catch (e) {
      samples.push({ ms: Date.now() - t0, error: String(e?.message || e) });
    }
  }
  const good = samples.filter((s) => !s.error).map((s) => s.ms);
  return ok({
    target,
    samples,
    colo: request.cf?.colo ?? null,
    country: request.cf?.country ?? null,
    avg: good.length ? Math.round(good.reduce((a, b) => a + b, 0) / good.length) : null,
    loss: `${samples.length - good.length}/${samples.length}`,
  });
}

export async function recentAudit(request, E, ctx) {
  const limit = Math.min(200, Number(ctx.url.searchParams.get("limit") || 50));
  const { results } = await E.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").bind(limit).all();
  return ok({ entries: results || [] });
}

/**
 * Lift a brute-force ban. `ip` defaults to the caller's own address, which is
 * the common case: you mistyped your password eight times and locked yourself
 * out of your own panel.
 *
 * Note the limitation, stated honestly: the ban gates /api/login, so a fully
 * locked-out admin with no live session cannot call this. Escape hatches then
 * are (a) wait out the 15-minute TTL, or (b) clear the Guard DO's storage from
 * the Cloudflare dashboard. RECOVERY_CODE is for a lost password, not a ban.
 */
export async function unban(request, E, ctx) {
  const body = await readJson(request).catch(() => ({}));
  const ip = String(body.ip || ctx.url.searchParams.get("ip") || ctx.ip || "").trim();
  if (!ip) throw badRequest("هیچ IP برای رفع مسدودی مشخص نشد");
  const guard = doStub(E.guard, "guard");
  if (!guard) throw new Error("Guard Durable Object binding is missing");
  const res = await guard.fetch(`https://guard/unban?key=${encodeURIComponent(`login:${ip}`)}`);
  const out = await res.json().catch(() => ({}));
  await audit(E, { actor: ctx.session?.subject, action: "guard.unban", ip: ctx.ip, target: ip });
  E.log?.info("guard.unban", { ip: ip.slice(0, 40) });
  return ok({ ip, ...out });
}

/**
 * Run the maintenance pass now and report what it did. Same code the Cron
 * Trigger runs, so "did my auto-reset work?" is a question you can answer with
 * one click instead of waiting ten minutes and squinting at D1.
 */
export async function maintenance(request, E, ctx) {
  const summary = await runMaintenance(E, { actor: ctx.session?.subject || "admin" });
  await audit(E, { actor: ctx.session?.subject, action: "maintenance.manual", ip: ctx.ip, detail: summary });
  return ok(summary);
}

export async function fragments(request, E) {
  return ok({ presets: presetList(), fingerprints: fingerprintList(), tlsPorts: CF_TLS_PORTS, httpPorts: CF_HTTP_PORTS });
}
