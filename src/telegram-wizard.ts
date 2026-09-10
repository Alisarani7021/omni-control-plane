import type { BotConnectionBoundary } from "./bot-actions";
import { addSecondsIso, isPublicIpv4, isValidEmail, isValidHostname, isValidWorkerName, nowIso } from "./security";
import type { Env, TelegramInlineKeyboard } from "./types";

export const WIZARD_TTL_SECONDS = 1800;
export const WIZARD_FLOW_DEPLOY = "deploy";

export const WIZARD_STEP_CONNECTION = "connection";
export const WIZARD_STEP_WORKER_NAME = "workerName";
export const WIZARD_STEP_WORKER_HOSTNAME = "workerHostname";
export const WIZARD_STEP_NODE_HOSTNAME = "nodeHostname";
export const WIZARD_STEP_VPS_IPV4 = "vpsIpv4";
export const WIZARD_STEP_ACME_EMAIL = "acmeEmail";
export const WIZARD_STEP_REALITY_SNI = "realitySNI";
export const WIZARD_STEP_UFW = "ufw";
export const WIZARD_STEP_CONFIRM = "confirm";

export interface DeployWizardState {
  connectionId: string;
  connectionName: string;
  accountId: string;
  accountName: string;
  zoneId: string;
  zoneName: string;
  workerName?: string | undefined;
  workerHostname?: string | undefined;
  nodeHostname?: string | undefined;
  vpsIpv4?: string | undefined;
  acmeEmail?: string | undefined;
  realityServerName?: string | undefined;
  enableUfw?: boolean | undefined;
}

export interface ActiveWizard {
  flow: string;
  step: string;
  state: DeployWizardState;
}

function parseState(raw: string): DeployWizardState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DeployWizardState>;
    if (!parsed.connectionId || !parsed.accountId || !parsed.zoneId || !parsed.zoneName) return null;
    return {
      connectionId: parsed.connectionId,
      connectionName: parsed.connectionName ?? "",
      accountId: parsed.accountId,
      accountName: parsed.accountName ?? "",
      zoneId: parsed.zoneId,
      zoneName: parsed.zoneName,
      workerName: parsed.workerName,
      workerHostname: parsed.workerHostname,
      nodeHostname: parsed.nodeHostname,
      vpsIpv4: parsed.vpsIpv4,
      acmeEmail: parsed.acmeEmail,
      realityServerName: parsed.realityServerName,
      enableUfw: parsed.enableUfw,
    };
  } catch {
    return null;
  }
}

export async function loadWizard(env: Env, telegramUserId: string): Promise<ActiveWizard | null> {
  const row = await env.DB.prepare("SELECT flow, step, state_json, expires_at FROM telegram_wizards WHERE telegram_user_id = ?")
    .bind(telegramUserId).first<{ flow: string; step: string; state_json: string; expires_at: string }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now() || row.flow !== WIZARD_FLOW_DEPLOY) {
    await clearWizard(env, telegramUserId);
    return null;
  }
  const state = parseState(row.state_json);
  if (!state) {
    await clearWizard(env, telegramUserId);
    return null;
  }
  return { flow: row.flow, step: row.step, state };
}

export async function saveWizard(env: Env, telegramUserId: string, step: string, state: DeployWizardState): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO telegram_wizards (telegram_user_id, flow, step, state_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       flow = excluded.flow, step = excluded.step, state_json = excluded.state_json,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  ).bind(telegramUserId, WIZARD_FLOW_DEPLOY, step, JSON.stringify(state), addSecondsIso(WIZARD_TTL_SECONDS), now, now).run();
}

export async function clearWizard(env: Env, telegramUserId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM telegram_wizards WHERE telegram_user_id = ?").bind(telegramUserId).run();
}

export function cancelKeyboard(): TelegramInlineKeyboard {
  return { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "wiz:cancel" }]] };
}

function withCancel(rows: TelegramInlineKeyboard["inline_keyboard"]): TelegramInlineKeyboard {
  return { inline_keyboard: [...rows, [{ text: "❌ انصراف", callback_data: "wiz:cancel" }]] };
}

export function workerNamePrompt(): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: [
      "➕ ساخت استقرار جدید — قدم ۱ از ۷",
      "",
      "نام Worker را بفرستید (انگلیسی کوچک، عدد و خط‌تیره).",
      "مثال: v13-my-node",
    ].join("\n"),
    keyboard: cancelKeyboard(),
  };
}

export function workerHostnamePrompt(zoneName: string): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: [
      "قدم ۲ از ۷",
      "",
      `زیردامنهٔ اشتراک (Worker) را بفرستید؛ باید زیر ${zoneName} باشد.`,
      `مثال: sub.${zoneName}`,
    ].join("\n"),
    keyboard: cancelKeyboard(),
  };
}

