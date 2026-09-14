/**
 * fx.js — the "alive" layer.
 *
 * Everything here is decorative and *additive*: it observes the DOM and adds
 * motion, never layout. No view knows it exists, so the contract tests and the
 * worker API are untouched. All effects are GPU-only (transform/opacity) and
 * fully disabled under `prefers-reduced-motion` or on coarse pointers where
 * they would fight scrolling.
 */

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(pointer: fine)");
const off = () => reduced.matches;

/* ── entrance stagger ───────────────────────────────────────────────────────
   New cards/rows fade-rise in sequence instead of popping. One MutationObserver
   for the whole app; nodes are tagged once (dataset.fx) so re-renders of the
   same view don't re-animate forever. */
let wave = 0;
let waveTimer = null;

function stagger(nodes) {
  if (off()) return;
  // a burst of insertions (one render) shares one wave index sequence
  wave = waveTimer ? wave : 0;
  clearTimeout(waveTimer);
  waveTimer = setTimeout(() => { wave = 0; waveTimer = null; }, 260);
  for (const el of nodes) {
    if (el.dataset.fx) continue;
    el.dataset.fx = "1";
    el.style.animationDelay = `${Math.min(wave, 10) * 45}ms`;
    el.classList.add("fx-in");
    wave++;
    el.addEventListener("animationend", () => { el.style.animationDelay = ""; }, { once: true });
  }
}

const WATCH = ".card, .toolbar, .bulkbar, tbody tr, .auth-card, .status-card, .tabs";
const observer = new MutationObserver((muts) => {
  const added = [];
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (!(n instanceof Element)) continue;
      if (n.matches(WATCH)) added.push(n);
      else added.push(...n.querySelectorAll(WATCH));
    }
  }
  if (added.length) stagger(added);
});

/* ── 3D tilt on cards (fine pointers only) ────────────────────────────────── */
function tilt(el) {
  if (!finePointer.matches || off() || el.dataset.tilt) return;
  el.dataset.tilt = "1";
  let raf = 0;
  el.addEventListener("pointermove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `translateY(-3px) perspective(900px) rotateX(${(-py * 4).toFixed(2)}deg) rotateY(${(px * 5).toFixed(2)}deg)`;
    });
  });
  el.addEventListener("pointerleave", () => { el.style.transform = ""; });
}

/* ── ripple on buttons ────────────────────────────────────────────────────── */
function ripple(e) {
  const btn = e.target.closest?.(".btn, .nav-item, .seg button, .tabs button");
  if (!btn || off()) return;
  const r = btn.getBoundingClientRect();
  const d = Math.max(r.width, r.height);
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = `${d}px`;
  s.style.left = `${e.clientX - r.left - d / 2}px`;
  s.style.top = `${e.clientY - r.top - d / 2}px`;
  btn.append(s);
  setTimeout(() => s.remove(), 650);
}

/* ── count-up for KPI numbers ─────────────────────────────────────────────── */
function countUp(el) {
  if (off() || el.dataset.counted) return;
  const raw = el.textContent.trim();
  const match = raw.match(/^[\d.,٬]+$/);
  if (!match) return;
  el.dataset.counted = "1";
  const target = Number(raw.replaceAll(/[.,٬]/g, ""));
  if (!Number.isFinite(target) || target === 0) return;
  const grouped = raw.includes(",") || raw.includes("٬");
  const t0 = performance.now();
  const dur = 700;
  const fmt = (n) => (grouped ? n.toLocaleString("en-US") : String(n));
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = fmt(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = raw;
  };
  requestAnimationFrame(step);
}

/* ── boot ─────────────────────────────────────────────────────────────────── */
export function initFx(root = document.body) {
  observer.observe(root, { childList: true, subtree: true });
  document.addEventListener("pointerdown", ripple, { passive: true });
  // tilt + count-up need to catch existing nodes too, not only new ones
  const sweep = () => {
    document.querySelectorAll(".card").forEach(tilt);
    document.querySelectorAll(".kpi-value").forEach(countUp);
  };
  sweep();
  const so = new MutationObserver(() => requestAnimationFrame(sweep));
  so.observe(root, { childList: true, subtree: true });
}
