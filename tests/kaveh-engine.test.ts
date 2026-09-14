import { describe, expect, it } from "vitest";
import { KAVEH_DEFAULT_CRON, kavehUploadMetadata } from "../src/kaveh-engine";
import { KAVEH_SOURCE, KAVEH_SOURCE_SHA256 } from "../src/kaveh-source";

describe("kaveh upload metadata", () => {
  const meta = kavehUploadMetadata({ agentKey: "ak", signingSecret: "sk" }, "d1-id");
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
    expect(meta.triggers).toEqual({ crons: [KAVEH_DEFAULT_CRON] });
  });

  it("omits SECRET when the provisioner does not pin one", () => {
    const noSecret = kavehUploadMetadata({ agentKey: "ak" }, "d1") .bindings as { name: string }[];
    expect(noSecret.map((b) => b.name)).not.toContain("SECRET");
  });
});

describe("vendored kaveh bundle", () => {
  it("is a non-trivial pinned module", () => {
    expect(KAVEH_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(KAVEH_SOURCE.length).toBeGreaterThan(20_000);
    expect(KAVEH_SOURCE.includes("export default") || KAVEH_SOURCE.includes("as default")).toBe(true);
    // the agent surface must exist in the node the bot deploys
    expect(KAVEH_SOURCE).toContain("/api/agent/");
  });
});
