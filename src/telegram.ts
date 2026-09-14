import {
  botConnectionBoundary,
  botCreateDeployment,
  botDeleteDeployment,
  botDisconnectConnection,
  botGetDeployment,
  botListConnections,
  botListDeployments,
  botPrincipal,
  botRetryDeployment,
  botRevokeDeployment,
  botRotateBootstrap,
  botRotateSubscription,
  type BotBootstrap,
  type BotConnectionSummary,
  type BotDeploymentSummary,
} from "./bot-actions";
import {
  findPanel,
  panelCatalogKeyboard,
  panelCatalogText,
  panelPromptFor,
  parsePanelPick,
  sanitizePanelPassword,
  sanitizeWorkerName,
} from "./panel-catalog";
import {
  deletePanelDeployment,
  deployPanel,
  listPanelDeployments,
  panelDeployText,
  type PanelDeploymentRow,
} from "./panel-deploy";
import { applySniDefault, applyUfwChoice, beginDeployWizard, cancelKeyboard, clearWizard, loadWizard, processWizardText } from "./telegram-wizard";
import { audit, rateLimit } from "./db";
import { getConnection, getValidCloudflareAuth } from "./cloudflare-api";
import { HttpError, json, readJson } from "./http";
import { connectPanelTokenFromChat } from "./api-token";
import {
  cleanIpPool,
  cleanIpRankingText,
  cleanIpReportTargets,
  cleanIpResolversText,
  CLEAN_IP_CITIES,
  CLEAN_IP_OPERATORS,
  CLEAN_IP_STATUS_LABELS,
  findCity,
  findOperator,
  rankCleanIps,
  type CleanIpRow,
} from "./clean-ip";
import { aggregateMap, mapText, MAP_ISPS, MAP_TRANSPORT_LABELS, MAP_TRANSPORTS } from "./censorship-map";
import { directRaceDomains, listRaceWinners, raceLine } from "./domestic-race";
import {
  DNS_SCAN_INTERVAL_MINUTES,
  healthyResolvers,
  rangeRoundSummary,
  replaceScanRange,
  runScanTick,
  scanRangeStatus,
  logDnsCenterAction,
  type RangeScanSummary,
  type ScanProgress,
} from "./dns-center";
import { poisonLine, poisonSummary } from "./dns-poison";
import { slipnetUri, TUNNEL_DEFAULT_MTU } from "./dns-tunnel";
import { cloudflarePanelTemplateUrl, issueConnectLink } from "./dns-connect";
import { latestRirSnapshot, rirCardLine } from "./geoip-ir";
import { renderDnsttIntroText } from "./dnstt";
import { upsertDnsRecord } from "./cloudflare-api";
import { clearWhiteHoleDrop, latestWhiteHoleDrop, publishWhiteHoleDrop, whiteHoleReadCommands, whiteHoleText } from "./whitehole";
import {
  DONATION_STATUS_LABELS,
  donationConsentText,
  donationMineText,
  donationPoolStats,
  donationPoolText,
  listDonations,
  setDonationStatus,
  withdrawDonation,
} from "./ai-donate";
import {
  clearPanelFlow,
  flowPrompt,
  FLOW_STEP_DNS_RANGE,
  FLOW_STEP_DNSTT_VPS,
  FLOW_STEP_WHITE_DOMAINS,
  FLOW_STEP_DONATE_KEY,
  FLOW_STEP_MAP_CITY,
  FLOW_STEP_MAP_ISP,
  FLOW_STEP_MAP_RTT,
  FLOW_STEP_MAP_TRANSPORT,
  FLOW_STEP_MAP_VERDICT,
  FLOW_STEP_PACK_DOMAIN,
  FLOW_STEP_RUM_PING,
  FLOW_STEP_PANEL_TOKEN,
  FLOW_STEP_PANEL_NAME,
  FLOW_STEP_PANEL_PASS,
  loadPanelFlow,
  panelFlowKeyboard,
  processPanelFlowText,
  savePanelFlow,
  type PanelFlow,
} from "./panel-flows";
import {
  findHelpTopic,
  helpIndexKeyboard,
  helpIndexText,
  helpTopicKeyboard,
  helpTopicText,
} from "./help-topics";
import {
  engineStatus,
  engineStatusText,
  listNodeHealth,
  nodeHealthText,
  panelCounters,
  rosterText,
  usageText,
} from "./panel-overview";
import {
  addSecondsIso,
  constantTimeEqual,
  escapeHtml,
  nowIso,
  parsePositiveInt,
  randomToken,
  sha256,
} from "./security";
import type {
  Env,
  SessionPrincipal,
  TelegramCallbackQuery,
  TelegramFrom,
  TelegramInlineKeyboard,
  TelegramUpdate,
} from "./types";

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

const TELEGRAM_RATE_LIMIT = 12;
const TELEGRAM_MAX_UPDATE_AGE_SECONDS = 600;
const TELEGRAM_RATE_WINDOW_SECONDS = 60;

/** Commands owned by the V13 / Omni-private section of the bot. */
export const V13_COMMANDS = [
  "start", "panel", "status", "help", "cancel",
  "cleanip", "map", "whitehole", "donate", "health", "usage",
  "pack", "dnstt",
] as const;
export type V13Command = (typeof V13_COMMANDS)[number];

/** Deep-link arguments (`/start <arg>`) that open the V13 private environment directly. */
export const V13_DEEP_LINK_ARGS: ReadonlySet<string> = new Set(["v13", "panel", "app", "omni"]);

/** Plain-text menu labels accepted as equivalents of the inline buttons. */
export const OMNI_MENU_TEXT_SATELLITE = "🛰️ محیط اختصاصی V13";
export const OMNI_MENU_TEXT_DEPS = "📦 استقرارها";
export const OMNI_MENU_TEXT_CONNS = "🔌 اتصال Cloudflare";
export const OMNI_MENU_TEXT_STATUS = "📊 وضعیت استقرارها";
export const OMNI_MENU_TEXT_HELP = "❓ راهنما";
export const OMNI_MENU_TEXT_HOME = "🏠 منوی اصلی";
export const OMNI_MENU_TEXT_CLEAN_IP = "💎 آی‌پی تمیز";
export const OMNI_MENU_TEXT_MAP = "🗺 نت ملی";
export const OMNI_MENU_TEXT_WHITEHOLE = "🌪️ WhiteHole";
export const OMNI_MENU_TEXT_DONATE = "🎁 اهدای AI";
export const OMNI_MENU_TEXT_HEALTH = "🩺 سلامت نودها";
export const OMNI_MENU_TEXT_USAGE = "📈 مصرف";
export const OMNI_MENU_TEXT_CHECK = "🔍 هلث چک";
export const OMNI_MENU_TEXTS: ReadonlySet<string> = new Set([
  OMNI_MENU_TEXT_SATELLITE,
  OMNI_MENU_TEXT_DEPS,
  OMNI_MENU_TEXT_CONNS,
  OMNI_MENU_TEXT_STATUS,
  OMNI_MENU_TEXT_HELP,
  OMNI_MENU_TEXT_HOME,
  OMNI_MENU_TEXT_CLEAN_IP,
  OMNI_MENU_TEXT_MAP,
  OMNI_MENU_TEXT_WHITEHOLE,
  OMNI_MENU_TEXT_DONATE,
  OMNI_MENU_TEXT_HEALTH,
  OMNI_MENU_TEXT_USAGE,
  OMNI_MENU_TEXT_CHECK,
]);

const STATUS_FA: Record<string, string> = {
  queued: "در صف",
  preparing: "در حال آماده‌سازی",
  awaiting_agent: "در انتظار نصب روی VPS",
  agent_ready: "نصب شد؛ در حال نهایی‌سازی",
  finalizing: "در حال نهایی‌سازی",
  ready: "فعال ✅",
  revoking: "در حال ابطال",
  failed: "ناموفق ❌",
  revoked: "باطل‌شده",
};

export function faDeploymentStatus(status: string): string {
  return STATUS_FA[status] ?? status;
}

export interface ParsedBotCommand {
  command: string;
  args: string[];
}

/** Parse `/command@bot arg1 arg2`. Returns null for non-commands or mentions of another bot. */
export function parseBotCommand(text: string | undefined, botUsername: string): ParsedBotCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...args] = trimmed.split(/\s+/u);
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).slice(1).toLowerCase();
  const mention = at === -1 ? "" : head.slice(at + 1);
  if (!command) return null;
  if (mention && mention.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { command, args };
}

/**
 * True when an update belongs to the V13 / Omni-private section.
 * An external Omni worker can use this to decide which updates to forward here.
 */
export function isV13TelegramUpdate(update: TelegramUpdate, botUsername: string): boolean {
  const data = update.callback_query?.data ?? "";
  if (data.startsWith("v13:") || data.startsWith("omni:") || data.startsWith("wiz:")) return true;
  const text = update.message?.text ?? "";
  const parsed = parseBotCommand(text, botUsername);
  if (parsed && (V13_COMMANDS as readonly string[]).includes(parsed.command)) return true;
  if (OMNI_MENU_TEXTS.has(text.trim())) return true;
  return false;
}

/**
 * Main Omni menu. The private-environment entry stays as its own separate
 * section; full worker management lives in the sections below it.
 */
const MENU_ROWS: TelegramInlineKeyboard["inline_keyboard"] = [
  [{ text: "🛰️ ورود به محیط اختصاصی V13", callback_data: "v13:login" }],
  [
    { text: "💎 آی‌پی تمیز", callback_data: "v13:ip" },
    { text: "🗺 نت ملی", callback_data: "v13:map" },
  ],
  [
    { text: "🌪️ WhiteHole", callback_data: "v13:wh" },
    { text: "🎁 اهدای AI", callback_data: "v13:donate" },
  ],
  // The DNS center is its own top-level section, never nested in other hubs.
  [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
  [{ text: "🌪️ تونل DNS (dnstt)", callback_data: "v13:dnstt" }],
  [
    { text: "🔍 هلث چک", callback_data: "v13:check" },
    { text: "❓ راهنما", callback_data: "v13:help" },
  ],
  [
    { text: "📁 دیپلوی‌های من", callback_data: "v13:deps" },
    { text: "🚀 دیپلوی پنل جدید", callback_data: "v13:dep:new" },
  ],
  [{ text: "👻 PHANTOM ۲۰تایی", callback_data: "v13:pack" }],
  // Owner request: the Cloudflare connection row lives ONLY inside the private
  // environment menu, never in the open menu.
  [{ text: "🔌 اتصال Cloudflare", callback_data: "v13:conns" }],
  [
    { text: "📊 وضعیت", callback_data: "v13:status" },
    { text: "🩺 سلامت نودها", callback_data: "v13:health" },
  ],
  [
    { text: "📈 مصرف و دارایی‌ها", callback_data: "v13:usage" },
  ],
];

/* The locked private environment keeps only the tenant-wide management rows. */
const ENV_CALLBACKS = new Set(["v13:conns", "v13:status", "v13:health", "v13:usage", "v13:roster", "v13:engine"]);

/** Home order: the panel deploy tools sit right under the environment entry, as in the panel worker. */
const HOME_ORDER = [
  "v13:login", "v13:deps", "v13:dep:new", "v13:pack",
  "v13:ip", "v13:map", "v13:wh", "v13:donate", "v13:check", "v13:help",
];

function rowRank(row: TelegramInlineKeyboard["inline_keyboard"][number]): number {
  const ranks = row
    .map((button) => HOME_ORDER.indexOf(button.callback_data ?? ""))
    .filter((rank) => rank >= 0);
  return ranks.length ? Math.min(...ranks) : HOME_ORDER.length;
}

/** Splits the single row table into the open home menu and the locked environment menu. */
function menuRows(environment: boolean): TelegramInlineKeyboard["inline_keyboard"] {
  const rows = MENU_ROWS.map((row) =>
    row.filter((button) => ENV_CALLBACKS.has(button.callback_data ?? "") === environment),
  ).filter((row) => row.length > 0);
  return environment ? rows : [...rows].sort((a, b) => rowRank(a) - rowRank(b));
}

export function omniMainMenuKeyboard(): TelegramInlineKeyboard {
  return { inline_keyboard: menuRows(false) };
}

/**
 * Management rows, moved inside the 🛰️ environment. Its message is sent with
 * protect_content and Telegram keeps that flag across edits, so everything
 * rendered in place there stays copy/screenshot-proof.
 */
export function omniEnvMenuKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      ...menuRows(true),
      [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
    ],
  };
}

function loginEnvKeyboard(appUrl: string, webUrl: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      ...loginKeyboard(appUrl, webUrl).inline_keyboard,
      ...omniEnvMenuKeyboard().inline_keyboard,
    ],
  };
}

const ENV_NOTICE =
  "\n\n🔐 این پیام و همهٔ بخش‌هایش محافظت‌شده‌اند: کپی، فوروارد و اسکرین‌شات قفل است. «🏠 منوی اصلی Omni» به بخش‌های آزاد برمی‌گردد.";

export function omniBackMenuKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]],
  };
}

export function omniWelcomeText(): string {
  return [
    "به دروازهٔ Omni × V13 خوش آمدید 👋",
    "",
    "🛰️ «محیط اختصاصی V13» پنل کامل شماست — جدا و امن.",
    "📦 از همین‌جا هم می‌توانید استقرار بسازید، وضعیت ببینید، تلاش مجدد کنید، بوت‌استرپ بگیرید و اتصال Cloudflare را مدیریت کنید.",
    "💎 بخش‌های پنل مستقل OMNI به این ربات منتقل شده‌اند: رادار IP تمیز، نقشهٔ نت ملی، هددراپ WhiteHole و استخر اهدای AI.",
    "",
    "⚠️ هیچ API Token یا رمز سروری را در چت ارسال نکنید.",
  ].join("\n");
}

export function omniLoginText(ttlMinutes: number): string {
  return [
    "🔐 لینک یک‌بارمصرف محیط اختصاصی آماده است.",
    "",
    `هر لینک ${ttlMinutes} دقیقه اعتبار دارد و بعد از اولین استفاده باطل می‌شود.`,
    "«در تلگرام» پنل را همین‌جا باز می‌کند؛ «در مرورگر» در مرورگر گوشی.",
  ].join("\n");
}

export function omniHelpText(): string {
  return [
    "❓ راهنمای ربات V13",
    "",
    "🛰️ ورود به محیط اختصاصی: پنل کامل (مرورگر یا داخل تلگرام)",
    "📦 استقرارها: ساخت قدم‌به‌قدم، جزئیات، تلاش مجدد، ابطال، بوت‌استرپ، اشتراک‌ها",
    "🔌 اتصال Cloudflare: مشاهده و قطع اتصال (ساخت اتصال جدید فقط در پنل امن)",
    "💎 آی‌پی تمیز: رتبه‌بندی IPها فقط از گزارش واقعی کلاینت‌ها · /cleanip",
    "🗺 نت ملی: نقشهٔ زندهٔ سانسور از گزارش‌های ناشناس · /map",
    "🌪️ WhiteHole: انتشار هددراپ TXT در Zone خودتان برای روز قطعی · /whitehole",
    "🎁 اهدای AI: ثبت رمزنگاری‌شدهٔ کلید برای استخر، با پس‌گرفتن · /donate",
    "🩺 سلامت نودها و 📈 مصرف: شمارش‌های واقعی D1 · /health و /usage",
    "",
    "/start — منوی اصلی · /panel — ورود · /status — وضعیت · /cancel — لغو فرایند نیمه‌کاره",
  ].join("\n");
}

export function omniUnknownCommandText(): string {
  return "این دستور برای من آشنا نیست. از دکمه‌های منوی اصلی استفاده کنید 👇";
}

export function omniFreeTextReply(): string {
  return [
    "پیام متنی شما ذخیره نمی‌شود.",
    "اگر API Token یا رمزی ارسال کرده‌اید، همین حالا آن را در سرویس مبدأ بچرخانید یا حذف کنید.",
    "برای ادامه از دکمه‌های منو استفاده کنید 👇",
  ].join("\n");
}

export interface DeploymentStatusRow {
  worker_name: string;
  status: string;
  node_hostname: string;
  updated_at: string;
}

export function formatDeploymentStatus(rows: DeploymentStatusRow[]): string {
  if (rows.length === 0) {
    return [
      "📊 هنوز استقراری ندارید.",
      "",
      "از «ورود به محیط اختصاصی V13» وارد شوید و اولین نود واقعی را بسازید.",
    ].join("\n");
  }
  const lines = rows.map((row) => `• ${row.worker_name} — ${faDeploymentStatus(row.status)}\n  ${row.node_hostname}`);
  return ["📊 وضعیت استقرارهای شما:", "", ...lines, "", "جزئیات و عملیات از بخش «📦 استقرارها» در دسترس است."].join("\n");
}

