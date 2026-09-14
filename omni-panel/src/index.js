/**
 * Kaveh — Worker entrypoint.
 *
 * Everything below is ~180 lines. The whole panel (worker + UI) is under 200 KB
 * of source, versus Zeus's single 634 KB / 11,000-line file that mixes proxy
 * protocol handling, SQL, HTML, CSS, and 3,000 lines of inline frontend JS.
 */
import { resolveEnv, assertReady, BootError, doStub } from "./core/env.js";
import { Router, requireMatch } from "./core/router.js";
import { handleError } from "./core/errors.js";
import { json, ok, securityHeaders, clientIp, noContent } from "./core/http.js";
import { authenticate } from "./api/auth.js";
import * as Auth from "./api/auth.js";
import * as UserApi from "./api/users.js";
import * as Stats from "./api/stats.js";
import * as Sub from "./api/sub.js";
import * as Diag from "./api/diag.js";
import { handleVlessWebSocket, uuidFromRequest } from "./proxy/vless.js";
import { Guard, Ledger } from "./auth/guard.js";
import { Settings } from "./db/index.js";
import { runMaintenance } from "./core/maintenance.js";
import * as Agent from "./api/agent.js";
import { ensureSchema } from "./db/migrate.js";

const router = new Router();

// ── public ──────────────────────────────────────────────────────────────────
router.post("/api/setup", Auth.setup, { auth: "none" });
router.post("/api/login", Auth.login, { auth: "none" });
router.post("/api/recover", Auth.recover, { auth: "none" });
router.get("/api/whoami", Auth.whoami, { auth: "none" });

// ── admin ───────────────────────────────────────────────────────────────────
router.post("/api/logout", Auth.logout);
router.post("/api/password", Auth.changePassword);
router.get("/api/sessions", Auth.listSessions);
router.post("/api/sessions/revoke", Auth.revokeSession);

router.get("/api/overview", Stats.overview);
router.get("/api/stats/usage", Stats.userUsage);
router.get("/api/settings", Stats.getSettings);
router.put("/api/settings", Stats.putSettings);
router.get("/api/backup", Stats.exportBackup);
router.post("/api/backup", Stats.importBackup);

router.get("/api/users", UserApi.list);
router.post("/api/users", UserApi.create);
router.post("/api/users/bulk", UserApi.bulkOp);
router.get("/api/users/:username", UserApi.getOne);
router.patch("/api/users/:username", UserApi.update);
router.delete("/api/users/:username", UserApi.remove);
router.post("/api/users/:username/reset", UserApi.reset);
router.post("/api/users/:username/rotate-token", UserApi.rotateToken);
router.post("/api/users/:username/rotate-uuid", UserApi.rotateUuid);

router.get("/api/diag/cf-usage", Stats.cfUsage);
router.post("/api/diag/probe-node", Diag.probeNode);
router.post("/api/diag/rank-ips", Diag.rankIps);
router.get("/api/diag/ping", Diag.ping);
router.get("/api/diag/logs", Diag.recentAudit);
router.get("/api/fragments", Diag.fragments);
router.post("/api/diag/maintenance", Diag.maintenance);
router.post("/api/diag/unban", Diag.unban);

// ── agent (control-plane channel, gated by the AGENT_KEY secret) ────────────
// auth:"none" here means "no admin SESSION": every handler re-checks the
// agent key itself and answers 503 when the secret is absent.
router.get("/api/agent/health", Agent.health, { auth: "none" });
router.get("/api/agent/users", Agent.users, { auth: "none" });
router.post("/api/agent/users", Agent.createUser, { auth: "none" });
router.get("/api/agent/users/:username", Agent.userConfigs, { auth: "none" });
router.post("/api/agent/users/:username/reset", Agent.userReset, { auth: "none" });
router.delete("/api/agent/users/:username", Agent.deleteUser, { auth: "none" });
router.post("/api/agent/admin/reset", Agent.adminReset, { auth: "none" });

