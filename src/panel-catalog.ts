/**
 * Panel catalogue ported from the standalone OMNI worker (`worker.js`).
 *
 * The worker kept this as a plain data table and drove the whole deploy wizard
 * from it; the control plane does the same so «🚀 دیپلوی پنل جدید» shows the very
 * same panels in the same order. `sourceUrl` is data, not code: `panel-source.ts`
 * refuses any host that is not in PANEL_SOURCE_HOSTS, and `scripts/preflight.mjs`
 * allows this single file to mention those hosts so the rule still guards the
 * rest of src/.
 */
import type { TelegramInlineKeyboard } from "./types.js";

export type PanelDbKind = "none" | "kv" | "d1";

export interface PanelSpec {
  key: string;
  name: string;
  desc: string;
  /** Path the panel answers on, appended to the workers.dev host. */
  path: string;
  db: PanelDbKind;
  defaultPass: string;
  /** Empty string means: no third-party source, deploy the repo's own data plane. */
  sourceUrl: string;
  /** KV binding names the panel expects (case matters — panels read them literally). */
  kvNames: readonly string[];
  /** D1 binding names the panel expects. */
  d1Names: readonly string[];
  /** What the bot injects into the source, so the note in chat stays honest. */
  inject: string;
}

/** Hosts a panel source may be downloaded from. Enforced by panel-source.ts. */
export const PANEL_SOURCE_HOSTS: readonly string[] = [
  "github.com",
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
];

export const PANEL_CATALOG: readonly PanelSpec[] = [
  {
    key: "bpb",
    name: "🅱️ BPB Panel (Stable Latest)",
    desc: "فرگمنت هوشمند، DoH - Auto UUID",
    path: "/panel",
    db: "kv",
    defaultPass: "admin123456",
    sourceUrl: "https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/download/v4.2.3/worker.js",
    kvNames: ["kv"],
    d1Names: [],
    inject: "رمز پنل در کلید «pwd» همان KV ذخیره می‌شود و UUID/TR_PASS به‌عنوان متغیر ست می‌شود",
  },
  {
    key: "nahan",
    name: "🎩 ناهان v2.5+",
    desc: "D1",
    path: "/sync/dash",
    db: "d1",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/itsyebekhe/nahan/main/_worker.js",
    kvNames: [],
    d1Names: ["IOT_DB", "DB"],
    inject: "masterKey داخل سورس با رمزی که می‌دهید جایگزین می‌شود",
  },
  {
    key: "zeus",
    name: "⚡ Zeus",
    desc: "D1",
    path: "/panel",
    db: "d1",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js",
    kvNames: [],
    d1Names: ["DB"],
    inject: "یک D1 تازه ساخته و به بایند DB وصل می‌شود",
  },
  {
    key: "spider",
    name: "🕷️ Spider",
    desc: "Arvan",
    path: "/",
    db: "kv",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/amirh00sain/SpiderPanel/main/_worker.js",
    kvNames: ["SPIDER_KV"],
    d1Names: [],
    inject: "توکن و دامنهٔ پنل به‌جای placeholderهای سورس گذاشته می‌شود",
  },
  {
    key: "nova",
    name: "🌌 Nova",
    desc: "VLESS/Trojan",
    path: "/sub",
    db: "kv",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js",
    kvNames: ["KV", "kv"],
    d1Names: [],
    inject: "مسیرهٔ ساب با یک کلید تصادفی ساخته می‌شود (/{key}) و رمز از PASSWORD خوانده می‌شود",
  },
  {
    key: "edgetunnel",
    name: "🌐 EdgeTunnel",
    desc: "Universal",
    path: "/sub",
    db: "kv",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js",
    kvNames: ["KV", "kv"],
    d1Names: [],
    inject: "مثل Nova: کلید ساب تصادفی + UUID/PASSWORD/PROXYIP به‌عنوان متغیر",
  },
  {
    key: "vless_core",
    name: "🌀 VLESS-Core",
    desc: "سبک",
    path: "/sub",
    db: "none",
    defaultPass: "admin",
    sourceUrl: "https://raw.githubusercontent.com/zizifn/edgetunnel/main/src/worker-vless.js",
    kvNames: [],
    d1Names: [],
    inject: "صفحهٔ کانفیگ روی /{UUID} است؛ KV لازم ندارد",
  },
  {
    key: "omni_pro",
    name: "👑 OMNI PRO (اختصاصی)",
    desc: "دیتاپلن خود همین ریپو",
    path: "/",
    db: "kv",
    defaultPass: "admin",
    sourceUrl: "",
    kvNames: ["kv", "KV"],
    d1Names: [],
    inject: "سورس از داخل ریپو (src/data-plane-source.ts) آپلود می‌شود، نه از بیرون",
  },
];

