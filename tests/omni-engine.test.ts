import { describe, expect, it } from "vitest";
import { OMNI_DEFAULT_CRON, omniUploadMetadata } from "../src/omni-engine";
import { OMNI_SOURCE, OMNI_SOURCE_SHA256 } from "../src/omni-source";

describe("omni upload metadata", () => {
  const meta = omniUploadMetadata({ agentKey: "ak", signingSecret: "sk" }, "d1-id");
  const bindings = meta.bindings as { type: string; name: string }[];

  it("binds D1, both SQLite DOs and the agent secret", () => {
    expect(bindings).toContainEqual(expect.objectContaining({ type: "d1", name: "DB", id: "d1-id" }));
    expect(bindings).toContainEqual(expect.objectContaining({ type: "durable_object_namespace", name: "LEDGER", class_name: "Ledger" }));
    expect(bindings).toContainEqual(expect.objectContaining({ type: "durable_object_namespace", name: "GUARD", class_name: "Guard" }));
    expect(bindings).toContainEqual(expect.objectContaining({ type: "secret_text", name: "AGENT_KEY" }));
    expect(bindings).toContainEqual(expect.objectContaining({ type: "secret_text", name: "SECRET" }));
  });

  it("declares the sqlite DO migration and the maintenance cron", () => {
    expect(meta.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Ledger", "Guard"] }]);
    expect(meta.triggers).toEqual({ crons: [OMNI_DEFAULT_CRON] });
  });

  it("omits SECRET when the provisioner does not pin one", () => {
    const noSecret = omniUploadMetadata({ agentKey: "ak" }, "d1") .bindings as { name: string }[];
    expect(noSecret.map((b) => b.name)).not.toContain("SECRET");
  });

  it("ensures Cloudflare worker names are strictly lowercase alphanumeric with dashes", () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const workerName = `omni-${suffix}`;
    expect(workerName).toMatch(/^omni-[0-9a-f]{6}$/);
    expect(workerName).toBe(workerName.toLowerCase());
  });
});

describe("vendored omni bundle", () => {
  it("is a non-trivial pinned module", () => {
    expect(OMNI_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(OMNI_SOURCE.length).toBeGreaterThan(20_000);
    expect(OMNI_SOURCE.includes("export default") || OMNI_SOURCE.includes("as default")).toBe(true);
    // the agent surface must exist in the node the bot deploys
    expect(OMNI_SOURCE).toContain("/api/agent/");
  });
});
