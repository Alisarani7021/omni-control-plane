import { describe, expect, it } from "vitest";
import {
  createDonation,
  detectProvider,
  donationPoolText,
  listDonations,
  purgeExpiredDonations,
  readDonationKey,
  redactKey,
  setDonationStatus,
  validateDonationKey,
  DONATION_MAX_PER_TENANT,
  withdrawDonation,
} from "../src/ai-donate";
import { encryptJson } from "../src/security";
import { HttpError } from "../src/http";
import type { Env } from "../src/types";

const ENVELOPE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DONATION_ID = "11111111-1111-4111-8111-111111111111";
const RAW_KEY = "sk-abcdefghijklmnopqrstuvwxyz1234";

interface Captured {
  sql: string;
  params: unknown[];
}

interface DonateEnvOptions {
  activeCount?: number;
  rateLimited?: boolean;
  batchError?: Error;
  ownerRow?: Record<string, unknown> | null;
  expiredIds?: string[];
  secretRow?: { secret_enc: string } | null;
}

/**
 * Fake D1 that behaves close enough for this module: `run` and `batch` both end
 * up in `executed`, so tests can assert on exactly what would have been written.
 */
function donateEnv(options: DonateEnvOptions = {}): { env: Env; prepared: Captured[]; executed: Captured[] } {
  const prepared: Captured[] = [];
  const executed: Captured[] = [];
  let lastRateWindow: number | null = null;
  const firstFor = (sql: string): unknown => {
    if (sql.includes("FROM rate_limits")) {
      const now = Math.floor(Date.now() / 1000);
      return { window_started_at: lastRateWindow ?? now - (now % 3_600), hits: options.rateLimited ? 99 : 1 };
    }
    if (sql.includes("COUNT(*)")) return { count: options.activeCount ?? 0 };
    if (sql.includes("FROM ai_donation_secrets")) return options.secretRow ?? null;
    if (sql.includes("FROM ai_donations")) return options.ownerRow ?? null;
    return null;
  };
  const DB = {
    prepare(sql: string) {
      const record: Captured = { sql, params: [] };
      prepared.push(record);
      return {
        bind(...params: unknown[]) {
          record.params = params;
          return {
            sql,
            record,
            run: async () => {
              executed.push(record);
              if (sql.includes("INSERT INTO rate_limits")) lastRateWindow = Number(params[1]);
              return { success: true, meta: { changes: 1 } };
            },
            first: async <T>() => (firstFor(sql) as T | null),
            all: async <T>() => ({ results: (options.expiredIds ?? []).map((id) => ({ id })) as unknown as T[] }),
          };
        },
      };
    },
    batch: async (statements: Array<{ record?: Captured }>) => {
      if (options.batchError) throw options.batchError;
      for (const statement of statements) {
        if (statement?.record) executed.push(statement.record);
      }
      return [];
    },
  };
  return { env: { DB, TOKEN_ENCRYPTION_KEY: ENVELOPE_KEY } as unknown as Env, prepared, executed };
}

describe("donation key handling", () => {
  it("labels providers and redacts everything in between", () => {
    expect(detectProvider("sk-ant-APiKey0123456789")).toBe("Anthropic Claude");
    expect(detectProvider("sk-proj-abcdefghijklmnop")).toBe("OpenAI (Project key)");
    expect(detectProvider("gsk_abcdefghijklmnopqrstuv")).toBe("Groq");
    expect(detectProvider("AIzaSyABCDEFGHIJKLMNOPQRSTUVW")).toBe("Google AI Studio");
    expect(detectProvider("xy1234567890abcdefghijkl")).toContain("نامشخص");

    const sample = "sk-proj-supersecretvalue-987654321";
    expect(redactKey(sample)).toBe("sk-…4321");
    expect(redactKey(sample)).not.toContain("supersecretvalue");
    expect(redactKey(RAW_KEY)).toBe("sk-…1234");
  });

  it("rejects junk instead of storing it", () => {
    for (const bad of ["short", "sk-key with spaces", "sk-".repeat(100), "replace_me_please", "changeme-1234567890ab", null, 42]) {
      expect(() => validateDonationKey(bad)).toThrow(HttpError);
    }
    expect(validateDonationKey(`  ${RAW_KEY}  `)).toBe(RAW_KEY);
  });
});

