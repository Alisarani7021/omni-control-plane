import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMNI_AGENT_HEADER,
  OMNI_AGENT_LEGACY_HEADER,
  omniAgent,
} from "../src/omni-engine";
import { OMNI_SOURCE } from "../src/omni-source";

/**
 * The node bundle is vendored and pinned, so the header it reads is the only
 * header that matters: if the control plane renames its outbound auth header
 * without keeping the pinned spelling, every agent call fails with
 * 403 «کلید عامل نامعتبر است» — exactly the regression the Kaveh→OMNI rebrand
 * introduced. These tests hold both sides of that contract together.
 */
function agentHeadersReadByNodeBundle(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/headers\.get\(\s*["'](x-[a-z-]*agent)["']\s*\)/gu)) {
    names.add(match[1]!.toLowerCase());
  }
  return [...names];
}

async function headersSentToNode(agentKey: string): Promise<Headers[]> {
  const seen: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ ok: true, service: "omni", version: "0.1.0" });
    }),
  );
  await omniAgent("https://omni-node.example.workers.dev", agentKey, "/api/agent/health");
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("omni agent-channel auth contract", () => {
  it("sends the header name the pinned node bundle actually reads", async () => {
    const required = agentHeadersReadByNodeBundle(OMNI_SOURCE);
    expect(required.length).toBeGreaterThan(0); // the guard exists in the bundle

    const seen = await headersSentToNode("agent-key-under-test");
    expect(seen).toHaveLength(1);
    for (const name of required) {
      expect(seen[0]?.get(name)).toBe("agent-key-under-test");
    }
  });

  it("keeps both the current and the pre-rebrand header name", async () => {
    expect(OMNI_AGENT_HEADER).toBe("X-Omni-Agent");
    expect(OMNI_AGENT_LEGACY_HEADER).toBe("X-Kaveh-Agent");

    const seen = await headersSentToNode("agent-key-under-test");
    expect(seen[0]?.get(OMNI_AGENT_HEADER)).toBe("agent-key-under-test");
    expect(seen[0]?.get(OMNI_AGENT_LEGACY_HEADER)).toBe("agent-key-under-test");
  });

  it("surfaces the node's own rejection text instead of a bare status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, code: "forbidden", error: "کلید عامل نامعتبر است" }, { status: 403 })),
    );
    await expect(omniAgent("https://omni-node.example.workers.dev", "wrong-key", "/api/agent/health"))
      .rejects.toThrow("کلید عامل نامعتبر است");
  });
});
