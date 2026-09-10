import { expect, it } from "vitest";
import { DATA_PLANE_SOURCE } from "../src/data-plane-source";

it("ships a syntactically valid embedded data-plane Worker", async () => {
  const encoded = btoa(DATA_PLANE_SOURCE);
  const module = await import(`data:text/javascript;base64,${encoded}`);
  expect(module.default.fetch).toBeTypeOf("function");
  expect(DATA_PLANE_SOURCE).toContain(String.raw`const match = /^\/sub\/`);
  expect(DATA_PLANE_SOURCE).toContain(String.raw`join("\n") + "\n"`);
});