/** Map worker errors to short Persian messages. Returns null when the caller must show the reconnect prompt. */
export function faErrorMessage(error: unknown): string | null {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "deployment_resource_conflict":
        return "این نام Worker یا دامنه قبلاً استفاده شده است؛ یکی دیگر انتخاب کنید.";
      case "cloudflare_reconnect_required":
        return null;
      case "invalid_deployment_state":
        return "این عملیات در وضعیت فعلی استقرار مجاز نیست.";
      case "invalid_connection":
        return "اتصال Cloudflare معتبر نیست یا منقضی شده است.";
      case "zone_mismatch":
        return "Zone در حساب انتخاب‌شده فعال نیست.";
      case "hostname_zone_mismatch":
        return "هر دو زیردامنه باید متعلق به همان Zone باشند.";
      case "invalid_reality_target":
        return "مقصد Reality نباید خودِ همین نود باشد.";
      case "cloudflare_resource_mismatch":
        return "منبع انتخاب‌شده خارج از محدودهٔ این اتصال است.";
      case "cloudflare_connection_busy":
        return "این اتصال هنوز توسط یک استقرار فعال لازم است؛ اول آن را تمام یا باطل کنید.";
      case "deployment_not_found":
        return "استقرار پیدا نشد.";
      case "deployment_not_deletable":
        return "فقط استقرار ناموفق یا باطل‌شده حذف می‌شود؛ برای نود زنده اول «🛑 ابطال» را بزنید.";
      case "invalid_input":
        return "ورودی معتبر نیست؛ دوباره بررسی کنید.";
      case "cloudflare_api_error":
        return `کلادفلر این عملیات را رد کرد: ${error.message}`;
      default:
        return "خطای موقت؛ کمی بعد دوباره تلاش کنید.";
    }
  }
  return "خطای موقت؛ کمی بعد دوباره تلاش کنید.";
}

async function ensureTenant(env: Env, from: TelegramFrom): Promise<{ id: string; displayName: string }> {
  const now = nowIso();
  const tenantId = crypto.randomUUID();
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ").slice(0, 120);
  await env.DB.prepare(
    `INSERT INTO tenants (id, telegram_user_id, telegram_username, display_name, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       display_name = excluded.display_name,
       locale = excluded.locale,
       updated_at = excluded.updated_at`,
  ).bind(tenantId, String(from.id), from.username ?? null, displayName, from.language_code ?? null, now, now).run();
  const tenant = await env.DB.prepare("SELECT id, display_name FROM tenants WHERE telegram_user_id = ?")
    .bind(String(from.id)).first<{ id: string; display_name: string }>();
  if (!tenant) throw new Error("Tenant upsert failed");
  return { id: tenant.id, displayName: tenant.display_name };
}

async function issueLoginLink(env: Env, tenantId: string): Promise<{ loginUrl: string; ttlMinutes: number }> {
  const rawLinkToken = randomToken(32);
  const tokenHash = await sha256(rawLinkToken);
  const ttl = parsePositiveInt(env.LOGIN_LINK_TTL_SECONDS, 900, 3600);
  await env.DB.prepare(
    "INSERT INTO login_links (token_hash, tenant_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, tenantId, addSecondsIso(ttl), nowIso()).run();
  const loginUrl = `${new URL(env.PUBLIC_BASE_URL).origin}/login?t=${encodeURIComponent(rawLinkToken)}`;
  return { loginUrl, ttlMinutes: Math.max(1, Math.floor(ttl / 60)) };
}

async function issueLoginPair(
  env: Env,
  tenantId: string,
  telegramUserId: string,
): Promise<{ appUrl: string; webUrl: string; ttlMinutes: number }> {
  const first = await issueLoginLink(env, tenantId);
  const second = await issueLoginLink(env, tenantId);
  for (let index = 0; index < 2; index += 1) {
    await audit(env, {
      tenantId,
      actorType: "telegram",
      actorId: telegramUserId,
      action: "login_link.create",
      outcome: "success",
    });
  }
  return { appUrl: first.loginUrl, webUrl: second.loginUrl, ttlMinutes: first.ttlMinutes };
}

function loginKeyboard(appUrl: string, webUrl: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🛰️ باز کردن در تلگرام", web_app: { url: appUrl } }],
      [{ text: "🌐 باز کردن در مرورگر", url: webUrl }],
      [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
    ],
  };
}

async function listRecentDeployments(env: Env, tenantId: string): Promise<DeploymentStatusRow[]> {
  const rows = await env.DB.prepare(
    "SELECT worker_name, status, node_hostname, updated_at FROM deployments WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 10",
  ).bind(tenantId).all<DeploymentStatusRow>();
  return rows.results ?? [];
}

async function telegramApi(env: Env, method: string, payload: Record<string, unknown>): Promise<TelegramApiResponse> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json<TelegramApiResponse>().catch(() => ({ ok: false as const }));
  if (!response.ok || !result.ok) {
    const description = typeof (result as { description?: unknown }).description === "string"
      ? (result as { description: string }).description
      : "";
    throw new Error(
      `Telegram API request failed: ${response.status} ${method}${description ? ` — ${description}` : ""}`,
    );
  }
  return result;
}

/** Telegram is strict about HTML entities; strip the tags we use so a card can never die on parsing. */
function stripMarkup(text: string): string {
  return text.replace(/<\/?(?:b|code|i|u|pre|a)[^>]*>/gi, "");
}

function isParseError(error: unknown): boolean {
  return error instanceof Error && /parse|entit|text/u.test(error.message);
}

function plainPayload(view: RenderedView): Record<string, unknown> {
  return {
    text: stripMarkup(view.text),
    ...(view.protect === true ? { protect_content: true } : {}),
    disable_web_page_preview: true,
    reply_markup: view.keyboard,
  };
}

function webhookSend(chatId: number, text: string, replyMarkup?: TelegramInlineKeyboard, html = false, protect = false): Response {
  return json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    ...(html ? { parse_mode: "HTML" } : {}),
    ...(protect ? { protect_content: true } : {}),
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/**
 * Forward updates that do NOT belong to V13 to an external Omni worker.
 * Returns true when a fallback is configured and accepted the update.
 */
async function forwardToOmni(env: Env, update: TelegramUpdate): Promise<boolean> {
  const target = (env.OMNI_FALLBACK_URL ?? "").trim();
  if (!target) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.OMNI_FALLBACK_SECRET) headers.Authorization = `Bearer ${env.OMNI_FALLBACK_SECRET}`;
  try {
    const response = await fetch(target, { method: "POST", headers, body: JSON.stringify(update) });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Renderers shared by message commands and callback buttons.
// ---------------------------------------------------------------------------

interface RenderedView {
  text: string;
  keyboard: TelegramInlineKeyboard;
  html: boolean;
  protect?: boolean;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

const RADAR_CHECK_ROWS = 8;

/**
 * "هلث چک" from the OMNI worker, minus the theatre: the old version claimed RUM
 * probes it never ran. This counts real client reports for the selected
 * operator/city inside the 7-day radar window and links the JSON feed.
 */
async function renderRadarCheckView(env: Env, operator = "mci", city = "tehran"): Promise<RenderedView> {
  const ranking = await rankCleanIps(env, { operator, city, limit: RADAR_CHECK_ROWS });
  const baseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/u, "");
  const lines = [
    "🔍 <b>هلث چک — زنده بودن رادار</b>",
    "",
    `📡 اپراتور: <b>${escapeHtml(ranking.operator.label)}</b> · شهر: <b>${escapeHtml(ranking.city.label)}</b>`,
    `🧮 ${ranking.measured} از ${ranking.poolSize} آی‌پی گزارش زندهٔ کلاینت دارد`,
    "",
  ];
  if (ranking.rows.length === 0) {
    lines.push("هنوز گزارشی برای این انتخاب ثبت نشده است.");
  } else {
    for (const [index, row] of ranking.rows.entries()) {
      const latency = row.latencyMs === null ? "—" : `${row.latencyMs}ms`;
      const loss = row.lossPct === null ? "—" : `${row.lossPct}%`;
      lines.push(
        `${index + 1}. <code>${escapeHtml(row.ip)}:${row.port}</code> — ${CLEAN_IP_STATUS_LABELS[row.status]} · ${latency} · loss ${loss} · ${row.reports} گزارش`,
      );
    }
  }
  lines.push(
    "",
    `🌐 <code>${escapeHtml(baseUrl)}/api/v1/clean-ip?format=json</code>`,
    "ℹ️ این ربات از سرور ابری پینگ نمی‌زند؛ مسیر شما را نمی‌سنجد. «۰ از N» یعنی هنوز کسی تست نکرده، نه اینکه همه بلاک‌اند.",
  );
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "🔄 تست مجدد", callback_data: `v13:check:${operator}:${city}` },
          { text: "📤 ثبت گزارش", callback_data: `v13:ip:report:${operator}:${city}` },
        ],
        [{ text: "💎 رادار کامل", callback_data: "v13:ip" }],
        [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
      ],
    },
    html: true,
  };
}

/** Statuses whose Cloudflare side is already gone, so removing the row is safe. */
const DELETABLE_STATUSES = ["failed", "revoked"];

/** One outcome card for a panel deploy: link in, home page, pack, and the list. */
function renderPanelDeployView(row: PanelDeploymentRow): RenderedView {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  if (row.status !== "failed") {
    rows.push([{ text: "🖥️ ورود", url: row.panel_url }]);
    const root = `https://${row.worker_domain}/`;
    if (row.panel_url !== root) rows.push([{ text: "🏠 صفحه اصلی", url: root }]);
    rows.push([
      { text: "👻 PHANTOM ۲۰تایی", callback_data: "v13:pack" },
      { text: "📁 دیپلوی‌های من", callback_data: "v13:deps" },
    ]);
  } else {
    rows.push([
      { text: "🔁 تلاش دوباره", callback_data: "v13:dep:new" },
      { text: "📁 دیپلوی‌های من", callback_data: "v13:deps" },
    ]);
  }
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return { text: panelDeployText(row, findPanel(row.panel_key)), keyboard: { inline_keyboard: rows }, html: true };
}

/**
 * Keyboard for the panel's own token step: one click opens Cloudflare's token
 * page with every permission the panel deploy needs already selected (BPB,
 * nahan, zeus, … all share the same scoped set); the user only copies the
 * token back into the chat.
 */
function panelTokenKeyboard(): TelegramInlineKeyboard {
  const cancel = cancelKeyboard().inline_keyboard[0];
  return {
    inline_keyboard: [
      [{ text: "☁️ ساخت Token آمادهٔ پنل در Cloudflare", url: cloudflarePanelTemplateUrl() }],
      ...(cancel ? [cancel] : []),
    ],
  };
}

async function handlePanelDeployText(
  env: Env,
  chatId: number,
  tenantId: string,
  displayName: string,
  telegramUserId: string,
  flow: PanelFlow,
  text: string,
): Promise<Response> {
  const spec = findPanel(flow.data["panel"] ?? "");
  if (!spec) {
    await clearPanelFlow(env, telegramUserId);
    return webhookSend(chatId, "پنل انتخابی پیدا نشد؛ دوباره از منو شروع کنید.", omniMainMenuKeyboard());
  }
  // The panel product owns its whole flow: when there is no connection yet the
  // panel gets its own temporary, auto-expiring connection created right here
  // in chat — the user is never routed into the dedicated environment.
  if (flow.step === FLOW_STEP_PANEL_TOKEN) {
    try {
      const connectionId = await connectPanelTokenFromChat(env, tenantId, telegramUserId, text.trim());
      await savePanelFlow(env, telegramUserId, {
        flow: "panel",
        step: FLOW_STEP_PANEL_NAME,
        data: { ...flow.data, connection: connectionId },
      });
      return webhookSend(
        chatId,
        `✅ اتصال اختصاصی ${spec.name} ساخته شد (موقت و رمزنگاری‌شده).\n\n🚀 قدم ۱ از ۲ — نام Worker را بفرستید (حرف کوچک، عدد، خط‌تیره؛ مثال: <code>my-bpb</code>).`,
        panelFlowKeyboard(),
        true,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return webhookSend(chatId, `⚠️ ${error.message}\n\nتوکن را دوباره بفرستید.`, panelTokenKeyboard(), true);
      }
      throw error;
    }
  }
  if (flow.step === FLOW_STEP_PANEL_NAME) {
    const workerName = sanitizeWorkerName(text);
    if (!workerName) {
      return webhookSend(chatId, "⚠️ حداقل ۳ نویسه و فقط حرف کوچک انگلیسی، عدد و خط‌تیره. دوباره بفرستید.", panelFlowKeyboard());
    }
    await savePanelFlow(env, telegramUserId, {
      flow: "panel",
      step: FLOW_STEP_PANEL_PASS,
      data: { ...flow.data, worker: workerName },
    });
    return webhookSend(
      chatId,
      `نام Worker: <code>${escapeHtml(workerName)}</code> — پنل: ${spec.name}\n\n🔒 حالا رمز پنل را بفرستید (حداقل ۴ نویسه). این رمز ذخیره نمی‌شود.`,
      panelFlowKeyboard(),
      true,
    );
  }
  if (flow.step !== FLOW_STEP_PANEL_PASS) {
    await clearPanelFlow(env, telegramUserId);
    return webhookSend(chatId, "این قدم باز نیست؛ دوباره از منو شروع کنید.", omniMainMenuKeyboard());
  }
  const password = sanitizePanelPassword(text);
  if (!password) {
    return webhookSend(chatId, "⚠️ رمز پنل باید حداقل ۴ نویسه باشد. دوباره بفرستید.", panelFlowKeyboard());
  }
  await clearPanelFlow(env, telegramUserId);
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: `⏳ در حال ${spec.name}: ساخت KV/D1، آپلود ورکر و تست لینک…`,
  });
  const principal = botPrincipal(tenantId, telegramUserId, displayName);
  const connectionId = flow.data["connection"] ?? "";
  try {
    const row = await deployPanel(env, principal, {
      panelKey: spec.key,
      workerName: flow.data["worker"] ?? "",
      password,
      ...(connectionId ? { connectionId } : {}),
    });
    return sendRendered(chatId, renderPanelDeployView(row));
  } catch (error) {
    await clearWizard(env, telegramUserId);
    return await handleErrorView(env, chatId, tenantId, telegramUserId, error);
  }
}

async function renderDepsList(env: Env, tenantId: string, displayName: string, telegramUserId: string): Promise<RenderedView> {
  const principal = botPrincipal(tenantId, telegramUserId, displayName);
  const deployments: BotDeploymentSummary[] = (await botListDeployments(env, principal)).slice(0, 10);
  const panelRows = await listPanelDeployments(env, tenantId);
  if (deployments.length === 0 && panelRows.length === 0) {
    return {
      text: "📁 هنوز استقراری ندارید. با دکمهٔ زیر اولین نود واقعی را بسازید 👇",
      keyboard: {
        inline_keyboard: [
          [{ text: "➕ جدید", callback_data: "v13:dep:new" }],
          [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
        ],
      },
      html: false,
    };
  }
  // Same shape as the OMNI worker: 🟢 on the live node, ⚪ on the rest, ➕ جدید on top,
  // plus a per-row 🗑 for the records that are safe to drop.
  const rows: TelegramInlineKeyboard["inline_keyboard"] = deployments.map((deployment) => {
    const marker = deployment.status === "ready" ? "🟢" : "⚪";
    const cells = [
      { text: `${marker} ${deployment.worker_name} — ${faDeploymentStatus(deployment.status)}`.slice(0, 52), callback_data: `v13:dep:${deployment.id}` },
    ];
    if (DELETABLE_STATUSES.includes(deployment.status)) {
      cells.push({ text: "🗑", callback_data: `v13:dep-del:${deployment.id}` });
    }
    return cells;
  });
  for (const row of panelRows) {
    const marker = row.status === "live" ? "🟢" : "⚪";
    const cells: TelegramInlineKeyboard["inline_keyboard"][number] = [
      { text: `${marker} ${row.worker_name} — ${row.panel_name}`.slice(0, 52), url: row.panel_url },
    ];
    if (row.status === "failed") cells.push({ text: "🗑", callback_data: `v13:pdel:${row.id}` });
    rows.push(cells);
  }
  rows.unshift([{ text: "➕ جدید", callback_data: "v13:dep:new" }]);
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return {
    text: `📁 دیپلوی‌ها — ${deployments.length}\n🟢 نود آماده · ⚪ بقیه\n🗑 فقط برای رکورد ناموفق یا باطل‌شده`,
    keyboard: { inline_keyboard: rows },
    html: false,
  };
}

async function renderDepDetail(
  env: Env,
  tenantId: string,
  displayName: string,
  telegramUserId: string,
  deploymentId: string,
): Promise<RenderedView> {
  const principal = botPrincipal(tenantId, telegramUserId, displayName);
  const { deployment } = await botGetDeployment(env, principal, deploymentId);
  const status = deployment.status;
  const updated = new Date(deployment.updatedAt).toLocaleString("fa-IR");
  const text = [
    `📦 <b>${escapeHtml(deployment.workerName)}</b> — ${escapeHtml(faDeploymentStatus(status))}`,
    "",
    `🖥️ اشتراک: ${escapeHtml(deployment.workerHostname)}`,
    `📡 نود: ${escapeHtml(deployment.nodeHostname)}`,
    `🌐 IP: ${escapeHtml(deployment.vpsIpv4)}`,
    `🕐 به‌روزرسانی: ${escapeHtml(updated)}${deployment.lastSeenAt ? `\n💚 آخرین گزارش سلامت: ${escapeHtml(new Date(deployment.lastSeenAt).toLocaleString("fa-IR"))}` : ""}`,
  ].join("\n");
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  if (status === "ready") {
    rows.push([
      { text: "🔗 اشتراک‌ها", callback_data: `v13:dep-subs:${deployment.id}` },
      { text: "🔁 چرخش اشتراک", callback_data: `v13:dep-subrot:${deployment.id}` },
    ]);
  }
  if (["queued", "preparing", "awaiting_agent", "failed"].includes(status)) {
    rows.push([{ text: "🔑 دستورهای بوت‌استرپ", callback_data: `v13:dep-boot:${deployment.id}` }]);
  }
  if (["agent_ready", "failed"].includes(status)) {
    rows.push([{ text: "🔄 تلاش مجدد", callback_data: `v13:dep-retry:${deployment.id}` }]);
  }
  if (!["revoked", "revoking"].includes(status)) {
    rows.push([{ text: "🛑 ابطال استقرار", callback_data: `v13:dep-revoke:${deployment.id}` }]);
  }
  if (DELETABLE_STATUSES.includes(status)) {
    rows.push([{ text: "🗑 حذف رکورد (بدون بازگشت)", callback_data: `v13:dep-del:${deployment.id}` }]);
  }
  rows.push([
    { text: "🔄 تازه‌سازی", callback_data: `v13:dep:${deployment.id}` },
    { text: "📦 لیست", callback_data: "v13:deps" },
  ]);
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return { text, keyboard: { inline_keyboard: rows }, html: true };
}

async function renderConnsList(
  env: Env,
  tenantId: string,
  displayName: string,
  telegramUserId: string,
): Promise<RenderedView> {
  const principal = botPrincipal(tenantId, telegramUserId, displayName);
  const connections: BotConnectionSummary[] = await botListConnections(env, principal);
  const homeRow = [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }];
  if (connections.length === 0) {
    return {
      text: "🔌 اتصال فعالی ندارید. با دکمهٔ زیر وارد پنل شوید و Scoped API Token را فقط در فرم امن وارد کنید 👇",
      keyboard: { inline_keyboard: [[{ text: "➕ ساخت اتصال جدید", callback_data: "v13:conn-new" }], homeRow] },
      html: false,
    };
  }
  const lines = connections.map((connection) => {
    const zone = connection.resource_zone_name ?? "?";
    const expires = connection.expires_at ? new Date(connection.expires_at).toLocaleString("fa-IR") : "نامشخص";
    return `• ${zone} — انقضای نگهداری: ${expires}`;
  });
  const rows = connections.map((connection) => ([
    { text: `🗑️ قطع: ${(connection.resource_zone_name ?? shortId(connection.id)).slice(0, 24)}`, callback_data: `v13:conn-disc:${connection.id}` },
  ]));
  rows.push([{ text: "➕ اتصال جدید", callback_data: "v13:conn-new" }]);
  rows.push(homeRow);
  return { text: ["🔌 اتصال‌های فعال:", "", ...lines].join("\n"), keyboard: { inline_keyboard: rows }, html: false };
}

