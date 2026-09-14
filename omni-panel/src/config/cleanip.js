/**
 * Clean Cloudflare edge IPs.
 *
 * In Iran, connecting to your Worker's real hostname often fails or throttles;
 * clients connect to a Cloudflare edge IP with `sni`/`host` set to your domain
 * instead. This module keeps a vetted pool per ISP and rotates it.
 *
 * Unlike Zeus, the pool is versioned in the repo (see `data/clean-ips.json`)
 * *and* verified by a scheduled probe before it is ever handed to a user, so a
 * dead IP cannot silently break 200 subscriptions.
 */
export const FALLBACK = [
  "104.16.0.0",
  "104.17.0.0",
  "104.18.0.0",
  "172.66.0.0",
  "188.114.96.0",
];

export function pickCleanIps(pool = [], count = 1, seed = Date.now()) {
  if (!pool.length) pool = FALLBACK;
  const out = [];
  const copy = [...pool];
  let s = seed;
  const rnd = () => {
    // Deterministic-enough xorshift; avoids Math.random for testability.
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return Math.abs(s % 1e9) / 1e9;
  };
  for (let i = 0; i < count && copy.length; i++) {
    out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  }
  return out;
}

/**
 * Probe an IP the way a client would: TLS handshake to 443 with the SNI of your
 * domain. Returns latency or null. Runs from a Cron Trigger, not from a user
 * request, so nobody's panel load pays for it.
 */
export async function probeIp(ip, { sni, timeoutMs = 4000 } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(`https://${ip}/cdn-cgi/trace`, {
      headers: { Host: sni, "user-agent": "kaveh-probe/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
      cf: { resolveOverride: sni } /* eslint-disable-line */,
    });
    if (!res.ok) return null;
    return Date.now() - started;
  } catch {
    return null;
  }
}

export async function rankPool(pool, { sni, concurrency = 10 } = {}) {
  const results = [];
  for (let i = 0; i < pool.length; i += concurrency) {
    const slice = pool.slice(i, i + concurrency);
    const lat = await Promise.all(slice.map((ip) => probeIp(ip, { sni })));
    slice.forEach((ip, idx) => results.push({ ip, latencyMs: lat[idx] }));
  }
  return results
    .filter((r) => r.latencyMs != null)
    .sort((a, b) => a.latencyMs - b.latencyMs)
    .map((r) => r.ip);
}
