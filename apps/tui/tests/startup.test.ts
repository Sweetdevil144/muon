import { describe, expect, it, vi } from "vitest";
import type { EnsureBrainResult } from "@muon/client/ensure-brain";
import { resolveStartupTarget } from "../src/lib/startup.js";

const makeEnsure = (result: EnsureBrainResult) => vi.fn(async () => result);
const resolveDataDir = () => "/data/MUON";
// A flag value wins; otherwise fall back to a loopback base (auto-discovery).
const resolveApiBase = (cliValue?: string) =>
  cliValue?.trim() ? cliValue.replace(/\/$/, "") : "http://127.0.0.1:41000";

describe("resolveStartupTarget (TUI mirror of the CLI preAction)", () => {
  it("with NO explicit base, invokes ensureBrain and marks the target re-resolvable", async () => {
    const ensureBrain = makeEnsure({
      live: true,
      started: true,
      base: "http://127.0.0.1:41000",
      dataDir: "/data/MUON",
    });

    const plan = await resolveStartupTarget({
      env: {},
      ensureBrain,
      resolveApiBase,
      resolveDataDir,
    });

    expect(ensureBrain).toHaveBeenCalledTimes(1);
    expect(plan.target.source).toBe("spawned");
    expect(plan.reresolvable).toBe(true);
    expect(plan.note).toBeUndefined();
  });

  it("labels an already-running brain as 'lockfile'", async () => {
    const ensureBrain = makeEnsure({
      live: true,
      started: false,
      base: "http://127.0.0.1:41000",
      dataDir: "/data/MUON",
    });

    const plan = await resolveStartupTarget({
      env: {},
      ensureBrain,
      resolveApiBase,
      resolveDataDir,
    });

    expect(plan.target.source).toBe("lockfile");
    expect(plan.reresolvable).toBe(true);
  });

  it("still boots (source 'default') and forwards the note when ensureBrain fails", async () => {
    const ensureBrain = makeEnsure({
      live: false,
      started: true,
      dataDir: "/data/MUON",
      note: "started the brain but it did not report healthy within 15s (lockfile: /data/MUON/brain.lock)",
    });

    const plan = await resolveStartupTarget({
      env: {},
      ensureBrain,
      resolveApiBase,
      resolveDataDir,
    });

    expect(plan.target.source).toBe("default");
    expect(plan.note).toContain("lockfile:");
    expect(plan.reresolvable).toBe(true);
  });

  it("with an explicit --api-base flag, NEVER invokes ensureBrain (F1 no-hijack)", async () => {
    const ensureBrain = makeEnsure({
      live: true,
      started: true,
      dataDir: "/data/MUON",
    });

    const plan = await resolveStartupTarget({
      apiBase: "https://remote.example:4000",
      env: {},
      ensureBrain,
      resolveApiBase,
      resolveDataDir,
    });

    expect(ensureBrain).not.toHaveBeenCalled();
    expect(plan.target.source).toBe("flag");
    expect(plan.target.base).toBe("https://remote.example:4000");
    expect(plan.reresolvable).toBe(false);
  });

  it("with MUON_API_BASE in the environment, NEVER invokes ensureBrain (source 'env')", async () => {
    const ensureBrain = makeEnsure({
      live: true,
      started: true,
      dataDir: "/data/MUON",
    });

    const plan = await resolveStartupTarget({
      env: { MUON_API_BASE: "http://192.168.1.9:4000" },
      ensureBrain,
      // resolveApiBase reads the env base when no cli value is given.
      resolveApiBase: (cliValue?: string) =>
        cliValue?.trim() ? cliValue : "http://192.168.1.9:4000",
      resolveDataDir,
    });

    expect(ensureBrain).not.toHaveBeenCalled();
    expect(plan.target.source).toBe("env");
    expect(plan.reresolvable).toBe(false);
  });
});