/** Standalone token intake (DNS center or panels): one-time form, never the dedicated panel. */
async function renderStandaloneConnectPrompt(env: Env, tenantId: string, next: "dns" | "panel"): Promise<RenderedView> {
  const { url, ttlMinutes } = await issueConnectLink(env, tenantId, next);
  return {
    text: [
      next === "dns" ? "🔑 <b>اتصال اختصاصی مرکز DNS</b>" : "🔑 <b>اتصال Cloudflare برای پنل‌ها</b>",
      next === "dns"
        ? "مرکز DNS محیط جدا خودش را دارد: توکن اسکوپ‌شدهٔ Cloudflare را فقط در فرم تک‌مرحله‌ای خودِ مرکز DNS بگذارید — نه در چت، نه در پنل محیط اختصاصی."
        : "پنل‌ها روی اتصال Cloudflare خودتان استقرار می‌یابند — کاملاً جدا از محیط اختصاصی. فرم تک‌مرحله‌ای خودش را دارد؛ نه چت، نه پنل اختصاصی.",
      `لینک یک‌بارمصرف فرم (${ttlMinutes} دقیقه اعتبار) پایین همین پیام است.`,
      "بعد از ثبت، سازنده‌های Master/White/Slipstream خودکار همهٔ کارها (انتشار TXT و کانفیگ‌ها) را روی zone شما انجام می‌دهند.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "📱 باز کردن فرم در تلگرام", url }],
        [{ text: "🌐 باز کردن فرم در مرورگر", url }],
        [{ text: "🧨 حذف این پیام", callback_data: "v13:delmsg" }],
      ],
    },
    html: true,
    protect: true,
  };
}

async function renderConnectPrompt(env: Env, tenantId: string, telegramUserId: string, intro: string): Promise<RenderedView> {
  const { appUrl, webUrl, ttlMinutes } = await issueLoginPair(env, tenantId, telegramUserId);
  return {
    text: [`${intro}`, "", omniLoginText(ttlMinutes), "", "توکن Cloudflare را فقط در فرم امن پنل وارد کنید، هرگز در چت."].join("\n"),
    keyboard: loginKeyboard(appUrl, webUrl),
    html: false,
    protect: true,
  };
}

function renderBootstrapMessage(bootstrap: BotBootstrap, workerName: string): { text: string; keyboard: TelegramInlineKeyboard } {
  const minutes = Math.max(1, Math.round(bootstrap.expiresInSeconds / 60));
  const text = [
    `🔑 دستورهای بوت‌استرپ <b>${escapeHtml(workerName)}</b> (${minutes} دقیقه اعتبار)`,
    "",
    "۱) دریافت:",
    `<pre>${escapeHtml(bootstrap.downloadCommand)}</pre>`,
    "۲) بررسی:",
    `<pre>${escapeHtml(bootstrap.inspectCommand)}</pre>`,
    "۳) اجرا:",
    `<pre>${escapeHtml(bootstrap.executeCommand)}</pre>`,
    "۴) حذف فایل:",
    `<pre>${escapeHtml(bootstrap.eraseCommand)}</pre>`,
    "",
    "⚠️ این پیام حاوی توکن یک‌بارمصرف است؛ بعد از اجرا با دکمهٔ زیر حذفش کنید.",
  ].join("\n");
  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: "🧨 حذف این پیام", callback_data: "v13:delmsg" }],
        [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
      ],
    },
  };
}

function renderSubscriptionsMessage(subscriptions: Record<string, string>, workerName: string, rotated: boolean): { text: string; keyboard: TelegramInlineKeyboard } {
  const entries: Array<[string, string]> = [
    ["🔗 اشتراک اصلی", subscriptions.uri ?? ""],
    ["📦 پروفایل VLESS", subscriptions.singBoxVless ?? ""],
    ["📦 پروفایل Hysteria2", subscriptions.singBoxHysteria2 ?? ""],
  ];
  const blocks = entries.filter(([, url]) => url).map(([label, url]) => `${label}:\n<pre>${escapeHtml(url)}</pre>`);
  const text = [
    `${rotated ? "🔁 اشتراک‌های جدید" : "🔗 اشتراک‌های"} <b>${escapeHtml(workerName)}</b>${rotated ? " (قبلی‌ها از کار افتادند)" : ""}`,
    "",
    ...blocks,
    "",
    "⚠️ این لینک‌ها مثل رمز هستند؛ برای کسی نفرستید و بعد از کپی، پیام را حذف کنید.",
  ].join("\n");
  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: "🧨 حذف این پیام", callback_data: "v13:delmsg" }],
        [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
      ],
    },
  };
}

const IP_PICKER_LIMIT = 12;

function publicOrigin(env: Env): string {
  try {
    return new URL(env.PUBLIC_BASE_URL).origin;
  } catch {
    return "https://control.invalid";
  }
}

function isAdminUserId(env: Env, telegramUserId: string): boolean {
  return (env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(telegramUserId);
}

function homeRow(): TelegramInlineKeyboard["inline_keyboard"] {
  return [[{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]];
}

function chunkButtons<T>(
  items: readonly T[],
  perRow: number,
  build: (item: T, index: number) => TelegramInlineKeyboard["inline_keyboard"][number][number],
): TelegramInlineKeyboard["inline_keyboard"] {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  for (let index = 0; index < items.length; index += perRow) {
    const row = items.slice(index, index + perRow).map((item, offset) => build(item, index + offset));
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Clean-IP radar (ported from the OMNI worker's "ULTRA WHITEHOLE" panel).
// ---------------------------------------------------------------------------

function cleanIpKeyboard(operatorKey: string, cityKey: string): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [
    [
      { text: "🔄 تازه‌سازی", callback_data: `v13:ip:${operatorKey}:${cityKey}` },
      { text: "📤 ثبت گزارش", callback_data: `v13:ip:report:${operatorKey}:${cityKey}` },
    ],
    ...chunkButtons(CLEAN_IP_OPERATORS, 3, (item) => ({
      text: `${item.key === operatorKey ? "✅ " : ""}${item.label}`,
      callback_data: `v13:ip:${item.key}:${cityKey}`,
    })),
    ...chunkButtons(CLEAN_IP_CITIES, 4, (item) => ({
      text: `${item.key === cityKey ? "✅ " : ""}${item.label}`,
      callback_data: `v13:ip:${operatorKey}:${item.key}`,
    })),
    [{ text: "🧭 راهنمای تنظیم کلاینت", callback_data: "v13:ip:hint" }],
    [{ text: "🌪️ هددراپ WhiteHole", callback_data: "v13:wh" }],
    ...homeRow(),
  ];
  return { inline_keyboard: rows };
}

async function renderCleanIpView(env: Env, operatorKey: string, cityKey: string): Promise<RenderedView> {
  const ranking = await rankCleanIps(env, { operator: operatorKey, city: cityKey, limit: 10 });
  return {
    text: cleanIpRankingText(ranking, publicOrigin(env)),
    keyboard: cleanIpKeyboard(ranking.operator.key, ranking.city.key),
    html: true,
  };
}

function cleanIpPickerKeyboard(rows: CleanIpRow[], operatorKey: string, cityKey: string): TelegramInlineKeyboard {
  const picker = rows.slice(0, IP_PICKER_LIMIT).map((row) => ([{
    text: `${row.ip}${row.measured ? ` · ${row.latencyMs}ms` : ""}`.slice(0, 60),
    callback_data: `v13:ip:pick:${row.ip}:${operatorKey}:${cityKey}`,
  }]));
  return {
    inline_keyboard: [
      ...picker,
      [{ text: "🔙 بازگشت به رادار", callback_data: `v13:ip:${operatorKey}:${cityKey}` }],
      ...homeRow(),
    ],
  };
}

async function renderCleanIpPicker(env: Env, operatorKey: string, cityKey: string): Promise<RenderedView> {
  const targets = await cleanIpReportTargets(env, operatorKey, cityKey);
  return {
    text: [
      "📤 <b>ثبت گزارش برای IP تمیز</b>",
      "",
      "یک IP را انتخاب کنید؛ سپس پینگ و درصد loss را با ابزار خودتان اندازه بگیرید و بفرستید.",
      "⚠️ V13 عددی از طرف شما نمی‌سازد — فقط همان چیزی که اعلام می‌کنید ثبت می‌شود.",
      "",
      `استخر: ${cleanIpPool().length} آی‌پی · بخش فعلی: ${findOperator(operatorKey).label} / ${findCity(cityKey).label}`,
    ].join("\n"),
    keyboard: cleanIpPickerKeyboard(targets, operatorKey, cityKey),
    html: true,
  };
}

// ---------------------------------------------------------------------------
// Live censorship map (نت ملی).
// ---------------------------------------------------------------------------

function mapKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "🔄 تازه‌سازی", callback_data: "v13:map" },
        { text: "📤 ثبت گزارش", callback_data: "v13:map:report" },
      ],
      ...homeRow(),
    ],
  };
}

async function renderMapView(env: Env): Promise<RenderedView> {
  const [aggregate, poison, snapshot, winners] = await Promise.all([
    aggregateMap(env),
    poisonSummary(env),
    latestRirSnapshot(env),
    listRaceWinners(env),
  ]);
  const extras = [poisonLine(poison), rirCardLine(snapshot), raceLine(winners)].filter(
    (line): line is string => line !== null,
  );
  return { text: mapText(aggregate, extras), keyboard: mapKeyboard(), html: true };
}

const DNSTEST_CITIES: readonly string[] = [
  "تهران", "مشهد", "اصفهان", "شیراز", "تبریز", "کرج", "قم", "اهواز",
  "کرمان", "رشت", "ارومیه", "زاهدان", "همدان", "یزد", "بندرعباس", "اردبیل",
];

function renderDnsTestView(env: Env, isp?: string, city?: string): RenderedView {
  const scriptUrl = `${publicOrigin(env)}/api/v1/dns-test.sh`;
  const intro = [
    "🧪 <b>تست مسمومیت DNS — اول تست، بعد تجویز</b>",
    "",
    "اسکریپت ۳ نام شاهد را از ۷ رزلور (سامانه، 1.1.1.1، DoH کلادفلر، شکن، ملی، 403، رادار) می‌پرسد؛",
    "سرور فقط جواب‌های سیاه‌چاله‌ای (loopback/0.0.0.0/10.10.34.34) را جعلی می‌شمارد و کارت «X از Y پاسخ جعلی» می‌دهد.",
    "نتیجه به aggregate نقشهٔ سانسور بر اساس (اپراتور/شهر) هم اضافه می‌شود. هیچ IP یا شناسه‌ای ذخیره نمی‌شود.",
  ];
  if (!isp) {
    return {
      text: [...intro, "", "۱) اول اپراتور را از دکمه‌ها انتخاب کنید تا فرمان آمادهٔ کپی ساخته شود."].join("\n"),
      keyboard: {
        inline_keyboard: [
          ...chunkButtons(MAP_ISPS, 2, (item) => ({ text: item, callback_data: `v13:dnstest:isp:${item}` })),
          [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
          ...homeRow(),
        ],
      },
      html: true,
    };
  }
  if (!city) {
    return {
      text: [...intro, "", `۲) اپراتور «${escapeHtml(isp)}» ثبت شد؛ حالا شهر را انتخاب کنید.`].join("\n"),
      keyboard: {
        inline_keyboard: [
          ...chunkButtons(DNSTEST_CITIES, 2, (item) => ({ text: item, callback_data: `v13:dnstest:run:${isp}:${item}` })),
          [{ text: "↩️ تغییر اپراتور", callback_data: "v13:dnstest" }],
          [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
          ...homeRow(),
        ],
      },
      html: true,
    };
  }
  const command = `curl --proto '=https' --tlsv1.2 -sSf ${scriptUrl} | bash -s -- "${isp}" "${city}"`;
  return {
    text: [
      ...intro,
      "",
      `✅ اپراتور: <b>${escapeHtml(isp)}</b> · شهر: <b>${escapeHtml(city)}</b>`,
      "۳) فقط همین یک خط را یک‌جا کپی و در ترمینال همان دستگاه (سرور، یا Termux گوشی) پیست کنید؛ هیچ چیزی نصب نمی‌شود (bash + python3 + curl کافی است):",
      `<code>${escapeHtml(command)}</code>`,
      "۴) چند ثانیه بعد کارت تجمیعی و نقشهٔ نت ملی با همان دادهٔ واقعی به‌روز می‌شوند؛ تکرارش آزاد است.",
    ].join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "↩️ تغییر شهر", callback_data: `v13:dnstest:isp:${isp}` },
          { text: "↩️ تغییر اپراتور", callback_data: "v13:dnstest" },
        ],
        [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
        ...homeRow(),
      ],
    },
    html: true,
  };
}

// ---------------------------------------------------------------------------
// DNS tunnel + sleeper cards (per deployment).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// V13.5 net-intel standalone views — one parent key opens this hub; each
// feature owns its dedicated key, its own card and a full how-to-run guide.
// ---------------------------------------------------------------------------

function dnsCenterKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "🔎 یافتن DNS سالم (اسکن رنج)", callback_data: "v13:dns:scan" }],
      [{ text: "🧪 تست مسمومیت DNS", callback_data: "v13:dnstest" }],
      [{ text: "🛠️ سازندهٔ Master DNS", callback_data: "v13:dnsb:master" }],
      [{ text: "🛡️ سازندهٔ White DNS", callback_data: "v13:dnsb:white" }],
      [{ text: "🌊 سازندهٔ Slipstream", callback_data: "v13:dnsb:slip" }],
      ...homeRow(),
    ],
  };
}

function renderDnsCenterView(): RenderedView {
  return {
    text: [
      "🌐 <b>مرکز DNS</b> — بخش کاملاً مستقل DNS، جدا از همهٔ بخش‌های دیگر.",
      "• 🔎 اسکن رنج: یک رنج بدهید، DNSهای سالمِ واقعی را پیدا می‌کند و هر ۳۰ دقیقه خودکار یافته‌های تازه می‌آورد.",
      "• 🧪 تست مسمومیت: رزولورهای رایج را روی دستگاه خودتان می‌سنجد.",
      "• 🛠️ سازنده‌ها: Master DNS (DoH اختصاصی + رکورد SVCB)، White DNS (لیست سفید روی zone خودتان) و Slipstream — همگی با اتصال اسکوپ‌شدهٔ Cloudflare خودتان.",
    ].join("\n"),
    keyboard: dnsCenterKeyboard(),
    html: true,
  };
}