export function nodeHostnamePrompt(zoneName: string): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: [
      "قدم ۳ از ۷",
      "",
      `زیردامنهٔ مستقیم VPS را بفرستید؛ باید زیر ${zoneName} و متفاوت از قبلی باشد.`,
      `مثال: node.${zoneName}`,
    ].join("\n"),
    keyboard: cancelKeyboard(),
  };
}

export function vpsIpv4Prompt(): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: ["قدم ۴ از ۷", "", "آدرس IPv4 عمومی VPS را بفرستید.", "مثال: 1.2.3.4"].join("\n"),
    keyboard: cancelKeyboard(),
  };
}

export function acmeEmailPrompt(): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: ["قدم ۵ از ۷", "", "ایمیل ACME را بفرستید.", "مثال: admin@example.com"].join("\n"),
    keyboard: cancelKeyboard(),
  };
}

export function realitySniPrompt(): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: ["قدم ۶ از ۷", "", "مقصد handshake برای Reality را بفرستید یا پیش‌فرض را بزنید."].join("\n"),
    keyboard: withCancel([[{ text: "پیش‌فرض: www.microsoft.com", callback_data: "wiz:sni-def" }]]),
  };
}

export function ufwPrompt(): { text: string; keyboard: TelegramInlineKeyboard } {
  return {
    text: [
      "قدم ۷ از ۷",
      "",
      "UFW خودکار فعال شود؟ فقط اگر پورت SSH فعلی را می‌دانید «بله» بزنید.",
    ].join("\n"),
    keyboard: withCancel([[
      { text: "✅ بله", callback_data: "wiz:ufw:1" },
      { text: "⏭️ نه", callback_data: "wiz:ufw:0" },
    ]]),
  };
}

export function confirmSummary(state: DeployWizardState): string {
  return [
    "🧾 پیش‌فاکتور استقرار — لطفاً بررسی و تأیید کنید:",
    "",
    `اتصال: ${state.connectionName || state.connectionId.slice(0, 8)}`,
    `حساب: ${state.accountName}`,
    `دامنه: ${state.zoneName}`,
    `Worker: ${state.workerName}`,
    `اشتراک: ${state.workerHostname}`,
    `نود: ${state.nodeHostname}`,
    `VPS: ${state.vpsIpv4}`,
    `ایمیل: ${state.acmeEmail}`,
    `Reality SNI: ${state.realityServerName}`,
    `UFW خودکار: ${state.enableUfw ? "بله" : "نه"}`,
  ].join("\n");
}

export function confirmKeyboard(): TelegramInlineKeyboard {
  return withCancel([[{ text: "✅ تأیید و ساخت", callback_data: "wiz:confirm" }]]);
}

export interface WizardTextResult {
  text: string;
  keyboard: TelegramInlineKeyboard;
}

function invalidRetry(message: string, prompt: { text: string; keyboard: TelegramInlineKeyboard }): WizardTextResult {
  return { text: `${message}\n\n${prompt.text}`, keyboard: prompt.keyboard };
}

export function validateWizardWorkerName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!isValidWorkerName(normalized)) {
    return "نام Worker معتبر نیست؛ فقط حروف کوچک انگلیسی، عدد و خط‌تیره (مثل v13-my-node).";
  }
  return null;
}

export function validateWizardSubdomain(value: string, zoneName: string, other: string | undefined, label: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!isValidHostname(normalized)) return `${label} معتبر نیست.`;
  if (!normalized.endsWith(`.${zoneName.toLowerCase()}`)) return `${label} باید زیردامنهٔ ${zoneName} باشد.`;
  if (other && normalized === other) return "دو زیردامنه باید متفاوت باشند.";
  return null;
}

export function validateWizardIpv4(value: string): string | null {
  if (!isPublicIpv4(value.trim())) return "فقط یک IPv4 عمومی و معتبر پذیرفته می‌شود.";
  return null;
}

export function validateWizardEmail(value: string): string | null {
  if (!isValidEmail(value.trim().toLowerCase())) return "ایمیل معتبر نیست.";
  return null;
}

export function validateWizardSni(value: string, nodeHostname: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!isValidHostname(normalized)) return "مقصد Reality معتبر نیست.";
  if (normalized === nodeHostname) return "مقصد Reality نباید خودِ همین نود باشد.";
  return null;
}

