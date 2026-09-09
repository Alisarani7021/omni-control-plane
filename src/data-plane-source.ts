// This module is bundled with the control plane. It is never fetched from an unpinned remote source.
export const DATA_PLANE_SOURCE = String.raw`
const encoder = new TextEncoder();

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return b64url(new Uint8Array(digest));
}

async function equalHash(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function headers(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405, headers: headers("application/json; charset=utf-8") });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "v13-data-plane" }, { headers: headers("application/json; charset=utf-8") });
    }
    const match = /^\\/sub\\/([A-Za-z0-9_-]{43,128})$/u.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    const candidateHash = await sha256(match[1]);
    if (!(await equalHash(candidateHash, env.SUB_TOKEN_HASH))) {
      return new Response("Not found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    }
    let bundle;
    try {
      bundle = JSON.parse(env.CONFIG_BUNDLE);
    } catch {
      return new Response("Configuration unavailable", { status: 503, headers: headers("text/plain; charset=utf-8") });
    }
    if (bundle.status !== "ready") {
      return new Response("Provisioning is still in progress", { status: 503, headers: headers("text/plain; charset=utf-8") });
    }
    const format = url.searchParams.get("format") || "uri";
    if (format === "uri") {
      return new Response(bundle.uris.join("\\n") + "\\n", { headers: headers("text/plain; charset=utf-8") });
    }
    if (format === "sing-box") {
      const profile = url.searchParams.get("profile") || "vless";
      if (profile !== "vless" && profile !== "hysteria2") {
        return Response.json({ error: "invalid_profile" }, { status: 400, headers: headers("application/json; charset=utf-8") });
      }
      return new Response(JSON.stringify(bundle.profiles[profile], null, 2) + "\\n", { headers: headers("application/json; charset=utf-8") });
    }
    return Response.json({ error: "invalid_format" }, { status: 400, headers: headers("application/json; charset=utf-8") });
  }
};
`;
