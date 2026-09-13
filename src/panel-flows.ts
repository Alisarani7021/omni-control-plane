import { createDonation } from "./ai-donate";
import { recordCleanIpReport, type CleanIpReport } from "./clean-ip";
import { recordMapReport, type MapReport } from "./censorship-map";
import { HttpError } from "./http";
import {
  normalizePhantomDomain,
  normalizePhantomUuid,
  renderPhantomPackageText,
} from "./phantom-gen";
import {
  isValidVpsIpv4,
  normalizeDnsttDomain,
  renderDnsttPackageText,
} from "./dnstt";
import { addSecondsIso, nowIso, normalizeBaseUrl } from "./security";
import type { Env, TelegramInlineKeyboard } from "./types";

/**
 * Tiny conversation state for the ported panel sections (report submission,
 * donation key entry). It mirrors the deploy wizard but keeps its own table so a
 * half-finished report can never block a deployment wizard.
 */

export const PANEL_FLOW_TTL_SECONDS = 900;

export type PanelFlowKind = "rum" | "map" | "donate" | "phantom" | "dnstt";

export const FLOW_STEP_RUM_PING = "rum:ping";
export const FLOW_STEP_RUM_LOSS = "rum:loss";
export const FLOW_STEP_MAP_ISP = "map:isp";
export const FLOW_STEP_MAP_TRANSPORT = "map:transport";
export const FLOW_STEP_MAP_VERDICT = "map:verdict";
export const FLOW_STEP_MAP_CITY = "map:city";
export const FLOW_STEP_MAP_RTT = "map:rtt";
export const FLOW_STEP_DONATE_KEY = "donate:key";
export const FLOW_STEP_PHANTOM_DOMAIN = "phantom:domain";
export const FLOW_STEP_PHANTOM_UUID = "phantom:uuid";
export const FLOW_STEP_DNSTT_VPS = "dnstt:vps";
export const FLOW_STEP_DNSTT_DOMAIN = "dnstt:domain";

/** Steps where the answer must come from an inline button, not from text. */
export const BUTTON_ONLY_STEPS: readonly string[] = [
  FLOW_STEP_MAP_ISP,
  FLOW_STEP_MAP_TRANSPORT,
  FLOW_STEP_MAP_VERDICT,
  FLOW_STEP_MAP_CITY,
];

export interface PanelFlow {
  flow: PanelFlowKind;
  step: string;
  data: Record<string, string>;
}

export function panelFlowKeyboard(): TelegramInlineKeyboard {
  return { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "v13:flow:cancel" }]] };
}

function isFlowKind(value: string): value is PanelFlowKind {
  return value === "rum" || value === "map" || value === "donate" || value === "phantom" || value === "dnstt";
}

export async function loadPanelFlow(env: Env, telegramUserId: string): Promise<PanelFlow | null> {
  const row = await env.DB.prepare(
    "SELECT flow, step, state_json, expires_at FROM telegram_flows WHERE telegram_user_id = ?",
  ).bind(telegramUserId).first<{ flow: string; step: string; state_json: string; expires_at: string }>();
  if (!row) return null;
  let data: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.state_json) as Record<string, string>;
    data = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    data = {};
  }
  if (!isFlowKind(row.flow) || Date.parse(row.expires_at) <= Date.now()) {
    await clearPanelFlow(env, telegramUserId);
    return null;
  }
  return { flow: row.flow, step: row.step, data };
}

export async function savePanelFlow(env: Env, telegramUserId: string, flow: PanelFlow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO telegram_flows (telegram_user_id, flow, step, state_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       flow = excluded.flow, step = excluded.step, state_json = excluded.state_json,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  ).bind(telegramUserId, flow.flow, flow.step, JSON.stringify(flow.data), addSecondsIso(PANEL_FLOW_TTL_SECONDS), nowIso()).run();
}

export async function clearPanelFlow(env: Env, telegramUserId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM telegram_flows WHERE telegram_user_id = ?").bind(telegramUserId).run();
}

