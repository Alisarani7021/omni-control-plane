import { rateLimit } from "./db";
import { HttpError } from "./http";
import { decryptJson, encryptJson, escapeHtml, nowIso, sha256 } from "./security";
import type { Env } from "./types";

/**
 * AI key donations — the port of the worker's "🎁 اهدا AI" pool.
 *
 * The original flow accepted a key in chat, kept it in a process-local array
 * (so it vanished on every isolate), printed a fabricated ping and told the user
 * the key was "active in the global pool". This port keeps the same product idea
 * but is honest and safe instead:
 *   - the key is encrypted with the same AES-256-GCM envelope as Cloudflare tokens,
 *   - only a redacted snippet and a one-way fingerprint are ever displayed,
 *   - a donated key is never auto-activated or tested against a provider here,
 *   - the donor can withdraw it and every donation hard-expires after 30 days.
 */

export const DONATION_RETENTION_DAYS = 30;
export const DONATION_MAX_PER_TENANT = 5;

export type DonationStatus = "pending" | "approved" | "rejected" | "withdrawn";

export const DONATION_STATUS_LABELS: Record<DonationStatus, string> = {
  pending: "⏳ در انتظار بازبینی",
  approved: "✅ تأییدشده",
  rejected: "❌ ردشده",
  withdrawn: "↩️ پس‌گرفته‌شده",
};

const PROVIDER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["sk-ant-", "Anthropic Claude"],
  ["sk-proj-", "OpenAI (Project key)"],
  ["sk-or-", "OpenRouter"],
  ["sk-", "OpenAI / سازگار با OpenAI"],
  ["gsk_", "Groq"],
  ["AIza", "Google AI Studio"],
  ["deepseek-", "DeepSeek"],
];

export function detectProvider(key: string): string {
  for (const [prefix, label] of PROVIDER_PREFIXES) if (key.startsWith(prefix)) return label;
  return "کلید عمومی / سازندهٔ نامشخص";
}

/** Never returns anything that could rebuild the key. */
export function redactKey(key: string): string {
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  return `${head}…${tail}`;
}

export function validateDonationKey(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_key", "کلید باید متن باشد");
  const key = value.trim();
  if (key.length < 20 || key.length > 256) {
    throw new HttpError(400, "invalid_key", "طول کلید باید بین ۲۰ تا ۲۵۶ نویسه باشد");
  }
  if (!/^[A-Za-z0-9_.-]+$/u.test(key)) {
    throw new HttpError(400, "invalid_key", "کلید فقط می‌تواند حرف، عدد، خط‌تیره، زیرخط و نقطه داشته باشد");
  }
  if (/^(replace|changeme|example|test)[-_]/iu.test(key)) {
    throw new HttpError(400, "invalid_key", "این مقدار کلید واقعی به نظر نمی‌رسد");
  }
  return key;
}

export interface DonationInput {
  tenantId: string;
  donorUserId: string;
  key: string;
}

export interface DonationRow {
  id: string;
  provider: string;
  snippet: string;
  status: DonationStatus;
  created_at: string;
  review_at: string | null;
  donor_user_id: string;
}

export async function createDonation(env: Env, input: DonationInput): Promise<DonationRow> {
  const key = validateDonationKey(input.key);
  const allowed = await rateLimit(env, `ai-donate:${input.donorUserId}`, 3, 3_600);
  if (!allowed) throw new HttpError(429, "rate_limited", "برای جلوگیری از شلوغ‌شدن صف، هر کاربر ساعتی ۳ کلید می‌تواند ثبت کند");
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ai_donations
     WHERE tenant_id = ? AND donor_user_id = ? AND status IN ('pending', 'approved') AND expires_at > ?`,
  ).bind(input.tenantId, input.donorUserId, nowIso()).first<{ count: number }>();
  if ((active?.count ?? 0) >= DONATION_MAX_PER_TENANT) {
    throw new HttpError(429, "too_many_donations", `حداکثر ${DONATION_MAX_PER_TENANT} کلید فعال برای هر کاربر مجاز است`);
  }

  const id = crypto.randomUUID();
  const fingerprint = await sha256(`ai-donation:${key}`);
  const provider = detectProvider(key);
  const secretEnc = await encryptJson({ key }, env.TOKEN_ENCRYPTION_KEY, `ai-donation:${id}`);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + DONATION_RETENTION_DAYS * 86_400_000).toISOString();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ai_donations (id, tenant_id, donor_user_id, provider, key_fingerprint, key_snippet, status, created_at, updated_at, review_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?)`,
      ).bind(id, input.tenantId, input.donorUserId, provider, fingerprint, redactKey(key), now, now, expiresAt),
      env.DB.prepare("INSERT INTO ai_donation_secrets (donation_id, secret_enc, created_at) VALUES (?, ?, ?)")
        .bind(id, secretEnc, now),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "duplicate_donation", "این کلید قبلاً ثبت شده است");
    throw error;
  }
  return { id, provider, snippet: redactKey(key), status: "pending", created_at: now, review_at: null, donor_user_id: input.donorUserId };
}

