import { json } from "./http.js";

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (msg, detail) => new HttpError(400, "bad_request", msg, detail);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "forbidden") => new HttpError(403, "forbidden", msg);
export const notFound = (what = "resource") => new HttpError(404, "not_found", `${what} not found`);
export const methodNotAllowed = (method, allowed = []) => {
  const e = new HttpError(405, "method_not_allowed", `${method} is not allowed here`);
  e.allow = allowed.join(", ");
  return e;
};
export const conflict = (msg) => new HttpError(409, "conflict", msg);
export const tooMany = (retryAfter = 60) => {
  const e = new HttpError(429, "rate_limited", "too many requests");
  e.retryAfter = retryAfter;
  return e;
};

/**
 * One error boundary for the whole app. Zeus returns the bare string
 * "Internal Server Error" and swallows the actual cause with `catch (e) {}`,
 * which makes production debugging effectively impossible.
 */
export function handleError(err, E, request) {
  if (err instanceof HttpError) {
    const headers = {};
    if (err.retryAfter) headers["Retry-After"] = String(err.retryAfter);
    if (err.allow) headers["Allow"] = err.allow;
    return json({ ok: false, code: err.code, error: err.message, detail: err.detail }, err.status, headers);
  }
  // Anything that carries an explicit HTTP status (thrown from a helper that
  // didn't use HttpError) still gets that status — a 405 must never surface as
  // a 500, or every client-side retry loop goes off.
  if (typeof err?.status === "number" && err.status >= 400 && err.status < 600) {
    return json({ ok: false, code: err.code || "error", error: err.message }, err.status, err.allow ? { Allow: err.allow } : {});
  }
  const id = crypto.randomUUID().slice(0, 8);
  E.log?.error("unhandled", {
    id,
    path: new URL(request.url).pathname,
    message: err?.message,
    stack: String(err?.stack || "").split("\n").slice(0, 4).join(" | "),
  });
  // The correlation id goes back to the user AND into the log, so a support
  // ticket can be traced to an exact stack.
  const body = { ok: false, code: "internal_error", error: "خطای داخلی سرور", ref: id };
  // Opt-in detail. Never on by default: an exception message can contain a
  // binding name, a query, or a hostname. It exists because "500 + ref" is
  // useless when you cannot read Workers Logs (no Observability permission).
  if (E?.config?.debugErrors) {
    body.debug = {
      name: err?.name,
      message: String(err?.message || err).slice(0, 400),
      stack: String(err?.stack || "").split("\n").slice(0, 6).join(" | ").slice(0, 600),
    };
  }
  return json(body, 500);
}
