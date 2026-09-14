import { describe, expect, it } from "vitest";
import {
  beaconContent,
  fnv1a,
  minuteLabel,
  SLEEPER_DEFAULT_ANCHOR_HOUR,
  SLEEPER_JITTER_MINUTES,
  sleeperWindowFor,
} from "../src/sleeper";

const DEPLOYMENT = "11111111-1111-4111-8111-111111111111";

describe("sleeper (خواب‌نت) window and beacon", () => {
  it("derives a deterministic daily window with bounded jitter", () => {
    const first = sleeperWindowFor(DEPLOYMENT, SLEEPER_DEFAULT_ANCHOR_HOUR, "2026-09-12");
    const again = sleeperWindowFor(DEPLOYMENT, SLEEPER_DEFAULT_ANCHOR_HOUR, "2026-09-12");
    expect(first).toEqual(again);
    expect(Math.abs(first.jitter)).toBeLessThanOrEqual(SLEEPER_JITTER_MINUTES);
    const other = sleeperWindowFor(DEPLOYMENT, SLEEPER_DEFAULT_ANCHOR_HOUR, "2026-09-13");
    expect(other.startMinute).not.toBe(first.startMinute);
  });

  it("keeps the window inside one day", () => {
    for (let day = 1; day < 30; day += 1) {
      const window = sleeperWindowFor(DEPLOYMENT, 23, `2026-09-${String(day).padStart(2, "0")}`);
      expect(window.startMinute).toBeGreaterThanOrEqual(0);
      expect(window.startMinute).toBeLessThan(1440);
    }
  });

  it("labels minutes as HH:MM", () => {
    expect(minuteLabel(65)).toBe("01:05");
    expect(minuteLabel(0)).toBe("00:00");
  });

  it("encodes a tiny read-only beacon payload", () => {
    const window = sleeperWindowFor(DEPLOYMENT, 3, "2026-09-12");
    const content = beaconContent(window, "report-now");
    expect(content.startsWith("v13b1 ")).toBe(true);
    expect(content).toContain("report-now");
    expect(content.length).toBeLessThan(200);
  });

  it("has a stable non-cryptographic hash for jitter only", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
  });
});