describe("createDonation", () => {
  it("stores only ciphertext, a one-way fingerprint and a snippet", async () => {
    const { env, executed } = donateEnv();
    const donation = await createDonation(env, { tenantId: "tenant-1", donorUserId: "555", key: RAW_KEY });
    expect(donation.status).toBe("pending");
    expect(donation.provider).toBe("OpenAI / سازگار با OpenAI");
    expect(donation.snippet).toBe("sk-…1234");

    const insert = executed.find((item) => item.sql.includes("INSERT INTO ai_donations"));
    expect(JSON.stringify(insert?.params)).not.toContain(RAW_KEY);
    expect(String(insert?.params[4])).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const secret = executed.find((item) => item.sql.includes("INSERT INTO ai_donation_secrets"));
    expect(String(secret?.params[1])).toMatch(/^v2\./u);
    expect(JSON.stringify(secret?.params)).not.toContain(RAW_KEY);
  });

  it("refuses a key that was already donated", async () => {
    const { env } = donateEnv({ batchError: new Error("UNIQUE constraint failed: ai_donations.key_fingerprint") });
    await expect(createDonation(env, { tenantId: "tenant-1", donorUserId: "555", key: RAW_KEY }))
      .rejects.toMatchObject({ code: "duplicate_donation", status: 409 });
  });

  it("caps the number of active keys per donor", async () => {
    const { env, executed } = donateEnv({ activeCount: DONATION_MAX_PER_TENANT });
    await expect(createDonation(env, { tenantId: "tenant-1", donorUserId: "555", key: RAW_KEY }))
      .rejects.toMatchObject({ code: "too_many_donations", status: 429 });
    expect(executed.filter((item) => item.sql.includes("INSERT INTO ai_donations"))).toHaveLength(0);
  });

  it("rate limits how often one donor can submit keys", async () => {
    const { env, executed } = donateEnv({ rateLimited: true });
    await expect(createDonation(env, { tenantId: "tenant-1", donorUserId: "555", key: RAW_KEY }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(executed.filter((item) => item.sql.includes("INSERT INTO ai_donations"))).toHaveLength(0);
  });

  it("never encrypts with a missing key envelope", async () => {
    const { env } = donateEnv();
    (env as unknown as { TOKEN_ENCRYPTION_KEY: string }).TOKEN_ENCRYPTION_KEY = "too-short";
    await expect(createDonation(env, { tenantId: "tenant-1", donorUserId: "555", key: RAW_KEY })).rejects.toThrow();
  });
});

describe("donation lifecycle", () => {
  it("lists rows without ever selecting the ciphertext", async () => {
    const { env, prepared } = donateEnv();
    await listDonations(env, { tenantId: "tenant-1", status: "pending", limit: 5 });
    const select = prepared.find((item) => item.sql.includes("FROM ai_donations"));
    expect(select?.sql).toContain("status = ?");
    expect(select?.sql).not.toContain("secret_enc");
    expect(select?.params).toEqual([expect.any(String), "tenant-1", "pending"]);
  });

  it("erases the ciphertext when the donor withdraws", async () => {
    const { env, executed } = donateEnv({ ownerRow: { tenant_id: "tenant-1", donor_user_id: "555", status: "pending" } });
    expect(await withdrawDonation(env, DONATION_ID, "555")).toBe(true);
    expect(executed.some((item) => item.sql.includes("DELETE FROM ai_donation_secrets"))).toBe(true);

    const other = donateEnv({ ownerRow: { tenant_id: "tenant-1", donor_user_id: "555", status: "pending" } });
    expect(await withdrawDonation(other.env, DONATION_ID, "999")).toBe(false);
    expect(other.executed).toHaveLength(0);
  });

  it("drops the secret on rejection but keeps the approved row", async () => {
    const rejected = donateEnv();
    await setDonationStatus(rejected.env, DONATION_ID, "rejected");
    expect(rejected.executed.some((item) => item.sql.includes("DELETE FROM ai_donation_secrets"))).toBe(true);
    const rejectedUpdate = rejected.executed.find((item) => item.sql.includes("UPDATE ai_donations SET status = ?"));
    expect(rejectedUpdate?.params[0]).toBe("rejected");

    const approved = donateEnv();
    await setDonationStatus(approved.env, DONATION_ID, "approved");
    expect(approved.executed.some((item) => item.sql.includes("DELETE FROM ai_donation_secrets"))).toBe(false);
    expect(approved.executed.some((item) => /UPDATE ai_donations SET status = \?/u.test(item.sql))).toBe(true);
  });

  it("hard-deletes expired donations and their secrets", async () => {
    const { env, executed } = donateEnv({ expiredIds: ["one", "two", "three"] });
    expect(await purgeExpiredDonations(env)).toBe(3);
    expect(executed.filter((item) => item.sql.includes("DELETE FROM ai_donations"))).toHaveLength(3);
    expect(executed.filter((item) => item.sql.includes("DELETE FROM ai_donation_secrets"))).toHaveLength(3);
  });

  it("returns nothing for an empty retention window", async () => {
    const { env } = donateEnv();
    expect(await purgeExpiredDonations(env)).toBe(0);
  });

  it("can decrypt a key only through the explicit reader helper", async () => {
    const secretEnc = await encryptJson({ key: RAW_KEY }, ENVELOPE_KEY, `ai-donation:${DONATION_ID}`);
    const { env } = donateEnv({ secretRow: { secret_enc: secretEnc } });
    expect(await readDonationKey(env, DONATION_ID)).toBe(RAW_KEY);

    const tampered = donateEnv({ secretRow: { secret_enc: "not-an-envelope" } });
    expect(await readDonationKey(tampered.env, DONATION_ID)).toBeNull();

    const otherAad = donateEnv({ secretRow: { secret_enc: secretEnc } });
    expect(await readDonationKey(otherAad.env, "22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it("reports pool numbers without invented latency", () => {
    const text = donationPoolText({
      total: 3,
      pending: 1,
      approved: 2,
      rejected: 0,
      withdrawn: 0,
      byProvider: [{ provider: "Groq", count: 2 }],
    }, "https://control.example.com");
    expect(text).toContain("Groq — 2 کلید");
    expect(text).toContain("⏳ در انتظار بازبینی: 1");
    expect(text).not.toMatch(/\d+ms/);
  });
});
