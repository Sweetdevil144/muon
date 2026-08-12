import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { dispatchVendorAction } from "../src/commands/run.js";

// ADR-0013 #52 v2, `muon run --action <action> [--vendor v] [--action-arg a…]
// [target]` posts the dispatch with the vendor-action fields; the backend ROUTE
// re-resolves + enforces the guards. These tests drive the exported helper with
// a stub client (no commander, no network) and assert the posted body.

function stubClient() {
  const enqueueDispatch = vi.fn().mockResolvedValue({ id: "job-x" });
  return { client: { enqueueDispatch } as unknown as MuonApiClient, enqueueDispatch };
}

describe("dispatchVendorAction", () => {
  it("`--action ultrareview claude src/app.ts` posts the resolved action fields", async () => {
    const { client, enqueueDispatch } = stubClient();
    await dispatchVendorAction(client, {
      action: "ultrareview",
      actionArgs: [],
      positionals: ["claude", "src/app.ts"], // [vendor] [target]
      egressOptIn: false,
      json: false,
    });
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "oneshot",
        vendor: "claude-code",
        action: "ultrareview",
        actionVendor: "claude-code",
        target: "src/app.ts",
      })
    );
  });

  it("carries --action-arg values and honors an explicit --vendor", async () => {
    const { client, enqueueDispatch } = stubClient();
    await dispatchVendorAction(client, {
      action: "model",
      vendor: "codex",
      actionArgs: ["opus-4.8"],
      positionals: [],
      egressOptIn: false,
      json: false,
    });
    expect(enqueueDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "codex",
        action: "model",
        actionVendor: "codex",
        actionArgs: ["opus-4.8"],
      })
    );
  });

  it("fails fast (never posts) on a '-'-prefixed ultrareview target", async () => {
    const { client, enqueueDispatch } = stubClient();
    await expect(
      dispatchVendorAction(client, {
        action: "ultrareview",
        positionals: ["claude", "--evil"],
        actionArgs: [],
        egressOptIn: false,
        json: false,
      })
    ).rejects.toThrow(/path\/ref, not a flag|not available/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("rejects an unknown vendor token", async () => {
    const { client, enqueueDispatch } = stubClient();
    await expect(
      dispatchVendorAction(client, {
        action: "model",
        positionals: ["not-a-vendor", "x"],
        actionArgs: [],
        egressOptIn: false,
        json: false,
      })
    ).rejects.toThrow(/unknown vendor/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });

  it("rejects opencode while its action set is empty (same fact as the route)", async () => {
    // normalizeVendorAlias("opencode") resolves, but actions: [] means the CLI
    // must refuse here — not wait for resolveVendorAction after TODO 3.4 lands.
    const { client, enqueueDispatch } = stubClient();
    await expect(
      dispatchVendorAction(client, {
        action: "model",
        positionals: ["opencode", "x"],
        actionArgs: [],
        egressOptIn: false,
        json: false,
      })
    ).rejects.toThrow(/unknown vendor 'opencode'/i);
    expect(enqueueDispatch).not.toHaveBeenCalled();
  });
});
