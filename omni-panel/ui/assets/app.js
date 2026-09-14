/**
 * Kaveh panel — application shell.
 *
 * Vanilla ES modules, hash routing, event delegation. No React, no bundler, no
 * CDN. First paint is one HTML file + one CSS file; everything else streams in.
 */
import { api, ApiError, subUrl, statusUrl, downloadBackup } from "./api.js";
import { I18N, t, bytes, num } from "./i18n.js";
import { icon, toast, openModal, closeModal, openDrawer, closeDrawer, confirmDialog, copyText, copyButton, qrSvg, esc } from "./components.js";
import { loginView, dashboardView, usersView, userFormBody, userDrawer, settingsView, diagView, sessionsView } from "./views.js";
import { initFx } from "./fx.js";
import { liveTest } from "./nettest.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  me: null,
  installed: true,
  authMode: "login",
  authError: "",
  view: location.hash.slice(2) || "dashboard",
  overview: null,
  settings: {},
  fragments: { presets: [], fingerprints: [] },
  users: [],
  total: 0,
  page: 1,
  size: 25,
  pages: 1,
  query: "",
  status: "all",
  sort: "created_at",
  dir: "desc",
  loading: false,
  selection: new Set(),
  logs: [],
  sessions: [],
  drawer: null,
  cfgFormat: "singbox",
  theme: localStorage.getItem("kaveh.theme") || "dark",
  sidebarOpen: false,
};

/* ══ boot ═════════════════════════════════════════════════════════════════ */
async function boot() {
  try {
    const me = await api.whoami();
    S.me = me.username ? { username: me.username, role: me.role } : null;
    S.installed = me.installed !== false;
    S.panelName = me.panelName || "Kaveh";
  } catch (e) {
    S.me = null;
    // Only a definitive "not installed" answer sends us to the setup screen.
    // A network failure shows the login form with the error, so a flaky
    // connection can never trick an admin into re-running first-run setup.
    S.installed = !(e instanceof ApiError && e.code === "not_installed");
    S.authError = e instanceof ApiError ? e.message : "اتصال به سرور برقرار نشد";
  }
  if (!S.installed) S.authMode = "setup";
  render();
  registerSW();
  wireGlobalEvents();
  window.addEventListener("hashchange", () => {
    S.view = location.hash.slice(2) || "dashboard";
    renderView();
  });
}

function applyPrefs() {
  I18N.set(localStorage.getItem("kaveh.lang") || "fa");
  document.documentElement.dataset.theme = S.theme;
}

function registerSW() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("online", () => setConn(true));
  window.addEventListener("offline", () => setConn(false));
}
function setConn(up) {
  const el = $("#conn-dot");
  if (el) el.style.background = up ? "var(--ok)" : "var(--danger)";
}

/* ══ render ═══════════════════════════════════════════════════════════════ */
async function render() {
  const root = $("#root");
  root.setAttribute("aria-busy", "false");
  if (!S.me) {
    root.innerHTML = loginView({ mode: S.authMode, error: S.authError });
    return;
  }
  // Fragment presets and fingerprints are needed by the user form and the
  // settings form, so they are fetched once before the first view paints.
  await loadFragments();
  root.innerHTML = shell();
  renderView();
}

const NAV = [
  { id: "dashboard", icon: "dash", label: () => t("nav.dashboard") },
  { id: "users", icon: "users", label: () => t("nav.users") },
  { id: "diag", icon: "activity", label: () => t("nav.diag") },
  { id: "settings", icon: "gear", label: () => t("nav.settings") },
  { id: "sessions", icon: "key", label: () => t("nav.sessions") },
];

