/**
 * Views. Each one is a pure function: (state) → HTML string.
 *
 * Because they are pure, the same view renders identically in the browser and
 * in a snapshot test (see test/views.test.js), and swapping the whole frontend
 * for a framework later means porting ~15 functions instead of untangling
 * 3,000 lines of inline DOM manipulation.
 */
import { icon, meter, statusBadge, copyButton, qrSvg, esc, skeletonRows, kpi } from "./components.js";
import { t, bytes, num, timeLeft, timeAgo, dateFmt, I18N } from "./i18n.js";
import { barChart, stackedChart, donut } from "./charts.js";
import { subUrl, statusUrl } from "./api.js";

/* ══ auth screens ═════════════════════════════════════════════════════════ */
export function loginView({ mode = "login", error = "" } = {}) {
  const isSetup = mode === "setup";
  const isRecover = mode === "recover";
  return `<div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo">
      <img src="/icon.svg" alt="" width="52" height="52">
      <h1>${esc(t("app.name"))}</h1>
      <p class="muted" style="margin:0;font-size:12px">${esc(t(isSetup ? "login.setupTitle" : isRecover ? "login.recover" : "login.title"))}</p>
    </div>
    ${error ? `<div class="toast err" style="margin-bottom:12px">${icon("alert")} ${esc(error)}</div>` : ""}
    <form id="auth-form" data-mode="${mode}" novalidate>
      ${isSetup ? `<div class="field" style="margin-bottom:11px">
          <label for="f-user">${esc(t("login.username"))}</label>
          <input id="f-user" name="username" type="text" value="admin" autocomplete="username" dir="ltr">
        </div>` : ""}
      ${isRecover ? `<div class="field" style="margin-bottom:11px">
          <label for="f-code">کد بازیابی</label>
          <input id="f-code" name="code" type="text" autocomplete="one-time-code" dir="ltr" required>
        </div>` : ""}
      <div class="field" style="margin-bottom:11px">
        <label for="f-pass">${esc(t(isRecover ? "login.newPassword" : "login.password"))}</label>
        <input id="f-pass" name="password" type="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required minlength="10" dir="ltr">
      </div>
      <button class="btn btn-primary btn-block" type="submit" style="margin-top:6px">
        ${icon(isSetup ? "bolt" : "key")} ${esc(t(isSetup ? "login.setup" : isRecover ? "login.recover" : "login.submit"))}
      </button>
      <p class="hint muted" style="font-size:11px;margin-top:12px;text-align:center">${esc(t(isSetup ? "login.setupHint" : "login.hint"))}</p>
      ${!isSetup && !isRecover ? `<p style="text-align:center;margin:10px 0 0"><button type="button" class="btn btn-ghost btn-sm" data-action="goto-recover">${esc(t("login.recover"))}</button></p>` : ""}
      ${isRecover ? `<p style="text-align:center;margin:10px 0 0"><button type="button" class="btn btn-ghost btn-sm" data-action="goto-login">→ ${esc(t("login.submit"))}</button></p>` : ""}
    </form>
  </div></div>`;
}