export const PANEL_KEYS: readonly string[] = PANEL_CATALOG.map((panel) => panel.key);

export function findPanel(key: string): PanelSpec | null {
  return PANEL_CATALOG.find((panel) => panel.key === key) ?? null;
}

export function panelCatalogText(): string {
  const lines = ["🚀 <b>انتخاب پنل:</b>", ""];
  for (const panel of PANEL_CATALOG) {
    lines.push(`• <b>${panel.name}</b> — ${panel.desc}`);
  }
  lines.push(
    "",
    "هر پنل با قواعد خودش استقرار می‌یابد (KV یا D1، مسیر پنل، تزریق رمز).",
    "بعد از انتخاب، فقط <b>نام Worker</b> و <b>رمز پنل</b> را می‌پرسم.",
  );
  return lines.join("\n");
}

/** Two panels per row, exactly like the worker's picker, plus the back rows. */
export function panelCatalogKeyboard(connectionId?: string): TelegramInlineKeyboard {
  const suffix = connectionId ? `:${connectionId}` : "";
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  for (let index = 0; index < PANEL_CATALOG.length; index += 2) {
    const row = PANEL_CATALOG.slice(index, index + 2).map((panel) => ({
      text: panel.name.slice(0, 42),
      callback_data: `v13:dep-panel:${panel.key}${suffix}`,
    }));
    rows.push(row);
  }
  rows.push([{ text: "🖥️ استقرار کامل VPS (۷ قدم)", callback_data: `v13:dep-vps${suffix}` }]);
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return { inline_keyboard: rows };
}

/** Splits `v13:dep-panel:<key>:<connectionId>` back into its parts. */
export function parsePanelPick(data: string): { key: string; connectionId: string } | null {
  const match = /^v13:dep-panel:([a-z0-9_]+)(?::([a-zA-Z0-9-]+))?$/u.exec(data);
  if (!match) return null;
  return { key: match[1] ?? "", connectionId: match[2] ?? "" };
}

export function panelPromptFor(panel: PanelSpec): string {
  return [
    `پنل: <b>${panel.name}</b>`,
    panel.desc ? panel.desc : "",
    "",
    `📌 پنل روی مسیر <code>${panel.path}</code> بالا می‌آید.`,
    `🪝 ${panel.inject}`,
    panel.sourceUrl ? "" : "📦 منبع: سورس خود ریپو — بدون دانلود از بیرون.",
    "",
    "حالا <b>نام Worker</b> را بفرستید (انگلیسی کوچک، عدد و خط‌تیره، حداقل ۳ نویسه).",
    "مثال: <code>my-bpb</code>",
  ].filter((line) => line !== "").join("\n");
}

/** Same sanitizer the worker used: lowercase, [a-z0-9-], no leading/trailing dash. */
export function sanitizeWorkerName(text: string): string | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  if (cleaned.length < 3 || cleaned.length > 64) return null;
  return cleaned;
}

/** The worker only required 4 characters; keep that, but cap the length. */
export function sanitizePanelPassword(text: string): string | null {
  const value = text.trim();
  if (value.length < 4 || value.length > 64) return null;
  return value;
}

export function panelLoginNote(panel: PanelSpec): string {
  if (panel.key === "bpb") return "\n\n🔐 اگه رفت به صفحهٔ login، همان رمز بالا را بزنید.";
  if (panel.key === "nova" || panel.key === "edgetunnel") {
    return "\n\n🔑 مدیریت: <code>/login</code> با همان رمز — لینک ساب را در کلاینت بگذارید.";
  }
  if (panel.key === "vless_core") return "\n\n📄 لینک بالا صفحهٔ کانفیگ است؛ متن vless:// را کپی کنید.";
  if (panel.key === "nahan") return "\n\n🎩 داشبورد ناهان روی /sync/dash است و masterKey همان رمز شماست.";
  return "";
}