function shell() {
  return `<div class="app">
    <aside class="sidebar ${S.sidebarOpen ? "open" : ""}" id="sidebar">
      <div class="brand">
        <img src="/icon.svg" alt="" width="34" height="34">
        <div><div class="brand-name">${esc(S.panelName || t("app.name"))}</div>
        <div class="brand-sub">${esc(t("app.tagline"))}</div></div>
      </div>
      ${NAV.map((n) => `<button class="nav-item" data-action="nav" data-view="${n.id}" ${S.view === n.id ? 'aria-current="page"' : ""}>
          ${icon(n.icon)} ${esc(n.label())}</button>`).join("")}
      <div class="nav-sep"></div>
      <div class="nav-label">ظاهر</div>
      <button class="nav-item" data-action="toggle-theme">${icon(S.theme === "dark" ? "sun" : "moon")} ${S.theme === "dark" ? "حالت روشن" : "Dark mode"}</button>
      <button class="nav-item" data-action="toggle-lang">${icon("globe")} ${I18N.lang === "fa" ? "English" : "فارسی"}</button>
      <div class="nav-sep"></div>
      <button class="nav-item" data-action="palette">${icon("search")} ${esc(t("common.search"))} <kbd style="margin-inline-start:auto">⌘K</kbd></button>
      <div class="spacer" style="flex:1"></div>
      <button class="nav-item" data-action="logout" style="color:var(--danger)">${icon("logout")} ${esc(t("nav.logout"))}</button>
      <div class="muted" style="font-size:10.5px;padding:8px 10px 0;text-align:center">
        <span id="conn-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-inline-end:5px"></span>
        kaveh v0.1.0
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon" data-action="toggle-sidebar" id="burger" style="display:none">${icon("menu")}</button>
        <h1 id="view-title">${esc(titleFor(S.view))}</h1>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-icon" data-action="refresh" title="${esc(t("common.refresh"))}">${icon("refresh")}</button>
      </header>
      <div class="content" id="view"></div>
    </main>
  </div>`;
}

function titleFor(v) {
  const map = { dashboard: t("nav.dashboard"), users: t("nav.users"), settings: t("nav.settings"), diag: t("nav.diag"), sessions: t("nav.sessions") };
  return map[v] || t("app.name");
}

