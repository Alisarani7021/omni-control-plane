import { describe, expect, it } from "vitest";
import { buildRuleSet, diffRanges, parseDelegatedIrnic, RIR_IR_URL } from "../src/geoip-ir";

const SAMPLE = [
  "# comment line",
  "irnic|IR|ipv4|2.144.0.0|65536|20100101|allocated|4c2f",
  "irnic|IR|ipv4|5.56.0.0|8192|20110101|allocated|4c2f",
  "irnic|IR|ipv6|2001:db8::|32|20120101|allocated",
  "apnic|IR|ipv4|5.144.0.0|8192|20150101|allocated",
  "apnic|DE|ipv4|7.0.0.0|256|20130101|allocated",
  "irnic|IR|ipv4|9.9.9.0|100|20140101|allocated", // non power-of-two length must be ignored
].join("\n");

describe("RIPE/IRNIC national ranges", () => {
  it("parses delegated-extended lines into CIDRs and ignores foreign/invalid rows", () => {
    const ranges = parseDelegatedIrnic(SAMPLE);
    expect(ranges).toEqual([
      { cidr: "2.144.0.0/16", family: "ipv4" },
      { cidr: "5.56.0.0/19", family: "ipv4" },
      { cidr: "2001:db8::/32", family: "ipv6" },
      { cidr: "5.144.0.0/19", family: "ipv4" },
    ]);
  });

  it("diffs snapshots both ways", () => {
    const previous = new Set(["2.144.0.0/16", "5.56.0.0/19"]);
    const next = new Set(["5.56.0.0/19", "5.144.0.0/16"]);
    expect(diffRanges(previous, next)).toEqual({ added: ["5.144.0.0/16"], removed: ["2.144.0.0/16"] });
  });

  it("emits a sing-box rule-set from the live range set", () => {
    const ruleSet = buildRuleSet(["2.144.0.0/16"]) as { version: number; rules: Array<{ ip_cidr: string[] }> };
    expect(ruleSet.version).toBe(2);
    expect(ruleSet.rules[0]?.ip_cidr).toEqual(["2.144.0.0/16"]);
  });

  it("reads the public APNIC stats (IR rows via NIR)", () => {
    expect(RIR_IR_URL).toContain("delegated-apnic-extended-latest");
  });
});
