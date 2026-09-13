/**
 * Per-section help. `❓ راهنما` shows this index as buttons and each button opens the
 * write-up of that section, so the explanation travels with the feature it documents.
 * Rendered as a fresh *unprotected* message: documentation has to stay copyable.
 */

import type { TelegramInlineKeyboard } from "./types";

export interface HelpTopic {
  id: string;
  label: string;
  title: string;
  lines: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "radar",
    label: "💎 رادار IP تمیز",
    title: "💎 رادار IP تمیز و نقشهٔ نت ملی",
    lines: [
      "هر IP استخر یک وضعیت می‌گیرد: 🟢 تأییدشده، 🟡 افت‌کیفیت، 🔴 پرریسک، ⚪ بدون داده.",
      "داده فقط از گزارش خودِ کاربران است: دکمهٔ «📤 ثبت گزارش» یا `POST /api/v1/telemetry/clean-ip`. ترکیب با میانگین نمایی (EMA)؛ هیچ عددی از سمت سرور ساخته نمی‌شود.",
      "ماندگاری رادار ۷ روز و نقشهٔ سانسور ۲۴ ساعت، بعد cron پاک می‌کند. ⚪ یعنی هنوز کسی تست نکرده، نه اینکه بلاک باشد.",
      "در نقشهٔ نت ملی هیچ IP یا شناسهٔ کاربری ذخیره نمی‌شود؛ فقط اپراتور/شهر/ترانسپورت/نتیجه.",
      "سقف نرخ: ۳۰ گزارش در ساعت به‌ازای هر آدرس (فقط هش روزانهٔ IP می‌ماند). خروجی: `GET /api/v1/clean-ip` و `GET /api/v1/map`.",
    ],
  },
  {
    id: "check",
    label: "🔍 هلث چک",
    title: "🔍 هلث چک — زنده بودن رادار",
    lines: [
      "می‌گوید چند IP از استخر در پنجرهٔ ۷ روزه گزارش زنده دارند (`measured / poolSize`) و ۸ رتبهٔ بالا کدام‌اند.",
      "«🔄 تست مجدد» فقط رتبه‌بندی را دوباره از D1 می‌خواند؛ هزینه‌ای ندارد.",
      "چرا پینگ مستقیم از سرور نمی‌زنیم؟ مسیر یک Worker ابری، مسیر شما نیست — عدد باید از شبکهٔ خودتان بیاید.",
      "خروجی ماشین‌خوان: `GET /api/v1/clean-ip?format=json`",
    ],
  },
  {
    id: "pack",
    label: "👻 PHANTOM ۲۰تایی",
    title: "👻 بستهٔ ۲۰ کانفیگ PHANTOM",
    lines: [
      "دامنه و UUID را می‌دهید؛ ربات ۲۰ کانفیگ (VLESS-WS-TLS، SS-2022، Hysteria2) در سه فرمت می‌سازد: `v2ray` (ساب base64)، `clash`، `singbox`.",
      "لینک‌ها به `GET /api/v1/pack?domain=&uuid=&format=` می‌روند؛ stateless است و هیچ‌چیز در دیتابیس نوشته نمی‌شود.",
      "⚠️ این فقط کانفیگ است، نه تست: سرور باید خودش روی همان دامنه/پورت بالا باشد. لایه‌های تزئینی نسخهٔ قبل (Refraction/ECH/«۱۱ غول») عمداً نیامده.",
      "UUID در پیام چت می‌آید؛ بعد از افزودن به اپ، «🧨 حذف این پیام» را بزنید.",
    ],
  },
  {
    id: "deps",
    label: "📦 استقرارها و حذف",
    title: "📦 دیپلوی پنل جدید، دیپلوی‌های من و حذف رکورد",
    lines: [
      "«🚀 دیپلوی پنل جدید»: ویزارد چندقدمی (نام Worker، دامنهٔ نود، IP سرور، ایمیل ACME، مقصد SNI، انتخاب UFW) و بعد Workflow با دستورهای بوت‌استرپ.",
      "«📁 دیپلوی‌های من»: 🟢 نود آماده، ⚪ بقیه، `➕ جدید` بالای لیست. روی هر نود: «🔗 اشتراک‌ها»، «🔄 تلاش مجدد»، «🔑 بوت‌استرپ»، «🛑 ابطال».",
      "«🗑 حذف» فقط روی رکوردهای failed/revoked و دو مرحله‌ای است؛ فقط ردیف‌های دیتابیس را می‌برد.",
      "نود زنده را حذف نکنید: اول «🛑 ابطال» تا Worker و دامنه روی Cloudflare هم پاک شوند، بعد «🗑 حذف».",
    ],
  },
  {
    id: "env",
    label: "🛰️ محیط اختصاصی و قفل‌ها",
    title: "🛰️ محیط اختصاصی V13، اتصال Cloudflare و قفل‌ها",
    lines: [
      "«🛰️ ورود به محیط اختصاصی V13» لینک یک‌بارمصرف می‌سازد (پیش‌فرض ۱۵ دقیقه، `LOGIN_LINK_TTL_SECONDS`) که مستقیم به پنل امن می‌رود.",
      "بخش‌های مدیریتی داخل همان پیام باز می‌شوند و `protect_content` دارند: کپی، فوروارد و (روی اندروید) اسکرین‌شات خاموش. بخش‌های آزاد منوی اصلی قابل کپی‌اند.",
      "قفل روی پیام نوشته می‌شود، پس ویرایشش آزادش نمی‌کند؛ «🏠 منوی اصلی Omni» پیام قفل را حذف و دوباره می‌فرستد.",
      "اتصال Cloudflare فقط در فرم امن پنل ساخته می‌شود — هرگز API Token را در چت نفرستید؛ «🗑️ قطع» رکورد اتصال را می‌برد اما توکن را در dash.cloudflare.com بی‌اعتبار کنید.",
      "دستورها: `/start` `/cleanip` `/map` `/whitehole` `/donate` `/health` `/usage` `/status` `/panel` `/help` `/cancel`",
    ],
  },
  {
    id: "whitehole",
    label: "🌪️ هددراپ WhiteHole",
    title: "🌪️ WhiteHole — هددراپ اضطراری روی DNS",
    lines: [
      "رتبه‌بندی فعلی رادار را به‌صورت تکه‌های TXT در Zone خودتان منتشر می‌کند تا در فیلترینگ شدید از DNS داخلی خوانده شود.",
      "رکوردها `ghost1..<code>ghostN</code>` با مقدار base64url؛ ترتیب و تعداد شارد در خودِ مقدار است.",
      "خواندن: `dig +short TXT ghost1.example.com @178.22.122.100` یا اسکریپت `GET /api/v1/whitehole/fetch.sh?domain=…`",
      "«🧹 پاک‌سازی» همان لحظه TXTها را می‌برد؛ سوابق انتشار ۳۰ روز می‌ماند. نیاز: اتصال فعال Cloudflare با دسترسی DNS.",
      "چون رکورد TXT عمومی است، هیچ رمز یا لینک اشتراکی در آن گذاشته نمی‌شود.",
    ],
  },
  {
    id: "donate",
    label: "🎁 اهدای کلید AI",
    title: "🎁 استخر اهدای کلید هوش مصنوعی",
    lines: [
      "«✅ می‌پذیرم» → کلید را می‌فرستید → فقط قطعهٔ مخدوش (مثل `sk-…4f2a`) نمایش داده می‌شود.",
      "خودِ کلید با AES-256-GCM و `TOKEN_ENCRYPTION_KEY` رمزنگاری می‌شود؛ در جدول اصلی فقط متادیتا و اثرانگشت است.",
      "تا ادمین («🧑‍⚖️ بازبینی») تأیید نکند، کلید در استخر عمومی نیست. «🎁 کلیدهای من → ↩️ پس‌گرفتن» ciphertext را hard-delete می‌کند.",
      "انقضا ۳۰ روز، سقف ۳ اهدا در ساعت. ادعای «تست‌شده» نداریم، چون کسی کلید را تست نمی‌کند.",
    ],
  },
  {
    id: "usage",
    label: "📈 مصرف و رازداری",
    title: "📈 مصرف، رازداری و زمان‌بندی",
    lines: [
      "نشان می‌دهد شمارش واقعی رکوردها (رادار، نقشه، هددراپ، اهداها، استقرارها). ترافیک گیگابایتی گزارش نمی‌شود چون اندازه گرفته نمی‌شود؛ آن را از Cloudflare Analytics یا خودِ سرور بگیرید.",
      "ماندگاری: رادار ۷ روز · نقشه ۲۴ ساعت · هددراپ و اهداها ۳۰ روز · توکن‌های موقت و update_id کهنه با همان cron پاک می‌شوند (`*/5 * * * *`).",
      "محدودیت نرخ: ۱۲ پیام/دکمه در دقیقه برای هر کاربر تلگرام؛ فیدهای عمومی سطل جدا با هش روزانهٔ IP دارند.",
      "نشتی توکن ربات؟ @BotFather → /revoke و بعد `npx wrangler secret put TELEGRAM_BOT_TOKEN`.",
      "دستورهای منوی تلگرام با `node scripts/set-telegram-webhook.mjs` ثبت می‌شوند؛ بعد از افزودن دستور تازه دوباره اجرایش کنید.",
    ],
  },
];

export function findHelpTopic(id: string): HelpTopic | null {
  return HELP_TOPICS.find((topic) => topic.id === id) ?? null;
}

export function helpIndexKeyboard(): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard["inline_keyboard"] = [];
  for (let index = 0; index < HELP_TOPICS.length; index += 2) {
    rows.push(HELP_TOPICS.slice(index, index + 2).map((topic) => ({
      text: topic.label,
      callback_data: `v13:help:${topic.id}`,
    })));
  }
  rows.push([{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }]);
  return { inline_keyboard: rows };
}

export function helpIndexText(): string {
  return [
    "❓ <b>راهنمای بخش‌ها</b>",
    "",
    "روی نام هر بخش بزنید تا توضیح کاملش را بخوانید:",
    "",
    HELP_TOPICS.map((topic) => `• ${topic.label}`).join("\n"),
  ].join("\n");
}

export function helpTopicText(topic: HelpTopic): string {
  return [`📖 <b>${topic.title}</b>`, "", ...topic.lines].join("\n");
}

export function helpTopicKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "📚 فهرست راهنما", callback_data: "v13:help" }],
      [{ text: "🏠 منوی اصلی Omni", callback_data: "omni:home" }],
    ],
  };
}