export function flowPrompt(flow: PanelFlow): string {
  if (BUTTON_ONLY_STEPS.includes(flow.step)) {
    return "لطفاً با دکمه‌هایی که ربات فرستاده انتخاب کنید 👇 (این قدم با متن آزاد پاسخ داده نمی‌شود)";
  }
  switch (flow.step) {
    case FLOW_STEP_RUM_PING:
      return [
        `📡 گزارش برای <code>${flow.data["ip"] ?? ""}</code> — قدم ۱ از ۲`,
        "",
        "پینگ (latency) را به میلی‌ثانیه بفرستید؛ اگر نتوانستید اندازه بگیرید «-» بفرستید.",
        "مثال: 38",
      ].join("\n");
    case FLOW_STEP_RUM_LOSS:
      return [
        "📡 قدم ۲ از ۲",
        "",
        "درصد بسته گم‌شده (loss) را بفرستید (۰ تا ۱۰۰) یا «-» برای نامشخص.",
        "مثال: 0",
      ].join("\n");
    case FLOW_STEP_MAP_RTT:
      return [
        "🗺 آخرین قدم",
        "",
        "میانهٔ پینگ به میلی‌ثانیه بفرستید یا «-» اگر اندازه نگرفتید.",
      ].join("\n");
    case FLOW_STEP_PHANTOM_DOMAIN:
      return [
        flow.data["mode"] === "simple" ? "🛡️ <b>10تایی ساده</b>" : "👻 <b>PHANTOM 20تایی</b>",
        "",
        "دامنه‌ات را بفرست (بدون https). برای مثال: <code>yourdomain.ir</code>",
        "این دامنه باید روی ورکر خودت باشد تا لایهٔ L2 کار کند.",
      ].join("\n");
    case FLOW_STEP_PHANTOM_UUID:
      return [
        `✅ دامنه: <code>${flow.data["domain"] ?? ""}</code>`,
        "",
        "UUID را بفرست یا بنویس <code>new</code> تا یکی ساخته شود:",
      ].join("\n");
    case FLOW_STEP_DNSTT_VPS:
      return [
        "🌪️ <b>تونل DNS با dnstt</b>",
        "",
        "👇 <b>اول IP عددی VPS رو بفرست:</b>",
        "مثال: <code>203.0.113.2</code>",
      ].join("\n");
    case FLOW_STEP_DNSTT_DOMAIN:
      return [
        `✅ VPS: <code>${flow.data["vps"] ?? ""}</code>`,
        "",
        "حالا ساب‌دامنهٔ تونل را بفرست (NS آن باید به VPS داده شود):",
        "مثال: <code>t.yourdomain.ir</code>",
      ].join("\n");
    case FLOW_STEP_DONATE_KEY:
      return [
        "🎁 کلید را بفرستید",
        "",
        "فقط خودِ کلید (بدون توضیح اضافه). پیام‌های ربات حاوی کلید نیست؛ فقط قطعهٔ مخدوش‌شده نمایش داده می‌شود.",
        "برای انصراف دکمهٔ پایین را بزنید.",
      ].join("\n");
    default:
      return "فرایند نیمه‌کاره‌ای باز نیست.";
  }
}

function parseNumberOrDash(text: string, max: number): number | null | "invalid" {
  const value = text.trim();
  if (value === "-" || value === "−" || value === "none" || value === "نامشخص") return null;
  const normalized = value.replace(/[^\d.]/gu, "");
  if (!normalized) return "invalid";
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return "invalid";
  return Math.round(parsed * 10) / 10;
}

export interface FlowTextResult {
  kind: "prompt" | "done";
  text: string;
  /** Optional follow-up view the caller should render after saving. */
  followUp?: "clean-ip" | "map" | "donations";
  saved?: boolean;
}

/**
 * Handles the free-text half of a flow. Callers own Telegram rendering; this
 * only validates, persists and returns the next prompt or a summary.
 */
