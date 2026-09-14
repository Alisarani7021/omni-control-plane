import { expect, it } from "vitest";
import { DATA_PLANE_SOURCE } from "../src/data-plane-source";

it("ships a syntactically valid embedded data-plane Worker", async () => {
  const encoded = btoa(DATA_PLANE_SOURCE);
  const module = await import(`data:text/javascript;base64,${encoded}`);
  expect(module.default.fetch).toBeTypeOf("function");
  expect(DATA_PLANE_SOURCE).toContain(String.raw`const match = /^\/sub\/`);
  expect(DATA_PLANE_SOURCE).toContain(String.raw`join("\n") + "\n"`);
});

it("serves DoH on the tenant domain with strict qtype and cap policy", () => {
  expect(DATA_PLANE_SOURCE).toContain('url.pathname === "/dns-query"');
  expect(DATA_PLANE_SOURCE).toContain("DOH_ALLOWED_QTYPES = [1, 28, 16]");
  expect(DATA_PLANE_SOURCE).toContain("REFUSED");
  expect(DATA_PLANE_SOURCE).toContain("dns_query_count");
  expect(DATA_PLANE_SOURCE).toContain("DOH_HOURLY_CAP");
});

it("serves clash and labelled sniff/fakedns variants from the subscription", () => {
  expect(DATA_PLANE_SOURCE).toContain('format === "clash"');
  expect(DATA_PLANE_SOURCE).toContain("profileVariants");
});
