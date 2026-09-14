/**
 * A ~70 line router with real middleware, path params, and method matching.
 *
 * Zeus's router is a 1100-line `if/else` chain inside `handleApi` that compares
 * `url.pathname` by hand, re-parses the body per branch, and mixes auth checks
 * into business logic. This one is declarative: every route states its method,
 * its auth requirement, and its handler. Adding a feature = adding a line.
 *
 * Method matching is done in ONE pass with a fallback, which matters more than
 * it looks: `/api/users/bulk` and `/api/users/:username` both match the same
 * path shape. A naive router returns the first path match and then discovers
 * the method is wrong — so `POST /api/users/bulk` becomes a 405 against
 * `GET /api/users/:username` instead of hitting the bulk handler. This router
 * keeps scanning for a method match before giving up.
 */
import { notFound, methodNotAllowed } from "./errors.js";

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function compile(path) {
  const keys = [];
  const pattern = path.replace(PARAM_RE, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { re: new RegExp(`^${pattern}$`), keys };
}

export class Router {
  #routes = [];

  /**
   * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method
   * @param {string} path e.g. "/api/users/:username"
   * @param {object} opts  { auth?: "admin"|"none", handler: (ctx)=>Response }
   */
  add(method, path, opts) {
    this.#routes.push({ method, ...compile(path), path, ...opts });
    return this;
  }

  get(p, h, o = {}) { return this.add("GET", p, { ...o, handler: h }); }
  post(p, h, o = {}) { return this.add("POST", p, { ...o, handler: h }); }
  put(p, h, o = {}) { return this.add("PUT", p, { ...o, handler: h }); }
  patch(p, h, o = {}) { return this.add("PATCH", p, { ...o, handler: h }); }
  delete(p, h, o = {}) { return this.add("DELETE", p, { ...o, handler: h }); }

  /**
   * @returns {null | {methodMatch:false, allowed:string[]} | {route:any, params:object, methodMatch:true}}
   */
  match(method, pathname) {
    const allowed = [];
    for (const route of this.#routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      allowed.push(route.method);
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = safeDecode(m[i + 1])));
      return { route, params, methodMatch: true };
    }
    return allowed.length ? { methodMatch: false, allowed } : null;
  }

  list() {
    return this.#routes.map((r) => `${r.method.padEnd(6)} ${r.path}`);
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Turn a match result into a route or the correct HTTP error. */
export function requireMatch(hit, method, pathname) {
  if (!hit) throw notFound(pathname);
  if (!hit.methodMatch) throw methodNotAllowed(method, hit.allowed);
  return hit;
}