/** Secret-shared header so only this worker can chain its own scan ticks. */
async function scanTickSecret(env: Env): Promise<string> {
  return sha256(`${env.TELEGRAM_WEBHOOK_SECRET}:scan-tick`);
}

async function scanTickFetch(env: Env, rangeId: string): Promise<boolean> {
  try {
    const secret = await scanTickSecret(env);
    const response = await fetch(`${new URL(env.PUBLIC_BASE_URL).origin}/internal/scan-tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Scan-Tick": secret },
      body: JSON.stringify({ rangeId }),
    });
    if (!response.ok) {
      console.error("scan_tick_chain_failed", { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    console.error("scan_tick_chain_failed", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Arms the next live-scan tick through the worker's own /internal/scan-tick.
 * If that self-fetch is blocked (zone challenge, WAF, killed request) the tick
 * runs directly inside this waitUntil chain instead, so the live card keeps
 * moving either way; the 5-minute cron is an additional backstop.
 */
async function chainNextTick(env: Env, ctx: ExecutionContext, rangeId: string): Promise<void> {
  if (await scanTickFetch(env, rangeId)) return;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await advanceLiveScan(env, ctx, rangeId);
}

/**
 * Runs one bounded scan slice, edits the live message, and either chains the
 * next tick (production, via ctx.waitUntil self-fetch) or recurses (tests).
 * Every invocation stays small, so no runtime limit can kill a full /24.
 */
export async function advanceLiveScan(env: Env, ctx: ExecutionContext | null, rangeId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT live_chat_id, live_message_id, cidr FROM dns_scan_ranges WHERE id = ?")
    .bind(rangeId)
    .first<{ live_chat_id: string | null; live_message_id: number | null; cidr: string }>();
  const chatId = row?.live_chat_id ? Number(row.live_chat_id) : null;
  const messageId = row?.live_message_id ?? null;
  let lastEdit = 0;
  const onProgress = async (progress: ScanProgress): Promise<void> => {
    if (chatId === null || messageId === null) return;
    const now = Date.now();
    if (now - lastEdit < 2500) return;
    lastEdit = now;
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: liveScanText(row?.cidr ?? "", progress),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }).catch(() => undefined);
  };
  try {
    const tick = await runScanTick(env, rangeId, 8_000, onProgress);
    if (!tick.done) {
      if (ctx) {
        ctx.waitUntil(chainNextTick(env, ctx, rangeId));
        return;
      }
      await advanceLiveScan(env, null, rangeId);
      return;
    }
    const summary = await rangeRoundSummary(env, rangeId);
    const card = rangeScanCardText(summary);
    const keyboard = { inline_keyboard: [[{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }], ...homeRow()] };
    if (chatId !== null && messageId !== null) {
      await telegramApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: card,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: keyboard,
      }).catch(() => undefined);
      return;
    }
    await sendView(env, chatId ?? 0, { text: card, keyboard, html: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("dns_live_scan_failed", { rangeId, reason });
    if (chatId !== null && messageId !== null) {
      await telegramApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ اسکن رنج با خطا متوقف شد: <code>${escapeHtml(reason)}</code>\nبا «🔄 تازه‌سازی» وضعیت را ببینید؛ کرن هر ۵ دقیقه ادامه می‌دهد.`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }).catch(() => undefined);
    }
  }
}

/** POST /internal/scan-tick — the worker asks itself for the next scan slice. */
export async function handleScanTick(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const provided = request.headers.get("X-Scan-Tick") ?? "";
  const expected = await scanTickSecret(env);
  if (!(await constantTimeEqual(provided, expected))) {
    throw new HttpError(401, "invalid_scan_tick", "Unauthorized scan tick");
  }
  const body = (await readJson<{ rangeId?: unknown }>(request, 4096)) as { rangeId?: string };
  const rangeId = typeof body.rangeId === "string" ? body.rangeId : "";
  if (!rangeId) throw new HttpError(400, "invalid_input", "rangeId is required");
  if (ctx) ctx.waitUntil(advanceLiveScan(env, ctx, rangeId));
  else await advanceLiveScan(env, null, rangeId);
  return json({ ok: true });
}

function liveScanText(cidr: string, progress: ScanProgress): string {
  const cells = 10;
  const done = Math.max(0, Math.min(cells, Math.floor((progress.scanned / Math.max(progress.total, 1)) * cells)));
  const bar = "▓".repeat(done) + "░".repeat(cells - done);
  return [
    `🔬 <b>اسکن زندهٔ رنج <code>${escapeHtml(cidr)}</code></b>`,
    `<code>${bar}</code> ${progress.scanned}/${progress.total}`,
    `• سالم: ${progress.healthy} · جعلی: ${progress.fake} · غلط: ${progress.wrong} · دسترس‌ناپذیر: ${progress.unreachable}`,
    "شمارنده‌ها همین‌جا جلو می‌روند تا دور کامل تمام شود…",
  ].join("\n");
}

function rangeScanCardText(summary: RangeScanSummary): string {
  const lines = [
    `🔬 <b>اسکن کامل رنج <code>${escapeHtml(summary.cidr)}</code> تمام شد</b>`,
    `• کل آدرس‌ها: ${summary.total}`,
    `• سالم: ${summary.healthy}`,
    `• جعلی (سیاه‌چاله): ${summary.fake}`,
    `• پاسخ غلط: ${summary.wrong}`,
    `• دسترس‌ناپذیر: ${summary.unreachable}`,
  ];
  if (summary.top.length > 0) {
    lines.push("", "سریع‌ترین بالادست‌های سالم:", ...summary.top.map((item, index) => `${index + 1}) <code>${escapeHtml(item.ip)}</code>${item.rttMs !== null ? ` — ${item.rttMs}ms` : ""}`));
  } else {
    lines.push("", "هنوز هیچ بالادست سالمی در این رنج پیدا نشد (صادقانه، بدون عدد جعلی).");
  }
  lines.push("", `اسکن خودکار هر ${DNS_SCAN_INTERVAL_MINUTES} دقیقه تکرار می‌شود؛ رنج‌های خودکار سامانه هم همیشه در حال اسکن‌اند.`);
  return lines.join("\n");
}

async function renderDnsScanView(env: Env, tenantId: string): Promise<RenderedView> {
  const [healthy, ranges] = await Promise.all([healthyResolvers(env, tenantId), scanRangeStatus(env, tenantId)]);
  const lines = [
    "🔎 <b>یافتن DNS سالم</b> — پرسش واقعی TCP/53 از هر آدرس رنج؛ سالم = پاسخ درست به کاناری، بدون جواب سیاه‌چاله.",
    `بروزرسانی خودکار: هر ${DNS_SCAN_INTERVAL_MINUTES} دقیقه یک دور کامل تازه؛ یافته‌های زیر مال ۶۰ دقیقهٔ اخیرند.`,
    "",
  ];
  if (ranges.length === 0) {
    lines.push("هنوز رنجی ثبت نکرده‌اید؛ با «➕ رنج جدید» یک CIDR (بین /24 تا /32) بفرستید.");
  } else {
    for (const range of ranges) {
      const state = range.last_scan_at
        ? `آخرین دور: ${range.last_scan_at.slice(0, 16).replace("T", " ")}`
        : `در حال اسکن: ${range.cursor}/${range.ips_total}`;
      lines.push(`• رنج <code>${escapeHtml(range.cidr)}</code> (${range.ips_total} آدرس) — ${state}`);
    }
    lines.push("");
    if (healthy.length === 0) {
      lines.push("هنوز DNS سالمی در این رنج‌ها پیدا نشده؛ دور بعدی اسکن نتایج تازه می‌آورد (صداقت: عدد جعلی نداریم).");
    } else {
      lines.push("<b>DNSهای سالم یافت‌شده (سریع‌ترین اول):</b>");
      for (const item of healthy) {
        lines.push(`• <code>${escapeHtml(item.ip)}</code> · rtt ${item.rtt_ms ?? "؟"}ms · از رنج ${escapeHtml(item.cidr)}`);
      }
      lines.push("این IPها را می‌توانید به‌عنوان resolver دستی در کلاینت/پروفیل استفاده کنید.");
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "➕ رنج جدید", callback_data: "v13:dns:scan:new" }],
        [{ text: "🔄 تازه‌سازی", callback_data: "v13:dns:scan" }],
        [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
        ...homeRow(),
      ],
    },
    html: true,
  };
}

async function renderBuilderPicker(
  env: Env,
  principal: SessionPrincipal,
  kind: "master" | "white" | "slip",
): Promise<RenderedView> {
  if (kind === "slip") return renderBuilderCard(env, principal, null, kind);
  const connections = await botListConnections(env, principal);
  const title = kind === "master" ? "🛠️ Master DNS — روی کدام اتصال/zone؟" : "🛡️ White DNS — روی کدام اتصال/zone؟";
  if (connections.length === 0) {
    return {
      text: `${title}\nهنوز اتصال Cloudflare ندارید؛ با دکمهٔ «🔑 اتصال Cloudflare» وارد قدم اتصال شوید (فقط فرم امن پنل، هرگز در چت)، بعد به همین سازنده برگردید — انتشار مستقیم در zone خودتان است و هیچ ربطی به محیط اختصاصی ندارد.`,
      keyboard: {
        inline_keyboard: [
          [{ text: "🔑 اتصال Cloudflare", callback_data: "v13:dns:connect" }],
          [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
          ...homeRow(),
        ],
      },
      html: false,
    };
  }
  return {
    text: title,
    keyboard: {
      inline_keyboard: [
        ...connections.map((connection) => [
          {
            text: (connection.resource_zone_name ?? shortId(connection.id)).slice(0, 40),
            callback_data: `v13:dnsb:${kind}:${connection.id}`,
          },
        ]),
        [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }],
        ...homeRow(),
      ],
    },
    html: false,
  };
}

async function renderBuilderCard(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string | null,
  kind: "master" | "white" | "slip",
): Promise<RenderedView> {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  let text = "";
  if (kind === "slip") {
    text = [
      "🌊 <b>Slipstream — سازندهٔ کانفیگ کلاینت</b>",
      "اینجا هیچ‌چیز به استقرارهای V13 گره خورده نیست: دامنهٔ تونل و کلید عمومی نود را می‌فرستید،",
      "خط slipnet:// آماده ساخته می‌شود و راهنمای paste در اپ SlipNet/Slipstream می‌آید.",
      "کلید خصوصی هرگز از VPS بیرون نمی‌رود؛ فقط کلید عمومی وارد این بخش می‌شود.",
      "",
      "نحوهٔ اجرا: ۱) «✍️ دامنه و کلید» را بزنید. ۲) در یک خط: «دامنه کلید عمومی [MTU]». ۳) خروجی را در اپ paste کنید. ۴) مهر سلامت: پرسش TXT روی همان دامنه.",
    ].join("\n");
    rows.push([{ text: "✍️ دامنه و کلید", callback_data: "v13:dnsb:slip:dom" }]);
    rows.push([{ text: "🔑 اتصال Cloudflare (اختیاری: مهر سلامت TXT در zone خودتان)", callback_data: "v13:dns:connect" }]);
  } else {
    const connection = await getConnection(env, connectionId ?? "", principal.tenantId);
    const zoneName = connection.resource_zone_name ?? "zone شما";
    if (kind === "master") {
      const healthy = await healthyResolvers(env, principal.tenantId);
      const upstreams = healthy.slice(0, 3).map((item) => item.ip);
      text = [
        "🛠️ <b>Master DNS — رزولور شخصی روی zone خودتان</b>",
        `اتصال: <code>${escapeHtml(zoneName)}</code> · دسترسی کامل DNS با توکن اسکوپ‌شدهٔ خودتان.`,
        upstreams.length > 0
          ? `بالادست‌های سالمِ اندازه‌گیری‌شده توسط اسکنر: ${upstreams.map((ip) => `<code>${escapeHtml(ip)}</code>`).join("، ")}`
          : "هنوز بالادست سالمی از اسکنر نداریم؛ تا آن زمان فقط 1.1.1.1 به‌عنوان fallback در کانفیگ می‌نشیند (صادقانه).",
        "دکمهٔ Cloudflare یک رکورد TXT خواندنی <code>_dns-master.<zone></code> می‌سازد که لیست بالادست‌های سالم را برای کلاینت‌هایتان منتشر می‌کند؛ دکمهٔ کانفیگ، sing-box/Clash آماده می‌دهد.",
      ].join("\n");
      rows.push([{ text: "🔑 کانفیگ‌ها (پیام محافظ‌شده)", callback_data: `v13:dnsb:master:${connection.id}:url` }]);
      rows.push([{ text: "☁️ انتشار TXT کشف در Cloudflare", callback_data: `v13:dnsb:master:${connection.id}:cf` }]);
    } else {
      const direct = await directRaceDomains(env);
      text = [
        "🛡️ <b>White DNS — لیست سفید شخصی روی zone خودتان</b>",
        `اتصال: <code>${escapeHtml(zoneName)}</code> · انتشار به‌صورت TXTهای خواندنی <code>_whiteN.<zone></code>.`,
        direct.length > 0 ? `برنده‌های فعلی مسابقهٔ مستقیم: ${direct.slice(0, 8).map((domain) => `<code>${escapeHtml(domain)}</code>`).join("، ")}` : "هنوز برندهٔ مستقیمی نداریم؛ لیست با دامنه‌های ملی + ورودی شما پر می‌شود.",
        "نحوهٔ اجرا: ۱) «✍️ دامنه‌های من» لیست را بفرستید. ۲) «☁️ انتشار» رکوردها را در zone خودتان می‌نویسد. ۳) کانفیگ sing-box مسیر همین دامنه‌ها را روی بالادست سالم می‌اندازد.",
      ].join("\n");
      rows.push([{ text: "✍️ دامنه‌های من", callback_data: `v13:dnsb:white:${connection.id}:dom` }]);
      rows.push([{ text: "☁️ انتشار TXT + کانفیگ", callback_data: `v13:dnsb:white:${connection.id}:cf` }]);
    }
  }
  rows.push([{ text: "↩️ اتصال/zone دیگر", callback_data: `v13:dnsb:${kind}` }]);
  rows.push([{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }]);
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return { text, keyboard: { inline_keyboard: rows }, html: true };
}

async function publishMasterDiscovery(env: Env, principal: SessionPrincipal, connectionId: string): Promise<{ name: string; count: number }> {
  const healthy = await healthyResolvers(env, principal.tenantId);
  if (healthy.length === 0) {
    throw new HttpError(400, "invalid_input", "No healthy resolver found yet; run a range scan first");
  }
  const connection = await getConnection(env, connectionId, principal.tenantId);
  const zoneName = connection.resource_zone_name ?? "";
  const auth = await getValidCloudflareAuth(env, connection);
  const name = `_dns-master.${zoneName}`;
  const ips = healthy.slice(0, 6).map((item) => item.ip);
  await upsertDnsRecord(auth, connection.resource_zone_id ?? "", "TXT", name, ips.join(","), 300);
  await logDnsCenterAction(env, principal.tenantId, principal.telegramUserId, "dns.master.publish", connectionId);
  return { name, count: ips.length };
}

async function publishWhiteList(
  env: Env,
  principal: SessionPrincipal,
  connectionId: string,
  domains: string[],
): Promise<number> {
  const connection = await getConnection(env, connectionId, principal.tenantId);
  const zoneName = connection.resource_zone_name ?? "";
  const auth = await getValidCloudflareAuth(env, connection);
  const joined = domains.join(",");
  const chunks: string[] = [];
  for (let index = 0; index < joined.length; index += 240) chunks.push(joined.slice(index, index + 240));
  let published = 0;
  for (let index = 0; index < Math.max(chunks.length, 1); index += 1) {
    await upsertDnsRecord(auth, connection.resource_zone_id ?? "", "TXT", `_white${index + 1}.${zoneName}`, chunks[index] ?? "", 300);
    published += 1;
  }
  await logDnsCenterAction(env, principal.tenantId, principal.telegramUserId, "dns.white.publish", connectionId);
  return published;
}


function mapStepKeyboard(items: readonly string[], prefix: string, labels?: Record<string, string>): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      ...chunkButtons(items, 2, (item) => ({
        text: (labels?.[item] ?? item).slice(0, 32),
        callback_data: `${prefix}${encodeURIComponent(item)}`,
      })),
      [{ text: "❌ انصراف", callback_data: "v13:flow:cancel" }],
    ],
  };
}

const MAP_CITIES = [...CLEAN_IP_CITIES.map((city) => city.label), "سایر"];

// ---------------------------------------------------------------------------
// WhiteHole dead-drop.
// ---------------------------------------------------------------------------

function whiteHoleKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "📤 انتشار رکوردها", callback_data: "v13:wh:publish" },
        { text: "🧹 پاک‌سازی", callback_data: "v13:wh:clear" },
      ],
      [{ text: "🧰 دستورات خواندن", callback_data: "v13:wh:cmds" }],
      [{ text: "💎 رادار IP تمیز", callback_data: "v13:ip" }],
      ...homeRow(),
    ],
  };
}

async function renderWhiteHoleView(env: Env, tenantId: string): Promise<RenderedView> {
  const drop = await latestWhiteHoleDrop(env, tenantId);
  return { text: whiteHoleText(drop, publicOrigin(env)), keyboard: whiteHoleKeyboard(), html: true };
}

