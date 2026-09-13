import { describe, expect, it } from "vitest";
import {
  classifyAnswers,
  DNS_CANARIES,
  encodeDnsQuery,
  parseCidr,
  parseDnsResponse,
} from "../src/dns-center";

describe("DNS center range parsing", () => {
  it("accepts single IPs and /24../32 CIDRs", () => {
    expect(parseCidr("1.1.1.1")?.ips).toEqual(["1.1.1.1"]);
    expect(parseCidr("178.22.122.0/24")?.ips).toHaveLength(256);
    expect(parseCidr("178.22.122.7/30")?.ips).toEqual(["178.22.122.4", "178.22.122.5", "178.22.122.6", "178.22.122.7"]);
  });

  it("rejects wide ranges, bad octets and garbage", () => {
    expect(parseCidr("10.0.0.0/16")).toBeNull();
    expect(parseCidr("300.1.1.1")).toBeNull();
    expect(parseCidr("example.com")).toBeNull();
    expect(parseCidr("")).toBeNull();
  });
});

describe("DNS wire format", () => {
  it("encodes a single A question", () => {
    const wire = encodeDnsQuery("dns.google");
    expect(wire[4]).toBe(0);
    expect(wire[5]).toBe(1); // qdcount
    expect(wire[12]).toBe(3); // label length "dns"
  });

  it("parses a synthetic NOERROR answer with one A record", () => {
    const response = new Uint8Array([
      0x13, 0x56, 0x81, 0x80, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x03, 0x64, 0x6e, 0x73, 0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x00,
      0x00, 0x01, 0x00, 0x01,
      0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x04, 8, 8, 8, 8,
    ]);
    const parsed = parseDnsResponse(response);
    expect(parsed.rcode).toBe(0);
    expect(parsed.answers).toEqual(["8.8.8.8"]);
  });
});

describe("honest verdicts", () => {
  const expected = (DNS_CANARIES[1] ?? DNS_CANARIES[0])?.expected ?? [];
  it("marks globally-correct answers healthy", () => {
    expect(classifyAnswers(["8.8.8.8"], ["8.8.8.8", "8.8.4.4"])).toBe("healthy");
  });
  it("marks blackhole answers fake", () => {
    expect(classifyAnswers(["127.0.0.1"], expected)).toBe("fake");
    expect(classifyAnswers(["10.10.34.34"], expected)).toBe("fake");
  });
  it("marks unexpected answers wrong and empty answers unreachable", () => {
    expect(classifyAnswers(["93.184.216.34"], expected)).toBe("wrong");
    expect(classifyAnswers([], expected)).toBe("unreachable");
  });
});