/* ══ dashboard ════════════════════════════════════════════════════════════ */
export function dashboardView(data) {
  if (!data) {
    return `<div class="grid grid-kpi">${Array.from({ length: 4 }, () => `<div class="skeleton" style="height:96px"></div>`).join("")}</div>
      <div class="grid grid-2" style="margin-top:14px">${Array.from({ length: 2 }, () => `<div class="skeleton" style="height:240px"></div>`).join("")}</div>`;
  }
  const u = data.users || {};
  const cf = data.cloudflare || {};
  const alerts = buildAlerts(data);
  const cfPct = cf.pct ?? 0;

  return `
  <div class="grid grid-kpi">
    ${kpi({ icon: "users", label: t("dash.users"), value: num(u.total || 0), sub: `${num(u.active || 0)} ${esc(t("dash.active"))}` })}
    ${kpi({ icon: "db", label: t("dash.traffic"), value: bytes(u.used_bytes || 0), sub: `${num(u.requests || 0)} req`, tone: "var(--accent-2)" })}
    ${kpi({ icon: "alert", label: t("dash.expired"), value: num(u.expired || 0), sub: alerts.expiring ? `${num(alerts.expiring)} ${esc(t("dash.expiringSoon"))}` : "", tone: (u.expired || 0) ? "var(--danger)" : "" })}
    ${kpi({
      icon: "bolt", label: t("dash.cf"),
      value: cf.available ? `${cfPct}%` : "—",
      sub: cf.available ? `${num(cf.daily || 0)} / ${num(cf.limit)}` : esc(t("dash.noCf")),
      tone: cfPct > 85 ? "var(--danger)" : cfPct > 60 ? "var(--warn)" : "var(--ok)",
    })}
  </div>

  <div class="grid grid-2" style="margin-top:14px">
    <div class="card">
      <div class="card-head">${icon("activity")}<h3>${esc(t("dash.traffic7"))}</h3><div class="spacer"></div>
        <div class="legend"><span><i style="background:var(--accent)"></i>↓ down</span><span><i style="background:var(--accent-2)"></i>↑ up</span></div>
      </div>
      ${stackedChart(data.series || [])}
    </div>

    <div class="card">
      <div class="card-head">${icon("shield")}<h3>${esc(t("dash.alerts"))}</h3></div>
      ${alerts.list.length
        ? `<div style="display:flex;flex-direction:column;gap:9px">${alerts.list
            .map((a) => `<div style="display:flex;gap:10px;align-items:flex-start;padding:10px;border-radius:10px;background:color-mix(in srgb, ${a.color} 9%, transparent);border:1px solid color-mix(in srgb, ${a.color} 26%, transparent)">
              <span style="color:${a.color};flex:none;margin-top:2px">${icon(a.level === "danger" ? "alert" : "clock")}</span>
              <div><div style="font-weight:600;font-size:13px">${esc(a.title)}</div>
              ${a.detail ? `<div class="muted" style="font-size:12px">${esc(a.detail)}</div>` : ""}</div></div>`).join("")}</div>`
        : `<div class="empty" style="padding:26px">${icon("check")}<div>${esc(t("dash.noAlerts"))}</div></div>`}
      ${cf.available ? `<div style="margin-top:14px;display:flex;align-items:center;gap:14px">
          ${donut(cfPct, { size: 68 })}
          <div style="flex:1;min-width:0">
            <div class="kpi-label">${esc(t("dash.reqToday"))}</div>
            <div style="font-weight:700;font-size:19px;font-variant-numeric:tabular-nums">${num(cf.daily || 0)}</div>
            ${meter(cfPct)}
            <div class="kpi-sub">limit ${num(cf.limit)}</div>
          </div></div>` : ""}
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-head">${icon("users")}<h3>${esc(t("dash.topUsers"))}</h3><div class="spacer"></div>
      <button class="btn btn-sm" data-action="nav" data-view="users">${esc(t("nav.users"))} ${icon("chevron")}</button></div>
    ${data.top?.length
      ? `<div style="display:flex;flex-direction:column;gap:10px">${data.top.map((x) => {
          const pct = x.quota_gb ? Math.min(100, (x.used_bytes / (x.quota_gb * 1024 ** 3)) * 100) : 0;
          return `<div>
            <div style="display:flex;gap:10px;align-items:baseline;margin-bottom:4px">
              <a href="#" data-action="open-user" data-user="${esc(x.username)}" class="cell-user">${esc(x.username)}</a>
              <span class="muted" style="font-size:12px">${bytes(x.used_bytes)} / ${num(x.quota_gb)} ${esc(t("common.gb"))}</span>
              <div class="spacer"></div><span class="muted mono" style="font-size:11px">${pct.toFixed(0)}%</span>
            </div>${meter(pct)}
          </div>`;
        }).join("")}</div>`
      : `<div class="empty">${icon("users")}<div>${esc(t("users.empty"))}</div></div>`}
  </div>`;
}

function buildAlerts(data) {
  const list = [];
  const cf = data.cloudflare || {};
  let expiring = 0;
  if (cf.available && cf.pct > 85) {
    list.push({ level: "danger", color: "var(--danger)", title: t("dash.cfDanger"), detail: `${cf.pct}% — ${num(cf.daily || 0)} / ${num(cf.limit)}` });
  }
  return { list, expiring };
}

