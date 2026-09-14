/**
 * Agent API — the control-plane channel.
 *
 * How an external orchestrator (the v13 Telegram control plane, a fleet
 * manager, an ops script) administers a Kaveh instance headlessly: create
 * users, read configs, reset traffic, hand the panel back to first-run setup.
 *
 * Security model:
 *   • gated by the AGENT_KEY secret (`wrangler secret put AGENT_KEY`);
 *     without it every agent route answers 503 — the surface does not exist
 *   • constant-time compare, key never logged
 *   • NOT an admin session: no password writes, no settings writes, no backup
 *     export. Exactly the verbs a bot needs, nothing more
 *   • every mutating call lands in the audit log with actor "agent"
 */
import { json, readJson } from "../core/http.js";
import { forbidden } from "../core/errors.js";
import { list, create, remove, reset, getOne } from "./users.js";
import { Settings } from "../db/index.js";

const ADMIN_HASH_KEY = "admin_hash";

/** Constant-time compare so response timing never leaks the key. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * @returns {null|Response} null when the caller may proceed.
 * 503 when AGENT_KEY is unset (feature off), 403 when the key is wrong —
 * so nobody can probe whether an instance has the feature enabled.
 */
function guard(request, E) {
  const key = E.raw?.AGENT_KEY ?? null;
  if (!key) return json({ ok: false, code: "agent_disabled", error: "AGENT_KEY تنظیم نشده است" }, 503);
  if (!safeEqual(request.headers.get("x-kaveh-agent") || "", key)) return forbidden("کلید عامل نامعتبر است");
  return null;
}

/** Router context for the delegated user handlers: agent identity, no session. */
const agentCtx = (request, params = {}) => ({
  params,
  session: { subject: "agent" },
  ip: request.headers.get("cf-connecting-ip") || "agent",
  url: new URL(request.url),
  ctx: null,
});

export async function health(request, E) {
  const denied = guard(request, E);
  if (denied) return denied;
  const S = new Settings(E);
  const [{ n }] = (await E.db.prepare("SELECT COUNT(*) AS n FROM users").all()).results;
  return json({ ok: true, service: "kaveh", version: "0.1.0", installed: !!(await S.get(ADMIN_HASH_KEY)), users: n });
}

export async function users(request, E) {
  const denied = guard(request, E);
  if (denied) return denied;
  return list(request, E, agentCtx(request));
}

export async function createUser(request, E) {
  const denied = guard(request, E);
  if (denied) return denied;
  // create() reads and validates the body itself (newUserInput), including
  // the placeholder-upstream guard — the bot gets the same rules as the UI.
  return create(request, E, agentCtx(request));
}

export async function userConfigs(request, E, ctx) {
  const denied = guard(request, E);
  if (denied) return denied;
  return getOne(request, E, agentCtx(request, ctx.params));
}

export async function userReset(request, E, ctx) {
  const denied = guard(request, E);
  if (denied) return denied;
  return reset(request, E, agentCtx(request, ctx.params));
}

export async function deleteUser(request, E, ctx) {
  const denied = guard(request, E);
  if (denied) return denied;
  return remove(request, E, agentCtx(request, ctx.params));
}

/**
 * Hand the panel back to first-run setup (the Zeus bot's «بازیابی رمز»).
 * The admin hash is wiped; the next visitor to /panel sets a new password.
 * The orchestrator must deliver that link to the tenant immediately —
 * same trust model as a fresh deploy.
 */
export async function adminReset(request, E) {
  const denied = guard(request, E);
  if (denied) return denied;
  const S = new Settings(E);
  await S.set({ [ADMIN_HASH_KEY]: "" });
  await E.db.prepare("DELETE FROM sessions").run();
  return json({ ok: true, installed: false, note: "panel is in first-run setup again" });
}

/** Convenience for orchestrators that speak JSON bodies only. */
export async function readBody(request) {
  return readJson(request);
}
