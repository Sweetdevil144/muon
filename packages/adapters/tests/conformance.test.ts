import { describe, expect, it } from "vitest";
import type { LaneCapabilities } from "@muon/protocol";
import { BaseLaneAdapter } from "../src/base-lane-adapter.js";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import { CodexAdapter } from "../src/codex-adapter.js";
import { CursorAdapter } from "../src/cursor-adapter.js";
import { OpencodeAdapter } from "../src/opencode-adapter.js";
import { createDefaultAdapters } from "../src/registry.js";

const REQUIRED_CAPABILITY_KEYS: (keyof LaneCapabilities)[] = [
  "canStreamEvents",
  "canInterrupt",
  "canBackground",
  "supportsApprovals",
  "supportsWorktrees",
];

/**
 * Conformance suite (ROADMAP Phase 5): every lane adapter must satisfy the
 * protocol contract without a real vendor binary installed. Capabilities are
 * declared explicitly, "unsupported" must be a visible false, never an
 * undefined surprise at runtime.
 *
 * HERMETIC: two lanes probe something real in `health()` — Cursor spawns the
 * vendor's own auth command — so the contract
 * loop runs against explicitly-stubbed instances. The stub list is drift-locked
 * against the real registry below, so a newly registered lane cannot quietly
 * skip conformance.
 */
const hermeticAdapters: BaseLaneAdapter[] = [
  new ClaudeAdapter(),
  new CodexAdapter(),
  new CursorAdapter({ probeAuth: async () => ({ authenticated: false }) }),
  new OpencodeAdapter({ probeAuth: async () => ({ authenticated: false }) }),
];

describe("lane adapter conformance", () => {
  const adapters = createDefaultAdapters() as BaseLaneAdapter[];

  it("registers the dispatch-ready lanes exactly once", () => {
    const ids = adapters.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["claude-code", "codex", "cursor", "opencode"]);
  });

  it("runs the contract loop over every registered lane", () => {
    expect(hermeticAdapters.map((adapter) => adapter.id)).toEqual(
      adapters.map((adapter) => adapter.id)
    );
  });

  for (const adapter of hermeticAdapters) {
    describe(adapter.id, () => {
      it("declares identity and role", () => {
        expect(adapter.displayName.length).toBeGreaterThan(0);
        expect(adapter.provider.length).toBeGreaterThan(0);
        expect(["peer", "worker"]).toContain(adapter.role);
      });

      it("pins concrete command candidates", () => {
        expect(adapter.commandCandidates.length).toBeGreaterThan(0);
        for (const candidate of adapter.commandCandidates) {
          expect(candidate).toMatch(/^[a-z][a-z0-9-]*$/);
        }
      });

      it("declares every capability explicitly", async () => {
        const capabilities = await adapter.capabilities();
        for (const key of REQUIRED_CAPABILITY_KEYS) {
          expect(typeof capabilities[key]).toBe("boolean");
        }
      });

      it("maps a brief to the vendor's non-interactive invocation", () => {
        const invocation = adapter.taskCommand("fix the failing test");
        expect(adapter.commandCandidates).toContain(invocation.command);
        expect(invocation.args.join(" ")).toContain("fix the failing test");
      });

      it("reports health without throwing when the binary is missing", async () => {
        const health = await adapter.health();
        expect(["healthy", "degraded", "unavailable"]).toContain(health.status);
        expect(health.details.length).toBeGreaterThan(0);
      });

      it("fails fast with an actionable error when running without the binary", async () => {
        // Point the invocation at a binary that cannot exist so the test
        // never depends on (or spawns) a real vendor CLI.
        const clone = Object.create(adapter) as BaseLaneAdapter;
        clone.taskCommand = () => ({
          command: "definitely-not-a-real-binary",
          args: ["x"],
        });

        await expect(
          clone.runTask({ taskId: "task-1", brief: "noop" }, () => undefined)
        ).rejects.toThrow(/not available|Install/);
      });
    });
  }
});
