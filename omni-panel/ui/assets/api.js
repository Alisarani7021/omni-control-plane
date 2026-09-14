/**
 * API client. One place for auth, CSRF, retries and error normalisation.
 *
 * Zeus's frontend has ~40 hand-written `fetch()` calls, each with its own
 * ad-hoc error handling — which is why some failures show a toast and others
 * silently leave a spinner spinning forever.
 */
const CSRF_HEADER = "x-kaveh-csrf";

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function call(method, path, body, { retry = 1, signal } = {}) {
  const init = {
    method,
    headers: { [CSRF_HEADER]: "1" },
    credentials: "same-origin",
    signal,
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let lastErr;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await fetch(path, init);
      if (res.status === 204) return null;
      const ct = res.headers.get("content-type") || "";
      const data = ct.includes("json") ? await res.json() : { raw: await res.text() };
      if (!res.ok || data.ok === false) {
        throw new ApiError(res.status, data.code || "error", data.error || res.statusText, data.detail);
      }
      return data;
    } catch (e) {
      lastErr = e;
      // Retry only on network blips / 5xx, never on 4xx.
      const retryable = e instanceof ApiError ? e.status >= 500 : !(e instanceof DOMException && e.name === "AbortError");
      if (!retryable || attempt === retry) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export const api = {
  get: (p, o) => call("GET", p, undefined, o),
  post: (p, b, o) => call("POST", p, b ?? {}, o),
  put: (p, b, o) => call("PUT", p, b ?? {}, o),
  patch: (p, b, o) => call("PATCH", p, b ?? {}, o),
  del: (p, o) => call("DELETE", p, undefined, o),

  // ── auth ────────────────────────────────────────────────────────────────
  whoami: () => call("GET", "/api/whoami", undefined, { retry: 0 }),
  login: (password, username) => call("POST", "/api/login", { password, username }, { retry: 0 }),
  setup: (password, username) => call("POST", "/api/setup", { password, username }, { retry: 0 }),
  logout: () => call("POST", "/api/logout", {}, { retry: 0 }),
  changePassword: (current, next) => call("POST", "/api/password", { current, next }, { retry: 0 }),

  // ── data ────────────────────────────────────────────────────────────────
  overview: (days = 7) => call("GET", `/api/overview?days=${days}`),
  users: (params = {}) => call("GET", `/api/users?${new URLSearchParams(params)}`),
  user: (u) => call("GET", `/api/users/${encodeURIComponent(u)}`),
  createUser: (body) => call("POST", "/api/users", body),
  updateUser: (u, body) => call("PATCH", `/api/users/${encodeURIComponent(u)}`, body),
  deleteUser: (u) => call("DELETE", `/api/users/${encodeURIComponent(u)}`),
  bulk: (usernames, op, value) => call("POST", "/api/users/bulk", { usernames, op, value }),
  resetUser: (u, body) => call("POST", `/api/users/${encodeURIComponent(u)}/reset`, body),
  rotateToken: (u) => call("POST", `/api/users/${encodeURIComponent(u)}/rotate-token`),
  rotateUuid: (u) => call("POST", `/api/users/${encodeURIComponent(u)}/rotate-uuid`),
  userUsage: (u, days = 14) => call("GET", `/api/stats/usage?username=${encodeURIComponent(u)}&days=${days}`),

  // ── settings & tools ────────────────────────────────────────────────────
  settings: () => call("GET", "/api/settings"),
  saveSettings: (body) => call("PUT", "/api/settings", body),
  fragments: () => call("GET", "/api/fragments"),
  probeNode: (proxy) => call("POST", "/api/diag/probe-node", { proxy }, { retry: 0 }),
  rankIps: (ips, host) => call("POST", "/api/diag/rank-ips", { ips, host }, { retry: 0 }),
  ping: (target) => call("GET", `/api/diag/ping?target=${encodeURIComponent(target)}`, { retry: 0 }),
  logs: (limit = 50) => call("GET", `/api/diag/logs?limit=${limit}`),
  // Same code path the Cron Trigger runs, so "is my auto-reset working?" is a click.
  maintenance: () => call("POST", "/api/diag/maintenance", {}, { retry: 0 }),
  sessions: () => call("GET", "/api/sessions"),
  revoke: (id) => call("POST", "/api/sessions/revoke", { id }),
  revokeAll: () => call("POST", "/api/sessions/revoke", { all: true }),
};

export function subUrl(token, type = "") {
  return `/s/${token}${type ? `?type=${type}` : ""}`;
}
export function statusUrl(token) {
  return `${location.origin}/status/${token}`;
}
export function downloadBackup() {
  const a = document.createElement("a");
  a.href = "/api/backup";
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}