// ---------------------------------------------------------------------------
// AI key donation pool.
// ---------------------------------------------------------------------------

function donationKeyboard(isAdmin: boolean): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [
    [
      { text: "✅ می‌پذیرم، کلید را می‌فرستم", callback_data: "v13:donate:agree" },
      { text: "🎁 کلیدهای من", callback_data: "v13:donate:mine" },
    ],
    [{ text: "🏊 وضعیت استخر", callback_data: "v13:donate:pool" }],
  ];
  if (isAdmin) rows.push([{ text: "🧑‍⚖️ بازبینی کلیدهای در انتظار", callback_data: "v13:donate:review" }]);
  rows.push(...homeRow());
  return { inline_keyboard: rows };
}

function renderDonationIntro(isAdmin: boolean): RenderedView {
  return { text: donationConsentText(), keyboard: donationKeyboard(isAdmin), html: true };
}

async function renderDonationPool(env: Env): Promise<RenderedView> {
  return { text: donationPoolText(await donationPoolStats(env), publicOrigin(env)), keyboard: donationKeyboard(false), html: true };
}

function donationMineKeyboard(rows: Awaited<ReturnType<typeof listDonations>>): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      ...rows.filter((row) => row.status === "pending" || row.status === "approved").map((row) => ([
        { text: `↩️ پس‌گرفتن ${row.snippet}`.slice(0, 60), callback_data: `v13:donate:wd:${row.id}` },
      ])),
      [{ text: "➕ اهدای کلید جدید", callback_data: "v13:donate:agree" }],
      [{ text: "🏊 وضعیت استخر", callback_data: "v13:donate:pool" }],
      ...homeRow(),
    ],
  };
}

async function renderMyDonations(env: Env, tenantId: string, telegramUserId: string): Promise<RenderedView> {
  const rows = await listDonations(env, { tenantId, donorUserId: telegramUserId, limit: 10 });
  return { text: donationMineText(rows), keyboard: donationMineKeyboard(rows), html: true };
}

function donationReviewKeyboard(rows: Awaited<ReturnType<typeof listDonations>>): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      ...rows.map((row) => ([
        { text: `✅ ${row.snippet}`.slice(0, 30), callback_data: `v13:donate:ok:${row.id}` },
        { text: "❌ رد", callback_data: `v13:donate:no:${row.id}` },
      ])),
      [{ text: "🏊 وضعیت استخر", callback_data: "v13:donate:pool" }],
      ...homeRow(),
    ],
  };
}

async function renderDonationReview(env: Env): Promise<RenderedView> {
  const rows = await listDonations(env, { status: "pending", limit: 10 });
  const stats = await donationPoolStats(env);
  const lines = rows.map((row) =>
    `• <code>${escapeHtml(row.snippet)}</code> — ${escapeHtml(row.provider)} · ${DONATION_STATUS_LABELS[row.status] ?? ""}`);
  const text = rows.length === 0
    ? `🧑‍⚖️ <b>بازبینی اهدا</b>\n\nصف خالی است. کلیدهای تأییدشده: ${stats.approved}`
    : ["🧑‍⚖️ <b>کلیدهای در انتظار بازبینی</b>", "", ...lines, "", "تأیید فقط وضعیت را عوض می‌کند؛ خودِ کلید در چت نمایش داده نمی‌شود."].join("\n");
  return { text, keyboard: donationReviewKeyboard(rows), html: true };
}

// ---------------------------------------------------------------------------
// Node health, usage and engine status.
// ---------------------------------------------------------------------------

function overviewKeyboard(isAdmin: boolean): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [
    [
      { text: "🩺 سلامت نودها", callback_data: "v13:health" },
      { text: "📈 مصرف و دارایی‌ها", callback_data: "v13:usage" },
    ],
    [{ text: "⚙️ وضعیت موتور", callback_data: "v13:engine" }],
  ];
  if (isAdmin) rows.push([{ text: "👥 کاربران سامانه", callback_data: "v13:roster" }]);
  rows.push([{ text: "📦 استقرارها", callback_data: "v13:deps" }]);
  rows.push(...homeRow());
  return { inline_keyboard: rows };
}

async function renderHealthView(env: Env, tenantId: string, telegramUserId: string): Promise<RenderedView> {
  const [rows, ranking] = await Promise.all([
    listNodeHealth(env, tenantId),
    rankCleanIps(env, { limit: 1 }),
  ]);
  return {
    text: nodeHealthText(rows, { measured: ranking.measured, poolSize: ranking.poolSize }),
    keyboard: overviewKeyboard(isAdminUserId(env, telegramUserId)),
    html: true,
  };
}

async function renderUsageView(env: Env, tenantId: string, telegramUserId: string): Promise<RenderedView> {
  const isAdmin = isAdminUserId(env, telegramUserId);
  // `measured` counts the whole pool, so a single row is enough here.
  const ranking = await rankCleanIps(env, { limit: 1 });
  const counters = await panelCounters(env, tenantId, isAdmin);
  return {
    text: usageText(counters, ranking.measured),
    keyboard: overviewKeyboard(isAdmin),
    html: true,
  };
}

async function renderRosterView(env: Env, tenantId: string): Promise<RenderedView> {
  const counters = await panelCounters(env, tenantId, true);
  return {
    text: rosterText(counters),
    keyboard: overviewKeyboard(true),
    html: true,
  };
}

function renderEngineView(env: Env, telegramUserId: string): RenderedView {
  return {
    text: engineStatusText(engineStatus(env)),
    keyboard: overviewKeyboard(isAdminUserId(env, telegramUserId)),
    html: true,
  };
}

function renderClientHintView(): RenderedView {
  return {
    text: cleanIpResolversText(),
    keyboard: { inline_keyboard: [[{ text: "💎 بازگشت به رادار", callback_data: "v13:ip:mci:tehran" }], ...homeRow()] },
    html: true,
  };
}

/**
 * Routes the `v13:` panel-section callbacks ported from the OMNI worker.
 * Returns false when the callback belongs to another section.
 */
interface PanelCallbackContext {
  env: Env;
  chatId: number;
  messageId: number | undefined;
  queryId: string;
  tenantId: string;
  displayName: string;
  telegramUserId: string;
  data: string;
}

function parseRadarSelection(data: string): { operator: string; city: string } | null {
  const parts = data.split(":");
  const operator = parts[2] ?? "";
  const city = parts[3] ?? "";
  if (parts[0] !== "v13" || parts[1] !== "ip" || !operator) return null;
  if (operator.includes("hint") || operator.includes("report") || operator.includes("pick")) return null;
  return { operator, city: city || "tehran" };
}

/** Callbacks must push a real message (the webhook answer is already used up). */
async function showCallbackError(
  env: Env,
  chatId: number,
  tenantId: string,
  telegramUserId: string,
  error: unknown,
  data = "",
): Promise<void> {
  console.error("telegram_callback_error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  let message = faErrorMessage(error);
  let html = false;
  // Admins get the raw reason appended to the generic fallback, so a
  // broken section can be diagnosed from the chat instead of wrangler tail.
  if (message && message.startsWith("خطای موقت") && isAdminUserId(env, telegramUserId)) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    message = `${message}\n🧾 <code>${escapeHtml(reason.slice(0, 300))}</code>`;
    html = true;
  }
  if (message) {
    await sendView(env, chatId, { text: message, keyboard: omniBackMenuKeyboard(), html });
    return;
  }
  // The DNS center and the panel product never route users into the dedicated
  // env login; they get the standalone one-time connect form instead. The
  // dedicated-env deploy paths (`v13:dep…`) keep the dedicated-env prompt.
  const next = data.startsWith("v13:dns") || data.startsWith("v13:dnstest")
    ? "dns"
    : data.startsWith("v13:panel")
      ? "panel"
      : null;
  if (next) {
    await sendView(env, chatId, await renderStandaloneConnectPrompt(env, tenantId, next));
    return;
  }
  await sendView(
    env,
    chatId,
    await renderConnectPrompt(env, tenantId, telegramUserId, "🔌 برای این بخش اول اتصال Cloudflare را وصل کنید (فقط در پنل امن)."),
  );
}

