import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import { createDefaultAdapters } from "../src/registry.js";
import {
  FAKE_ARTIFACT_FILENAME,
  FAKE_MEMORY_SENTINEL,
  FAKE_VENDOR_KEY,
  FakeLaneAdapter,
  clearFakeInvocations,
  fakeVendorEnabled,
  lastFakeInvocation,
} from "../src/fake-lane-adapter.js";
import { emptyLaneProfile } from "@muon/protocol";

describe("fake vendor seam (dev/test only)", () => {
  const originalEnv = process.env.MUON_FAKE_VENDOR;
  const originalDescendantFile =
    process.env.MUON_FAKE_VENDOR_DESCENDANT_FILE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MUON_FAKE_VENDOR;
    else process.env.MUON_FAKE_VENDOR = originalEnv;
    if (originalDescendantFile === undefined) {
      delete process.env.MUON_FAKE_VENDOR_DESCENDANT_FILE;
    } else {
      process.env.MUON_FAKE_VENDOR_DESCENDANT_FILE =
        originalDescendantFile;
    }
  });

  it("is NOT registered by default (production dispatch can't reach it)", () => {
    delete process.env.MUON_FAKE_VENDOR;
    expect(fakeVendorEnabled()).toBe(false);
    expect(createDefaultAdapters().map((a) => a.id)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
    ]);
  });

  it("is registered ONLY when MUON_FAKE_VENDOR=1", () => {
    process.env.MUON_FAKE_VENDOR = "1";
    expect(fakeVendorEnabled()).toBe(true);
    expect(createDefaultAdapters().map((a) => a.id)).toContain(FAKE_VENDOR_KEY);
  });

  it("runs deterministically: additive edit + stream events + terminal exit-0", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
    try {
      const adapter = new FakeLaneAdapter();
      const events: LaneEvent[] = [];
      const result = await adapter.runTask(
        { taskId: "task-xyz", brief: "make the additive edit" },
        (event) => events.push(event),
        { cwd }
      );

      // Terminal completed / exit-0.
      expect(result.exitCode).toBe(0);
      expect(result.errorOutput).toBe("");

      // A couple of StreamChunk-bearing events including a terminal one.
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("task.started");
      expect(kinds).toContain("task.progress");
      expect(kinds).toContain("task.completed");
      expect(events.length).toBeGreaterThanOrEqual(3);

      // The additive workspace edit exists with the deterministic marker + task id.
      const artifact = path.join(cwd, FAKE_ARTIFACT_FILENAME);
      const contents = readFileSync(artifact, "utf8");
      expect(contents).toContain("task-xyz");
      expect(contents).toContain(FAKE_MEMORY_SENTINEL);

      // The review-capture signal is present in the output (VERDICT: CONCERNS).
      expect(result.output).toMatch(/VERDICT:\s*CONCERNS/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appends (never clobbers) on a repeat run, the edit is strictly additive", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
    try {
      const adapter = new FakeLaneAdapter();
      await adapter.runTask({ taskId: "first", brief: "a" }, () => undefined, { cwd });
      await adapter.runTask({ taskId: "second", brief: "b" }, () => undefined, { cwd });
      const contents = readFileSync(path.join(cwd, FAKE_ARTIFACT_FILENAME), "utf8");
      expect(contents).toContain("first");
      expect(contents).toContain("second");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("can leave a test-only descendant for packaged process-tree cleanup proofs", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
    const pidFile = path.join(cwd, "descendant.pid");
    let descendantPid: number | undefined;
    process.env.MUON_FAKE_VENDOR = "1";
    process.env.MUON_FAKE_VENDOR_DESCENDANT_FILE = pidFile;
    try {
      const adapter = new FakeLaneAdapter();
      await adapter.runTask(
        { taskId: "descendant", brief: "spawn cleanup proof" },
        () => undefined,
        { cwd }
      );
      descendantPid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── ADR-0013 v2, the resolved dispatch inputs reach the (simulated) spawn ────
  describe("captures the invocation that would reach spawn (ADR-0013 v2)", () => {
    beforeEach(() => clearFakeInvocations());

    it("a resolved subcommand argvOverride reaches the fake's captured command", async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
      try {
        const adapter = new FakeLaneAdapter();
        // Exactly what `resolveVendorAction("claude-code","ultrareview",…)` yields.
        await adapter.runTask({ taskId: "uv", brief: "unused" }, () => undefined, {
          cwd,
          argvOverride: { command: "claude", args: ["ultrareview", "src/app.ts", "--json"] },
        });
        const captured = lastFakeInvocation();
        expect(captured?.command).toBe("claude");
        expect(captured?.args).toEqual(["ultrareview", "src/app.ts", "--json"]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("even if FORCED, the spawned argv contains NO --strict-mcp-config (backstop)", async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
      try {
        const adapter = new FakeLaneAdapter();
        // Force the guarded flag two ways: via the argv override AND via extraArgs.
        await adapter.runTask({ taskId: "sm", brief: "x" }, () => undefined, {
          cwd,
          argvOverride: { args: ["ultrareview", "--strict-mcp-config"] },
          profile: { ...emptyLaneProfile, extraArgs: ["--strict-mcp-config=1", "--keep"] },
        });
        const captured = lastFakeInvocation();
        expect(captured?.args.some((a) => a.startsWith("--strict-mcp-config"))).toBe(false);
        // A benign flag survives, only the governed-brain evictor is stripped.
        expect(captured?.args).toContain("--keep");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("records the merged profile so a full-auto patch is observable", async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "muon-fake-adapter-"));
      try {
        const adapter = new FakeLaneAdapter();
        await adapter.runTask({ taskId: "fa", brief: "x" }, () => undefined, {
          cwd,
          profile: { ...emptyLaneProfile, permissionMode: "full-auto" },
        });
        expect(lastFakeInvocation()?.profile?.permissionMode).toBe("full-auto");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