// ── worker ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, rawEnv, ctx) {
    const E = resolveEnv(rawEnv);
    E.ctx = ctx;
    const url = new URL(request.url);
    const ip = clientIp(request);

    try {
      assertReady(E);
      // Latched: one indexed read per isolate, no-op forever after. This is what
      // makes a fresh auto-provisioned D1 (dashboard / Deploy-button / GitHub
      // deploys, where `wrangler d1 migrations apply` cannot run) work.
      await ensureSchema(E);

      // 1. WebSocket tunnel — checked first, cheapest path, no DB schema work.
      if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
        return await handleVlessWebSocket(request, E, ctx);
      }

      // 2. Subscriptions and public status pages — no auth, heavily cached.
      const subPrefix = `/${E.config.subPrefix}/`;
      if (url.pathname.startsWith(subPrefix)) {
        const res = await Sub.subscription(request, E, url.pathname.slice(subPrefix.length));
        return withSecurity(res, false);
      }
      if (url.pathname.startsWith("/status/")) {
        return withSecurity(await Sub.statusPage(request, E, url.pathname.slice("/status/".length)), true);
      }

      // 3. API routes.
      if (url.pathname.startsWith("/api/")) {
        const hit = requireMatch(router.match(request.method, url.pathname), request.method, url.pathname);
        const session = await authenticate(request, E);
        const needsAuth = hit.route.auth !== "none";
        if (needsAuth && !session) return json({ ok: false, code: "unauthorized", error: "وارد شوید" }, 401);
        if (needsAuth && request.method !== "GET" && !csrfOk(request)) {
          return json({ ok: false, code: "csrf", error: "توکن CSRF نامعتبر است" }, 403);
        }
        const response = await hit.route.handler(request, E, { ...hit, session, ip, url, ctx });
        return withSecurity(response);
      }

      // 4. Everything else → static assets from Cloudflare's edge cache.
      //    Zero Worker CPU, zero D1 reads. The browser gets /panel/index.html
      //    from the nearest POP in ~20 ms instead of waiting on a cold isolate
      //    to build a 600 KB string.
      //    Tunnel-shaped paths are NOT assets: serving the SPA there would
      //    answer a broken client with HTTP 200 HTML (and let the edge cache
      //    it), which reads as "the proxy is down" in every client app.
      if (uuidFromRequest(request, url)) return new Response("Not Found", { status: 404 });
      // Headless builds (bot-deployed tenant nodes) ship without [assets]:
      // the UI lives on the control plane, so unknown paths are a plain 404.
      if (!E.assets) return new Response("Not Found", { status: 404 });
      const assetRes = await E.assets.fetch(new Request(url.origin + mapAssetPath(url.pathname), request));
      return withSecurity(assetRes, url.pathname === "/" || !url.pathname.includes("."));
    } catch (err) {
      if (err instanceof BootError) {
        return new Response(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">
        <body style="font-family:system-ui;padding:40px;line-height:1.9;background:#0b0f19;color:#e6edf7">
        <h2>⚒️ کاوه راه‌اندازی نشده</h2><p>${err.message}</p></body></html>`, {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return handleError(err, E, request);
    }
  },

  /**
   * Cron Triggers — see `[triggers] crons` in wrangler.toml (every 10 min).
   *
   * Scheduled work belongs here, not in `ctx.waitUntil` on a random user
   * request — Zeus's approach means a busy panel repeats it thousands of times a
   * day while an idle panel never runs it at all.
   *
   * The body is `runMaintenance()` in src/core/maintenance.js, which is also
   * callable from the panel via POST /api/diag/maintenance. One implementation,
   * two triggers, and it returns a summary instead of failing silently.
   */
  async scheduled(event, rawEnv, ctx) {
    const E = resolveEnv(rawEnv);
    E.ctx = ctx;
    try {
      await runMaintenance(E, { actor: `cron:${event?.cron ?? "?"}` });
    } catch (err) {
      // Without this the platform returns the opaque string "exception" and
      // nothing is logged anywhere: the panel would silently stop expiring
      // users and you would never know.
      E.log.error("scheduled.failed", {
        message: String(err?.message || err),
        stack: String(err?.stack || "").split("\n").slice(0, 3).join(" | "),
      });
      throw err;
    }
  },
};

// Durable Object classes must be exported from the Worker's main module.
export { Guard, Ledger };

/**
 * SPA routing: /panel and /login both serve the app shell.
 *
 * Ask the asset server for "/" rather than "/index.html" — with the default
 * html_handling = "auto-trailing-slash", a direct request for /index.html comes
 * back as a 307 redirect to /, costing a round trip for no reason.
 */
function mapAssetPath(pathname) {
  if (pathname === "/" || pathname === "/panel" || pathname === "/login") return "/";
  if (pathname === "/manifest.json") return "/manifest.webmanifest";
  return pathname;
}

function withSecurity(res, isHtml = false) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders(isHtml))) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * CSRF: SameSite=Strict cookies already block cross-site form posts, but a
 * malicious page could still trigger a fetch with credentials from a subdomain
 * or via a redirect chain. Requiring a custom header on every mutating request
 * closes that, because custom headers cannot be set cross-origin without a
 * preflight that our CORS policy denies.
 */
function csrfOk(request) {
  if (request.headers.has("x-kaveh-csrf")) return true;
  const type = request.headers.get("content-type") || "";
  return type.includes("application/json");
}
