/**
 * UI primitives. No framework, no virtual DOM — plain strings plus event
 * delegation. The whole panel is ~35 KB of JS; React alone would be 45 KB
 * before a single component existed.
 */
import { t, I18N, bytes, num, timeLeft, timeAgo } from "./i18n.js";

export const esc = (s) =>
  String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/* ── icons ─────────────────────────────────────────────────────────────── */
const P = {
  dash: "M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 2h-4l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  copy: "M9 9h10v12H9zM5 15H3V3h12v2",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  edit: "M11 4H4v16h16v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z",
  close: "M18 6 6 18M6 6l12 12",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2M12 21v-2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M22 12h-2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5-2.3 3.8-5.3 3.8-9S14.5 4.3 12 2C9.5 4.3 8.2 7.3 8.2 11s1.3 6.7 3.8 9ZM2.5 9h19M2.5 15h19",
  check: "M20 6 9 17l-5-5",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  bolt: "M13 2 3 14h7v8l10-12h-7z",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  qr: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 21h1v-3M21 14v1",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  play: "M6 3l14 9-14 9z",
  menu: "M3 6h18M3 12h18M3 18h18",
  chevron: "m9 18 6-6-6-6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2",
  filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
  key: "M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7 7 5 5 0 0 1 7-7Zm0 0L15 8m0 0 3 3 3-3-3-3",
  db: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Zm8-3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5m16 7c0 1.7-3.6 3-8 3s-8-1.3-8-3",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  wifi: "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0",
};
const FILLED = new Set(["dash", "bolt", "play", "filter"]);

export function icon(name, cls = "") {
  const d = P[name] || P.bolt;
  const filled = FILLED.has(name);
  // width/height ATTRIBUTES (not CSS): contexts that style svg themselves
  // (.btn svg, .qr svg, .chart …) override these, everywhere else the icon
  // stays 18 px instead of stretching to the container width.
  return `<svg viewBox="0 0 24 24" width="18" height="18" class="${cls}" fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/* ── toasts ────────────────────────────────────────────────────────────── */
export function toast(message, kind = "info", ms = 3200) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "err" ? "alert" : kind === "ok" ? "check" : "bolt")} <span>${esc(message)}</span>`;
  el.style.display = "flex";
  el.style.gap = "8px";
  el.style.alignItems = "center";
  host.append(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s, transform .25s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ── modal ─────────────────────────────────────────────────────────────── */
let modalRoot = null;
export function openModal({ title, body, footer = "", wide = false, onMount }) {
  closeModal();
  modalRoot = document.createElement("div");
  modalRoot.className = "overlay";
  modalRoot.innerHTML = `<div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><div class="spacer"></div>
        <button class="btn btn-ghost btn-icon" data-action="close-modal" aria-label="${esc(t("common.close"))}">${icon("close")}</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
    </div>`;
  modalRoot.addEventListener("mousedown", (e) => { if (e.target === modalRoot) closeModal(); });
  document.body.append(modalRoot);
  document.body.style.overflow = "hidden";
  onMount?.(modalRoot);
  modalRoot.querySelector("input,select,textarea,button")?.focus();
  return modalRoot;
}
export function closeModal() {
  modalRoot?.remove();
  modalRoot = null;
  if (!document.querySelector(".drawer")) document.body.style.overflow = "";
}
export const modalEl = () => modalRoot;

/** Promise-based confirm. Native confirm() is ugly and blocks the thread. */
export function confirmDialog(message, { danger = false, okLabel } = {}) {
  return new Promise((resolve) => {
    const root = openModal({
      title: danger ? t("common.delete") : "؟",
      body: `<p style="margin:0;font-size:14px;line-height:1.8">${esc(message)}</p>`,
      footer: `<button class="btn" data-confirm="no">${esc(t("common.cancel"))}</button>
               <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm="yes">${esc(okLabel || t("common.yes"))}</button>`,
      onMount: (m) => {
        m.addEventListener("click", (e) => {
          const b = e.target.closest("[data-confirm]");
          if (!b) return;
          closeModal();
          resolve(b.dataset.confirm === "yes");
        });
      },
    });
    root?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeModal(); resolve(false); }
    });
  });
}

/* ── drawer ────────────────────────────────────────────────────────────── */
export function openDrawer({ title, body, footer = "", onMount }) {
  closeDrawer();
  const el = document.createElement("div");
  el.className = "drawer";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><div class="spacer"></div>
      <button class="btn btn-ghost btn-icon" data-action="close-drawer">${icon("close")}</button></div>
    <div class="modal-body" style="flex:1">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ""}`;
  document.body.append(el);
  document.body.style.overflow = "hidden";
  onMount?.(el);
  return el;
}
export function closeDrawer() {
  document.querySelector(".drawer")?.remove();
  if (!modalRoot) document.body.style.overflow = "";
}
export const setDrawerBody = (html) => {
  const b = document.querySelector(".drawer .modal-body");
  if (b) b.innerHTML = html;
};

/* ── small pieces ──────────────────────────────────────────────────────── */
export const meter = (pct, cls = "") =>
  `<div class="meter ${cls}"><div class="meter-fill ${pct > 90 ? "danger" : pct > 70 ? "warn" : ""}" style="width:${Math.min(100, pct)}%"></div></div>`;

export const statusBadge = (status) => {
  const map = { active: "ok", expired: "danger", exhausted: "warn", disabled: "" };
  return `<span class="badge ${map[status] ?? ""}">${esc(t(`users.status.${status}`))}</span>`;
};

export function copyButton(text, label = t("common.copy"), small = true) {
  return `<button class="btn ${small ? "btn-sm" : ""}" data-action="copy" data-copy="${esc(text)}">${icon("copy")} ${esc(label)}</button>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back for http:// previews.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
}

/** QR from the vendored local encoder — never a CDN. */
export function qrSvg(text, size = 168) {
  const factory = globalThis.qrcode;
  if (!factory || !text) return "";
  try {
    const qr = factory(0, "M"); // auto version, medium ECC
    qr.addData(text, "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    return "";
  }
}

export function skeletonRows(n = 6) {
  return Array.from({ length: n }, () => `<tr><td colspan="7"><div class="skeleton" style="height:16px"></div></td></tr>`).join("");
}

export const kpi = ({ icon: ic, label, value, sub, tone = "" }) => `
  <div class="card" style="display:flex;gap:13px;align-items:flex-start">
    <div class="kpi-icon" style="${tone ? `background:color-mix(in srgb, ${tone} 14%, transparent);color:${tone}` : ""}">${icon(ic)}</div>
    <div style="min-width:0;flex:1">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value">${value}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
    </div>
  </div>`;

export { t, I18N, bytes, num, timeLeft, timeAgo };