export async function listDonations(
  env: Env,
  filter: { tenantId?: string; donorUserId?: string; status?: DonationStatus; limit?: number } = {},
): Promise<DonationRow[]> {
  const where: string[] = ["expires_at > ?"];
  const params: Array<string | number> = [nowIso()];
  if (filter.tenantId) {
    where.push("tenant_id = ?");
    params.push(filter.tenantId);
  }
  if (filter.donorUserId) {
    where.push("donor_user_id = ?");
    params.push(filter.donorUserId);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const limit = Math.min(25, Math.max(1, filter.limit ?? 10));
  const rows = await env.DB.prepare(
    `SELECT id, provider, key_snippet, status, created_at, review_at, donor_user_id
     FROM ai_donations
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  ).bind(...params).all<DonationRow>();
  return rows.results ?? [];
}

export interface DonationPoolStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  withdrawn: number;
  byProvider: Array<{ provider: string; count: number }>;
}

export async function donationPoolStats(env: Env): Promise<DonationPoolStats> {
  const statuses = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM ai_donations WHERE expires_at > ? GROUP BY status",
  ).bind(nowIso()).all<{ status: DonationStatus; count: number }>();
  const providers = await env.DB.prepare(
    "SELECT provider, COUNT(*) AS count FROM ai_donations WHERE expires_at > ? GROUP BY provider ORDER BY count DESC LIMIT 8",
  ).bind(nowIso()).all<{ provider: string; count: number }>();
  const stats: DonationPoolStats = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    withdrawn: 0,
    byProvider: (providers.results ?? []).map((row) => ({ provider: row.provider, count: row.count })),
  };
  for (const row of statuses.results ?? []) {
    if (row.status in stats) stats[row.status] = row.count;
    stats.total += row.count;
  }
  return stats;
}

/** Reads the ciphertext for a single donation; only used by an approved admin action. */
export async function readDonationKey(env: Env, donationId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT secret_enc FROM ai_donation_secrets WHERE donation_id = ?")
    .bind(donationId).first<{ secret_enc: string }>();
  if (!row) return null;
  try {
    const value = await decryptJson<{ key: string }>(row.secret_enc, env.TOKEN_ENCRYPTION_KEY, `ai-donation:${donationId}`);
    return value.key;
  } catch {
    return null;
  }
}

export async function setDonationStatus(
  env: Env,
  donationId: string,
  status: Exclude<DonationStatus, "pending">,
): Promise<DonationRow | null> {
  const now = nowIso();
  if (status === "withdrawn" || status === "rejected") {
    // A rejected or withdrawn donation must not keep its ciphertext around.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ai_donation_secrets WHERE donation_id = ?").bind(donationId),
      env.DB.prepare("UPDATE ai_donations SET status = ?, updated_at = ?, review_at = ? WHERE id = ?")
        .bind(status, now, now, donationId),
    ]);
  } else {
    await env.DB.prepare("UPDATE ai_donations SET status = ?, updated_at = ?, review_at = ? WHERE id = ?")
      .bind(status, now, now, donationId).run();
  }
  const row = await env.DB.prepare(
    "SELECT id, provider, key_snippet, status, created_at, review_at, donor_user_id FROM ai_donations WHERE id = ?",
  ).bind(donationId).first<DonationRow>();
  return row ?? null;
}

/** Owner-only withdrawal: the ciphertext is deleted, not just flagged. */
export async function withdrawDonation(env: Env, donationId: string, donorUserId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT tenant_id, donor_user_id, status FROM ai_donations WHERE id = ?")
    .bind(donationId).first<{ tenant_id: string; donor_user_id: string; status: DonationStatus }>();
  if (!row || row.donor_user_id !== donorUserId || row.status === "withdrawn") return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_donation_secrets WHERE donation_id = ?").bind(donationId),
    env.DB.prepare("UPDATE ai_donations SET status = 'withdrawn', updated_at = ? WHERE id = ?").bind(nowIso(), donationId),
  ]);
  return true;
}

export async function purgeExpiredDonations(env: Env): Promise<number> {
  const cutoff = nowIso();
  const secrets = await env.DB.prepare(
    "SELECT id FROM ai_donations WHERE expires_at <= ? OR status = 'rejected'",
  ).bind(cutoff).all<{ id: string }>();
  const ids = (secrets.results ?? []).map((row) => row.id);
  if (ids.length === 0) return 0;
  const statements = ids.flatMap((id) => ([
    env.DB.prepare("DELETE FROM ai_donation_secrets WHERE donation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM ai_donations WHERE id = ?").bind(id),
  ]));
  for (let index = 0; index < statements.length; index += 20) {
    await env.DB.batch(statements.slice(index, index + 20));
  }
  return ids.length;
}

export function donationConsentText(): string {
  return [
    "🎁 <b>اهدای کلید هوش مصنوعی</b>",
    "",
    "کلید شما در یک صف بازبینی قرار می‌گیرد. V13 در این نسخه کلید اهدایی را تست نمی‌کند، به سرویسی وصل نمی‌کند و خرج شما نمی‌کند.",
    "",
    "پس از تأیید ادمین، کلید داخل دیتابیس همین کنترل‌پلین با AES-256-GCM (همان کلید رمزنگاری Tokenهای Cloudflare) نگهداری می‌شود.",
    "• در چت فقط قطعهٔ مخدوش‌شده نشان داده می‌شود (۳ نویسهٔ اول و ۴ نویسهٔ آخر).",
    "• هر کلید بعد از ۳۰ روز به‌طور کامل پاک می‌شود؛ تا آن زمان با دکمهٔ «پس‌گرفتن» قابل حذف فوری است.",
    "• با اهدا تأیید می‌کنید کلید متعلق به شماست و اشتراک آن با استخر را می‌پذیرید.",
    "",
    "⚠️ اگر بعداً پشیمان شدید، کلید را در سرویس مبدأ (OpenAI/Groq/…) هم revoke کنید؛ پاک‌کردن از V13 خودِ کلید را در آن سرویس زنده نگه می‌دارد.",
    "",
    "برای ادامه «✅ می‌پذیرم، کلید را می‌فرستم» را بزنید و در پیام بعدی فقط خودِ کلید را بفرستید.",
  ].join("\n");
}

export function donationPoolText(stats: DonationPoolStats, baseUrl: string): string {
  const providers = stats.byProvider.length > 0
    ? stats.byProvider.map((row) => `• ${row.provider} — ${row.count} کلید`).join("\n")
    : "— هنوز کلیدی ثبت نشده است.";
  return [
    "🏊 <b>وضعیت استخر کلیدهای AI</b>",
    "",
    `کلیدهای فعال: ${stats.total}`,
    `⏳ در انتظار بازبینی: ${stats.pending} · ✅ تأییدشده: ${stats.approved}`,
    "",
    providers,
    "",
    "ℹ️ این اعداد شمارش واقعی دیتابیس است؛ هیچ پینگ یا سرعت سنجیده‌نشده‌ای در پنل نمایش داده نمی‌شود.",
    `🧑‍💼 لینک راهنما: <code>${escapeHtml(baseUrl)}/omni</code>`,
  ].join("\n");
}

export function donationMineText(rows: DonationRow[]): string {
  if (rows.length === 0) return "🎁 هنوز کلیدی اهدا نکرده‌اید.";
  const lines = rows.map((row) =>
    `• <code>${escapeHtml(row.snippet)}</code> — ${escapeHtml(row.provider)} · ${DONATION_STATUS_LABELS[row.status] ?? escapeHtml(row.status)}`);
  return ["🎁 <b>کلیدهای من</b>", "", ...lines, "", "با «↩️ پس‌گرفتن» ciphertext کلید بلافاصله حذف می‌شود."].join("\n");
}