/* ══ users ════════════════════════════════════════════════════════════════ */
export function usersView(s) {
  const rows = s.loading
    ? skeletonRows(8)
    : (s.users || []).map((u) => userRow(u, s.selection.has(u.username))).join("");

  return `
  <div class="toolbar">
    <div class="search" style="flex:1;min-width:190px">${icon("search")}
      <input type="search" id="user-search" placeholder="${esc(t("users.search"))}" value="${esc(s.query)}" data-debounce="300">
    </div>
    <div class="seg" role="group" aria-label="filter">
      ${["all", "active", "disabled", "expired"].map((k) =>
        `<button data-action="filter" data-status="${k}" aria-pressed="${s.status === k}">${esc(t(`users.${k === "all" ? "all" : k === "active" ? "activeOnly" : k === "disabled" ? "disabledOnly" : "expiredOnly"}`))}</button>`,
      ).join("")}
    </div>
    <button class="btn btn-ghost btn-icon" data-action="refresh-users" title="${esc(t("common.refresh"))}">${icon("refresh")}</button>
    <button class="btn btn-primary" data-action="new-user">${icon("plus")} ${esc(t("users.create"))}</button>
  </div>

  ${s.selection.size
    ? `<div class="bulkbar">
        <strong>${num(s.selection.size)}</strong> <span class="muted">${esc(t("users.selected"))}</span>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-action="bulk" data-op="enable">${icon("check")} ${esc(t("users.bulkEnable"))}</button>
        <button class="btn btn-sm" data-action="bulk" data-op="disable">${esc(t("users.bulkDisable"))}</button>
        <button class="btn btn-sm" data-action="bulk" data-op="reset_traffic">${icon("refresh")} ${esc(t("users.bulkReset"))}</button>
        <button class="btn btn-sm" data-action="bulk-extend">${icon("clock")} ${esc(t("users.bulkExtend"))}</button>
        <button class="btn btn-sm btn-danger" data-action="bulk" data-op="delete">${icon("trash")} ${esc(t("users.bulkDelete"))}</button>
        <button class="btn btn-ghost btn-sm" data-action="clear-selection">${icon("close")}</button>
      </div>`
    : ""}

  <div class="table-wrap">
    <table class="users-table">
      <thead><tr>
        <th style="width:34px"><input type="checkbox" data-action="select-all" ${s.users?.length && s.selection.size === s.users.length ? "checked" : ""} aria-label="select all"></th>
        <th class="sortable" data-action="sort" data-key="username">${esc(t("users.col.user"))}${sortMark(s, "username")}</th>
        <th>${esc(t("users.col.status"))}</th>
        <th class="sortable" data-action="sort" data-key="used_bytes" style="min-width:170px">${esc(t("users.col.traffic"))}${sortMark(s, "used_bytes")}</th>
        <th class="sortable" data-action="sort" data-key="expires_at">${esc(t("users.col.expiry"))}${sortMark(s, "expires_at")}</th>
        <th>${esc(t("users.col.devices"))}</th>
        <th style="text-align:end">${esc(t("users.col.actions"))}</th>
      </tr></thead>
      <tbody>${rows || emptyRow()}</tbody>
    </table>
    ${s.total > s.size ? pager(s) : ""}
  </div>`;
}

function sortMark(s, key) {
  if (s.sort !== key) return "";
  return ` <span style="opacity:.6">${s.dir === "asc" ? "▲" : "▼"}</span>`;
}

function emptyRow() {
  return `<tr><td colspan="7"><div class="empty">${icon("users")}
    <div style="font-weight:600;color:var(--text-dim)">${esc(t("users.empty"))}</div>
    <div style="font-size:12px">${esc(t("users.emptyHint"))}</div></div></td></tr>`;
}

function userRow(u, selected) {
  const pct = u.used_pct || 0;
  return `<tr class="${selected ? "selected" : ""}" data-username="${esc(u.username)}">
    <td><input type="checkbox" data-action="select-user" data-user="${esc(u.username)}" ${selected ? "checked" : ""} aria-label="${esc(u.username)}"></td>
    <td><a href="#" data-action="open-user" data-user="${esc(u.username)}" class="cell-user">${esc(u.username)}</a>
      ${u.note ? `<div class="muted" style="font-size:11px">${esc(u.note)}</div>` : ""}</td>
    <td>${statusBadge(u.status)}</td>
    <td><div style="display:flex;gap:8px;align-items:center">
        <span class="mono" style="font-size:11.5px;min-width:62px">${bytes(u.used_bytes)}</span>
        <div style="flex:1;min-width:52px">${meter(pct, "meter-thin")}</div>
        <span class="muted" style="font-size:11px">${num(u.quota_gb)}GB</span>
      </div></td>
    <td><span class="${u.ms_left != null && u.ms_left < 86400000 * 2 ? "badge warn" : "muted"}" style="${u.ms_left != null && u.ms_left < 86400000 * 2 ? "" : "font-size:12px"}">${timeLeft(u.ms_left)}</span>
      ${u.first_connect && !u.activated_at ? `<div class="muted" style="font-size:10.5px">⏳ first-connect</div>` : ""}</td>
    <td class="muted">${num(u.device_limit)}</td>
    <td><div class="cell-actions">
      <button class="btn btn-ghost btn-icon" data-action="copy-sub" data-token="${esc(u.sub_token)}" title="${esc(t("users.drawer.sub"))}">${icon("link")}</button>
      <button class="btn btn-ghost btn-icon" data-action="quick-toggle" data-user="${esc(u.username)}" data-active="${u.is_active ? 1 : 0}" title="${esc(t(u.is_active ? "users.bulkDisable" : "users.bulkEnable"))}">${icon(u.is_active ? "eye" : "check")}</button>
      <button class="btn btn-ghost btn-icon" data-action="edit-user" data-user="${esc(u.username)}" title="${esc(t("common.edit"))}">${icon("edit")}</button>
      <button class="btn btn-ghost btn-icon" data-action="delete-user" data-user="${esc(u.username)}" title="${esc(t("common.delete"))}" style="color:var(--danger)">${icon("trash")}</button>
    </div></td>
  </tr>`;
}

