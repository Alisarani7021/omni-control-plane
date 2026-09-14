/**
 * i18n. Two dictionaries, one `t()` call.
 *
 * Zeus hardcodes Persian strings inside the HTML template *and* English ones in
 * the worker, so changing a label means editing a 6,000-line template literal.
 * Here every string has a key, and the whole UI can be re-rendered in another
 * language (or re-skinned for a reseller) without touching a single view.
 */

const DICT = {
  fa: {
    app: { name: "کاوه", tagline: "پنل پروکسی لبه‌ای" },
    nav: { dashboard: "داشبورد", users: "کاربران", settings: "تنظیمات", diag: "عیب‌یابی", sessions: "نشست‌ها", logout: "خروج" },
    login: {
      title: "ورود به پنل", setupTitle: "راه‌اندازی کاوه",
      password: "رمز عبور", username: "نام کاربری", newPassword: "رمز جدید",
      submit: "ورود", setup: "ساخت پنل", recover: "بازیابی رمز",
      hint: "رمز عبور با PBKDF2 و ۲۱۰٬۰۰۰ تکرار هش می‌شود.",
      setupHint: "حداقل ۱۰ کاراکتر. این رمز تنها یک‌بار قابل تنظیم است.",
    },
    dash: {
      users: "کاربران", active: "فعال", expired: "منقضی", traffic: "ترافیک مصرفی",
      cf: "سهمیه‌ی کلودفلر", reqToday: "درخواست امروز", topUsers: "پرمصرف‌ترین‌ها",
      traffic7: "ترافیک ۷ روز اخیر", alerts: "هشدارها", noAlerts: "همه‌چیز سالم است ✅",
      noCf: "برای دیدن سهمیه، CF_ACCOUNT_ID و CF_API_TOKEN را تنظیم کنید.",
      cfDanger: "سهمیه‌ی کلودفلر نزدیک اتمام است — احتمال بن شدن اکانت.",
      expiringSoon: "کاربر تا ۲۴ ساعت دیگر منقضی می‌شود.",
    },
    users: {
      title: "کاربران", create: "کاربر جدید", search: "جستجوی نام، یادداشت یا UUID…",
      col: { user: "کاربر", status: "وضعیت", traffic: "مصرف", quota: "سهمیه", expiry: "انقضا", devices: "دستگاه", actions: "" },
      all: "همه", activeOnly: "فعال", disabledOnly: "غیرفعال", expiredOnly: "منقضی",
      selected: "انتخاب شده", bulkEnable: "فعال‌سازی", bulkDisable: "غیرفعال‌سازی",
      bulkReset: "ریست حجم", bulkExtend: "تمدید روز", bulkDelete: "حذف",
      empty: "هنوز کاربری نساخته‌اید", emptyHint: "اولین کاربر را بسازید تا لینک اشتراک تولید شود.",
      confirmDelete: "حذف کاربر «{name}»؟ این عمل قابل بازگشت نیست.",
      confirmBulkDelete: "حذف {n} کاربر؟ این عمل قابل بازگشت نیست.",
      form: {
        username: "نام کاربری", quota: "حجم (گیگابایت)", days: "مدت (روز)",
        devices: "سقف دستگاه همزمان", requests: "سقف درخواست (۰ = نامحدود)",
        firstConnect: "شروع زمان از اولین اتصال", fragment: "پریست فرگمنت",
        fingerprint: "اثر انگشت TLS", ips: "آی‌پی‌های تمیز (هر خط یکی)",
        proxies: "پروکسی بالادستی (هر خط یکی)", note: "یادداشت",
        blockList: "دامنه‌های مسدود (هر خط یکی)", active: "فعال",
        usernameHint: "۳ تا ۳۲ کاراکتر انگلیسی، عدد، . _ -",
      },
      drawer: { configs: "کانفیگ‌ها", usage: "مصرف", sub: "لینک اشتراک", qr: "کیوآر", copy: "کپی", copied: "کپی شد!", rotateToken: "چرخش توکن اشتراک", rotateUuid: "چرخش UUID", reset: "ریست حجم", statusPage: "صفحه وضعیت", liveTest: "تست زنده‌ی اتصال" },
      status: { active: "فعال", disabled: "غیرفعال", expired: "منقضی", exhausted: "حجم تمام" },
    },
    settings: {
      title: "تنظیمات", general: "عمومی", network: "شبکه", security: "امنیت", danger: "منطقه خطر",
      panelName: "نام پنل", publicHost: "دامنه عمومی (SNI)", port: "پورت",
      cleanIps: "آی‌پی‌های تمیز فعلی", ipPool: "مخزن آی‌پی برای چرخش",
      autoRotate: "چرخش خودکار آی‌پی", rotateMinutes: "فاصله چرخش (دقیقه)",
      mux: "فعال‌سازی Mux", blockNsfw: "مسدودسازی محتوای بزرگسال", blockAds: "مسدودسازی تبلیغات",
      remark: "پیشوند نام کانفیگ", defaultQuota: "حجم پیش‌فرض", defaultDays: "مدت پیش‌فرض",
      save: "ذخیره تغییرات", saved: "تنظیمات ذخیره شد",
      backup: "پشتیبان‌گیری", export: "خروجی JSON", import: "بازیابی از JSON",
      changePassword: "تغییر رمز عبور", currentPassword: "رمز فعلی",
      maintenance: "حالت تعمیرات",
    },
    diag: {
      title: "عیب‌یابی", probeNode: "تست پروکسی بالادستی", probeHint: "user:pass@1.2.3.4:1080 یا socks5://host:port",
      run: "اجرا", rankIps: "رتبه‌بندی آی‌پی تمیز", rankHint: "آی‌پی‌ها را از لبه‌ی کلودفلر تست می‌کند، نه از مرورگر شما.",
      ping: "تأخیر از لبه", pingHint: "سه نمونه از نزدیک‌ترین POP کلودفلر.",
      audit: "گزارش رویدادها", auditHint: "هر تغییر، با بازیگر و زمان. چیزی که Zeus ندارد.",
      latency: "تأخیر", healthy: "سالم", unhealthy: "قطع", colo: "مرکز داده",
      maintenance: "اجرای نگهداشت", maintenanceHint: "همان کاری که کرون هر ۱۰ دقیقه می‌کند: انقضا، چرخش آی‌پی، پاک‌سازی. در Zeus فقط می‌توانید حدس بزنید که اجرا شده یا نه.",
      maintenanceDone: "نگهداشت اجرا شد", expired: "منقضی‌شده", ipsRotated: "آی‌پی چرخیده",
    },
    live: {
      hint: "تونل را از همین‌جا باز می‌کند و تأخیر واقعی را می‌گیرد.",
      running: "در حال تست…",
      ok: "وصل شد — تونل سالم است.",
      refused: "رد شد: UUID نامعتبر/غیرفعال، سقف دستگاه، یا شبکه بسته.",
      nodata: "تونل باز شد اما بالادست جواب نداد — آی‌پی تمیز یا پریست فرگمنت را عوض کن.",
      noopen: "دست‌دهی WebSocket انجام نشد — دامنه/SNI یا شبکه را بررسی کن.",
    },
    common: {
      cancel: "انصراف", save: "ذخیره", create: "ساخت", delete: "حذف", edit: "ویرایش",
      close: "بستن", copy: "کپی", refresh: "نوسازی", loading: "در حال بارگذاری…",
      yes: "بله", no: "خیر", none: "—", search: "جستجو", cmdk: "جستجو یا فرمان…",
      offline: "آفلاین", version: "نسخه", gb: "گیگابایت", day: "روز", days: "روز",
    },
  },
  en: {
    app: { name: "Kaveh", tagline: "Edge proxy panel" },
    nav: { dashboard: "Dashboard", users: "Users", settings: "Settings", diag: "Diagnostics", sessions: "Sessions", logout: "Sign out" },
    login: {
      title: "Sign in", setupTitle: "Set up Kaveh", password: "Password", username: "Username",
      newPassword: "New password", submit: "Sign in", setup: "Create panel", recover: "Recover",
      hint: "Passwords are hashed with PBKDF2, 210,000 iterations.",
      setupHint: "At least 10 characters. This can only be set once.",
    },
    dash: {
      users: "Users", active: "Active", expired: "Expired", traffic: "Traffic used",
      cf: "Cloudflare quota", reqToday: "Requests today", topUsers: "Top consumers",
      traffic7: "Traffic — last 7 days", alerts: "Alerts", noAlerts: "All clear ✅",
      noCf: "Set CF_ACCOUNT_ID and CF_API_TOKEN to see quota.",
      cfDanger: "Cloudflare quota nearly exhausted — account ban risk.",
      expiringSoon: "user(s) expire within 24 hours.",
    },
    users: {
      title: "Users", create: "New user", search: "Search name, note or UUID…",
      col: { user: "User", status: "Status", traffic: "Used", quota: "Quota", expiry: "Expires", devices: "Devices", actions: "" },
      all: "All", activeOnly: "Active", disabledOnly: "Disabled", expiredOnly: "Expired",
      selected: "selected", bulkEnable: "Enable", bulkDisable: "Disable", bulkReset: "Reset traffic",
      bulkExtend: "Extend days", bulkDelete: "Delete",
      empty: "No users yet", emptyHint: "Create your first user to generate a subscription link.",
      confirmDelete: "Delete user “{name}”? This cannot be undone.",
      confirmBulkDelete: "Delete {n} users? This cannot be undone.",
      form: {
        username: "Username", quota: "Quota (GB)", days: "Duration (days)", devices: "Concurrent devices",
        requests: "Request limit (0 = unlimited)", firstConnect: "Start clock on first connect",
        fragment: "Fragment preset", fingerprint: "TLS fingerprint", ips: "Clean IPs (one per line)",
        proxies: "Upstream proxies (one per line)", note: "Note", blockList: "Blocked domains (one per line)", active: "Active",
        usernameHint: "3–32 chars: letters, digits, . _ -",
      },
      drawer: { configs: "Configs", usage: "Usage", sub: "Subscription link", qr: "QR", copy: "Copy", copied: "Copied!", rotateToken: "Rotate sub token", rotateUuid: "Rotate UUID", reset: "Reset traffic", statusPage: "Status page", liveTest: "Live connection test" },
      status: { active: "Active", disabled: "Disabled", expired: "Expired", exhausted: "Exhausted" },
    },
    settings: {
      title: "Settings", general: "General", network: "Network", security: "Security", danger: "Danger zone",
      panelName: "Panel name", publicHost: "Public host (SNI)", port: "Port", cleanIps: "Current clean IPs",
      ipPool: "IP pool for rotation", autoRotate: "Auto-rotate IPs", rotateMinutes: "Rotation interval (min)",
      mux: "Enable Mux", blockNsfw: "Block adult content", blockAds: "Block ads", remark: "Config name prefix",
      defaultQuota: "Default quota", defaultDays: "Default duration", save: "Save changes", saved: "Settings saved",
      backup: "Backup", export: "Export JSON", import: "Import JSON", changePassword: "Change password",
      currentPassword: "Current password", maintenance: "Maintenance mode",
    },
    diag: {
      title: "Diagnostics", probeNode: "Probe upstream proxy", probeHint: "user:pass@1.2.3.4:1080 or socks5://host:port",
      run: "Run", rankIps: "Rank clean IPs", rankHint: "Tested from Cloudflare's edge, not your browser.",
      ping: "Edge latency", pingHint: "Three samples from the nearest Cloudflare POP.",
      audit: "Audit log", auditHint: "Every change, with actor and time. Zeus has none.",
      latency: "Latency", healthy: "Healthy", unhealthy: "Down", colo: "Colo",
      maintenance: "Run maintenance", maintenanceHint: "Exactly what the cron does every 10 minutes: expiry, IP rotation, pruning. In Zeus you can only guess whether it ran.",
      maintenanceDone: "Maintenance complete", expired: "Expired", ipsRotated: "IPs rotated",
    },
    live: {
      hint: "Opens the tunnel from here and measures real latency.",
      running: "Testing…",
      ok: "Connected — tunnel is healthy.",
      refused: "Refused: unknown/disabled UUID, device limit, or blocked network.",
      nodata: "Tunnel opened but upstream stayed silent — try another clean IP or fragment preset.",
      noopen: "WebSocket handshake failed — check domain/SNI or your network.",
    },
    common: {
      cancel: "Cancel", save: "Save", create: "Create", delete: "Delete", edit: "Edit", close: "Close",
      copy: "Copy", refresh: "Refresh", loading: "Loading…", yes: "Yes", no: "No", none: "—",
      search: "Search", cmdk: "Search or run a command…", offline: "Offline", version: "Version",
      gb: "GB", day: "day", days: "days",
    },
  },
};

