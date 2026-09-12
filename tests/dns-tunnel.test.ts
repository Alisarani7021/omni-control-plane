import { describe, expect, it } from "vitest";
import {
  DNSTT_MODULE,
  GO_AMD64_SHA256,
  GO_ARM64_SHA256,
  SLIPSTREAM_PIN,
  slipnetUri,
  TUNNEL_DEFAULT_MTU,
  TUNNEL_EXPECTATIONS,
  TUNNEL_MTU_SIZES,
  TUNNEL_SAFETY,
  tunnelHostnameFor,
} from "../src/dns-tunnel";

describe("DNS tunnel provisioning surface", () => {
  it("delegates under t.<zone>", () => {
    expect(tunnelHostnameFor("Example.com")).toBe("t.example.com");
  });

  it("builds the slipnet URI exactly as the apps expect", () => {
    const uri = slipnetUri("t.example.com", "ab".repeat(32), 1180);
    expect(uri.startsWith("slipnet://d=t.example.com&k=")).toBe(true);
    expect(uri).toContain("mtu=1180");
    expect(uri).toContain("socks=127.0.0.1%3A2080");
  });

  it("probes five MTU sizes including the default", () => {
    expect(TUNNEL_MTU_SIZES).toHaveLength(5);
    expect(TUNNEL_MTU_SIZES).toContain(TUNNEL_DEFAULT_MTU - 52);
  });

  it("states honest expectations and the amplifier safety line on the card", () => {
    expect(TUNNEL_EXPECTATIONS.join("\n")).toContain("kbit/s");
    expect(TUNNEL_SAFETY.join("\n")).toContain("amplifier");
  });

  it("embeds full-length official Go tarball checksums", () => {
    expect(GO_AMD64_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(GO_ARM64_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("pins slipstream to a commit and dnstt to its upstream module path", () => {
    expect(SLIPSTREAM_PIN).toMatch(/^[0-9a-f]{40}$/u);
    expect(DNSTT_MODULE).toContain("bamsoftware.com");
  });
});
