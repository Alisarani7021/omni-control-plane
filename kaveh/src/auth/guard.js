/**
 * Durable Object: distributed rate limiting + login brute-force guard.
 *
 * Zeus keeps `LOGIN_ATTEMPTS` in a module-level `Map`. That Map exists once per
 * isolate, and Cloudflare runs hundreds of isolates per Worker — so an attacker
 * simply rotates requests across POPs and each POP has its own fresh counter.
 * The protection is decorative. A Durable Object is a single global instance
 * per key, so the counter is real everywhere.
 */
export class Guard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1) || "hit";
    const key = url.searchParams.get("key") || "global";
    const limit = Number(url.searchParams.get("limit") || 100);
    const windowSec = Number(url.searchParams.get("window") || 60);

    switch (action) {
      case "hit":
        return Response.json(await this.hit(key, limit, windowSec));
      case "reset":
        await this.state.storage.delete(`rl:${key}`);
        return Response.json({ ok: true });
      case "unban":
        // `reset` clears the counter but NOT an active ban, so an operator who
        // tripped their own brute-force guard had no way back in except waiting
        // out the 15 minutes. This is the way back in.
        await this.state.storage.delete(`rl:${key}`);
        await this.state.storage.delete(`ban:${key}`);
        return Response.json({ ok: true, unbanned: key });
      case "ban":
        await this.state.storage.put(`ban:${key}`, Date.now() + Number(url.searchParams.get("ttl") || 900_000));
        return Response.json({ ok: true });
      case "banned":
        return Response.json({ banned: await this.isBanned(key) });
      default:
        return new Response("unknown action", { status: 404 });
    }
  }

  async isBanned(key) {
    const until = await this.state.storage.get(`ban:${key}`);
    if (!until) return false;
    if (until < Date.now()) {
      await this.state.storage.delete(`ban:${key}`);
      return false;
    }
    return true;
  }

  /** Sliding-window counter. Returns { allowed, remaining, resetIn, banned }. */
  async hit(key, limit, windowSec) {
    const now = Date.now();
    if (await this.isBanned(key)) {
      return { allowed: false, remaining: 0, resetIn: 0, banned: true };
    }
    const bucket = `rl:${key}`;
    const win = (await this.state.storage.get(bucket)) || { count: 0, start: now };
    if (now - win.start > windowSec * 1000) {
      win.count = 0;
      win.start = now;
    }
    win.count += 1;
    await this.state.storage.put(bucket, win);
    const remaining = Math.max(0, limit - win.count);
    const resetIn = Math.ceil((win.start + windowSec * 1000 - now) / 1000);
    const allowed = win.count <= limit;
    if (!allowed) {
      // Three consecutive windows of abuse → 15 minute ban on this key.
      const strikes = ((await this.state.storage.get(`strike:${key}`)) || 0) + 1;
      await this.state.storage.put(`strike:${key}`, strikes);
      if (strikes >= 3) {
        await this.state.storage.put(`ban:${key}`, now + 15 * 60 * 1000);
        await this.state.storage.delete(`strike:${key}`);
        return { allowed: false, remaining: 0, resetIn: 900, banned: true };
      }
    } else {
      await this.state.storage.delete(`strike:${key}`);
    }
    return { allowed, remaining, resetIn, banned: false };
  }
}

/**
 * Durable Object: the traffic ledger.
 *
 * Every byte of every tunnel is reported here. The DO keeps exact per-user
 * totals in SQLite-backed storage and flushes to D1 in batches, so:
 *   - nothing is lost when an isolate dies
 *   - D1 write volume is bounded (~1 write per user per 60 s, not per byte)
 *   - concurrent-device limits are enforced globally, not per POP
 */
const FLUSH_INTERVAL_MS = 30_000;

export class Ledger {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.dirty = new Map(); // username -> {up, down, conns}
    this.devices = new Map(); // username -> Map<deviceHash, lastSeen>
    this.flushTimer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);
    const p = url.searchParams;

    switch (action) {
      case "report": {
        const u = p.get("u");
        const up = Number(p.get("up") || 0);
        const down = Number(p.get("down") || 0);
        const d = p.get("d");
        const cur = this.dirty.get(u) || { up: 0, down: 0, conns: 0 };
        cur.up += up;
        cur.down += down;
        cur.conns += 1;
        this.dirty.set(u, cur);
        if (d) this.touchDevice(u, d);
        this.scheduleFlush();
        return Response.json({ ok: true, devices: this.devices.get(u)?.size || 0 });
      }
      case "admit": {
        // Device-limit enforcement happens BEFORE the tunnel opens.
        const u = p.get("u");
        const d = p.get("d");
        const limit = Number(p.get("limit") || 0);
        if (!limit) return Response.json({ ok: true, devices: 0 });
        this.touchDevice(u, d);
        const count = this.devices.get(u)?.size || 0;
        return Response.json({ ok: count <= limit, devices: count, limit });
      }
      case "devices":
        return Response.json({ devices: [...(this.devices.get(p.get("u"))?.keys() || [])] });
      case "peek":
        return Response.json({ dirty: Object.fromEntries(this.dirty) });
      case "flush":
        await this.flush();
        return Response.json({ ok: true });
      default:
        return new Response("unknown action", { status: 404 });
    }
  }

  touchDevice(user, hash) {
    const now = Date.now();
    if (!this.devices.has(user)) this.devices.set(user, new Map());
    const m = this.devices.get(user);
    m.set(hash, now);
    // A device that hasn't reported in 5 minutes is gone.
    for (const [k, v] of m) if (now - v > 5 * 60 * 1000) m.delete(k);
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    // Alarms survive isolate eviction — unlike setTimeout, which does not.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
    }, FLUSH_INTERVAL_MS);
    this.ctx?.waitUntil?.(this.flush());
    this.state.waitUntil?.(this.flush());
  }

  async alarm() {
    await this.flush();
  }

  async flush() {
    if (!this.dirty.size) return;
    const entries = [...this.dirty.entries()];
    this.dirty.clear();
    const db = this.env?.DB;
    if (!db) return;
    const day = new Date().toISOString().slice(0, 10);
    const statements = [];
    for (const [user, v] of entries) {
      statements.push(
        db.prepare("UPDATE users SET used_bytes = used_bytes + ?, requests_used = requests_used + 1 WHERE username = ?").bind(v.up + v.down, user),
        db
          .prepare(
            `INSERT INTO usage_daily (day, username, up_bytes, down_bytes, conns)
             VALUES (?,?,?,?,?)
             ON CONFLICT(day, username) DO UPDATE SET
               up_bytes = up_bytes + excluded.up_bytes,
               down_bytes = down_bytes + excluded.down_bytes,
               conns = conns + excluded.conns`,
          )
          .bind(day, user, v.up, v.down, v.conns),
      );
    }
    for (let i = 0; i < statements.length; i += 100) {
      try {
        await db.batch(statements.slice(i, i + 100));
      } catch (e) {
        // Put the numbers back rather than dropping them on the floor.
        for (const [user, v] of entries) {
          const cur = this.dirty.get(user) || { up: 0, down: 0, conns: 0 };
          cur.up += v.up;
          cur.down += v.down;
          cur.conns += v.conns;
          this.dirty.set(user, cur);
        }
        console.error("ledger flush failed, re-queued", String(e?.message || e));
        await this.state.storage.setAlarm(Date.now() + 15_000);
        break;
      }
    }
    await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
  }
}
