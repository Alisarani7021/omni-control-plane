import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryApiTokenConnection } from "../src/api-token";
import { HttpError } from "../src/http";
import { bytesToBase64Url } from "../src/security";
import type { Env, SessionPrincipal } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

const principal: SessionPrincipal = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  telegramUserId: "123456789",
  displayName: "Test User",
  isAdmin: false,
  sessionHash: "session-hash",
};

function encryptionKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function mockEnv() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const currentWindow = Math.floor(Date.now() / 1000 / 600) * 600;
  const DB = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return {
          run: async () => ({ success: true, meta: { changes: 0 } }),
          first: async () => {
            if (sql.includes("SELECT window_started_at, hits")) return { window_started_at: currentWindow, hits: 1 };
            if (sql.includes("SELECT COUNT(*) AS count")) return { count: 0 };
            return null;
          },
        };
      },
    }),
  };
  const env = {
    DB,
    TOKEN_ENCRYPTION_KEY: encryptionKey(),
    API_TOKEN_TTL_SECONDS: "7200",
  } as unknown as Env;
  return { env, statements };
}

function requestFor(token: string): Request {
  return new Request("https://control.example.com/api/v1/cloudflare/api-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiToken: token }),
  });
}

function cloudflareFetch(zones: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/user/tokens/verify")) {
      return Response.json({ success: true, result: { id: "token-id", status: "active", expires_on: "2099-01-01T00:00:00Z" } });
    }
    if (url.includes("/zones?")) return Response.json({ success: true, result: zones });
    if (url.includes("/dns_records") || url.includes("/workers/scripts")) {
      return Response.json({ success: true, result: [] });
    }
    return Response.json({ success: false, errors: [{ code: 404 }] }, { status: 404 });
  });
}

const zone = {
  id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "example.com",
  status: "active",
  account: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Example Account" },
};

describe("scoped API token connection endpoint", () => {
  it("verifies capabilities, encrypts the token, and binds one account and zone", async () => {
    const secret = "scoped-api-token-secret-1234567890";
    const { env, statements } = mockEnv();
    const fetchMock = cloudflareFetch([zone]);
    vi.stubGlobal("fetch", fetchMock);

    const response = await createTemporaryApiTokenConnection(requestFor(secret), env, principal);
    const result = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(201);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(statements)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${secret}`);
    }
    const insert = statements.find(({ sql }) => sql.includes("INSERT INTO oauth_connections"));
    expect(insert).toBeDefined();
    expect(insert?.values).toContain(zone.account.id);
    expect(insert?.values).toContain(zone.id);
    expect(insert?.values[2]).not.toBe(secret);
  });

  it("fails closed when a token exposes more than one active zone", async () => {
    const { env, statements } = mockEnv();
    const secondZone = { ...zone, id: "cccccccccccccccccccccccccccccccc", name: "other.example" };
    vi.stubGlobal("fetch", cloudflareFetch([zone, secondZone]));

    let caught: unknown;
    try {
      await createTemporaryApiTokenConnection(requestFor("scoped-api-token-secret-1234567890"), env, principal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).code).toBe("cloudflare_token_scope_too_broad");
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO oauth_connections"))).toBe(false);
  });
});