function pager(s) {
  return `<div class="pager">
    <button class="btn btn-sm" data-action="page" data-page="${s.page - 1}" ${s.page <= 1 ? "disabled" : ""}>→</button>
    <span>${num(s.page)} / ${num(s.pages)}</span>
    <button class="btn btn-sm" data-action="page" data-page="${s.page + 1}" ${s.page >= s.pages ? "disabled" : ""}>←</button>
  </div>`;
}

/* ══ user form (create / edit) ════════════════════════════════════════════ */
export function userFormBody(u = {}, presets = [], fingerprints = []) {
  const isEdit = !!u.username;
  const val = (k, d = "") => esc(u[k] ?? d);
  const lines = (arr) => esc((arr || []).join("\n"));
  return `<form id="user-form" data-edit="${isEdit ? esc(u.username) : ""}">
    <div class="form-grid">
      <div class="field"><label for="uf-user">${esc(t("users.form.username"))} *</label>
        <input id="uf-user" name="username" type="text" required dir="ltr" ${isEdit ? "readonly style='opacity:.6'" : ""} value="${val("username")}" placeholder="ali-123">
        <span class="hint">${esc(t("users.form.usernameHint"))}</span></div>
      <div class="field"><label for="uf-quota">${esc(t("users.form.quota"))}</label>
        <input id="uf-quota" name="quota_gb" type="number" min="0.1" step="0.5" value="${val("quota_gb", 50)}"></div>
      <div class="field"><label for="uf-days">${esc(t("users.form.days"))}</label>
        <input id="uf-days" name="expiry_days" type="number" min="1" value="${val("expiry_days", 30)}"></div>
      <div class="field"><label for="uf-dev">${esc(t("users.form.devices"))}</label>
        <input id="uf-dev" name="device_limit" type="number" min="1" max="50" value="${val("device_limit", 3)}"></div>
      <div class="field"><label for="uf-req">${esc(t("users.form.requests"))}</label>
        <input id="uf-req" name="request_limit" type="number" min="0" value="${val("request_limit", 0)}"></div>
      <div class="field"><label for="uf-frag">${esc(t("users.form.fragment"))}</label>
        <select id="uf-frag" name="fragment">
          ${presets.map((p) => `<option value="${esc(p.id)}" ${u.fragment === p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
        </select></div>
      <div class="field"><label for="uf-fp">${esc(t("users.form.fingerprint"))}</label>
        <select id="uf-fp" name="fingerprint">
          <option value="">—</option>
          ${fingerprints.map((f) => `<option value="${esc(f)}" ${u.fingerprint === f ? "selected" : ""}>${esc(f)}</option>`).join("")}
        </select></div>
      <div class="field"><label style="display:flex;align-items:center;gap:9px;padding-top:22px">
        <label class="switch"><input type="checkbox" name="first_connect" ${u.first_connect !== false ? "checked" : ""}><span></span></label>
        <span>${esc(t("users.form.firstConnect"))}</span></label></div>
      <div class="field"><label style="display:flex;align-items:center;gap:9px">
        <label class="switch"><input type="checkbox" name="is_active" ${u.is_active !== false ? "checked" : ""}><span></span></label>
        <span>${esc(t("users.form.active"))}</span></label></div>
    </div>
    <div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
      <div class="field"><label for="uf-ips">${esc(t("users.form.ips"))}</label>
        <textarea id="uf-ips" name="ips" rows="3" placeholder="104.16.0.0">${lines(u.ips)}</textarea></div>
      <div class="field"><label for="uf-proxy">${esc(t("users.form.proxies"))}</label>
        <textarea id="uf-proxy" name="proxies" rows="3" placeholder="user:pass@1.2.3.4:1080">${lines(u.proxies)}</textarea></div>
      <div class="field"><label for="uf-block">${esc(t("users.form.blockList"))}</label>
        <textarea id="uf-block" name="block_list" rows="3" placeholder="example.com">${lines(u.block_list)}</textarea></div>
    </div>
    <div class="field"><label for="uf-note">${esc(t("users.form.note"))}</label>
      <input id="uf-note" name="note" type="text" maxlength="200" value="${val("note")}" style="font-family:var(--font)"></div>
  </form>`;
}

/* ══ user detail drawer ═══════════════════════════════════════════════════ */
export function userDrawer(u, cfg, usage = []) {
  const sub = `${location.origin}${subUrl(u.sub_token)}`;
  const st = `${location.origin}/status/${u.sub_token}`;
  const series = (usage || []).map((d) => ({ ...d, total: (d.up_bytes || 0) + (d.down_bytes || 0) }));
  return `
  <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
    ${statusBadge(u.status)}
    <span class="badge">${num(u.device_limit)} ${esc(t("users.col.devices"))}</span>
    <span class="badge">${esc(u.fragment || "—")}</span>
    ${u.fingerprint ? `<span class="badge">${esc(u.fingerprint)}</span>` : ""}
  </div>

  <div style="display:flex;gap:14px;align-items:center;margin-top:4px">
    ${donut(u.used_pct, { size: 78 })}
    <div style="flex:1;min-width:0">
      <div class="kpi-label">${esc(t("users.col.traffic"))}</div>
      <div style="font-weight:800;font-size:19px">${bytes(u.used_bytes)} <span class="muted" style="font-size:12px;font-weight:400">/ ${num(u.quota_gb)} GB</span></div>
      <div class="kpi-sub">${esc(t("users.col.expiry"))}: ${timeLeft(u.ms_left)}${u.expires_at ? ` · ${dateFmt(u.expires_at)}` : ""}</div>
    </div>
  </div>

  <div class="tabs" role="tablist" style="margin-top:8px">
    <button role="tab" aria-selected="true" data-action="drawer-tab" data-tab="qr">${icon("qr")} ${esc(t("users.drawer.qr"))}</button>
    <button role="tab" aria-selected="false" data-action="drawer-tab" data-tab="configs">${esc(t("users.drawer.configs"))}</button>
    <button role="tab" aria-selected="false" data-action="drawer-tab" data-tab="usage">${esc(t("users.drawer.usage"))}</button>
    <button role="tab" aria-selected="false" data-action="drawer-tab" data-tab="sub">${esc(t("users.drawer.sub"))}</button>
  </div>

  <div data-tab-panel="qr">
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div class="qr">${qrSvg(cfg.uris?.[0] || "")}</div>
      <div style="flex:1;min-width:190px">
        <div class="kpi-label" style="margin-bottom:5px">vless://</div>
        <div class="codebox" style="max-height:120px">${esc(cfg.uris?.[0] || "")}</div>
        <div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap">
          ${copyButton(cfg.uris?.[0] || "")}
          <button class="btn btn-sm" data-action="copy-all-uris">${icon("copy")} ${esc(cfg.uris?.length || 0)}×</button>
        </div>
        <div class="livetest">
          <button class="btn btn-sm" data-action="live-test" data-uuid="${esc(u.uuid)}" data-host="${esc(cfg.host || "")}">${icon("activity")} ${esc(t("users.drawer.liveTest"))}</button>
          <span class="ms" data-lt-ms hidden>—</span>
          <span class="muted" data-lt-msg style="font-size:11.5px;flex:1;min-width:120px">${esc(t("live.hint"))}</span>
        </div>
      </div>
    </div>
    ${(cfg.uris || []).length > 1 ? `<div class="kpi-label" style="margin:14px 0 7px">${num(cfg.uris.length)} لوکیشن</div>
      <div style="display:flex;flex-direction:column;gap:7px">${cfg.uris.map((uri, i) =>
        `<div style="display:flex;gap:8px;align-items:center"><span class="badge info">#${i + 1}</span>
         <div class="codebox" style="flex:1;max-height:44px;font-size:10.5px">${esc(uri)}</div>
         ${copyButton(uri, "", true)}</div>`).join("")}</div>` : ""}
  </div>

  <div data-tab-panel="configs" class="hide">
    <div class="seg" style="margin-bottom:10px">
      <button data-action="cfg-format" data-format="singbox" aria-pressed="true">sing-box</button>
      <button data-action="cfg-format" data-format="clash" aria-pressed="false">Clash</button>
      <button data-action="cfg-format" data-format="base64" aria-pressed="false">Base64</button>
    </div>
    <pre class="codebox" id="cfg-out" style="max-height:340px">${esc(JSON.stringify(cfg.singbox, null, 2))}</pre>
    <div style="display:flex;gap:7px;margin-top:9px">
      <button class="btn btn-sm" data-action="copy-cfg">${icon("copy")} ${esc(t("common.copy"))}</button>
      <button class="btn btn-sm" data-action="download-cfg">${icon("download")} دانلود</button>
    </div>
  </div>

  <div data-tab-panel="usage" class="hide">
    ${series.length ? barChart(series, { valueKey: "total", height: 170 }) : `<div class="empty">${icon("activity")}<div>no usage yet</div></div>`}
    ${series.length ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr>
        <th>روز</th><th>↓</th><th>↑</th><th>اتصال</th></tr></thead><tbody>
      ${series.slice().reverse().slice(0, 14).map((d) => `<tr><td class="mono">${esc(d.day)}</td><td class="mono">${bytes(d.down_bytes)}</td><td class="mono">${bytes(d.up_bytes)}</td><td class="mono">${num(d.conns)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
  </div>

  <div data-tab-panel="sub" class="hide">
    <div class="field"><label>${esc(t("users.drawer.sub"))}</label>
      <div class="codebox" id="sub-link">${esc(sub)}</div>
      <div style="display:flex;gap:7px;margin-top:8px;flex-wrap:wrap">
        ${copyButton(sub)}
        <a class="btn btn-sm" href="${esc(st)}" target="_blank" rel="noopener">${icon("globe")} ${esc(t("users.drawer.statusPage"))}</a>
        <button class="btn btn-sm" data-action="rotate-token">${icon("refresh")} ${esc(t("users.drawer.rotateToken"))}</button>
        <button class="btn btn-sm" data-action="rotate-uuid">${icon("key")} ${esc(t("users.drawer.rotateUuid"))}</button>
      </div>
    </div>
    <p class="hint muted" style="font-size:11.5px;margin-top:10px">
      UUID: <span class="mono">${esc(u.uuid)}</span>
    </p>
  </div>

  <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
    <button class="btn btn-sm" data-action="edit-user" data-user="${esc(u.username)}">${icon("edit")} ${esc(t("common.edit"))}</button>
    <button class="btn btn-sm" data-action="reset-user" data-user="${esc(u.username)}">${icon("refresh")} ${esc(t("users.drawer.reset"))}</button>
    <div class="spacer"></div>
    <button class="btn btn-sm btn-danger" data-action="delete-user" data-user="${esc(u.username)}">${icon("trash")} ${esc(t("common.delete"))}</button>
  </div>`;
}

/* ══ settings ═════════════════════════════════════════════════════════════ */
export function settingsView(s, presets = [], fingerprints = []) {
  const g = (k, d = "") => esc(s[k] ?? d);
  const on = (k) => (s[k] === "1" || s[k] === true ? "checked" : "");
  const list = (k) => {
    const v = s[k];
    let arr = Array.isArray(v) ? v : [];
    if (typeof v === "string" && v.trim()) { try { arr = JSON.parse(v); } catch { arr = v.split(/[\n,]/); } }
    return esc((arr || []).join("\n"));
  };
  return `<form id="settings-form">
  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${icon("gear")}<h3>${esc(t("settings.general"))}</h3></div>
      <div class="form-grid" style="grid-template-columns:1fr">
        <div class="field"><label>${esc(t("settings.panelName"))}</label><input name="panel_name" type="text" value="${g("panel_name", "Kaveh")}"></div>
        <div class="field"><label>${esc(t("settings.publicHost"))}</label><input name="public_host" type="text" dir="ltr" value="${g("public_host")}" placeholder="panel.example.workers.dev">
          <span class="hint">SNI/Host که کلاینت می‌فرستد. اگر خالی باشد، دامنه‌ی ورکر استفاده می‌شود.</span></div>
        <div class="field"><label>${esc(t("settings.remark"))}</label><input name="remark_prefix" type="text" value="${g("remark_prefix", "Kaveh")}"></div>
        <div style="display:flex;gap:11px">
          <div class="field" style="flex:1"><label>${esc(t("settings.defaultQuota"))}</label><input name="default_quota_gb" type="number" min="1" value="${g("default_quota_gb", "50")}"></div>
          <div class="field" style="flex:1"><label>${esc(t("settings.defaultDays"))}</label><input name="default_expiry_days" type="number" min="1" value="${g("default_expiry_days", "30")}"></div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch"><input type="checkbox" name="maintenance" ${on("maintenance")}><span></span></label>
          <span>${esc(t("settings.maintenance"))}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">${icon("wifi")}<h3>${esc(t("settings.network"))}</h3></div>
      <div class="form-grid" style="grid-template-columns:1fr">
        <div class="field"><label>${esc(t("settings.port"))}</label>
          <select name="port">${[443, 2053, 2083, 2087, 2096, 8443, 80, 8080, 2052, 2082, 2086, 2095].map((p) =>
            `<option value="${p}" ${String(s.port) === String(p) ? "selected" : ""}>${p}${[443, 2053, 2083, 2087, 2096, 8443].includes(p) ? " (TLS)" : ""}</option>`).join("")}</select></div>
        <div class="field"><label>${esc(t("users.form.fragment"))}</label>
          <select name="fragment_preset">${presets.map((p) => `<option value="${esc(p.id)}" ${s.fragment_preset === p.id ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></div>
        <div class="field"><label>${esc(t("users.form.fingerprint"))}</label>
          <select name="fingerprint"><option value="">—</option>${fingerprints.map((f) => `<option value="${esc(f)}" ${s.fingerprint === f ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></div>
        <div class="field"><label>${esc(t("settings.cleanIps"))}</label>
          <textarea name="clean_ips" rows="3" dir="ltr">${list("clean_ips")}</textarea></div>
        <div class="field"><label>${esc(t("settings.ipPool"))}</label>
          <textarea name="ip_pool" rows="4" dir="ltr" placeholder="104.16.0.0&#10;172.66.0.0">${list("ip_pool")}</textarea>
          <span class="hint">مخزنی که Cron هر ${esc(s.rotate_minutes || 30)} دقیقه از آن تست می‌گیرد و بهترین‌ها را در «آی‌پی تمیز فعلی» می‌گذارد.</span></div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch"><input type="checkbox" name="auto_rotate" ${on("auto_rotate")}><span></span></label><span>${esc(t("settings.autoRotate"))}</span>
          <input name="rotate_minutes" type="number" min="5" max="1440" value="${g("rotate_minutes", "30")}" style="width:88px"></div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch"><input type="checkbox" name="mux_enabled" ${on("mux_enabled")}><span></span></label><span>${esc(t("settings.mux"))}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">${icon("shield")}<h3>${esc(t("settings.security"))}</h3></div>
      <div style="display:flex;flex-direction:column;gap:11px">
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch"><input type="checkbox" name="block_nsfw" ${on("block_nsfw")}><span></span></label><span>${esc(t("settings.blockNsfw"))}</span></div>
        <div style="display:flex;align-items:center;gap:10px">
          <label class="switch"><input type="checkbox" name="block_ads" ${on("block_ads")}><span></span></label><span>${esc(t("settings.blockAds"))}</span></div>
        <p class="hint muted" style="font-size:11.5px;margin:0">
          مسدودسازی روی لبه و با DoH انجام می‌شود؛ فهرست دامنه‌ها در هر کاربر هم قابل تنظیم است.</p>
        <div class="nav-sep"></div>
        <div class="field"><label>${esc(t("settings.changePassword"))}</label>
          <input name="pw_current" type="password" placeholder="${esc(t("settings.currentPassword"))}" autocomplete="current-password" dir="ltr">
          <input name="pw_next" type="password" placeholder="${esc(t("login.newPassword"))}" autocomplete="new-password" dir="ltr" minlength="10" style="margin-top:7px">
          <button class="btn btn-sm" type="button" data-action="change-password" style="margin-top:9px;align-self:flex-start">${icon("key")} ${esc(t("settings.changePassword"))}</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">${icon("db")}<h3>${esc(t("settings.backup"))}</h3></div>
      <p class="hint muted" style="font-size:12px;margin-top:0">
        خروجی کامل D1 به JSON — کاربران، تنظیمات، پلن‌ها و نودها. برای جابه‌جایی بین اکانت کلودفلر یا فرار از بن شدن.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" data-action="export-backup">${icon("download")} ${esc(t("settings.export"))}</button>
        <label class="btn" style="cursor:pointer">${icon("upload")} ${esc(t("settings.import"))}
          <input type="file" accept="application/json" data-action="import-backup" hidden></label>
      </div>
      <div class="nav-sep" style="margin:16px 0"></div>
      <div class="card-head" style="color:var(--danger)">${icon("alert")}<h3 style="color:var(--danger)">${esc(t("settings.danger"))}</h3></div>
      <button class="btn btn-danger" type="button" data-action="revoke-all">${icon("logout")} خروج از همه نشست‌ها</button>
    </div>
  </div>

  <div style="position:sticky;bottom:0;margin-top:14px;display:flex;gap:9px;justify-content:flex-end;padding:12px;
    background:color-mix(in srgb, var(--surface) 88%, transparent);backdrop-filter:blur(10px);border:1px solid var(--border);border-radius:var(--radius)">
    <button class="btn" type="button" data-action="reload-settings">${esc(t("common.cancel"))}</button>
    <button class="btn btn-primary" type="submit">${icon("check")} ${esc(t("settings.save"))}</button>
  </div>
  </form>`;
}

/* ══ diagnostics ══════════════════════════════════════════════════════════ */
export function diagView(logs = []) {
  return `<div class="grid grid-2">
    <div class="card">
      <div class="card-head">${icon("wifi")}<h3>${esc(t("diag.probeNode"))}</h3></div>
      <div class="field"><input id="probe-input" type="text" dir="ltr" placeholder="${esc(t("diag.probeHint"))}">
        <span class="hint">${esc(t("diag.probeHint"))}</span></div>
      <button class="btn btn-primary btn-sm" data-action="probe" style="margin-top:10px">${icon("play")} ${esc(t("diag.run"))}</button>
      <div id="probe-out" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <div class="card-head">${icon("bolt")}<h3>${esc(t("diag.rankIps"))}</h3></div>
      <div class="field"><textarea id="rank-input" rows="4" dir="ltr" placeholder="104.16.0.0&#10;172.66.0.0"></textarea>
        <span class="hint">${esc(t("diag.rankHint"))}</span></div>
      <button class="btn btn-primary btn-sm" data-action="rank" style="margin-top:10px">${icon("play")} ${esc(t("diag.run"))}</button>
      <div id="rank-out" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <div class="card-head">${icon("activity")}<h3>${esc(t("diag.ping"))}</h3></div>
      <div class="field"><input id="ping-input" type="text" dir="ltr" value="https://cp.cloudflare.com"></div>
      <button class="btn btn-primary btn-sm" data-action="ping" style="margin-top:10px">${icon("play")} ${esc(t("diag.run"))}</button>
      <div id="ping-out" style="margin-top:12px"></div>
    </div>

    <div class="card">
      <div class="card-head">${icon("refresh")}<h3>${esc(t("diag.maintenance"))}</h3></div>
      <p class="hint muted" style="margin-top:-4px">${esc(t("diag.maintenanceHint"))}</p>
      <button class="btn btn-primary btn-sm" data-action="maintenance" style="margin-top:10px">${icon("play")} ${esc(t("diag.run"))}</button>
      <div id="maintenance-out" style="margin-top:12px"></div>
    </div>

    <div class="card" style="grid-column:1/-1">
      <div class="card-head">${icon("shield")}<h3>${esc(t("diag.audit"))}</h3><div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" data-action="reload-logs">${icon("refresh")}</button></div>
      <p class="hint muted" style="margin-top:-6px;font-size:11.5px">${esc(t("diag.auditHint"))}</p>
      <div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr>
        <th>زمان</th><th>بازیگر</th><th>رویداد</th><th>هدف</th></tr></thead>
        <tbody>${(logs || []).map((l) => `<tr>
          <td class="muted" style="white-space:nowrap">${timeAgo(l.at)}</td>
          <td class="mono" style="font-size:11.5px">${esc(l.actor)}</td>
          <td><span class="badge ${/delete|failed|revoke/.test(l.action) ? "danger" : /create|update|login$/.test(l.action) ? "info" : ""}">${esc(l.action)}</span></td>
          <td class="muted mono" style="font-size:11.5px">${esc(l.target || "")}</td></tr>`).join("")
          || `<tr><td colspan="4"><div class="empty">—</div></td></tr>`}</tbody></table></div>
    </div>
  </div>`;
}

/* ══ sessions ═════════════════════════════════════════════════════════════ */
export function sessionsView(sessions = []) {
  return `<div class="card">
    <div class="card-head">${icon("key")}<h3>${esc(t("nav.sessions"))}</h3><div class="spacer"></div>
      <button class="btn btn-sm btn-danger" data-action="revoke-all">${esc(t("settings.danger"))}</button></div>
    <div class="table-wrap"><table><thead><tr><th>Subject</th><th>Role</th><th>ایجاد</th><th>انقضا</th><th>IP</th><th></th></tr></thead>
    <tbody>${sessions.map((s) => `<tr>
      <td class="cell-user">${esc(s.subject)}</td><td><span class="badge info">${esc(s.role)}</span></td>
      <td class="muted">${timeAgo(s.created_at)}</td><td class="muted">${timeLeft(s.expires_at - Date.now())}</td>
      <td class="mono muted" style="font-size:11px">${esc((s.ip_hash || "").slice(0, 8))}</td>
      <td style="text-align:end"><button class="btn btn-ghost btn-sm" data-action="revoke-session" data-id="${esc(s.id)}">${icon("close")}</button></td>
    </tr>`).join("") || `<tr><td colspan="6"><div class="empty">—</div></td></tr>`}</tbody></table></div>
  </div>`;
}