async function handlePanelCallback(ctx: PanelCallbackContext): Promise<boolean> {
  const { env, data, queryId, chatId, messageId, tenantId, telegramUserId } = ctx;
  const edit = async (view: RenderedView): Promise<void> => {
    if (messageId === undefined) {
      await sendView(env, chatId, view);
      return;
    }
    await editView(env, chatId, messageId, view);
  };

  // --- Clean-IP radar ---
  if (data === "v13:ip" || data.startsWith("v13:ip:")) {
    if (data === "v13:ip:hint") {
      await answerCallback(env, queryId, "راهنمای تنظیم");
      await edit(renderClientHintView());
      return true;
    }
    if (data.startsWith("v13:ip:report:")) {
      const selection = parseRadarSelection(data.replace("v13:ip:report", "v13:ip"));
      await answerCallback(env, queryId, "یک IP انتخاب کنید");
      await edit(await renderCleanIpPicker(env, selection?.operator ?? "mci", selection?.city ?? "tehran"));
      return true;
    }
    if (data.startsWith("v13:ip:pick:")) {
      const [, , , ip = "", operator = "mci", city = "tehran"] = data.split(":");
      if (!ip) {
        await answerCallback(env, queryId, "IP نامعتبر است.", true);
        return true;
      }
      const flow: PanelFlow = { flow: "rum", step: FLOW_STEP_RUM_PING, data: { ip, operator, city } };
      await savePanelFlow(env, telegramUserId, flow);
      await answerCallback(env, queryId, "حالا پینگ را بفرستید");
      await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: true });
      return true;
    }
    const selection = data === "v13:ip" ? { operator: "mci", city: "tehran" } : parseRadarSelection(data);
    if (selection) {
      await answerCallback(env, queryId, "رادار IP تمیز");
      await edit(await renderCleanIpView(env, selection.operator, selection.city));
      return true;
    }
  }

  // --- PHANTOM pack (domain + uuid in, config pack out) ---
  if (data === "v13:pack") {
    const flow: PanelFlow = { flow: "pack", step: FLOW_STEP_PACK_DOMAIN, data: {} };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "دامنه را بفرستید");
    await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: true });
    return true;
  }

  // --- Radar health check ---
  if (data === "v13:check" || data.startsWith("v13:check:")) {
    const selected = data.slice("v13:check".length).split(":").filter((part) => part.length > 0);
    const operator = selected[0] ?? "mci";
    const city = selected[1] ?? "tehran";
    await answerCallback(env, queryId, "هلث چک");
    await edit(await renderRadarCheckView(env, operator, city));
    return true;
  }

  // --- Censorship map ---
  if (data === "v13:map") {
    await answerCallback(env, queryId, "نقشهٔ سانسور");
    await edit(await renderMapView(env));
    return true;
  }
  if (data === "v13:map:report") {
    const flow: PanelFlow = { flow: "map", step: FLOW_STEP_MAP_ISP, data: {} };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "اپراتور را انتخاب کنید");
    await edit({
      text: "🗺 <b>گزارش نقشهٔ سانسور — قدم ۱</b>\n\nاپراتور/ISP خود را انتخاب کنید:",
      keyboard: mapStepKeyboard(MAP_ISPS, "v13:map:isp:"),
      html: true,
    });
    return true;
  }
  if (data.startsWith("v13:map:isp:")) {
    const isp = decodeURIComponent(data.slice("v13:map:isp:".length));
    const flow: PanelFlow = { flow: "map", step: FLOW_STEP_MAP_TRANSPORT, data: { isp } };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "ترانسپورت را انتخاب کنید");
    await edit({
      text: `🗺 <b>قدم ۲ — ترانسپورت</b>\n\nبا کدام پروتکل تست کردید؟`,
      keyboard: mapStepKeyboard(MAP_TRANSPORTS, "v13:map:tr:", MAP_TRANSPORT_LABELS),
      html: true,
    });
    return true;
  }
  if (data.startsWith("v13:map:tr:")) {
    const transport = decodeURIComponent(data.slice("v13:map:tr:".length));
    const base = (await loadPanelFlow(env, telegramUserId))?.data ?? {};
    const data2 = { ...base, transport };
    await savePanelFlow(env, telegramUserId, { flow: "map", step: FLOW_STEP_MAP_VERDICT, data: data2 });
    await answerCallback(env, queryId, "نتیجه را انتخاب کنید");
    await edit({
      text: "🗺 <b>قدم ۳ — نتیجهٔ اتصال</b>\n\nبعد از انتخاب ترانسپورت، اتصال برقرار شد یا قطع؟",
      keyboard: {
        inline_keyboard: [
          [
            { text: "🟢 وصل شدم", callback_data: "v13:map:ok:1" },
            { text: "🔴 قطع بود", callback_data: "v13:map:ok:0" },
          ],
          [{ text: "❌ انصراف", callback_data: "v13:flow:cancel" }],
        ],
      },
      html: true,
    });
    return true;
  }
  if (data === "v13:map:ok:1" || data === "v13:map:ok:0") {
    const base = (await loadPanelFlow(env, telegramUserId))?.data ?? {};
    const data2 = { ...base, ok: data.endsWith(":1") ? "1" : "0" };
    await savePanelFlow(env, telegramUserId, { flow: "map", step: FLOW_STEP_MAP_CITY, data: data2 });
    await answerCallback(env, queryId, "شهر را انتخاب کنید");
    await edit({
      text: "🗺 <b>قدم ۴ — شهر</b>\n\nشهر خود را انتخاب کنید (در دیتابیس بدون IP و بدون شناسهٔ شما ذخیره می‌شود):",
      keyboard: mapStepKeyboard(MAP_CITIES, "v13:map:city:"),
      html: true,
    });
    return true;
  }
  if (data.startsWith("v13:map:city:")) {
    const city = decodeURIComponent(data.slice("v13:map:city:".length));
    const base = (await loadPanelFlow(env, telegramUserId))?.data ?? {};
    const data2 = { ...base, city };
    const next: PanelFlow = { flow: "map", step: FLOW_STEP_MAP_RTT, data: data2 };
    await savePanelFlow(env, telegramUserId, next);
    await answerCallback(env, queryId, "پینگ (اختیاری)");
    await edit({ text: flowPrompt(next), keyboard: panelFlowKeyboard(), html: false });
    return true;
  }

  // --- WhiteHole dead-drop ---
  if (data === "v13:wh") {
    await answerCallback(env, queryId, "هددراپ WhiteHole");
    await edit(await renderWhiteHoleView(env, tenantId));
    return true;
  }
  if (data === "v13:wh:cmds") {
    const drop = await latestWhiteHoleDrop(env, tenantId);
    await answerCallback(env, queryId, "دستورات خواندن");
    await edit({
      text: drop ? whiteHoleReadCommands(drop.zone_name) : whiteHoleReadCommands("example.com"),
      keyboard: whiteHoleKeyboard(),
      html: true,
    });
    return true;
  }
  if (data === "v13:wh:publish" || data === "v13:wh:clear") {
    try {
      await answerCallback(env, queryId, data === "v13:wh:publish" ? "در حال انتشار…" : "در حال پاک‌سازی…");
      if (data === "v13:wh:publish") {
        const ranking = await rankCleanIps(env, { limit: 12 });
        const result = await publishWhiteHoleDrop(env, botPrincipal(tenantId, telegramUserId, ctx.displayName), ranking);
        await sendView(env, chatId, {
          text: [
            "✅ <b>هددراپ منتشر شد</b>",
            "",
            `Zone: <code>${escapeHtml(result.zone)}</code>`,
            `رکوردها: <code>${escapeHtml(result.recordNames.join("، "))}</code>`,
            `تکه‌ها: ${result.shards} · امضا: <code>${escapeHtml(result.digest.slice(0, 12))}…</code>`,
            `IPهای با گزارش زنده در لیست: ${result.measured}`,
            "",
            "⏳ انتشار DNS تا چند دقیقه زمان می‌برد؛ با دستور dig چک کنید.",
          ].join("\n"),
          keyboard: whiteHoleKeyboard(),
          html: true,
        });
      } else {
        const removed = await clearWhiteHoleDrop(env, botPrincipal(tenantId, telegramUserId, ctx.displayName));
        await sendView(env, chatId, {
          text: `🧹 ${removed} رکورد TXT هددراپ حذف شد.`,
          keyboard: whiteHoleKeyboard(),
          html: false,
        });
      }
      await audit(env, {
        tenantId,
        actorType: "telegram",
        actorId: telegramUserId,
        action: data === "v13:wh:publish" ? "whitehole.publish" : "whitehole.clear",
        outcome: "success",
      });
      return true;
    } catch (error) {
      await showCallbackError(env, chatId, tenantId, telegramUserId, error, data);
      return true;
    }
  }

  // --- AI donations ---
  if (data === "v13:donate") {
    await answerCallback(env, queryId, "اهدای کلید AI");
    await edit(renderDonationIntro(isAdminUserId(env, telegramUserId)));
    return true;
  }
  if (data === "v13:donate:agree") {
    const flow: PanelFlow = { flow: "donate", step: FLOW_STEP_DONATE_KEY, data: {} };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "کلید را بفرستید");
    await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: false });
    return true;
  }
  if (data === "v13:donate:pool") {
    await answerCallback(env, queryId, "استخر AI");
    await edit(await renderDonationPool(env));
    return true;
  }
  if (data === "v13:donate:mine") {
    await answerCallback(env, queryId, "کلیدهای من");
    await edit(await renderMyDonations(env, tenantId, telegramUserId));
    return true;
  }
  if (data.startsWith("v13:donate:wd:")) {
    const id = data.slice("v13:donate:wd:".length);
    if (!/^[0-9a-f-]{36}$/u.test(id)) {
      await answerCallback(env, queryId, "شناسه نامعتبر است.", true);
      return true;
    }
    const removed = await withdrawDonation(env, id, telegramUserId);
    await answerCallback(env, queryId, removed ? "کلید و ciphertext حذف شد ✅" : "چیزی برای حذف پیدا نشد.");
    await edit(await renderMyDonations(env, tenantId, telegramUserId));
    return true;
  }
  if (data === "v13:donate:review" || data.startsWith("v13:donate:ok:") || data.startsWith("v13:donate:no:")) {
    if (!isAdminUserId(env, telegramUserId)) {
      await answerCallback(env, queryId, "فقط ادمین‌ها می‌توانند کلیدها را بازبینی کنند.", true);
      return true;
    }
    if (data === "v13:donate:review") {
      await answerCallback(env, queryId, "صف بازبینی");
      await edit(await renderDonationReview(env));
      return true;
    }
    const id = data.slice(data.lastIndexOf(":") + 1);
    if (!/^[0-9a-f-]{36}$/u.test(id)) {
      await answerCallback(env, queryId, "شناسه نامعتبر است.", true);
      return true;
    }
    const status = data.startsWith("v13:donate:ok:") ? "approved" : "rejected";
    await setDonationStatus(env, id, status);
    await audit(env, { tenantId, actorType: "telegram", actorId: telegramUserId, action: `donation.${status}`, resourceType: "ai_donation", resourceId: id, outcome: "success" });
    await answerCallback(env, queryId, status === "approved" ? "تأیید شد ✅" : "رد شد؛ ciphertext حذف می‌شود.");
    await edit(await renderDonationReview(env));
    return true;
  }


  // --- restored legacy sections: dnstt wizard ---
  if (data === "v13:dnstt") {
    const flow: PanelFlow = { flow: "dnstt", step: FLOW_STEP_DNSTT_VPS, data: {} };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "تونل DNS (dnstt)");
    await edit({ text: renderDnsttIntroText(), keyboard: panelFlowKeyboard(), html: true });
    return true;
  }
  // --- Health / usage / engine ---
  if (data === "v13:health" || data === "v13:usage" || data === "v13:roster" || data === "v13:engine") {
    if (data === "v13:engine") {
      await answerCallback(env, queryId, "وضعیت موتور");
      await edit(renderEngineView(env, telegramUserId));
      return true;
    }
    if (data === "v13:roster" && !isAdminUserId(env, telegramUserId)) {
      await answerCallback(env, queryId, "فقط ادمین.", true);
      return true;
    }
    await answerCallback(env, queryId, "در حال دریافت…");
    if (data === "v13:roster") await edit(await renderRosterView(env, tenantId));
    else if (data === "v13:usage") await edit(await renderUsageView(env, tenantId, telegramUserId));
    else await edit(await renderHealthView(env, tenantId, telegramUserId));
    return true;
  }

  if (data === "v13:flow:cancel") {
    await clearPanelFlow(env, telegramUserId);
    await answerCallback(env, queryId, "فرایند لغو شد.");
    await edit({ text: "فرایند نیمه‌کاره لغو شد.", keyboard: omniMainMenuKeyboard(), html: false });
    return true;
  }

  // --- مرکز DNS (independent section) ---
  if (data === "v13:dns") {
    await answerCallback(env, queryId, "مرکز DNS");
    await edit(renderDnsCenterView());
    return true;
  }
  if (data === "v13:dns:scan") {
    await answerCallback(env, queryId, "اسکن DNS سالم");
    await edit(await renderDnsScanView(env, tenantId));
    return true;
  }
  if (data === "v13:dns:scan:new") {
    const flow: PanelFlow = { flow: "dnsrange", step: FLOW_STEP_DNS_RANGE, data: {} };
    await savePanelFlow(env, telegramUserId, flow);
    await answerCallback(env, queryId, "رنج را بفرستید");
    await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: true });
    return true;
  }
  if (data === "v13:dnstest") {
    await answerCallback(env, queryId, "تست مسمومیت DNS");
    await edit(renderDnsTestView(env));
    return true;
  }
  if (data.startsWith("v13:dnstest:isp:")) {
    const isp = decodeURIComponent(data.slice("v13:dnstest:isp:".length));
    await answerCallback(env, queryId, isp);
    await edit(renderDnsTestView(env, isp));
    return true;
  }
  if (data.startsWith("v13:dnstest:run:")) {
    const [isp, city] = data.slice("v13:dnstest:run:".length).split(":");
    await answerCallback(env, queryId, "فرمان آماده");
    await edit(renderDnsTestView(env, decodeURIComponent(isp ?? ""), decodeURIComponent(city ?? "")));
    return true;
  }
  if (data === "v13:dns:connect") {
    await answerCallback(env, queryId, "فرم اتصال مرکز DNS");
    await edit(await renderStandaloneConnectPrompt(env, tenantId, "dns"));
    return true;
  }
  if (data === "v13:dnsb:master" || data === "v13:dnsb:white" || data === "v13:dnsb:slip") {
    const kind = data.slice("v13:dnsb:".length) as "master" | "white" | "slip";
    await answerCallback(env, queryId, "سازندهٔ کانفیگ");
    await edit(await renderBuilderPicker(env, botPrincipal(tenantId, telegramUserId, ctx.displayName), kind));
    return true;
  }
  if (data.startsWith("v13:dnsb:")) {
    const parts = data.slice("v13:dnsb:".length).split(":");
    const kind = parts[0] as "master" | "white" | "slip";
    const connectionId = parts[1] ?? "";
    const action = parts[2] ?? "";
    const principal = botPrincipal(tenantId, telegramUserId, ctx.displayName);
    try {
      if (kind === "slip" && action === "dom") {
        const flow: PanelFlow = { flow: "slipcfg", step: "slipcfg:line", data: {} };
        await savePanelFlow(env, telegramUserId, flow);
        await answerCallback(env, queryId, "یک خط: دامنه کلید MTU");
        await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: true });
        return true;
      }
      if (kind === "master" && action === "url") {
        await answerCallback(env, queryId, "کانفیگ Master DNS");
        const healthy = await healthyResolvers(env, tenantId);
        const upstreams = healthy.slice(0, 3).map((item) => item.ip);
        const servers = upstreams.length > 0 ? upstreams : ["1.1.1.1"];
        const lines = [
          "🔑 <b>کانفیگ‌های Master DNS شما</b> (پیام محافظ‌شده؛ پس از کپی «🧨 حذف این پیام» را بزنید):",
          upstreams.length > 0
            ? "بالادست‌ها مستقیماً از نتایج اسکنر شما آمده‌اند:"
            : "هنوز بالادست سالمی از اسکنر نداریم؛ فقط 1.1.1.1 نشسته (صادقانه، بدون دادهٔ جعلی).",
          "sing-box — در dns.servers قرار دهید:",
          `<code>${escapeHtml(JSON.stringify({ type: "udp", servers, strategy: "ipv4_only" }))}</code>`,
          "Clash Meta:",
          `<code>dns:\n  enable: true\n  nameserver: [${servers.join(", ")}]</code>`,
          "راهنمای اجرا: ۱) بلوک بالا را در کانفیگ خود بگذارید. ۲) «☁️ انتشار TXT کشف» لیست سالم را در zone شما عمومی می‌کند تا بقیهٔ کلاینت‌ها همگام بمانند. ۳) مهر سلامت: در تست DNS همین رزولورها را بپرسید.",
        ].join("\n");
        await sendView(env, chatId, {
          text: lines,
          keyboard: { inline_keyboard: [[{ text: "🧨 حذف این پیام", callback_data: "v13:delmsg" }], [{ text: "🌐 مرکز DNS", callback_data: "v13:dns" }]] },
          html: true,
          protect: true,
        });
        return true;
      }
      if (kind === "master" && action === "cf") {
        await answerCallback(env, queryId, "انتشار TXT کشف…");
        const published = await publishMasterDiscovery(env, principal, connectionId);
        await sendView(env, chatId, {
          text: `☁️ رکورد TXT کشف در <code>${escapeHtml(published.name)}</code> ثبت/به‌روز شد (${published.count} بالادست سالم). انتشار چند دقیقه طول می‌کشد؛ مهر سلامت: در تست DNS همین نام را با نوع TXT بپرسید.`,
          keyboard: omniBackMenuKeyboard(),
          html: true,
        });
        return true;
      }
      if (kind === "white" && action === "cf") {
        await answerCallback(env, queryId, "انتشار لیست سفید…");
        const winners = await directRaceDomains(env);
        const domains = [...new Set([...winners, "aparat.com", "digikala.com", "bale.ai"])].slice(0, 40);
        const published = await publishWhiteList(env, principal, connectionId, domains);
        const connection = await getConnection(env, connectionId, tenantId);
        const healthy = await healthyResolvers(env, tenantId);
        const upstream = healthy[0]?.ip ?? "1.1.1.1";
        const snippet = [
          "🛡️ کانفیگ sing-box (لیست سفید روی بالادست سالم — پیام محافظ‌شده):",
          `<code>${escapeHtml(JSON.stringify({ type: "udp", tag: "doh-white", server: upstream }))}</code>`,
          `rule: domain_suffix روی ${escapeHtml(domains.slice(0, 10).join("، "))}${domains.length > 10 ? " و بقیهٔ لیست منتشرشده" : ""} → outbound direct با resolver doh-white.`,
          `TXTهای منتشرشده در zone خودتان: ${published} رکورد (نام‌ها: _white1.${escapeHtml(connection.resource_zone_name ?? "zone")} …).`,
        ].join("\n");
        await sendView(env, chatId, { text: snippet, keyboard: omniBackMenuKeyboard(), html: true, protect: true });
        return true;
      }
      if (kind === "white" && action === "dom") {
        const flow: PanelFlow = { flow: "white", step: FLOW_STEP_WHITE_DOMAINS, data: { connection: connectionId } };
        await savePanelFlow(env, telegramUserId, flow);
        await answerCallback(env, queryId, "لیست را بفرستید");
        await edit({ text: flowPrompt(flow), keyboard: panelFlowKeyboard(), html: true });
        return true;
      }
      await answerCallback(env, queryId, "سازندهٔ کانفیگ");
      await edit(await renderBuilderCard(env, principal, kind === "slip" ? null : connectionId, kind));
      return true;
    } catch (error) {
      await showCallbackError(env, chatId, tenantId, telegramUserId, error, data);
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Message updates.
// ---------------------------------------------------------------------------

async function sendLoginLinkMessage(
  env: Env,
  chatId: number,
  tenantId: string,
  telegramUserId: string,
): Promise<Response> {
  const { appUrl, webUrl, ttlMinutes } = await issueLoginPair(env, tenantId, telegramUserId);
  return webhookSend(chatId, omniLoginText(ttlMinutes) + ENV_NOTICE, loginEnvKeyboard(appUrl, webUrl), false, true);
}

async function sendStatusMessage(env: Env, chatId: number, tenantId: string): Promise<Response> {
  const rows = await listRecentDeployments(env, tenantId);
  return webhookSend(chatId, formatDeploymentStatus(rows), omniEnvMenuKeyboard(), false, true);
}

async function sendRendered(chatId: number, view: RenderedView): Promise<Response> {
  return webhookSend(chatId, view.text, view.keyboard, view.html, view.protect === true);
}

async function handleErrorView(
  env: Env,
  chatId: number,
  tenantId: string,
  telegramUserId: string,
  error: unknown,
): Promise<Response> {
  const message = faErrorMessage(error);
  if (message) return webhookSend(chatId, message, omniBackMenuKeyboard());
  return sendRendered(chatId, await renderConnectPrompt(env, tenantId, telegramUserId, "🔌 اتصال Cloudflare منقضی شده؛ اول دوباره وصل شوید."));
}

async function handleMessageUpdate(update: TelegramUpdate, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const message = update.message;
  const user = message?.from;
  if (!message || !user || user.is_bot || message.chat.type !== "private" || String(message.chat.id) !== String(user.id)) {
    return json({ ok: true });
  }
  // Reject stale/replayed updates: Telegram always sends `date` (unix seconds).
  // Anything older than TELEGRAM_MAX_UPDATE_AGE_SECONDS is acknowledged but ignored.
  if (typeof message.date === "number" && Math.abs(Date.now() / 1000 - message.date) > TELEGRAM_MAX_UPDATE_AGE_SECONDS) {
    return json({ ok: true });
  }
  const allowed = await rateLimit(env, `telegram:${user.id}`, TELEGRAM_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (!allowed) {
    return webhookSend(message.chat.id, "درخواست‌ها خیلی سریع ارسال شدند. لطفاً یک دقیقه بعد دوباره تلاش کنید.");
  }
  const tenant = await ensureTenant(env, user);
  const telegramUserId = String(user.id);
  const text = (message.text ?? "").trim();
  const parsed = parseBotCommand(text, env.BOT_USERNAME);

  if (parsed) {
    switch (parsed.command) {
      case "start": {
        const arg = (parsed.args[0] ?? "").toLowerCase();
        if (arg && !V13_DEEP_LINK_ARGS.has(arg)) {
          if (await forwardToOmni(env, update)) return json({ ok: true });
          return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
        }
        if (V13_DEEP_LINK_ARGS.has(arg)) {
          return sendLoginLinkMessage(env, message.chat.id, tenant.id, telegramUserId);
        }
        return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
      }
      case "panel":
        return sendLoginLinkMessage(env, message.chat.id, tenant.id, telegramUserId);
      case "status":
        return sendStatusMessage(env, message.chat.id, tenant.id);
      case "help":
        return webhookSend(message.chat.id, helpIndexText(), helpIndexKeyboard(), true);
      case "cancel": {
        await clearWizard(env, telegramUserId);
        await clearPanelFlow(env, telegramUserId);
        return webhookSend(message.chat.id, "فرایند نیمه‌کاره لغو شد.", omniMainMenuKeyboard());
      }
      case "cleanip":
        return sendRendered(message.chat.id, await renderCleanIpView(env, (parsed.args[0] ?? "mci").toLowerCase(), (parsed.args[1] ?? "tehran").toLowerCase()));
      case "map":
        return sendRendered(message.chat.id, await renderMapView(env));
      case "whitehole":
        return sendRendered(message.chat.id, await renderWhiteHoleView(env, tenant.id));
      case "donate":
        return sendRendered(message.chat.id, renderDonationIntro(isAdminUserId(env, telegramUserId)));
      case "health":
        return sendRendered(message.chat.id, { ...(await renderHealthView(env, tenant.id, telegramUserId)), protect: true });
      case "usage":
        return sendRendered(message.chat.id, { ...(await renderUsageView(env, tenant.id, telegramUserId)), protect: true });
      case "pack": {
        const flow: PanelFlow = { flow: "pack", step: FLOW_STEP_PACK_DOMAIN, data: {} };
        await savePanelFlow(env, telegramUserId, flow);
        return webhookSend(message.chat.id, flowPrompt(flow), panelFlowKeyboard(), true);
      }
      case "dnstt": {
        const flow: PanelFlow = { flow: "dnstt", step: FLOW_STEP_DNSTT_VPS, data: {} };
        await savePanelFlow(env, telegramUserId, flow);
        return webhookSend(message.chat.id, renderDnsttIntroText(), panelFlowKeyboard(), true);
      }
      default: {
        if (await forwardToOmni(env, update)) return json({ ok: true });
        return webhookSend(message.chat.id, omniUnknownCommandText(), omniMainMenuKeyboard());
      }
    }
  }

  if (text === OMNI_MENU_TEXT_SATELLITE) {
    return sendLoginLinkMessage(env, message.chat.id, tenant.id, telegramUserId);
  }
  if (text === OMNI_MENU_TEXT_DEPS) {
    await clearWizard(env, telegramUserId);
    try {
      return sendRendered(message.chat.id, await renderDepsList(env, tenant.id, tenant.displayName, telegramUserId));
    } catch (error) {
      return handleErrorView(env, message.chat.id, tenant.id, telegramUserId, error);
    }
  }
  if (text === OMNI_MENU_TEXT_CONNS) {
    await clearWizard(env, telegramUserId);
    try {
      return sendRendered(message.chat.id, await renderConnsList(env, tenant.id, tenant.displayName, telegramUserId));
    } catch (error) {
      return handleErrorView(env, message.chat.id, tenant.id, telegramUserId, error);
    }
  }
  if (text === OMNI_MENU_TEXT_STATUS) {
    return sendStatusMessage(env, message.chat.id, tenant.id);
  }
  if (text === OMNI_MENU_TEXT_HELP) {
    return webhookSend(message.chat.id, helpIndexText(), helpIndexKeyboard(), true);
  }
  if (text === OMNI_MENU_TEXT_CHECK) {
    return sendRendered(message.chat.id, await renderRadarCheckView(env));
  }
  if (text === OMNI_MENU_TEXT_CLEAN_IP) {
    return sendRendered(message.chat.id, await renderCleanIpView(env, "mci", "tehran"));
  }
  if (text === OMNI_MENU_TEXT_MAP) {
    return sendRendered(message.chat.id, await renderMapView(env));
  }
  if (text === OMNI_MENU_TEXT_WHITEHOLE) {
    return sendRendered(message.chat.id, await renderWhiteHoleView(env, tenant.id));
  }
  if (text === OMNI_MENU_TEXT_DONATE) {
    return sendRendered(message.chat.id, renderDonationIntro(isAdminUserId(env, telegramUserId)));
  }
  if (text === OMNI_MENU_TEXT_HEALTH) {
    return sendRendered(message.chat.id, { ...(await renderHealthView(env, tenant.id, telegramUserId)), protect: true });
  }
  if (text === OMNI_MENU_TEXT_USAGE) {
    return sendRendered(message.chat.id, { ...(await renderUsageView(env, tenant.id, telegramUserId)), protect: true });
  }
  if (text === OMNI_MENU_TEXT_HOME) {
    await clearWizard(env, telegramUserId);
    return webhookSend(message.chat.id, omniWelcomeText(), omniMainMenuKeyboard());
  }

  const wizard = await loadWizard(env, telegramUserId);
  if (wizard) {
    const result = await processWizardText(env, telegramUserId, wizard, text);
    return webhookSend(message.chat.id, result.text, result.keyboard);
  }

  const flow = await loadPanelFlow(env, telegramUserId);
  if (flow) {
    try {
      if (flow.flow === "panel") {
        return await handlePanelDeployText(env, message.chat.id, tenant.id, tenant.displayName, telegramUserId, flow, text);
      }
      if (flow.flow === "pack") {
        const packResult = await processPanelFlowText(env, telegramUserId, tenant.id, flow, text);
        if (packResult.kind === "prompt") {
          return webhookSend(message.chat.id, packResult.text, panelFlowKeyboard(), true);
        }
        // The pack carries the operator's own UUID: copyable (it has to be pasted
        // into a client) with an explicit "delete this message" escape hatch.
        await sendView(env, message.chat.id, {
          text: packResult.text,
          keyboard: {
            inline_keyboard: [
              [{ text: "🧨 حذف این پیام", callback_data: "v13:delmsg" }],
              [{ text: "👻 بستهٔ دیگر", callback_data: "v13:pack" }],
            ],
          },
          html: true,
        });
        return json({ ok: true });
      }
      if (flow.flow === "dnsrange") {
        try {
          const parsed = await replaceScanRange(env, tenant.id, text);
          await clearPanelFlow(env, telegramUserId);
          const sent = await telegramApi(env, "sendMessage", {
            chat_id: message.chat.id,
            text: `${liveScanText(parsed.cidr, { scanned: 0, total: parsed.ips.length, healthy: 0, fake: 0, wrong: 0, unreachable: 0 })}\nرنج‌های قبلی پاک شدند؛ فقط همین رنج، همین‌جا و کامل اسکن می‌شود.`,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          });
          const progressId = (sent.result as { message_id?: number } | undefined)?.message_id;
          await env.DB.prepare("UPDATE dns_scan_ranges SET live_chat_id = ?, live_message_id = ? WHERE id = ?")
            .bind(String(message.chat.id), progressId ?? null, parsed.rangeId)
            .run();
          if (ctx) {
            ctx.waitUntil(chainNextTick(env, ctx, parsed.rangeId));
            return json({ ok: true });
          }
          await advanceLiveScan(env, null, parsed.rangeId);
          return json({ ok: true });
        } catch (error) {
          const reason = faErrorMessage(error) ?? "رنج معتبر نیست؛ مثال: 178.22.122.0/24";
          return webhookSend(message.chat.id, `⚠️ ${reason}`, panelFlowKeyboard());
        }
      }
      if (flow.flow === "white") {
        const domains = text.split(/[،,\s]+/u).filter((part) => part.length > 0).slice(0, 40);
        const connectionId = flow.data["connection"] ?? "";
        if (domains.length === 0 || connectionId.length === 0) {
          return webhookSend(message.chat.id, "⚠️ هیچ دامنهٔ معتبری پیدا نشد یا اتصال انتخاب نشده؛ از «🛡️ White DNS» دوباره شروع کنید.", panelFlowKeyboard());
        }
        try {
          const principal = botPrincipal(tenant.id, telegramUserId, tenant.displayName);
          const published = await publishWhiteList(env, principal, connectionId, domains);
          await clearPanelFlow(env, telegramUserId);
          const connection = await getConnection(env, connectionId, tenant.id);
          const healthy = await healthyResolvers(env, tenant.id);
          const upstream = healthy[0]?.ip ?? "1.1.1.1";
          await sendView(env, message.chat.id, {
            text: [
              `🛡️ لیست سفید منتشر شد: ${published} رکورد TXT خواندنی (<code>_white1.${escapeHtml(connection.resource_zone_name ?? "")}</code> …)؛ دامنه‌ها: <code>${escapeHtml(domains.join("، "))}</code>`,
              `کانفیگ sing-box (روی بالادست سالم اسکنر): <code>${escapeHtml(JSON.stringify({ type: "udp", tag: "doh-white", server: upstream }))}</code>`,
              "راهنمای اجرا: ۱) این JSON را در dns.servers بگذارید. ۲) rule با domain_suffix روی لیست خود → outbound direct. ۳) مهر سلامت: در تست DNS یکی از دامنه‌ها را بپرسید — باید REAL برگردد.",
            ].join("\n"),
            keyboard: omniBackMenuKeyboard(),
            html: true,
          });
          return sendRendered(message.chat.id, await renderBuilderCard(env, principal, connectionId, "white"));
        } catch (error) {
          await clearPanelFlow(env, telegramUserId);
          const reason = faErrorMessage(error) ?? "انتشار ناموفق بود؛ اتصال Cloudflare را بررسی کنید.";
          return webhookSend(message.chat.id, `⚠️ ${reason}`, omniMainMenuKeyboard());
        }
      }
      if (flow.flow === "slipcfg") {
        const parts = text.trim().split(/\s+/);
        const domain = (parts[0] ?? "").toLowerCase();
        const pubkey = (parts[1] ?? "").toLowerCase();
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || !/^[0-9a-f]{64}$/.test(pubkey)) {
          return webhookSend(message.chat.id, "⚠️ فرمت درست یک خط است: «تونل.example.com <کلید عمومی 64 کاراکتر hex> [MTU]». دوباره بفرستید.", panelFlowKeyboard());
        }
        const mtu = Number(parts[2] ?? TUNNEL_DEFAULT_MTU);
        if (!Number.isInteger(mtu) || mtu < 1000 || mtu > 9000) {
          return webhookSend(message.chat.id, "⚠️ MTU باید عددی بین ۱۰۰۰ تا ۹۰۰۰ باشد.", panelFlowKeyboard());
        }
        await clearPanelFlow(env, telegramUserId);
        const uri = slipnetUri(domain, pubkey, mtu);
        await sendView(env, message.chat.id, {
          text: [
            "🌊 <b>کانفیگ Slipstream شما</b>",
            `<code>${escapeHtml(uri)}</code>`,
            "راهنمای اجرا: ۱) در اپ SlipNet/Slipstream گزینهٔ Import/Add config را بزنید و همین خط را paste کنید. ۲) فقط همین یک نود فعال شود. ۳) مهر سلامت: در تست DNS یک پرسش TXT روی دامنهٔ تونل بزنید — پاسخ باید همان چیزی باشد که سمت سرور برگردانده (بدون دستکاری اپراتور).",
            "هیچ استقرار V13 در این مسیر لازم نیست؛ فقط یک نود Slipstream که خودتان بالا آورده‌اید.",
          ].join("\n"),
          keyboard: omniBackMenuKeyboard(),
          html: true,
        });
        return json({ ok: true });
      }
      const result = await processPanelFlowText(env, telegramUserId, tenant.id, flow, text);
      const followUp = result.followUp === "clean-ip"
        ? await renderCleanIpView(env, flow.data["operator"] ?? "mci", flow.data["city"] ?? "tehran")
        : result.followUp === "map"
          ? await renderMapView(env)
          : null;
      if (result.kind === "prompt") {
        return webhookSend(message.chat.id, result.text, panelFlowKeyboard());
      }
      if (followUp && result.kind === "done") {
        await sendView(env, message.chat.id, { text: result.text, keyboard: panelFlowKeyboard(), html: true });
        return sendRendered(message.chat.id, followUp);
      }
      return webhookSend(message.chat.id, result.text, followUp?.keyboard ?? omniMainMenuKeyboard(), true);
    } catch (error) {
      await clearPanelFlow(env, telegramUserId);
      const reason = faErrorMessage(error) ?? "فرایند لغو شد؛ دوباره شروع کنید.";
      return webhookSend(message.chat.id, `⚠️ ${reason}`, omniMainMenuKeyboard());
    }
  }

  if (await forwardToOmni(env, update)) return json({ ok: true });
  return webhookSend(message.chat.id, omniFreeTextReply(), omniMainMenuKeyboard());
}

// ---------------------------------------------------------------------------
// Callback updates.
// ---------------------------------------------------------------------------

async function answerCallback(
  env: Env,
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await telegramApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

async function editView(
  env: Env,
  chatId: number,
  messageId: number,
  view: RenderedView,
): Promise<void> {
  try {
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: view.text,
      ...(view.html ? { parse_mode: "HTML" } : {}),
      disable_web_page_preview: true,
      reply_markup: view.keyboard,
    });
  } catch (error) {
    if (view.html && isParseError(error)) {
      try {
        await telegramApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, ...plainPayload(view) });
        return;
      } catch {
        // fall through to the stripped sendMessage, then the plain one
      }
      try {
        await telegramApi(env, "sendMessage", { chat_id: chatId, ...plainPayload(view) });
        return;
      } catch {
        // fall through
      }
    }
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: view.text,
      ...(view.html ? { parse_mode: "HTML" } : {}),
      ...(view.protect === true ? { protect_content: true } : {}),
      disable_web_page_preview: true,
      reply_markup: view.keyboard,
    });
  }
}