async function renderView() {
  const host = $("#view");
  if (!host) return render();
  $("#view-title") && ($("#view-title").textContent = titleFor(S.view));
  $$(".nav-item[data-view]").forEach((b) => {
    // CSS matches [aria-current="page"], so the literal value matters —
    // toggleAttribute() alone would set aria-current="".
    if (b.dataset.view === S.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (window.matchMedia("(max-width: 900px)").matches) {
    const burger = $("#burger");
    if (burger) burger.style.display = "";
  }
  switch (S.view) {
    case "users":
      host.innerHTML = usersView(S);
      await loadUsers();
      break;
    case "settings":
      host.innerHTML = settingsView(S.settings, S.fragments.presets, S.fragments.fingerprints);
      await loadSettings(true);
      break;
    case "diag":
      host.innerHTML = diagView(S.logs);
      await loadLogs();
      break;
    case "sessions":
      host.innerHTML = sessionsView(S.sessions);
      await loadSessions();
      break;
    default:
      S.view = "dashboard";
      host.innerHTML = dashboardView(null);
      await loadOverview();
  }
}

/* ══ data loaders ═════════════════════════════════════════════════════════ */
async function loadOverview() {
  try {
    S.overview = await api.overview(7);
    const host = $("#view");
    if (host && S.view === "dashboard") host.innerHTML = dashboardView(S.overview);
  } catch (e) { fail(e); }
}

async function loadUsers() {
  S.loading = true;
  paintUsers();
  try {
    const res = await api.users({ q: S.query, status: S.status, sort: S.sort, dir: S.dir, page: S.page, size: S.size });
    S.users = res.users;
    S.total = res.total;
    S.pages = res.pages || 1;
    S.page = res.page;
  } catch (e) {
    fail(e);
    S.users = [];
  } finally {
    S.loading = false;
    paintUsers();
  }
}
function paintUsers() {
  const host = $("#view");
  if (host && S.view === "users") host.innerHTML = usersView(S);
  const input = $("#user-search");
  if (input && document.activeElement !== input) input.value = S.query;
}

async function loadFragments() {
  if (S.fragments.presets.length) return;
  try {
    S.fragments = await api.fragments();
  } catch {
    S.fragments = { presets: [{ id: "none", label: "—" }, { id: "mci", label: "MCI" }, { id: "irancell", label: "Irancell" }, { id: "tci", label: "TCI" }], fingerprints: ["chrome", "safari", "ios", "android"] };
  }
}

async function loadSettings(force) {
  try {
    if (force || !Object.keys(S.settings).length) {
      const res = await api.settings();
      S.settings = res.settings || {};
      const host = $("#view");
      if (host && S.view === "settings") host.innerHTML = settingsView(S.settings, S.fragments.presets, S.fragments.fingerprints);
    }
  } catch (e) { fail(e); }
}

async function loadLogs() {
  try {
    const res = await api.logs(60);
    S.logs = res.entries || [];
    const host = $("#view");
    if (host && S.view === "diag") host.innerHTML = diagView(S.logs);
  } catch {}
}

async function loadSessions() {
  try {
    const res = await api.sessions();
    S.sessions = res.sessions || [];
    const host = $("#view");
    if (host && S.view === "sessions") host.innerHTML = sessionsView(S.sessions);
  } catch (e) { fail(e); }
}

function fail(e) {
  if (e instanceof ApiError && e.status === 401) {
    S.me = null;
    S.authError = t("login.title");
    render();
    return;
  }
  toast(e?.message || String(e), "err");
}

/* ══ drawer: user detail ══════════════════════════════════════════════════ */
async function openUser(username) {
  openDrawer({ title: username, body: `<div class="skeleton" style="height:220px"></div>`, footer: "" });
  try {
    const res = await api.user(username);
    let usage = [];
    try { usage = (await api.userUsage(username, 14)).series || []; } catch {}
    S.drawer = { user: res.user, configs: res.configs, usage };
    S.cfgFormat = "singbox";
    const d = $(".drawer");
    if (d) {
      d.querySelector("h2").textContent = res.user.username;
      $(".modal-body", d).innerHTML = userDrawer(res.user, res.configs, usage);
    }
  } catch (e) {
    closeDrawer();
    fail(e);
  }
}

/* ══ user form ════════════════════════════════════════════════════════════ */
function openUserForm(user = {}) {
  const isEdit = !!user.username;
  openModal({
    title: isEdit ? `${t("common.edit")}: ${user.username}` : t("users.create"),
    body: userFormBody(user, S.fragments.presets, S.fragments.fingerprints),
    footer: `<button class="btn" data-action="close-modal">${esc(t("common.cancel"))}</button>
             <button class="btn btn-primary" form="user-form" type="submit">${icon(isEdit ? "check" : "plus")} ${esc(t(isEdit ? "common.save" : "common.create"))}</button>`,
  });
}

function collectForm(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) out[k] = v;
  for (const cb of $$('input[type="checkbox"]', form)) {
    if (["ips", "proxies", "block_list"].includes(cb.name)) continue;
    out[cb.name] = cb.checked;
  }
  for (const ta of $$("textarea", form)) out[ta.name] = ta.value.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const n of $$('input[type="number"]', form)) out[n.name] = Number(n.value);
  return out;
}

async function submitUserForm(form) {
  const data = collectForm(form);
  const editing = form.dataset.edit;
  const btn = $('button[type="submit"][form="user-form"]');
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="skeleton" style="width:60px;height:14px"></div>`; }
  try {
    const res = editing ? await api.updateUser(editing, data) : await api.createUser(data);
    closeModal();
    toast(editing ? "ذخیره شد" : `کاربر «${res.user.username}» ساخته شد`, "ok");
    if (S.view === "users") await loadUsers();
    else if (S.view === "dashboard") await loadOverview();
    if ($(".drawer") && S.drawer?.user.username === res.user.username) {
      S.drawer = { ...S.drawer, user: res.user, configs: res.configs };
      $(".drawer .modal-body").innerHTML = userDrawer(res.user, res.configs, S.drawer.usage);
    }
  } catch (e) {
    toast(e?.message || String(e), "err", 5000);
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon("check")} ${esc(t("common.save"))}`; }
  }
}