export async function processPanelFlowText(
  env: Env,
  telegramUserId: string,
  tenantId: string,
  flow: PanelFlow,
  text: string,
): Promise<FlowTextResult> {
  try {
    if (BUTTON_ONLY_STEPS.includes(flow.step)) {
      return { kind: "prompt", text: flowPrompt(flow) };
    }
    switch (flow.step) {
      case FLOW_STEP_RUM_PING: {
        const latency = parseNumberOrDash(text, 10_000);
        if (latency === "invalid") {
          return { kind: "prompt", text: `عدد پینگ معتبر نیست.\n\n${flowPrompt(flow)}` };
        }
        flow.step = FLOW_STEP_RUM_LOSS;
        flow.data = { ...flow.data, latencyMs: latency === null ? "" : String(latency) };
        await savePanelFlow(env, telegramUserId, flow);
        return { kind: "prompt", text: flowPrompt(flow) };
      }
      case FLOW_STEP_RUM_LOSS: {
        const loss = parseNumberOrDash(text, 100);
        if (loss === "invalid") {
          return { kind: "prompt", text: `درصد loss معتبر نیست.\n\n${flowPrompt(flow)}` };
        }
        const ip = flow.data["ip"] ?? "";
        if (!ip) {
          await clearPanelFlow(env, telegramUserId);
          return { kind: "done", text: "فرایند منقضی شد؛ از اول شروع کنید." };
        }
        const latencyMs = Number(flow.data["latencyMs"] ?? "");
        const report: CleanIpReport = {
          ip,
          operator: flow.data["operator"] ?? "mci",
          city: flow.data["city"] ?? "tehran",
          latencyMs: Number.isFinite(latencyMs) && latencyMs > 0 ? Math.round(latencyMs) : -1,
          lossPct: loss === null ? 0 : loss,
          ok: loss === null ? latencyMs > 0 : loss < 100,
        };
        await recordCleanIpReport(env, report);
        await clearPanelFlow(env, telegramUserId);
        return {
          kind: "done",
          text: `✅ گزارش <code>${ip}</code> ثبت شد (${report.operator}/${report.city}). داده‌ها ۷ روز در رتبه‌بندی می‌مانند.`,
          followUp: "clean-ip",
          saved: true,
        };
      }
      case FLOW_STEP_MAP_RTT: {
        const rtt = parseNumberOrDash(text, 10_000);
        if (rtt === "invalid") {
          return { kind: "prompt", text: `عدد پینگ معتبر نیست.\n\n${flowPrompt(flow)}` };
        }
        const report: MapReport = {
          isp: flow.data["isp"] ?? "سایر",
          city: flow.data["city"] ?? "نامشخص",
          transport: flow.data["transport"] ?? "other",
          rttMs: rtt === null ? null : Math.round(rtt),
          ok: flow.data["ok"] === "1",
        };
        await recordMapReport(env, report);
        await clearPanelFlow(env, telegramUserId);
        return { kind: "done", text: "✅ گزارش ناشناس شما به نقشهٔ سانسور اضافه شد.", followUp: "map", saved: true };
      }
      case FLOW_STEP_PHANTOM_DOMAIN: {
        const domain = normalizePhantomDomain(text);
        if (!domain) {
          return { kind: "prompt", text: `⚠️ دامنه معتبر نیست. مثال: <code>t.example.ir</code>\n\n${flowPrompt(flow)}` };
        }
        flow.step = FLOW_STEP_PHANTOM_UUID;
        flow.data = { ...flow.data, domain };
        await savePanelFlow(env, telegramUserId, flow);
        return { kind: "prompt", text: flowPrompt(flow) };
      }
      case FLOW_STEP_PHANTOM_UUID: {
        const domain = flow.data["domain"] ?? "";
        if (!normalizePhantomDomain(domain)) {
          await clearPanelFlow(env, telegramUserId);
          return { kind: "done", text: "فرایند منقضی شد؛ از اول شروع کنید." };
        }
        const uuid = normalizePhantomUuid(text);
        await clearPanelFlow(env, telegramUserId);
        return {
          kind: "done",
          text: renderPhantomPackageText({
            domain,
            uuid,
            mode: flow.data["mode"] === "simple" ? "simple" : "full",
            baseUrl: normalizeBaseUrl(env.PUBLIC_BASE_URL),
          }),
          saved: true,
        };
      }
      case FLOW_STEP_DNSTT_VPS: {
        const vps = text.trim();
        if (!isValidVpsIpv4(vps)) {
          return { kind: "prompt", text: `⚠️ IP معتبر نیست. مثال: <code>203.0.113.2</code>\n\n${flowPrompt(flow)}` };
        }
        flow.step = FLOW_STEP_DNSTT_DOMAIN;
        flow.data = { ...flow.data, vps };
        await savePanelFlow(env, telegramUserId, flow);
        return { kind: "prompt", text: flowPrompt(flow) };
      }
      case FLOW_STEP_DNSTT_DOMAIN: {
        const vps = flow.data["vps"] ?? "";
        if (!isValidVpsIpv4(vps)) {
          await clearPanelFlow(env, telegramUserId);
          return { kind: "done", text: "فرایند منقضی شد؛ از اول شروع کنید." };
        }
        const domain = normalizeDnsttDomain(text);
        if (!domain) {
          return { kind: "prompt", text: `⚠️ دامنه معتبر نیست. مثال: <code>t.example.ir</code>\n\n${flowPrompt(flow)}` };
        }
        await clearPanelFlow(env, telegramUserId);
        return {
          kind: "done",
          text: renderDnsttPackageText(vps, domain, normalizeBaseUrl(env.PUBLIC_BASE_URL)),
          saved: true,
        };
      }
      case FLOW_STEP_DONATE_KEY: {
        const donation = await createDonation(env, { tenantId, donorUserId: telegramUserId, key: text });
        await clearPanelFlow(env, telegramUserId);
        return {
          kind: "done",
          text: [
            "✅ <b>کلید ثبت شد</b>",
            "",
            `ارائه‌دهنده: ${donation.provider}`,
            `قطعهٔ قابل نمایش: <code>${donation.snippet}</code>`,
            "وضعیت: ⏳ در انتظار بازبینی ادمین — V13 فعلاً از آن استفاده نمی‌کند.",
            "",
            "🔐 کلید در D1 رمزنگاری شد؛ برای حذف فوری به «🎁 کلیدهای من» بروید. توصیه می‌شود کلید اهدایی را در سرویس مبدأ هم محدود/گردش کنید.",
          ].join("\n"),
          followUp: "donations",
          saved: true,
        };
      }
      default:
        await clearPanelFlow(env, telegramUserId);
        return { kind: "done", text: "فرایند نیمه‌کاره منقضی شد؛ از اول شروع کنید." };
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return { kind: "done", text: `⚠️ ${error.message}`, followUp: "donations" };
    }
    throw error;
  }
}
