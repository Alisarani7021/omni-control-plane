/**
 * TLS fragment / fingerprint presets.
 *
 * These are the values that actually matter for getting through DPI on Iranian
 * ISPs. They live in one table instead of being scattered through UI strings,
 * so they can be tuned without touching the frontend and shipped to every
 * client format identically.
 */
export const PRESETS = {
  none: { label: "بدون فرگمنت", size: "", interval: "", packets: "" },
  mci: { label: "همراه اول (MCI)", size: "100-200", interval: "1-1", packets: "tlshello" },
  irancell: { label: "ایرانسل", size: "1-3", interval: "1-1", packets: "tlshello" },
  rightel: { label: "رایتل", size: "100-200", interval: "5-10", packets: "tlshello" },
  tci: { label: "مخابرات (TCI)", size: "1-1", interval: "1-1", packets: "tlshello,sniext" },
  gaming: { label: "گیمینگ / پینگ پایین", size: "", interval: "", packets: "" },
  aggressive: { label: "حالت تهاجمی", size: "1-100", interval: "1-5", packets: "tlshello,sniext,clienthello" },
};

export const FINGERPRINTS = ["chrome", "safari", "ios", "android", "edge", "firefox", "randomized", ""];

/** TLS ports Cloudflare terminates on — everything else is plain WS. */
export const CF_TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
export const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];

export function preset(name) {
  const p = PRESETS[name] || PRESETS.none;
  if (!p.size) return null;
  return { size: p.size, interval: p.interval, packets: p.packets };
}

export function presetList() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, ...p }));
}

export function fingerprintList() {
  return FINGERPRINTS.filter(Boolean);
}

/**
 * Pick a Cloudflare port. TLS is preferred; port 443 is the least likely to be
 * throttled by an ISP because it is indistinguishable from normal HTTPS.
 */
export function pickPort(preferTls = true) {
  return preferTls ? 443 : 80;
}