/* ══ command palette ══════════════════════════════════════════════════════ */
function openPalette() {
  const commands = [
    ...NAV.map((n) => ({ label: n.label(), icon: n.icon, run: () => go(n.id) })),
    { label: t("users.create"), icon: "plus", run: () => openUserForm({}) },
    { label: S.theme === "dark" ? "حالت روشن" : "Dark mode", icon: S.theme === "dark" ? "sun" : "moon", run: toggleTheme },
    { label: I18N.lang === "fa" ? "English" : "فارسی", icon: "globe", run: toggleLang },
    { label: t("common.refresh"), icon: "refresh", run: () => renderView() },
    { label: t("settings.export"), icon: "download", run: downloadBackup },
    { label: t("nav.logout"), icon: "logout", run: doLogout },
    ...(S.users || []).slice(0, 60).map((u) => ({ label: `👤 ${u.username}`, icon: "users", run: () => openUser(u.username) })),
  ];

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="palette" role="dialog" aria-modal="true">
      <input type="search" placeholder="${esc(t("common.cmdk"))}" aria-label="command">
      <div class="palette-list"></div>
    </div>`;
  document.body.append(overlay);
  const input = $("input", overlay);
  const list = $(".palette-list", overlay);
  let filtered = commands;
  let active = 0;

  const paint = () => {
    list.innerHTML = filtered.slice(0, 40).map((c, i) =>
      `<div class="palette-item" data-i="${i}" aria-selected="${i === active}">${icon(c.icon)} ${esc(c.label)}</div>`).join("")
      || `<div class="empty" style="padding:22px">—</div>`;
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
    active = 0;
    paint();
  };
  const run = (i) => {
    const c = filtered[i];
    overlay.remove();
    c?.run();
  };
  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(active + 1, filtered.length - 1); paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); paint(); e.preventDefault(); }
    else if (e.key === "Enter") run(active);
    else if (e.key === "Escape") overlay.remove();
  });
  list.addEventListener("click", (e) => {
    const item = e.target.closest("[data-i]");
    if (item) run(Number(item.dataset.i));
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  paint();
  input.focus();
}

/* ══ actions ══════════════════════════════════════════════════════════════ */
function go(view) {
  S.view = view;
  location.hash = `#/${view}`;
  S.sidebarOpen = false;
  $("#sidebar")?.classList.remove("open");
  renderView();
}

function toggleTheme() {
  S.theme = S.theme === "dark" ? "light" : "dark";
  localStorage.setItem("kaveh.theme", S.theme);
  document.documentElement.dataset.theme = S.theme;
  render();
}

function toggleLang() {
  I18N.set(I18N.lang === "fa" ? "en" : "fa");
  render();
}

async function doLogout() {
  try { await api.logout(); } catch {}
  S.me = null;
  S.authMode = "login";
  S.authError = "";
  render();
}

async function doBulk(op, value) {
  const names = [...S.selection];
  if (!names.length) return;
  if (op === "delete") {
    const yes = await confirmDialog(t("users.confirmBulkDelete", { n: names.length }), { danger: true });
    if (!yes) return;
  }
  try {
    const res = await api.bulk(names, op, value);
    toast(`${op}: ${res.affected} کاربر`, "ok");
    S.selection.clear();
    await loadUsers();
  } catch (e) { fail(e); }
}

async function bulkExtend() {
  const days = prompt(t("users.bulkExtend"), "30");
  if (!days) return;
  await doBulk("extend", Number(days));
}

/* ══ global event wiring ══════════════════════════════════════════════════ */
function wireGlobalEvents() {
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("change", onChange);
  document.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
}

