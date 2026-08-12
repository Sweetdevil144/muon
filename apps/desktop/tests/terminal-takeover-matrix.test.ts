import { describe, expect, it } from "vitest";
import {
  VENDOR_IDS,
  VENDOR_REGISTRY,
  terminalTakeoverVendorIds,
  type VendorId,
} from "@muon/client/vendors";
import {
  TERMINAL_KINDS,
  resolveTerminalSpawn,
} from "../src/lib/terminal-spawn.js";

/**
 * The terminal-takeover matrix (ADR-0022 G6).
 *
 * `resolveTerminalSpawn` is a renderer-DRIVEN binary spawn, and the renderer is
 * untrusted (prompt injection from repo files). The only thing standing between
 * "the renderer names a kind" and "a process starts" is this allowlist, so the
 * question "which vendors may be spawned into a pty" needs the same two
 * independent statements every other authority surface has: the registry's
 * `authority.terminalTakeover`, and the hand-written table below.
 *
 * Written BEFORE Wave C5 re-pointed `TERMINAL_COMMANDS` at the registry, and
 * green against the hand-written table first, so the refactor cannot widen the
 * spawnable set without failing here.
 */
const EXPECTED_VENDOR_TERMINALS: Record<
  VendorId,
  { file: string; args: readonly string[] } | null
> = {
  "claude-code": { file: "claude", args: [] },
  codex: { file: "codex", args: [] },
  cursor: { file: "cursor-agent", args: [] },
  // Was `null` while `opencode` was also an attach-namespace label (ADR-0022
  // §8) — the id in two keyspaces could have merged them. Wave F removed it
  // from the attach table, the drift-lock now pins the keyspaces disjoint,
  // and bare `opencode` is the interactive TUI (live-verified 1.18.5).
  opencode: { file: "opencode", args: [] },
  fake: null,
};

/** The one non-vendor kind. A plain terminal is the operator's own shell. */
const NON_VENDOR_KINDS = ["shell"] as const;

describe("terminal takeover matrix — completeness", () => {
  it("the hand-written table covers exactly the registry's vendors", () => {
    expect(Object.keys(EXPECTED_VENDOR_TERMINALS).sort()).toEqual(
      [...VENDOR_IDS].sort()
    );
  });

  it("agrees with the registry's authority.terminalTakeover column", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDOR_REGISTRY[id].authority.terminalTakeover).toBe(
        EXPECTED_VENDOR_TERMINALS[id] !== null
      );
    }
    expect([...terminalTakeoverVendorIds()].sort()).toEqual(
      VENDOR_IDS.filter((id) => EXPECTED_VENDOR_TERMINALS[id] !== null).sort()
    );
  });
});

describe("terminal takeover matrix — what the renderer may start", () => {
  it("exposes exactly the takeover-authorized vendors plus the shell", () => {
    expect([...TERMINAL_KINDS].sort()).toEqual(
      [
        ...VENDOR_IDS.filter((id) => EXPECTED_VENDOR_TERMINALS[id] !== null),
        ...NON_VENDOR_KINDS,
      ].sort()
    );
  });

  for (const id of VENDOR_IDS) {
    const expected = EXPECTED_VENDOR_TERMINALS[id];
    if (expected) {
      it(`${id} spawns its fixed host-resolved command`, () => {
        const spawn = resolveTerminalSpawn(id, "/repo");
        expect(spawn.file).toBe(expected.file);
        expect(spawn.args).toEqual([...expected.args]);
      });
    } else {
      it(`${id} is REFUSED a pty`, () => {
        expect(() => resolveTerminalSpawn(id, "/repo")).toThrow(/not allowed/);
      });
    }
  }

  it("an unregistered vendor id is refused a pty", () => {
    expect(() => resolveTerminalSpawn("kiro", "/repo")).toThrow(/not allowed/);
  });
});

describe("terminal takeover matrix — spawnable, never merely installed", () => {
  it("every terminal binary is a SPAWNABLE candidate for its vendor", () => {
    // The cursor trap, and the reason ADR-0022 §6.7 keeps `commandCandidates`
    // and `readiness.installedCandidates` as two fields: the bare `cursor` IDE
    // launcher counts as INSTALLED but must never be spawned for a dispatch. A
    // terminal command sourced from the readiness list would spawn the IDE.
    for (const id of VENDOR_IDS) {
      const expected = EXPECTED_VENDOR_TERMINALS[id];
      if (!expected) continue;
      expect(VENDOR_REGISTRY[id].execution.commandCandidates).toContain(
        expected.file
      );
    }
  });

  it("cursor's terminal is the agent CLI and not the IDE launcher", () => {
    expect(EXPECTED_VENDOR_TERMINALS.cursor?.file).toBe("cursor-agent");
    expect(VENDOR_REGISTRY.cursor.readiness.installedCandidates).toContain(
      "cursor"
    );
    expect(VENDOR_REGISTRY.cursor.execution.commandCandidates).not.toContain(
      "cursor"
    );
  });
});
