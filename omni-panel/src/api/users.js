import { readJson, ok, json } from "../core/http.js";
import { badRequest, notFound } from "../core/errors.js";
import * as Users from "../db/users.js";
import { Settings, audit } from "../db/index.js";
import { vlessUri, singBoxConfig, clashYaml, base64Subscription, trojanUri } from "../config/generator.js";
import { preset } from "../config/fragment.js";

/** Resolve the public host of this Worker (the SNI clients must send). */
export async function panelHost(request, E) {
  const S = new Settings(E);
  return (await S.get("public_host")) || new URL(request.url).hostname;
}

/** Build the client configs for one user, for every supported format. */
export async function buildConfigs(E, user, request) {
  const S = new Settings(E);
  const host = await panelHost(request, E);
  const ips = user.ips?.length ? user.ips : JSON.parse((await S.get("clean_ips")) || "[]");
  const port = Number((await S.get("port")) || 443);
  const fp = user.fingerprint || (await S.get("fingerprint")) || "";
  const frag = preset(user.fragment || (await S.get("fragment_preset")) || E.config.fragmentPreset);
  const remarkBase = (await S.get("remark_prefix")) || host;

  const items = (ips.length ? ips : [host]).slice(0, 8).map((ip, i) => ({
    uuid: user.uuid,
    host,
    address: ip,
    port,
    path: `/${user.uuid}`,
    fingerprint: fp,
    remark: ips.length > 1 ? `${remarkBase}#${i + 1}` : remarkBase,
  }));

  const opts = { fragment: frag, fingerprint: fp, mux: (await S.get("mux_enabled")) === "1" ? 8 : 0 };
  const uris = items.map((it) => vlessUri({ ...it, opts }));

  return {
    host,
    port,
    items,
    uris,
    vless: uris,
    singbox: singBoxConfig(items.map((it) => ({ ...it, fingerprint: fp }))),
    clash: clashYaml(items.map((it) => ({ ...it, fingerprint: fp }))),
    base64: base64Subscription(uris),
    qr: uris[0] || "",
  };
}

export async function list(request, E, ctx) {
  // Third argument is the router context ({params, session, ip, url, ctx}),
  // NOT the URL — reading `.searchParams` off it throws at runtime.
  const p = ctx.url.searchParams;
  const page = Math.max(1, Number(p.get("page") || 1));
  const size = Math.min(200, Math.max(1, Number(p.get("size") || 50)));
  const { users, total } = await Users.listUsers(E, {
    q: p.get("q") || "",
    status: p.get("status") || "all",
    sort: p.get("sort") || "created_at",
    dir: p.get("dir") || "desc",
    page,
    size,
  });
  return ok({ users, total, page, size, pages: Math.ceil(total / size) });
}

export async function getOne(request, E, ctx) {
  const user = await Users.getUser(E, ctx.params.username);
  return ok({ user, configs: await buildConfigs(E, user, request) });
}

export async function create(request, E, ctx) {
  const body = await readJson(request);
  const input = Users.newUserInput({ ...body, created_by: ctx.session?.subject }, E);
  const user = await Users.createUser(E, input);
  await audit(E, { actor: ctx.session?.subject, action: "user.create", target: user.username, ip: ctx.ip });
  return ok({ user, configs: await buildConfigs(E, user, request) });
}

export async function update(request, E, ctx) {
  const body = await readJson(request);
  const user = await Users.updateUser(E, ctx.params.username, body);
  await audit(E, { actor: ctx.session?.subject, action: "user.update", target: user.username, ip: ctx.ip, detail: { keys: Object.keys(body) } });
  return ok({ user, configs: await buildConfigs(E, user, request) });
}

export async function remove(request, E, ctx) {
  await Users.deleteUser(E, ctx.params.username);
  await audit(E, { actor: ctx.session?.subject, action: "user.delete", target: ctx.params.username, ip: ctx.ip });
  return ok();
}

export async function bulkOp(request, E, ctx) {
  const body = await readJson(request);
  const res = await Users.bulk(E, body.usernames, body.op, body.value);
  await audit(E, { actor: ctx.session?.subject, action: `user.bulk.${body.op}`, ip: ctx.ip, detail: { n: res.affected } });
  return ok(res);
}

export async function rotateToken(request, E, ctx) {
  const token = await Users.rotateSubToken(E, ctx.params.username);
  await audit(E, { actor: ctx.session?.subject, action: "user.rotate_sub", target: ctx.params.username, ip: ctx.ip });
  return ok({ sub_token: token });
}

export async function rotateUuid(request, E, ctx) {
  const uuid = await Users.rotateUuid(E, ctx.params.username);
  await audit(E, { actor: ctx.session?.subject, action: "user.rotate_uuid", target: ctx.params.username, ip: ctx.ip });
  return ok({ uuid });
}

/** Reset a single user's counters (traffic / requests / expiry). */
export async function reset(request, E, ctx) {
  const body = await readJson(request);
  const sets = ["updated_at = ?"];
  const bind = [Date.now()];
  if (body.traffic !== false) { sets.push("used_bytes = 0"); }
  if (body.requests) { sets.push("requests_used = 0"); }
  if (body.days) { sets.push("expires_at = ?"); bind.push(Date.now() + Number(body.days) * 86400000); }
  await E.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username = ?`).bind(...bind, ctx.params.username).run();
  await audit(E, { actor: ctx.session?.subject, action: "user.reset", target: ctx.params.username, ip: ctx.ip });
  return ok({ user: await Users.getUser(E, ctx.params.username) });
}
