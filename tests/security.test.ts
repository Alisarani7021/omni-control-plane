import { describe, expect, it } from "vitest";
import {
  bytesToBase64Url,
  decryptJson,
  encryptJson,
  isPublicIpv4,
  randomToken,
} from "../src/security";

function key(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

describe("security primitives", () => {
  it("round-trips an AES-256-GCM envelope with bound AAD", async () => {
    const encodedKey = key();
    const encrypted = await encryptJson({ token: "secret" }, encodedKey, "tenant:one");
    expect(encrypted).not.toContain("secret");
    await expect(decryptJson(encrypted, encodedKey, "tenant:one")).resolves.toEqual({ token: "secret" });
    await expect(decryptJson(encrypted, encodedKey, "tenant:two")).rejects.toThrow();
  });

  it("creates high-entropy URL-safe bearer tokens", () => {
    const left = randomToken(32);
    const right = randomToken(32);
    expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(left).not.toBe(right);
  });

  it("rejects private, loopback, documentation and carrier-grade NAT ranges", () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "203.0.113.10"]) {
      expect(isPublicIpv4(address)).toBe(false);
    }
    expect(isPublicIpv4("1.1.1.1")).toBe(true);
  });
});