async function onClick(e) {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  const user = el.dataset.user;

  switch (a) {
    case "nav": e.preventDefault(); return go(el.dataset.view);
    case "toggle-theme": return toggleTheme();
    case "toggle-lang": return toggleLang();
    case "toggle-sidebar": S.sidebarOpen = !S.sidebarOpen; return $("#sidebar")?.classList.toggle("open", S.sidebarOpen);
    case "palette": return openPalette();
    case "logout": return doLogout();
    case "refresh": return renderView();
    case "close-modal": return closeModal();
    case "close-drawer": return closeDrawer();
    case "goto-recover": S.authMode = "recover"; return render();
    case "goto-login": S.authMode = "login"; return render();

    // ── users ────────────────────────────────────────────────────────────
    case "new-user": return openUserForm({});
    case "edit-user": {
      e.preventDefault();
      const full = (await api.user(user)).user;
      return openUserForm(full);
    }
    case "open-user": e.preventDefault(); return openUser(user);
    case "delete-user": {
      e.preventDefault();
      const yes = await confirmDialog(t("users.confirmDelete", { name: user }), { danger: true, okLabel: t("common.delete") });
      if (!yes) return;
      try { await api.deleteUser(user); toast("حذف شد", "ok"); closeDrawer(); await (S.view === "users" ? loadUsers() : loadOverview()); }
      catch (err) { fail(err); }
      return;
    }
    case "reset-user": {
      try { await api.resetUser(user, { traffic: true, requests: true }); toast("حجم ریست شد", "ok"); closeDrawer(); await loadUsers(); }
      catch (err) { fail(err); }
      return;
    }
    case "live-test": {
      const btn = el;
      const wrap = btn.closest(".livetest");
      const msEl = wrap?.querySelector("[data-lt-ms]");
      const msgEl = wrap?.querySelector("[data-lt-msg]");
      btn.disabled = true;
      if (msEl) { msEl.hidden = false; msEl.className = "ms"; msEl.textContent = "…"; }
      if (msgEl) msgEl.textContent = t("live.running");
      const r = await liveTest({ host: el.dataset.host || location.host, uuid: el.dataset.uuid });
      btn.disabled = false;
      if (msEl) {
        msEl.className = `ms ${r.ok ? "ok" : "bad"}`;
        msEl.textContent = r.ok ? `${r.ms} ms` : "✕";
      }
      if (msgEl) msgEl.textContent = t(`live.${r.stage}`);
      toast(t(`live.${r.stage}`), r.ok ? "ok" : "err");
      return;
    }
    case "quick-toggle": {
      try {
        await api.updateUser(user, { is_active: el.dataset.active === "0" });
        await loadUsers();
      } catch (err) { fail(err); }
      return;
    }
    case "select-user": return; // handled by change
    case "select-all": return;
    case "clear-selection": S.selection.clear(); return paintUsers();
    case "bulk": return doBulk(el.dataset.op);
    case "bulk-extend": return bulkExtend();
    case "page": S.page = Number(el.dataset.page); return loadUsers();
    case "filter": S.status = el.dataset.status; S.page = 1; return renderView();
    case "sort": {
      const k = el.dataset.key;
      if (S.sort === k) S.dir = S.dir === "asc" ? "desc" : "asc";
      else { S.sort = k; S.dir = "desc"; }
      return loadUsers();
    }
    case "refresh-users": return loadUsers();

    // ── copy / qr ────────────────────────────────────────────────────────
    case "copy": {
      const ok = await copyText(el.dataset.copy || "");
      return toast(ok ? t("users.drawer.copied") : "کپی ناموفق بود", ok ? "ok" : "err", 1600);
    }
    case "copy-sub": {
      const link = `${location.origin}${subUrl(el.dataset.token)}`;
      const ok = await copyText(link);
      return toast(ok ? "لینک اشتراک کپی شد" : "کپی ناموفق بود", ok ? "ok" : "err", 1800);
    }
    case "copy-all-uris": {
      const uris = S.drawer?.configs?.uris || [];
      const ok = await copyText(uris.join("\n"));
      return toast(ok ? `${uris.length} کانفیگ کپی شد` : "کپی ناموفق بود", ok ? "ok" : "err");
    }
    case "copy-cfg": {
      const ok = await copyText($("#cfg-out")?.textContent || "");
      return toast(ok ? t("users.drawer.copied") : "کپی ناموفق بود", ok ? "ok" : "err", 1600);
    }
    case "download-cfg": {
      const cfg = S.drawer?.configs || {};
      const fmt = S.cfgFormat;
      const body = fmt === "singbox" ? JSON.stringify(cfg.singbox, null, 2) : fmt === "clash" ? cfg.clash : cfg.base64;
      const ext = fmt === "singbox" ? "json" : fmt === "clash" ? "yaml" : "txt";
      const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${S.drawer.user.username}.${ext}`;
      link.click();
      URL.revokeObjectURL(link.href);
      return;
    }
    case "cfg-format": {
      S.cfgFormat = el.dataset.format;
      $$("[data-action='cfg-format']").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
      const cfg = S.drawer?.configs || {};
      $("#cfg-out").textContent =
        S.cfgFormat === "singbox" ? JSON.stringify(cfg.singbox, null, 2) : S.cfgFormat === "clash" ? cfg.clash : cfg.base64;
      return;
    }
    case "drawer-tab": {
      $$("[data-action='drawer-tab']").forEach((b) => b.setAttribute("aria-selected", String(b === el)));
      $$("[data-tab-panel]").forEach((p) => p.classList.toggle("hide", p.dataset.tabPanel !== el.dataset.tab));
      return;
    }
    case "rotate-token": {
      const yes = await confirmDialog("لینک اشتراک فعلی باطل می‌شود و کاربر باید لینک جدید را بگیرد. ادامه؟", { danger: true });
      if (!yes) return;
      try {
        const r = await api.rotateToken(S.drawer.user.username);
        S.drawer.user.sub_token = r.sub_token;
        $("#sub-link").textContent = `${location.origin}${subUrl(r.sub_token)}`;
        toast("توکن جدید ساخته شد", "ok");
      } catch (err) { fail(err); }
      return;
    }
    case "rotate-uuid": {
      const yes = await confirmDialog("UUID عوض می‌شود؛ همه‌ی کانفیگ‌های قبلی از کار می‌افتند. ادامه؟", { danger: true });
      if (!yes) return;
      try { await api.rotateUuid(S.drawer.user.username); toast("UUID عوض شد", "ok"); closeDrawer(); await loadUsers(); }
      catch (err) { fail(err); }
      return;
    }

    // ── settings ─────────────────────────────────────────────────────────
    case "reload-settings": return loadSettings(true);
    case "change-password": return changePassword();
    case "export-backup": return downloadBackup();
    case "revoke-all": {
      const yes = await confirmDialog("همه‌ی نشست‌ها باطل می‌شوند و باید دوباره وارد شوید.", { danger: true });
      if (!yes) return;
      try { await api.revokeAll(); await doLogout(); } catch (err) { fail(err); }
      return;
    }
    case "revoke-session": {
      try { await api.revoke(el.dataset.id); await loadSessions(); } catch (err) { fail(err); }
      return;
    }

    // ── diagnostics ──────────────────────────────────────────────────────
    case "probe": return runProbe();
    case "rank": return runRank();
    case "ping": return runPing();
    case "reload-logs": return loadLogs();
  }
}

function onSubmit(e) {
  const form = e.target;
  e.preventDefault();
  if (form.id === "auth-form") return submitAuth(form);
  if (form.id === "user-form") return submitUserForm(form);
  if (form.id === "settings-form") return submitSettings(form);
}

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const fd = new FormData(form);
  const btn = $('button[type="submit"]', form);
  btn.disabled = true;
  S.authError = "";
  try {
    if (mode === "setup") await api.setup(fd.get("password"), fd.get("username") || "admin");
    else if (mode === "recover") {
      const res = await fetch("/api/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: fd.get("code"), password: fd.get("password") }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new ApiError(res.status, j.code, j.error);
      toast("رمز بازنشانی شد. دوباره وارد شوید.", "ok");
      S.authMode = "login";
      return render();
    } else await api.login(fd.get("password"), fd.get("username"));
    const me = await api.whoami();
    S.me = { username: me.username, role: me.role };
    S.panelName = me.panelName || "Kaveh";
    toast(`خوش آمدید، ${S.me.username} 👋`, "ok");
    location.hash = "#/dashboard";
    S.view = "dashboard";
    render();
  } catch (err) {
    S.authError = err?.message || String(err);
    render();
  } finally {
    btn.disabled = false;
  }
}

async function submitSettings(form) {
  const data = collectForm(form);
  const patch = {};
  for (const k of ["panel_name", "public_host", "port", "fragment_preset", "fingerprint", "remark_prefix", "default_quota_gb", "default_expiry_days", "rotate_minutes"]) {
    if (data[k] !== undefined && data[k] !== "") patch[k] = String(data[k]);
  }
  for (const k of ["maintenance", "auto_rotate", "mux_enabled", "block_nsfw", "block_ads"]) patch[k] = data[k] ? "1" : "0";
  for (const k of ["clean_ips", "ip_pool"]) if (Array.isArray(data[k])) patch[k] = data[k];
  try {
    const res = await api.saveSettings(patch);
    S.settings = res.settings;
    toast(t("settings.saved"), "ok");
    S.panelName = S.settings.panel_name || S.panelName;
    render();
  } catch (e) { fail(e); }
}

async function changePassword() {
  const form = $("#settings-form");
  const current = form?.pw_current?.value;
  const next = form?.pw_next?.value;
  if (!current || !next) return toast("هر دو فیلد رمز را پر کنید", "warn");
  try {
    await api.changePassword(current, next);
    toast("رمز تغییر کرد. دوباره وارد شوید.", "ok");
    await doLogout();
  } catch (e) { fail(e); }
}

function onChange(e) {
  const el = e.target;
  const a = el.dataset.action;
  if (a === "select-user") {
    el.checked ? S.selection.add(el.dataset.user) : S.selection.delete(el.dataset.user);
    el.closest("tr")?.classList.toggle("selected", el.checked);
    paintUsers();
    return;
  }
  if (a === "select-all") {
    S.selection = el.checked ? new Set(S.users.map((u) => u.username)) : new Set();
    return paintUsers();
  }
  if (a === "import-backup") return importBackup(el.files?.[0]);
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const yes = await confirmDialog(`${parsed.users?.length || 0} کاربر از فایل بازیابی شود؟ حالت «جایگزینی» کاربران فعلی را پاک می‌کند.`, { danger: true });
    if (!yes) return;
    const res = await api.post("/api/backup", { ...parsed, mode: "replace" });
    toast(`${res.imported} کاربر بازیابی شد`, "ok");
    await loadUsers();
  } catch (e) { fail(e); }
}

let searchTimer;
function onInput(e) {
  if (e.target.id !== "user-search") return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.query = e.target.value;
    S.page = 1;
    loadUsers();
  }, Number(e.target.dataset.debounce || 300));
}

function onKey(e) {
  const typing = /input|textarea|select/i.test(e.target.tagName);
  if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    return S.me ? openPalette() : null;
  }
  if (e.key === "Escape") {
    $(".overlay")?.remove();
    closeDrawer();
    closeModal();
    return;
  }
  if (!typing && S.me) {
    if (e.key === "/") { e.preventDefault(); $("#user-search")?.focus(); }
    if (e.key === "g") { S._g = Date.now(); }
    else if (S._g && Date.now() - S._g < 1200) {
      if (e.key === "d") go("dashboard");
      if (e.key === "u") go("users");
      if (e.key === "s") go("settings");
      S._g = 0;
    }
  }
}

/* ══ diagnostics runners ══════════════════════════════════════════════════ */
async function runProbe() {
  const proxy = $("#probe-input").value.trim();
  const out = $("#probe-out");
  if (!proxy) return toast("آدرس پروکسی را وارد کنید", "warn");
  out.innerHTML = `<div class="skeleton" style="height:34px"></div>`;
  try {
    const r = await api.probeNode(proxy);
    out.innerHTML = r.ok
      ? `<div class="badge ok">${icon("check")} سالم · ${num(r.latencyMs)} ms</div>`
      : `<div class="badge danger">${icon("alert")} قطع</div><div class="codebox" style="margin-top:8px">${esc(r.error || "")}</div>`;
  } catch (e) { out.innerHTML = `<div class="toast err">${esc(e.message)}</div>`; }
}

async function runRank() {
  const ips = $("#rank-input").value.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
  const out = $("#rank-out");
  if (!ips.length) return toast("آی‌پی وارد کنید", "warn");
  out.innerHTML = `<div class="skeleton" style="height:34px"></div>`;
  try {
    const r = await api.rankIps(ips, S.settings.public_host || location.hostname);
    out.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">${num(r.healthy)} از ${num(r.total)} سالم</div>
      <div class="codebox">${esc(r.ips.join("\n"))}</div>
      <div style="margin-top:8px">${copyButton(r.ips.join("\n"))}
      <button class="btn btn-sm" data-action="apply-ranked">${icon("check")} اعمال در آی‌پی تمیز</button></div>`;
    window.__ranked = r.ips;
  } catch (e) { out.innerHTML = `<div class="toast err">${esc(e.message)}</div>`; }
}

async function runPing() {
  const target = $("#ping-input").value.trim();
  const out = $("#ping-out");
  out.innerHTML = `<div class="skeleton" style="height:34px"></div>`;
  try {
    const r = await api.ping(target);
    out.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge ${r.avg == null ? "danger" : "ok"}">${r.avg == null ? "unreachable" : `${num(r.avg)} ms`}</span>
        ${r.colo ? `<span class="badge info">${esc(r.colo)}</span>` : ""}
        <span class="muted" style="font-size:12px">loss ${esc(r.loss)}</span></div>
      <div class="codebox" style="margin-top:8px;max-height:110px">${esc(JSON.stringify(r.samples, null, 2))}</div>`;
  } catch (e) { out.innerHTML = `<div class="toast err">${esc(e.message)}</div>`; }
}

async function runMaintenance() {
  const out = $("#maintenance-out");
  out.innerHTML = `<div class="skeleton" style="height:34px"></div>`;
  try {
    const r = await api.maintenance();
    out.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap">
        <span class="badge ok">${icon("check")} ${num(r.ms)} ms</span>
        <span class="badge ${r.expired_handled ? "info" : ""}">${esc(t("diag.expired"))}: ${num(r.expired_handled)}</span>
        <span class="badge">${esc(t("diag.ipsRotated"))}: ${num(r.ips_rotated)}</span>
      </div>
      <div class="codebox" style="margin-top:8px">${esc(JSON.stringify(r, null, 2))}</div>`;
    toast(t("diag.maintenanceDone"), "ok");
  } catch (e) { out.innerHTML = `<div class="toast err">${esc(e.message)}</div>`; }
}

// Delegated follow-up for the "apply ranked IPs" button injected above.
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-action='maintenance']")) return runMaintenance();
  if (!e.target.closest("[data-action='apply-ranked']")) return;
  try {
    const res = await api.saveSettings({ clean_ips: window.__ranked || [] });
    S.settings = res.settings;
    toast("آی‌پی‌های تمیز به‌روزرسانی شد", "ok");
  } catch (err) { fail(err); }
});

/* ── start ──────────────────────────────────────────────────────────────
   Deliberately the last statement in the module: boot() renders the shell,
   which reads NAV and the handler table. Starting earlier would only work by
   accident of the first `await` suspending before they are touched.        */
applyPrefs();
initFx();
boot();
