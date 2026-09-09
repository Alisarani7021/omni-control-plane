const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function parsePositiveInt(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

export function bytesToBase64Url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftHash = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightHash = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index]! ^ b[index]!;
  return mismatch === 0;
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(encodedKey);
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return importAesKey(raw);
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length);
  crypto.getRandomValues(data);
  return data;
}

export async function encryptJson<T>(value: T, encodedKey: string, aad: string): Promise<string> {
  const keyEncryptionKey = await importEncryptionKey(encodedKey);
  const dataKeyBytes = randomBytes(32);
  const dataKey = await importAesKey(dataKeyBytes);
  const wrapNonce = randomBytes(12);
  const dataNonce = randomBytes(12);
  const wrappedDataKey = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: wrapNonce, additionalData: encoder.encode(`${aad}|dek`), tagLength: 128 },
    keyEncryptionKey,
    dataKeyBytes,
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: dataNonce, additionalData: encoder.encode(`${aad}|data`), tagLength: 128 },
    dataKey,
    encoder.encode(JSON.stringify(value)),
  );
  return [
    "v2",
    bytesToBase64Url(wrapNonce),
    bytesToBase64Url(new Uint8Array(wrappedDataKey)),
    bytesToBase64Url(dataNonce),
    bytesToBase64Url(new Uint8Array(ciphertext)),
  ].join(".");
}

export async function decryptJson<T>(envelope: string, encodedKey: string, aad: string): Promise<T> {
  const parts = envelope.split(".");
  const keyEncryptionKey = await importEncryptionKey(encodedKey);
  if (parts[0] === "v1" && parts.length === 3 && parts[1] && parts[2]) {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(parts[1]), additionalData: encoder.encode(aad), tagLength: 128 },
      keyEncryptionKey,
      base64UrlToBytes(parts[2]),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  }
  if (parts[0] !== "v2" || parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
    throw new Error("Unsupported encrypted envelope");
  }
  const dataKeyBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(parts[1]), additionalData: encoder.encode(`${aad}|dek`), tagLength: 128 },
    keyEncryptionKey,
    base64UrlToBytes(parts[2]),
  );
  const dataKey = await importAesKey(new Uint8Array(dataKeyBytes));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(parts[3]), additionalData: encoder.encode(`${aad}|data`), tagLength: 128 },
    dataKey,
    base64UrlToBytes(parts[4]),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function sessionCookie(rawToken: string, maxAge: number): string {
  return `v13_session=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return "v13_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_BASE_URL must be a clean HTTPS origin");
  }
  return parsed.origin;
}

export function isValidHostname(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/u.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255 && String(number) === part;
  });
}

export function isPublicIpv4(value: string): boolean {
  if (!isValidIpv4(value)) return false;
  const [a, b, c] = value.split(".").map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function isValidCloudflareId(value: string): boolean {
  return /^[a-f0-9]{32}$/u.test(value);
}

export function isValidWorkerName(value: string): boolean {
  return /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/u.test(value);
}

export function redactError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "UnknownError";
}