async function sendView(
  env: Env,
  chatId: number,
  view: RenderedView,
): Promise<void> {
  try {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: view.text,
      ...(view.html ? { parse_mode: "HTML" } : {}),
      ...(view.protect === true ? { protect_content: true } : {}),
      disable_web_page_preview: true,
      reply_markup: view.keyboard,
    });
  } catch (error) {
    if (view.html && isParseError(error)) {
      await telegramApi(env, "sendMessage", { chat_id: chatId, ...plainPayload(view) });
      return;
    }
    throw error;
  }
}

async function answerError(
  env: Env,
  chatId: number,
  tenantId: string,
  telegramUserId: string,
  queryId: string,
  error: unknown,
): Promise<void> {
  console.error("telegram_callback_error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  const message = faErrorMessage(error);
  if (message) {
    await answerCallback(env, queryId, message, true);
    return;
  }
  await answerCallback(env, queryId, "اتصال Cloudflare منقضی شده است.");
  await sendView(env, chatId, await renderConnectPrompt(env, tenantId, telegramUserId, "🔌 برای این عملیات اول دوباره وصل شوید."));
}

function deploymentIdFrom(data: string, prefix: string): string | null {
  if (!data.startsWith(prefix)) return null;
  const id = data.slice(prefix.length);
  return /^[0-9a-f-]{36}$/u.test(id) ? id : null;
}

async function handleCallbackUpdate(update: TelegramUpdate, env: Env): Promise<Response> {
  const query: TelegramCallbackQuery | undefined = update.callback_query;
  const user = query?.from;
  const chatId = query?.message?.chat.id;
  const chatType = query?.message?.chat.type;
  if (!query || !user || user.is_bot || !chatId || chatType !== "private" || String(chatId) !== String(user.id)) {
    return json({ ok: true });
  }
  const allowed = await rateLimit(env, `telegram:${user.id}`, TELEGRAM_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (!allowed) {
    try {
      await answerCallback(env, query.id, "درخواست‌ها خیلی سریع است؛ یک دقیقه بعد تلاش کنید.", true);
    } catch {
      // Best effort: never fail the webhook on a rate-limit notice.
    }
    return json({ ok: true });
  }

  const data = query.data ?? "";
  if (!data.startsWith("v13:") && !data.startsWith("omni:") && !data.startsWith("wiz:")) {
    if (await forwardToOmni(env, update)) return json({ ok: true });
    try {
      await answerCallback(env, query.id, "این دکمه متعلق به بخش دیگری است.", true);
    } catch {
      // Best effort only.
    }
    return json({ ok: true });
  }

  try {
    const tenant = await ensureTenant(env, user);
    const telegramUserId = String(user.id);
    const principal = botPrincipal(tenant.id, telegramUserId, tenant.displayName);
    const messageId = query.message?.message_id;

    // --- Private environment section (standalone) ---
    if (data === "v13:login") {
      const { appUrl, webUrl, ttlMinutes } = await issueLoginPair(env, tenant.id, telegramUserId);
      await answerCallback(env, query.id, "لینک ورود ساخته شد ✅");
      await sendView(env, chatId, { text: omniLoginText(ttlMinutes) + ENV_NOTICE, keyboard: loginEnvKeyboard(appUrl, webUrl), html: false, protect: true });
      return json({ ok: true });
    }
    if (data === "v13:status") {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "در حال دریافت وضعیت…");
      const rows = await listRecentDeployments(env, tenant.id);
      await editView(env, chatId, messageId, { text: formatDeploymentStatus(rows), keyboard: omniEnvMenuKeyboard(), html: false });
      return json({ ok: true });
    }
    if (data === "v13:help" || data.startsWith("v13:help:")) {
      if (data === "v13:help") {
        await answerCallback(env, query.id, "راهنما");
        // Documentation is meant to be copied, so it leaves the locked message
        // instead of editing inside it: a fresh, unprotected view.
        await sendView(env, chatId, { text: helpIndexText(), keyboard: helpIndexKeyboard(), html: true });
        return json({ ok: true });
      }
      const topic = findHelpTopic(data.slice("v13:help:".length));
      if (!topic) {
        await answerCallback(env, query.id, "بخش نامشخص است.", true);
        return json({ ok: true });
      }
      await answerCallback(env, query.id, topic.label);
      await sendView(env, chatId, { text: helpTopicText(topic), keyboard: helpTopicKeyboard(), html: true });
      return json({ ok: true });
    }
    if (data === "omni:home") {
      if (messageId === undefined) return json({ ok: true });
      await clearWizard(env, telegramUserId);
      await answerCallback(env, query.id, "منوی اصلی Omni");
      await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
      await sendView(env, chatId, { text: omniWelcomeText(), keyboard: omniMainMenuKeyboard(), html: false });
      return json({ ok: true });
    }
    if (data === "v13:delmsg") {
      if (messageId === undefined) return json({ ok: true });
      try {
        await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
        await answerCallback(env, query.id, "حذف شد 🧨");
      } catch {
        await answerCallback(env, query.id, "حذف نشد؛ لطفاً دستی حذفش کنید.", true);
      }
      return json({ ok: true });
    }

    // --- Deployments browser ---
    if (data === "v13:deps") {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "استقرارها");
      await editView(env, chatId, messageId, await renderDepsList(env, tenant.id, tenant.displayName, telegramUserId));
      return json({ ok: true });
    }
    if (data === "v13:dep:new") {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "کاتالوگ پنل‌ها");
      await editView(env, chatId, messageId, {
        text: panelCatalogText(),
        keyboard: panelCatalogKeyboard(),
        html: true,
      });
      return json({ ok: true });
    }
    const pickedConnection = deploymentIdFrom(data, "v13:conn-panel:");
    if (pickedConnection) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "پنل را انتخاب کنید.");
      await editView(env, chatId, messageId, {
        text: panelCatalogText(),
        keyboard: panelCatalogKeyboard(pickedConnection),
        html: true,
      });
      return json({ ok: true });
    }
    const panelPick = parsePanelPick(data);
    if (panelPick) {
      const spec = findPanel(panelPick.key);
      if (!spec) {
        await answerCallback(env, query.id, "چنین پنلی در کاتالوگ نداریم.", true);
        return json({ ok: true });
      }
      await clearWizard(env, telegramUserId);
      await clearPanelFlow(env, telegramUserId);
      // Owner request: panels never ask about connections or zones — a panel
      // deploys on workers.<account> with no domain, so picking one always
      // starts the panel's own one-click token step. (A connectionId only
      // arrives from legacy picker buttons; those keep working.)
      const connectionId = panelPick.connectionId;
      if (!connectionId) {
        const tokenFlow: PanelFlow = {
          flow: "panel",
          step: FLOW_STEP_PANEL_TOKEN,
          data: { panel: spec.key, panel_name: spec.name },
        };
        await savePanelFlow(env, telegramUserId, tokenFlow);
        await answerCallback(env, query.id, "توکن پنل را بفرستید");
        const tokenView: RenderedView = { text: flowPrompt(tokenFlow), keyboard: panelTokenKeyboard(), html: true };
        if (messageId === undefined) await sendView(env, chatId, tokenView);
        else await editView(env, chatId, messageId, tokenView);
        return json({ ok: true });
      }
      const flow: PanelFlow = { flow: "panel", step: FLOW_STEP_PANEL_NAME, data: { panel: spec.key, connection: connectionId } };
      await savePanelFlow(env, telegramUserId, flow);
      await answerCallback(env, query.id, `${spec.name} — نام Worker را بفرستید`);
      const view: RenderedView = { text: panelPromptFor(spec), keyboard: panelFlowKeyboard(), html: true };
      if (messageId === undefined) await sendView(env, chatId, view);
      else await editView(env, chatId, messageId, view);
      return json({ ok: true });
    }
    if (data === "v13:dep-vps" || data.startsWith("v13:dep-vps:")) {
      let connectionId = data.slice("v13:dep-vps:".length);
      if (!connectionId && messageId !== undefined) {
        const connections = await botListConnections(env, principal);
        if (connections.length === 0) {
          // The VPS wizard belongs to the dedicated environment, so its
          // missing connection is the dedicated-env connection.
          await answerCallback(env, query.id, "اول اتصال Cloudflare");
          await editView(
            env,
            chatId,
            messageId,
            await renderConnectPrompt(env, tenant.id, telegramUserId, "🔌 برای دیپلوی کامل VPS اول در محیط اختصاصی اتصال Cloudflare را وصل کنید."),
          );
          return json({ ok: true });
        }
        if (connections.length > 1) {
          await answerCallback(env, query.id, "اتصال را انتخاب کنید");
          const rows: TelegramInlineKeyboard["inline_keyboard"] = connections.map((connection) => ([
            { text: (connection.resource_zone_name ?? shortId(connection.id)).slice(0, 40), callback_data: `v13:dep-vps:${connection.id}` },
          ]));
          rows.push(cancelKeyboard().inline_keyboard[0]!);
          await editView(env, chatId, messageId, {
            text: "🖥️ ویزارد کامل VPS روی کدام اتصال Cloudflare اجرا شود؟",
            keyboard: { inline_keyboard: rows },
            html: false,
          });
          return json({ ok: true });
        }
        connectionId = connections[0]?.id ?? "";
      }
      try {
        const boundary = await botConnectionBoundary(env, principal, connectionId);
        const prompt = await beginDeployWizard(env, telegramUserId, boundary);
        await answerCallback(env, query.id, "شروع شد ✅");
        const view: RenderedView = { text: prompt.text, keyboard: prompt.keyboard, html: false };
        if (messageId === undefined) await sendView(env, chatId, view);
        else await editView(env, chatId, messageId, view);
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const panelDeleteYes = deploymentIdFrom(data, "v13:pdel-yes:");
    if (panelDeleteYes) {
      const outcome = await deletePanelDeployment(env, principal, panelDeleteYes);
      await answerCallback(env, query.id, outcome.deleted ? "🗑 رکورد استقرار پنل حذف شد" : "این رکورد حذف‌شدنی نیست.");
      if (messageId !== undefined) {
        await editView(env, chatId, messageId, await renderDepsList(env, tenant.id, tenant.displayName, telegramUserId));
      }
      return json({ ok: true });
    }
    const panelDelete = deploymentIdFrom(data, "v13:pdel:");
    if (panelDelete) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "تأیید حذف رکورد");
      await editView(env, chatId, messageId, {
        text: "🗑 فقط رکورد این استقرار پنل حذف می‌شود؛ پنل روی Cloudflare دست‌نخورده می‌ماند (برای بستن واقعی، اتصال را ابطال کنید). ادامه می‌دهید؟",
        keyboard: {
          inline_keyboard: [
            [{ text: "🗑 بله، رکورد حذف شود", callback_data: `v13:pdel-yes:${panelDelete}` }],
            [{ text: "❌ منصرف شدم", callback_data: "v13:deps" }],
          ],
        },
        html: false,
      });
      return json({ ok: true });
    }
    if (data === "wiz:cancel") {
      await clearWizard(env, telegramUserId);
      await clearPanelFlow(env, telegramUserId);
      await answerCallback(env, query.id, "لغو شد.");
      if (messageId !== undefined) {
        await telegramApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
      }
      await sendView(env, chatId, { text: omniWelcomeText(), keyboard: omniMainMenuKeyboard(), html: false });
      return json({ ok: true });
    }
    if (data === "wiz:sni-def" || data === "wiz:ufw:1" || data === "wiz:ufw:0") {
      if (messageId === undefined) return json({ ok: true });
      const wizard = await loadWizard(env, telegramUserId);
      if (!wizard) {
        await answerCallback(env, query.id, "فرایند منقضی شده؛ از اول شروع کنید.", true);
        return json({ ok: true });
      }
      if (data === "wiz:sni-def") {
        const prompt = await applySniDefault(env, telegramUserId, wizard);
        await answerCallback(env, query.id, "پیش‌فرض انتخاب شد.");
        await editView(env, chatId, messageId, { text: prompt.text, keyboard: prompt.keyboard, html: false });
      } else {
        const prompt = await applyUfwChoice(env, telegramUserId, wizard, data === "wiz:ufw:1");
        await answerCallback(env, query.id, "ثبت شد.");
        await editView(env, chatId, messageId, { text: prompt.text, keyboard: prompt.keyboard, html: false });
      }
      return json({ ok: true });
    }
    if (data === "wiz:confirm") {
      const wizard = await loadWizard(env, telegramUserId);
      if (!wizard) {
        await answerCallback(env, query.id, "فرایند منقضی شده؛ از اول شروع کنید.", true);
        return json({ ok: true });
      }
      const state = wizard.state;
      if (!state.workerName || !state.workerHostname || !state.nodeHostname || !state.vpsIpv4 || !state.acmeEmail || !state.realityServerName || state.enableUfw === undefined) {
        await answerCallback(env, query.id, "اطلاعات ناقص است؛ از اول شروع کنید.", true);
        await clearWizard(env, telegramUserId);
        return json({ ok: true });
      }
      try {
        await answerCallback(env, query.id, "در حال ساخت…");
        const created = await botCreateDeployment(env, principal, {
          connectionId: state.connectionId,
          accountId: state.accountId,
          zoneId: state.zoneId,
          workerName: state.workerName,
          workerHostname: state.workerHostname,
          nodeHostname: state.nodeHostname,
          vpsIpv4: state.vpsIpv4,
          acmeEmail: state.acmeEmail,
          realityServerName: state.realityServerName,
          enableUfw: state.enableUfw,
        });
        await clearWizard(env, telegramUserId);
        const bootstrap = renderBootstrapMessage(created.bootstrap, state.workerName);
        await sendView(env, chatId, {
          text: `✅ استقرار ساخته شد و Workflow آغاز شد.\n🆔 ${shortId(created.deploymentId)}`,
          keyboard: omniBackMenuKeyboard(),
          html: false,
        });
        await sendView(env, chatId, { text: bootstrap.text, keyboard: bootstrap.keyboard, html: true, protect: true });
      } catch (error) {
        const message = faErrorMessage(error);
        await clearWizard(env, telegramUserId);
        if (message) {
          await answerCallback(env, query.id, "ساخت ناموفق بود.");
          await sendView(env, chatId, {
            text: `${message}\n\nبا «ساخت استقرار جدید» دوباره تلاش کنید.`,
            keyboard: {
              inline_keyboard: [
                [{ text: "🔁 شروع دوباره", callback_data: "v13:dep:new" }],
                [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
              ],
            },
            html: false,
          });
        } else {
          await answerCallback(env, query.id, "اتصال Cloudflare منقضی شده است.");
          await sendView(env, chatId, await renderConnectPrompt(env, tenant.id, telegramUserId, "🔌 اتصال Cloudflare منقضی شده؛ اول دوباره وصل شوید."));
        }
      }
      return json({ ok: true });
    }

    const depDetail = deploymentIdFrom(data, "v13:dep:");
    if (depDetail) {
      if (messageId === undefined) return json({ ok: true });
      try {
        await answerCallback(env, query.id, "جزئیات");
        await editView(env, chatId, messageId, await renderDepDetail(env, tenant.id, tenant.displayName, telegramUserId, depDetail));
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depRetry = deploymentIdFrom(data, "v13:dep-retry:");
    if (depRetry) {
      try {
        await botRetryDeployment(env, principal, depRetry);
        await answerCallback(env, query.id, "Workflow جدید آغاز شد ✅");
        if (messageId !== undefined) {
          await editView(env, chatId, messageId, await renderDepDetail(env, tenant.id, tenant.displayName, telegramUserId, depRetry));
        }
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depRevoke = deploymentIdFrom(data, "v13:dep-revoke:");
    if (depRevoke && !data.startsWith("v13:dep-revoke-yes:")) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "تأیید ابطال");
      await editView(env, chatId, messageId, {
        text: "⚠️ این استقرار باطل شود؟ اشتراک‌ها از کار می‌افتند و این عمل قابل بازگشت نیست.",
        keyboard: {
          inline_keyboard: [
            [{ text: "🛑 بله، ابطال شود", callback_data: `v13:dep-revoke-yes:${depRevoke}` }],
            [{ text: "❌ منصرف شدم", callback_data: `v13:dep:${depRevoke}` }],
          ],
        },
        html: false,
      });
      return json({ ok: true });
    }
    const depRevokeYes = deploymentIdFrom(data, "v13:dep-revoke-yes:");
    if (depRevokeYes) {
      try {
        await botRevokeDeployment(env, principal, depRevokeYes);
        await answerCallback(env, query.id, "ابطال آغاز شد.");
        if (messageId !== undefined) {
          await editView(env, chatId, messageId, await renderDepDetail(env, tenant.id, tenant.displayName, telegramUserId, depRevokeYes));
        }
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depDelete = deploymentIdFrom(data, "v13:dep-del:");
    if (depDelete && !data.startsWith("v13:dep-del-yes:")) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "تأیید حذف");
      await editView(env, chatId, messageId, {
        text: "⚠️ رکورد این استقرار از دیتابیس حذف می‌شود (با همهٔ گزارش‌ها و توکن‌هایش). اگر نود هنوز روی Cloudflare زنده است، اول «🛑 ابطال» را بزنید.\n\nاین عمل قابل بازگشت نیست.",
        keyboard: {
          inline_keyboard: [
            [{ text: "🗑 بله، حذف شود", callback_data: `v13:dep-del-yes:${depDelete}` }],
            [{ text: "❌ منصرف شدم", callback_data: `v13:dep:${depDelete}` }],
          ],
        },
        html: false,
      });
      return json({ ok: true });
    }
    const depDeleteYes = deploymentIdFrom(data, "v13:dep-del-yes:");
    if (depDeleteYes) {
      try {
        await botDeleteDeployment(env, principal, depDeleteYes);
        await audit(env, {
          tenantId: tenant.id,
          actorType: "telegram",
          actorId: telegramUserId,
          action: "deployment.delete",
          resourceType: "deployment",
          resourceId: depDeleteYes,
          outcome: "success",
        });
        await answerCallback(env, query.id, "حذف شد 🗑");
        if (messageId !== undefined) {
          await editView(env, chatId, messageId, {
            text: "🗑 رکورد استقرار حذف شد. برای دیدن بقیه: «📁 دیپلوی‌های من»",
            keyboard: omniEnvMenuKeyboard(),
            html: false,
          });
        }
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depBoot = deploymentIdFrom(data, "v13:dep-boot:");
    if (depBoot) {
      try {
        const detail = await botGetDeployment(env, principal, depBoot);
        const rotated = await botRotateBootstrap(env, principal, depBoot);
        const bootstrap = renderBootstrapMessage(rotated.bootstrap, detail.deployment.workerName);
        await answerCallback(env, query.id, "بوت‌استرپ جدید صادر شد ✅");
        await sendView(env, chatId, { text: bootstrap.text, keyboard: bootstrap.keyboard, html: true, protect: true });
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depSubs = deploymentIdFrom(data, "v13:dep-subs:");
    if (depSubs) {
      try {
        const detail = await botGetDeployment(env, principal, depSubs);
        if (!detail.subscriptions) {
          await answerCallback(env, query.id, "اشتراک فقط برای استقرار فعال نمایش داده می‌شود.", true);
          return json({ ok: true });
        }
        const view = renderSubscriptionsMessage(detail.subscriptions, detail.deployment.workerName, false);
        await answerCallback(env, query.id, "اشتراک‌ها");
        await sendView(env, chatId, { text: view.text, keyboard: view.keyboard, html: true, protect: true });
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }
    const depSubrot = deploymentIdFrom(data, "v13:dep-subrot:");
    if (depSubrot && !data.startsWith("v13:dep-subrot-yes:")) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "تأیید چرخش اشتراک");
      await editView(env, chatId, messageId, {
        text: "🔁 اشتراک‌های فعلی از کار می‌افتند و لینک جدید صادر می‌شود. ادامه می‌دهید؟",
        keyboard: {
          inline_keyboard: [
            [{ text: "🔁 بله، بچرخان", callback_data: `v13:dep-subrot-yes:${depSubrot}` }],
            [{ text: "❌ منصرف شدم", callback_data: `v13:dep:${depSubrot}` }],
          ],
        },
        html: false,
      });
      return json({ ok: true });
    }
    const depSubrotYes = deploymentIdFrom(data, "v13:dep-subrot-yes:");
    if (depSubrotYes) {
      try {
        const detail = await botGetDeployment(env, principal, depSubrotYes);
        const rotated = await botRotateSubscription(env, principal, depSubrotYes);
        const view = renderSubscriptionsMessage(rotated.subscriptions, detail.deployment.workerName, true);
        await answerCallback(env, query.id, "اشتراک چرخید ✅");
        await sendView(env, chatId, { text: view.text, keyboard: view.keyboard, html: true, protect: true });
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }

    // --- Cloudflare connections browser ---
    if (data === "v13:conns") {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "اتصال‌ها");
      await editView(env, chatId, messageId, await renderConnsList(env, tenant.id, tenant.displayName, telegramUserId));
      return json({ ok: true });
    }
    if (data === "v13:conn-new") {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "ورود به پنل امن");
      await editView(
        env,
        chatId,
        messageId,
        await renderConnectPrompt(env, tenant.id, telegramUserId, "➕ ساخت اتصال جدید فقط در پنل امن انجام می‌شود."),
      );
      return json({ ok: true });
    }
    const connDisc = deploymentIdFrom(data, "v13:conn-disc:");
    if (connDisc && !data.startsWith("v13:conn-disc-yes:")) {
      if (messageId === undefined) return json({ ok: true });
      await answerCallback(env, query.id, "تأیید قطع اتصال");
      await editView(env, chatId, messageId, {
        text: "🗑️ این اتصال قطع شود؟ نسخهٔ ذخیره‌شده از V13 پاک می‌شود (توکن اصلی در Cloudflare می‌ماند).",
        keyboard: {
          inline_keyboard: [
            [{ text: "🗑️ بله، قطع شود", callback_data: `v13:conn-disc-yes:${connDisc}` }],
            [{ text: "❌ منصرف شدم", callback_data: "v13:conns" }],
          ],
        },
        html: false,
      });
      return json({ ok: true });
    }
    const connDiscYes = deploymentIdFrom(data, "v13:conn-disc-yes:");
    if (connDiscYes) {
      try {
        await botDisconnectConnection(env, principal, connDiscYes);
        await answerCallback(env, query.id, "قطع شد ✅");
        if (messageId !== undefined) {
          await editView(env, chatId, messageId, await renderConnsList(env, tenant.id, tenant.displayName, telegramUserId));
        }
      } catch (error) {
        await answerError(env, chatId, tenant.id, telegramUserId, query.id, error);
      }
      return json({ ok: true });
    }

    if (await handlePanelCallback({
      env,
      chatId,
      messageId,
      queryId: query.id,
      tenantId: tenant.id,
      displayName: tenant.displayName,
      telegramUserId,
      data,
    })) {
      return json({ ok: true });
    }

    if (await forwardToOmni(env, update)) return json({ ok: true });
    await answerCallback(env, query.id, "این دکمه دیگر معتبر نیست.", true);
    return json({ ok: true });
  } catch (error) {
    console.error("telegram_callback_failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await answerCallback(env, query.id, "خطای موقت؛ دوباره تلاش کنید.", true);
    } catch {
      // Best effort only.
    }
    return json({ ok: true });
  }
}

export async function handleTelegramWebhook(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !(await constantTimeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
    await audit(env, { actorType: "telegram", action: "webhook.authenticate", outcome: "denied", request });
    throw new HttpError(401, "invalid_webhook_secret", "Unauthorized");
  }
  const update = await readJson<TelegramUpdate>(request, 64_000);
  if (!Number.isSafeInteger(update.update_id)) throw new HttpError(400, "invalid_update", "Invalid Telegram update");
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
    .bind(update.update_id, nowIso()).run();
  if ((inserted.meta.changes ?? 0) === 0) return json({ ok: true });

  if (update.callback_query) return handleCallbackUpdate(update, env);
  if (update.message) return handleMessageUpdate(update, env, ctx);
  if (await forwardToOmni(env, update)) return json({ ok: true });
  return json({ ok: true });
}

export async function sendTelegramMessage(env: Env, telegramUserId: string, text: string): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: telegramUserId,
    text,
    disable_web_page_preview: true,
  });
}
