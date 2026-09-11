/**
 * Downloads a third-party panel source for «🚀 دیپلوی پنل جدید».
 *
 * The worker fetched whatever `PANEL_CATALOG[key].rawUrl` pointed at. Here the
 * same download is allowed, but only over https, only from the hosts listed in
 * `PANEL_SOURCE_HOSTS`, only once per deploy, and always hashed so the deploy
 * record can say which bytes went out.
 */
import { PANEL_SOURCE_HOSTS } from "./panel-catalog";
import { sha256 } from "./security";

export const PANEL_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export const PANEL_SOURCE_MIN_CHARS = 50;

export interface PanelSource {
  source: string;
  sha256: string;
  bytes: number;
  host: string;
  url: string;
}

export class PanelSourceError extends Error {}

export function isAllowedPanelSourceUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const allowed = PANEL_SOURCE_HOSTS.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
  return allowed ? url : null;
}

/** Fetches the source text, refusing oversized or empty responses. */
export async function fetchPanelSource(
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PanelSource> {
  const url = isAllowedPanelSourceUrl(value);
  if (!url) {
    throw new PanelSourceError(
      `آدرس سورس پنل مجاز نیست. فقط https و فقط از: ${PANEL_SOURCE_HOSTS.join(", ")}`,
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } });
  } catch {
    throw new PanelSourceError("دانلود سورس پنل انجام نشد (خطای شبکه).");
  }
  if (!response.ok) {
    throw new PanelSourceError(`سورس پنل با کد ${response.status} برگشت.`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > PANEL_SOURCE_MAX_BYTES) {
    throw new PanelSourceError("سورس پنل از حد مجاز ۲ مگابایت بزرگ‌تر است.");
  }
  const source = new TextDecoder().decode(buffer);
  if (source.length < PANEL_SOURCE_MIN_CHARS) {
    throw new PanelSourceError("سورس پنل خالی یا خیلی کوتاه است.");
  }
  return { source, sha256: await sha256(source), bytes: buffer.byteLength, host: url.hostname, url: url.toString() };
}

/**
 * Rewrites the downloaded source the way the worker did, per panel family.
 * Returns the source plus a short note about what was changed.
 */
export function transformPanelSource(
  panelKey: string,
  source: string,
  values: { password: string; domain: string },
): { source: string; note: string } {
  if (panelKey === "nahan") {
    const next = source.replace(/masterKey:\s*"admin"/gu, `masterKey: "${values.password}"`);
    return {
      source: next,
      note: next === source ? "masterKey در سورس پیدا نشد؛ همان پیش‌فرض می‌ماند" : "masterKey با رمز شما جایگزین شد",
    };
  }
  if (panelKey === "spider") {
    const next = source
      .replace(/__PANEL_TOKEN__/gu, JSON.stringify(values.password))
      .replace(/__PANEL_DOMAIN__/gu, JSON.stringify(values.domain));
    return { source: next, note: "توکن و دامنهٔ پنل در سورس جای‌گذاری شد" };
  }
  if (panelKey === "bpb") {
    // BPB v4 ignores injected settings and reads pwd from KV — seeding the
    // namespace is the only correct way to set the password.
    return { source, note: "رمز پنل از طریق KV (کلید pwd) ست می‌شود، نه با دست‌کاری سورس" };
  }
  return { source, note: "سورس بدون تغییر منتقل شد" };
}