export const I18N = {
  lang: localStorage.getItem("kaveh.lang") || "fa",
  dir() { return this.lang === "fa" ? "rtl" : "ltr"; },
  set(lang) {
    this.lang = lang;
    localStorage.setItem("kaveh.lang", lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = this.dir();
  },
  t(path, vars) {
    const get = (d) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), d);
    let s = get(DICT[this.lang]) ?? get(DICT.en) ?? path;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  },
};

export const t = (p, v) => I18N.t(p, v);

const FA_DIGITS = ["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"];
export function num(n, { digits = 0 } = {}) {
  const v = Number(n || 0).toLocaleString(I18N.lang === "fa" ? "fa-IR" : "en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return v;
}
export const bytes = (b) => {
  const n = Number(b || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};
export function timeAgo(ms) {
  if (!ms) return t("common.none");
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return I18N.lang === "fa" ? `${s} ثانیه پیش` : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return I18N.lang === "fa" ? `${m} دقیقه پیش` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return I18N.lang === "fa" ? `${h} ساعت پیش` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return I18N.lang === "fa" ? `${d} روز پیش` : `${d}d ago`;
}
export function timeLeft(ms) {
  if (ms == null) return "∞";
  if (ms <= 0) return I18N.lang === "fa" ? "تمام شده" : "expired";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return I18N.lang === "fa" ? `${d} روز و ${h} ساعت` : `${d}d ${h}h`;
  return I18N.lang === "fa" ? `${h} ساعت` : `${h}h`;
}
export const dateFmt = (ms) => (ms ? new Date(ms).toLocaleDateString(I18N.lang === "fa" ? "fa-IR" : "en-US") : t("common.none"));
