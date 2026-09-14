/**
 * Charts — ~90 lines of SVG, no library.
 *
 * Zeus draws nothing; it shows numbers in boxes. A panel that sells bandwidth
 * needs a trend line, so here is one, built with plain SVG so it renders
 * instantly, scales crisply, and adds 0 KB of dependencies.
 */
import { bytes, num, I18N } from "./i18n.js";

export function barChart(series, { height = 150, valueKey = "total", labelKey = "day", color = "var(--accent)" } = {}) {
  if (!series?.length) {
    return `<svg class="chart" viewBox="0 0 600 ${height}" preserveAspectRatio="none"><text x="300" y="${height / 2}" text-anchor="middle" class="chart-label">no data</text></svg>`;
  }
  const w = 600;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const max = Math.max(...series.map((d) => Number(d[valueKey] || 0)), 1);
  const bw = (w - pad.l - pad.r) / series.length;
  const bars = series
    .map((d, i) => {
      const v = Number(d[valueKey] || 0);
      const h = Math.max(2, ((v / max) * (height - pad.t - pad.b)));
      const x = pad.l + i * bw + bw * 0.18;
      const y = height - pad.b - h;
      const label = String(d[labelKey] || "").slice(5);
      return `<g><title>${d[labelKey]} — ${bytes(v)}</title>
        <rect class="chart-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="4" style="fill:${color}"/>
        <text class="chart-label" x="${(x + bw * 0.32).toFixed(1)}" y="${height - 7}" text-anchor="middle">${label}</text></g>`;
    })
    .join("");
  const grid = [0.25, 0.5, 0.75].map((f) => {
    const y = pad.t + (height - pad.t - pad.b) * f;
    return `<line class="chart-grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" stroke-dasharray="3 5"/>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img">${grid}${bars}
    <text class="chart-label" x="${pad.l}" y="10">${bytes(max)}</text></svg>`;
}

/** Stacked up/down — what actually matters when you're paying for egress. */
export function stackedChart(series, { height = 160 } = {}) {
  if (!series?.length) return barChart([]);
  const w = 600;
  const pad = { l: 8, r: 8, t: 14, b: 22 };
  const max = Math.max(...series.map((d) => (d.up || 0) + (d.down || 0)), 1);
  const bw = (w - pad.l - pad.r) / series.length;
  const inner = height - pad.t - pad.b;
  const bars = series.map((d, i) => {
    const x = pad.l + i * bw + bw * 0.18;
    const bwid = bw * 0.64;
    const hd = (d.down / max) * inner;
    const hu = (d.up / max) * inner;
    return `<g><title>${d.day} — ↓${bytes(d.down)} ↑${bytes(d.up)}</title>
      <rect x="${x.toFixed(1)}" y="${(height - pad.b - hd).toFixed(1)}" width="${bwid.toFixed(1)}" height="${hd.toFixed(1)}" rx="4" fill="var(--accent)" opacity=".85"/>
      <rect x="${x.toFixed(1)}" y="${(height - pad.b - hd - hu).toFixed(1)}" width="${bwid.toFixed(1)}" height="${hu.toFixed(1)}" rx="4" fill="var(--accent-2)" opacity=".85"/>
      <text class="chart-label" x="${(x + bwid / 2).toFixed(1)}" y="${height - 7}" text-anchor="middle">${String(d.day).slice(5)}</text></g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none">${bars}
    <text class="chart-label" x="${pad.l}" y="10">${bytes(max)}</text></svg>`;
}

export function sparkline(values, { width = 90, height = 26, color = "var(--accent)" } = {}) {
  if (!values?.length) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * width;
    const y = height - ((v - min) / span) * (height - 3) - 1.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

export function donut(pct, { size = 74, stroke = 8, color = "var(--accent)", label } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const dash = (p / 100) * c;
  const danger = p > 90 ? "var(--danger)" : p > 70 ? "var(--warn)" : color;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${p}%">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${danger}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})" style="transition:stroke-dasharray .6s cubic-bezier(.22,1,.36,1)"/>
    <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle"
      style="font:700 ${size * 0.24}px var(--font);fill:var(--text)">${label ?? `${Math.round(p)}%`}</text>
  </svg>`;
}
