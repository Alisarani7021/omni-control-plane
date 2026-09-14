/**
 * DNS-over-HTTPS resolver with an LRU cache.
 *
 * Used for domain addresses in the VLESS header (the client says "connect to
 * api.openai.com:443" and we need an IP). Cloudflare's `connect()` accepts a
 * hostname directly, but we resolve explicitly when we want to (a) apply the
 * per-user block list, (b) pick between a clean IP and the real one, and
 * (c) log what was actually reached.
 */
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 2048;

export class DnsCache {
  #m = new Map();
  get(key) {
    const hit = this.#m.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) {
      this.#m.delete(key);
      return null;
    }
    // Refresh recency for LRU eviction.
    this.#m.delete(key);
    this.#m.set(key, hit);
    return hit.value;
  }
  set(key, value, ttl = TTL_MS) {
    if (this.#m.size >= MAX_ENTRIES) this.#m.delete(this.#m.keys().next().value);
    this.#m.set(key, { value, exp: Date.now() + ttl });
  }
}

export const dns = new DnsCache();

export async function resolve(domain, { type = "A", resolver = "https://cloudflare-dns.com/dns-query", timeoutMs = 4000 } = {}) {
  const key = `${type}:${domain}`;
  const cached = dns.get(key);
  if (cached) return cached;
  const url = `${resolver}?name=${encodeURIComponent(domain)}&type=${type}`;
  // Hard timeout. This runs inside a live tunnel: an unbounded fetch here means
  // a WebSocket that hangs open forever, never reports its bytes, and burns an
  // isolate slot.
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`DoH ${res.status} for ${domain}`);
  const body = await res.json();
  const answers = (body.Answer || []).filter((a) => (type === "A" ? a.type === 1 : a.type === 28)).map((a) => a.data);
  const ttl = Math.min(TTL_MS, Math.max(30_000, (body.Answer?.[0]?.TTL || 300) * 1000));
  if (answers.length) dns.set(key, answers, ttl);
  return answers;
}

export async function resolveOne(domain, opts) {
  const list = await resolve(domain, opts);
  if (!list.length) throw new Error(`no address for ${domain}`);
  return list[Math.floor(Math.random() * list.length)];
}

export const isIpv4 = (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(v));
export const isIpv6 = (v) => String(v).includes(":");