/** Start the wizard after a connection was picked; returns the first prompt. */
export async function beginDeployWizard(
  env: Env,
  telegramUserId: string,
  boundary: BotConnectionBoundary,
): Promise<WizardTextResult> {
  const state: DeployWizardState = {
    connectionId: boundary.connectionId,
    connectionName: boundary.connectionName,
    accountId: boundary.accountId,
    accountName: boundary.accountName,
    zoneId: boundary.zoneId,
    zoneName: boundary.zoneName,
  };
  await saveWizard(env, telegramUserId, WIZARD_STEP_WORKER_NAME, state);
  return workerNamePrompt();
}

/** Process free-text input for the active wizard step. */
export async function processWizardText(
  env: Env,
  telegramUserId: string,
  wizard: ActiveWizard,
  rawText: string,
): Promise<WizardTextResult> {
  const { step, state } = wizard;
  switch (step) {
    case WIZARD_STEP_WORKER_NAME: {
      const error = validateWizardWorkerName(rawText);
      if (error) return invalidRetry(error, workerNamePrompt());
      state.workerName = rawText.trim().toLowerCase();
      await saveWizard(env, telegramUserId, WIZARD_STEP_WORKER_HOSTNAME, state);
      return workerHostnamePrompt(state.zoneName);
    }
    case WIZARD_STEP_WORKER_HOSTNAME: {
      const error = validateWizardSubdomain(rawText, state.zoneName, undefined, "زیردامنهٔ اشتراک");
      if (error) return invalidRetry(error, workerHostnamePrompt(state.zoneName));
      state.workerHostname = rawText.trim().toLowerCase();
      await saveWizard(env, telegramUserId, WIZARD_STEP_NODE_HOSTNAME, state);
      return nodeHostnamePrompt(state.zoneName);
    }
    case WIZARD_STEP_NODE_HOSTNAME: {
      const error = validateWizardSubdomain(rawText, state.zoneName, state.workerHostname, "زیردامنهٔ نود");
      if (error) return invalidRetry(error, nodeHostnamePrompt(state.zoneName));
      state.nodeHostname = rawText.trim().toLowerCase();
      await saveWizard(env, telegramUserId, WIZARD_STEP_VPS_IPV4, state);
      return vpsIpv4Prompt();
    }
    case WIZARD_STEP_VPS_IPV4: {
      const error = validateWizardIpv4(rawText);
      if (error) return invalidRetry(error, vpsIpv4Prompt());
      state.vpsIpv4 = rawText.trim();
      await saveWizard(env, telegramUserId, WIZARD_STEP_ACME_EMAIL, state);
      return acmeEmailPrompt();
    }
    case WIZARD_STEP_ACME_EMAIL: {
      const error = validateWizardEmail(rawText);
      if (error) return invalidRetry(error, acmeEmailPrompt());
      state.acmeEmail = rawText.trim().toLowerCase();
      await saveWizard(env, telegramUserId, WIZARD_STEP_REALITY_SNI, state);
      return realitySniPrompt();
    }
    case WIZARD_STEP_REALITY_SNI: {
      const error = validateWizardSni(rawText, state.nodeHostname ?? "");
      if (error) return invalidRetry(error, realitySniPrompt());
      state.realityServerName = rawText.trim().toLowerCase();
      await saveWizard(env, telegramUserId, WIZARD_STEP_UFW, state);
      return ufwPrompt();
    }
    case WIZARD_STEP_UFW:
      return { text: "لطفاً با دکمه‌ها انتخاب کنید 👇", keyboard: ufwPrompt().keyboard };
    case WIZARD_STEP_CONFIRM:
      return { text: `${confirmSummary(state)}\n\nلطفاً با دکمه‌ها تأیید یا انصراف بزنید 👇`, keyboard: confirmKeyboard() };
    default:
      await clearWizard(env, telegramUserId);
      return { text: "فرایند نیمه‌کاره منقضی شد؛ از اول شروع کنید.", keyboard: cancelKeyboard() };
  }
}

/** Button presses inside the wizard (sni default / ufw / confirm are handled by callers needing extra data). */
export async function applySniDefault(env: Env, telegramUserId: string, wizard: ActiveWizard): Promise<WizardTextResult> {
  wizard.state.realityServerName = "www.microsoft.com";
  await saveWizard(env, telegramUserId, WIZARD_STEP_UFW, wizard.state);
  return ufwPrompt();
}

export async function applyUfwChoice(
  env: Env,
  telegramUserId: string,
  wizard: ActiveWizard,
  enable: boolean,
): Promise<WizardTextResult> {
  wizard.state.enableUfw = enable;
  await saveWizard(env, telegramUserId, WIZARD_STEP_CONFIRM, wizard.state);
  return { text: confirmSummary(wizard.state), keyboard: confirmKeyboard() };
}
