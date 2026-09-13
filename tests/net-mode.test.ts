import { describe, expect, it } from "vitest";
import { classifyNetMode, EDGE_OK_RATIO, NET_MODE_LABELS } from "../src/net-mode";

describe("network-mode classification", () => {
  const edge = (okRatio: number, latency: number | null = 120) => ({ okRatio, medianLatencyMs: latency, samples: 12 });
  const inner = (alive: boolean, degraded = false) => ({ alive, degraded });

  it("calls an all-healthy pair open", () => {
    expect(classifyNetMode(edge(1), inner(true))).toBe("open");
  });

  it("flags a degraded inner eye as throttled", () => {
    expect(classifyNetMode(edge(EDGE_OK_RATIO), inner(true, true))).toBe("throttled");
  });

  it("flags a slow edge as throttled", () => {
    expect(classifyNetMode(edge(1, 1500), inner(true))).toBe("throttled");
  });

  it("detects national-only when the edge eye dies but the node lives", () => {
    expect(classifyNetMode(edge(0.1), inner(true))).toBe("national-only");
  });

  it("detects blackout when both eyes are dark", () => {
    expect(classifyNetMode(edge(0), inner(false))).toBe("blackout");
  });

  it("never guesses without measurements", () => {
    expect(classifyNetMode(null, null)).toBe("nodata");
    expect(classifyNetMode(null, inner(true))).toBe("nodata");
    expect(classifyNetMode({ okRatio: 1, medianLatencyMs: null, samples: 0 }, inner(true))).toBe("nodata");
  });

  it("labels every state in Persian", () => {
    for (const mode of ["open", "throttled", "national-only", "blackout", "nodata"] as const) {
      expect(NET_MODE_LABELS[mode].length).toBeGreaterThan(3);
    }
  });
});
