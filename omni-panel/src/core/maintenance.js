/**
 * Maintenance pass — expiry enforcement, clean-IP rotation, pruning.
 *
 * Lives in its own module for one practical reason: it has TWO callers.
 *   1. `scheduled()` via the Cron Trigger (every 10 minutes)
 *   2. `POST /api/diag/maintenance` from the panel's diagnostics tab
 *
 * The second caller matters more than it sounds. Zeus runs this logic inside
 * `ctx.waitUntil()` on every user request, so it is impossible to trigger on
 * demand and impossible to observe: if the auto-reset silently stops working
 * you only find out when customers complain. Here the exact same code path is
 * one button, and it returns a JSON summary of what it did.
 */
import { Settings, audit } from "../db/index.js";
import { doStub } from "./env.js";
import { rankPool } from "../config/cleanip.js";
import { purgeExpiredSessions } from "../auth/session.js";
import { ensureSchema } from "../db/migrate.js";

/** @returns {Promise<object>} machine-readable summary */
export async function runMaintenance(E, { actor = "cron" } = {}) {
  const started = Date.now();
  await ensureSchema(E);
  const S = new Settings(E);
  await S.all();
  const summary = { expired_handled: 0, policy: null, ips_rotated: 0, sessions_purged: 0, ms: 0 };

  // 1. Expired subscriptions.
  const onExpiry = await S.get("on_expiry", "disable"); // disable | renew | delete
  summary.policy = onExpiry;
  const due = await E.db
    .prepare("SELECT username, quota_gb, expiry_days FROM users WHERE is_active=1 AND expires_at IS NOT NULL AND expires_at < ?")
    .bind(Date.now())
    .all();
  const statements = [];
  for (const u of due.results || []) {
    if (onExpiry === "renew") {
      statements.push(
        E.db.prepare("UPDATE users SET expires_at = ?, used_bytes = 0 WHERE username = ?").bind(Date.now() + u.expiry_days * 86400000, u.username),
      );
    } else if (onExpiry === "delete") {
      statements.push(E.db.prepare("DELETE FROM users WHERE username = ?").bind(u.username));
    } else {
      statements.push(E.db.prepare("UPDATE users SET is_active = 0 WHERE username = ?").bind(u.username));
    }
  }
  if (statements.length) {
    for (let i = 0; i < statements.length; i += 100) await E.db.batch(statements.slice(i, i + 100));
    summary.expired_handled = statements.length;
    await audit(E, { actor, action: "maintenance.expiry", detail: { n: statements.length, policy: onExpiry } });
  }

  // 2. Clean-IP rotation — verified before publication, so a dead IP can never
  //    be pushed into 200 live subscriptions.
  if ((await S.get("auto_rotate")) === "1") {
    try {
      const pool = await S.getJson("ip_pool", []);
      const host = await S.get("public_host");
      if (pool?.length && host) {
        const ranked = await rankPool(pool, { sni: host });
        if (ranked.length) {
          await S.set({ clean_ips: ranked.slice(0, 8), last_rotate: String(Date.now()) });
          summary.ips_rotated = ranked.length;
        }
      }
    } catch (e) {
      // A rotation failure must not abort the rest of the pass.
      E.log.warn("ip_rotation_failed", { e: String(e?.message || e) });
    }
  }

  // 3. Housekeeping.
  await purgeExpiredSessions(E);
  await E.db.prepare("DELETE FROM usage_daily WHERE day < date('now','-90 day')").run().catch((e) =>
    E.log.warn("prune_usage_failed", { e: String(e?.message || e) }),
  );
  await E.db.prepare("DELETE FROM audit_log WHERE at < ?").bind(Date.now() - 90 * 86400000).run().catch((e) =>
    E.log.warn("prune_audit_failed", { e: String(e?.message || e) }),
  );

  // 4. Force the traffic ledger to flush so the dashboard is never showing
  //    numbers that are minutes stale.
  await doStub(E.ledger, "ledger")?.fetch("https://ledger/flush").catch(() => {});

  summary.ms = Date.now() - started;
  E.log.info("maintenance.done", summary);
  return summary;
}
