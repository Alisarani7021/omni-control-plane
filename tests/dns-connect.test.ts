import { describe, expect, it, vi } from "vitest";
import { dnsConnectGet, dnsConnectPost } from "../src/dns-connect";
import type { Env } from "../src/types";

const TOKEN = "x".repeat(40);

function makeEnv() {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const DB = {
    prepare(sql: string) {
      const record = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          record.params = params;
          return {
            sql,
            params: record.params,
            run: async () => {
              executed.push(record);
              return { success: true, meta: { changes: 1 } };
            },
            first: async <T>() => {
              executed.push(record);
              if (sql.includes("FROM login_links")) {
                return {
                  tenant_id: "tenant-1",
                  expires_at: new Date(Date.now() + 600_000).toISOString(),
                  consumed_at: null,
                } as unknown as T;
              }
              if (sql.includes("FROM rate_limits")) {
                const now = Math.floor(Date.now() / 1000);
                return { window_started_at: now - (now % 600), hits: 1 } as unknown as T;
              }
              if (sql.includes("COUNT(*)")) return { count: 0 } as unknown as T;
              return null as unknown as T;
            },
            all: async <T>() => {
              executed.push(record);
              return { results: [] as T[] };
            },
          };
        },
      };
    },
    batch: async () => [],
  };
  const env = {
    DB,
    PUBLIC_BASE_URL: "https://control.example.com",
    TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    API_TOKEN_TTL_SECONDS: "7200",
  } as unknown as Env;
  return { env, executed };
}

function cfFetchStub(mode: "ok" | "rejected") {
  return vi.fn(async (url: string) => {
    const endpoint = String(url).split("/").pop() ?? "";
    if (mode === "rejected" && endpoint === "verify") {
      return new Response(JSON.stringify({ success: false }), { status: 401 });
    }
    if (endpoint === "verify") {
      return Response.json({ success: true, result: { id: "tok", status: "active" } });
    }
    if (String(url).includes("/zones?")) {
      return Response.json({
        success: true,
        result: [
          {
            id: "a".repeat(32),
            name: "example.ir",
            status: "active",
            account: { id: "b".repeat(32), name: "Ali" },
            permissions: ["#dns_records:edit"],
          },
        ],
      });
    }
    return Response.json({ success: true, result: [] });
  });
}

describe("DNS center standalone Cloudflare connect form", () => {
  it("serves its own one-time form page, never the dedicated panel", async () => {
    const { env } = makeEnv();
    const response = await dnsConnectGet(new Request(`https://control.example.com/dns/connect?t=${TOKEN}`), env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("مرکز DNS — اتصال Cloudflare");
    expect(body).toContain("dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=");
    expect(body).toContain('action="/connect"');
    expect(body).not.toContain("/app");
  });

  it("rejects expired or unknown links honestly", async () => {
    const { env } = makeEnv();
    const response = await dnsConnectGet(new Request("https://control.example.com/dns/connect?t=short"), env);
    const body = await response.text();
    expect(body).toContain("لینک معتبر نیست");
  });

  it("creates the DNS-center connection from the form and consumes the link", async () => {
    const { env, executed } = makeEnv();
    vi.stubGlobal("fetch", cfFetchStub("ok"));
    const response = await dnsConnectPost(
      new Request("https://control.example.com/dns/connect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: TOKEN, apiToken: "Y".repeat(40) }).toString(),
      }),
      env,
    );
    const body = await response.text();
    expect(body).toContain("اتصال مرکز DNS ساخته شد");
    expect(executed.some((item) => item.sql.startsWith("UPDATE login_links SET consumed_at"))).toBe(true);
    expect(executed.some((item) => item.sql.startsWith("INSERT INTO oauth_connections"))).toBe(true);
  });

  it("shows the Cloudflare rejection on the form instead of hiding it", async () => {
    const { env } = makeEnv();
    vi.stubGlobal("fetch", cfFetchStub("rejected"));
    const response = await dnsConnectPost(
      new Request("https://control.example.com/dns/connect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: TOKEN, apiToken: "Y".repeat(40) }).toString(),
      }),
      env,
    );
    const body = await response.text();
    expect(body).toContain('class="err"');
    expect(body).not.toContain("اتصال مرکز DNS ساخته شد");
  });
});
