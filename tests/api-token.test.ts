import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudflareApi,
  eraseExpiredApiTokens,
  getValidCloudflareAuth,
  revokeConnectionGrant,
} from "../src/cloudflare-api";
import { bytesToBase64Url, encryptJson } from "../src/security";
import type { ConnectionRow, Env } from "../src/types";

function connectionFixture(accessTokenEnc: string): ConnectionRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    auth_type: "api_token",
    access_token_enc: accessTokenEnc,
    refresh_token_enc: null,
    expires_at: "2099-09-10T12:00:00.000Z",
    scopes: "scoped-api-token",
    cf_user_id: "cloudflare-token-id",
    cf_email: null,
    resource_account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    resource_account_name: "Example Account",
    resource_zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    resource_zone_name: "example.com",
    revoked_at: null,
    created_at: "2026-09-10T00:00:00.000Z",
    updated_at: "2026-09-10T00:00:00.000Z",
  };
}

function encryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

afterEach(() => vi.unstubAllGlobals());

describe("temporary scoped Cloudflare API token", () => {
  it("decrypts only for use and sends a Bearer authorization header", async () => {
    const key = encryptionKey();
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const secret = "scoped-token-secret-value-123456";
    const encrypted = await encryptJson(secret, key, `cloudflare:${connectionId}:api-token`);
    const env = { TOKEN_ENCRYPTION_KEY: key } as Env;
    const auth = await getValidCloudflareAuth(env, connectionFixture(encrypted));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, result: { id: "user" } }));
    vi.stubGlobal("fetch", fetchMock);

    await cloudflareApi<{ id: string }>(auth, "/user/tokens/verify");

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const headers = new Headers((firstCall?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${secret}`);
    expect(headers.has("X-Auth-Key")).toBe(false);
    expect(headers.has("X-Auth-Email")).toBe(false);
  });

  it("scrubs the stored ciphertext without attempting remote token deletion", async () => {
    const key = encryptionKey();
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const encrypted = await encryptJson("scoped-token-secret-value-123456", key, `cloudflare:${connectionId}:api-token`);
    const boundValues: unknown[][] = [];
    const env = {
      TOKEN_ENCRYPTION_KEY: key,
      DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => {
            boundValues.push(values);
            return { run: async () => ({ success: true }) };
          },
        }),
      },
    } as unknown as Env;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await revokeConnectionGrant(env, connectionFixture(encrypted));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(boundValues[0]?.at(-1)).toBe(connectionId);
  });

  it("rejects expired credentials before decrypting or calling Cloudflare", async () => {
    const key = encryptionKey();
    const connection = connectionFixture("not-an-envelope");
    connection.expires_at = "2000-01-01T00:00:00.000Z";

    await expect(getValidCloudflareAuth({ TOKEN_ENCRYPTION_KEY: key } as Env, connection)).rejects.toThrow(
      "Temporary Cloudflare API token expired",
    );
  });

  it("erases expired rows with one bounded database update", async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const env = {
      DB: {
        prepare: (statement: string) => {
          statements.push(statement);
          return {
            bind: (...bound: unknown[]) => {
              values.push(bound);
              return { run: async () => ({ meta: { changes: 3 } }) };
            },
          };
        },
      },
    } as unknown as Env;

    await expect(eraseExpiredApiTokens(env)).resolves.toBe(3);
    expect(statements[0]).toContain("auth_type = 'api_token'");
    expect(statements[0]).toContain("expires_at <= ?");
    expect(values[0]).toHaveLength(3);
  });
});
