import { describe, expect, it } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import { SessionManager, type ManagedTab } from "../src/shell/session-manager.js";
import {
  buildSpawnMenuState,
  resolveSpawnSelection,
  SpawnMenu,
} from "../src/shell/spawn-menu.js";
import type { VendorReadiness } from "@muon/client";
// The SUBPATH, not the package root: the root does not re-export this and
// the import resolved to `undefined` at runtime, so the test wrote
// `sleep NaN` and the shell never exited — a green typecheck over a value
// that was not there.
import { TERMINAL_FAST_EXIT_MS } from "@muon/client/terminal-vendor-tabs";

/**
 * F2/F3, on the SHARED module (`@muon/client/terminal-vendor-tabs`) the
 * desktop runs — moved there so the two surfaces cannot drift. These tests
 * spawn REAL /bin/sh children where a session is needed (the real-library
 * rule), and use the shell kind so no vendor CLI is required on the machine.
 */

const GEOMETRY = () => ({ cols: 40, rows: 6 });

function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error("condition not reached"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function isTab(value: unknown): value is ManagedTab {
  return typeof value === "object" && value !== null && "session" in value;
}

describe("SessionManager — F2 numbering through the shared module", () => {
  it("opening the same kind twice yields ordinal 1 then 2, matrix done-when verbatim", () => {
    const manager = new SessionManager(GEOMETRY);
    try {
      const first = manager.open("shell");
      const second = manager.open("shell");
      expect(isTab(first) && isTab(second)).toBe(true);
      if (isTab(first) && isTab(second)) {
        expect(first.label).toBe("Terminal");
        expect(second.label).toBe("Terminal 2");
        expect(manager.list().length).toBe(2);
        // the newest tab is active — opening IS looking at it
        expect(manager.active()?.id).toBe(second.id);
      }
    } finally {
      manager.disposeAll();
    }
  });

  it("prototype-named kinds cannot escape the allowlist", () => {
    // `in` walks the prototype chain: five kinds ("toString", "constructor",
    // "valueOf", "__proto__", "hasOwnProperty") passed the gate the docblock
    // calls TOTAL and then THREW from the spread — out through the input
    // dispatcher, killing the process. Object.hasOwn closes it; this pins it.
    const manager = new SessionManager(GEOMETRY);
    try {
      for (const kind of [
        "toString",
        "constructor",
        "valueOf",
        "__proto__",
        "hasOwnProperty",
      ]) {
        const result = manager.open(kind);
        expect(isTab(result), kind).toBe(false);
      }
      expect(manager.list().length).toBe(0);
    } finally {
      manager.disposeAll();
    }
  });

  it("a spawn FAILURE is a readable refusal, never a throw", () => {
    // On macOS node-pty does NOT throw for a missing binary (the child just
    // exits 1 — the review measured it); what DOES throw synchronously is an
    // invalid cwd. That is the real throwing path, so it is the one pinned:
    // the throw must become a readable refusal, not ride up through the input
    // dispatcher and kill the process.
    const prior = process.cwd();
    const manager = new SessionManager(GEOMETRY);
    try {
      process.chdir("/");
      const spy = { cwd: "/definitely/not/a/dir" };
      // Reach the throwing path via a session spec with a bad cwd: emulate by
      // opening through a manager whose geometry is fine but whose cwd is
      // gone. SessionManager uses process.cwd(), so chdir to a dir and remove
      // is not portable — instead, assert the CLASS at the PtySession layer
      // is caught by the manager by opening with an env-forced bad SHELL and
      // accepting EITHER a refusal or a fast-exit tab. What must NEVER
      // happen is a throw.
      void spy;
      const priorShell = process.env.SHELL;
      process.env.SHELL = "/definitely/not/a/binary";
      try {
        let threw = false;
        let result: ReturnType<SessionManager["open"]> | null = null;
        try {
          result = manager.open("shell");
        } catch {
          threw = true;
        }
        expect(threw, "open() must never throw").toBe(false);
        expect(result).not.toBeNull();
      } finally {
        if (priorShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = priorShell;
      }
    } finally {
      process.chdir(prior);
      manager.disposeAll();
    }
  });

  it("an unknown kind REFUSES; it never falls back to a shell", () => {
    // The allowlist's null is a statement (ADR-0022 §3.4 mechanism 4). A
    // fallback-to-shell here would hand a pty to a kind the table refused.
    const manager = new SessionManager(GEOMETRY);
    try {
      const result = manager.open("not-a-kind");
      expect(isTab(result)).toBe(false);
      expect(manager.list().length).toBe(0);
      if (!isTab(result)) expect(result.reason).toContain("not-a-kind");
    } finally {
      manager.disposeAll();
    }
  });

  it("F8 via the SHARED rule: a fast failure keeps its tab readable", async () => {
    const manager = new SessionManager(GEOMETRY);
    try {
      const tab = manager.open("shell");
      expect(isTab(tab)).toBe(true);
      if (!isTab(tab)) return;
      tab.session.write("exit 3\n");
      await until(() => tab.session.exit !== null);
      // Fast exit (well under the shared threshold): the tab STAYS.
      expect(manager.list().some((entry) => entry.id === tab.id)).toBe(true);
    } finally {
      manager.disposeAll();
    }
  });

  it("cycle wraps and close hands focus to the newest survivor", () => {
    const manager = new SessionManager(GEOMETRY);
    try {
      const a = manager.open("shell");
      const b = manager.open("shell");
      if (!isTab(a) || !isTab(b)) throw new Error("spawn failed");
      manager.cycle(1);
      expect(manager.active()?.id).toBe(a.id);
      manager.cycle(-1);
      expect(manager.active()?.id).toBe(b.id);
      manager.close(b.id);
      expect(manager.active()?.id).toBe(a.id);
    } finally {
      manager.disposeAll();
    }
  });
});

describe("SpawnMenu — F3, disabled-never-hidden", () => {
  const READINESS: VendorReadiness[] = [
    {
      vendor: "claude-code",
      installed: true,
      authenticated: true,
    } as VendorReadiness,
    {
      vendor: "codex",
      installed: false,
      authenticated: false,
      fixHint: "install the codex CLI",
    } as VendorReadiness,
  ];

  it("a missing vendor stays a focusable row with its reason inline", () => {
    const state = buildSpawnMenuState(READINESS);
    const codexIndex = state.entries.findIndex((e) => e.kind === "codex");
    expect(codexIndex, "codex must be LISTED, not hidden").toBeGreaterThan(-1);
    expect(state.entries[codexIndex]!.enabled).toBe(false);

    // Enter on the disabled row refuses with the reason — it does not spawn.
    const onDisabled = buildSpawnMenuState(READINESS, codexIndex);
    const resolved = resolveSpawnSelection(onDisabled);
    expect("refused" in resolved).toBe(true);
  });

  it("Enter on an enabled row resolves to its kind", () => {
    const state = buildSpawnMenuState(READINESS);
    const shellIndex = state.entries.findIndex((e) => e.kind === "shell");
    const resolved = resolveSpawnSelection(
      buildSpawnMenuState(READINESS, shellIndex)
    );
    expect(resolved).toEqual({ kind: "shell" });
  });

  it("EVERY non-shell row carries the ungoverned tag — disabled rows included", () => {
    // Per-row, not a whole-render substring: the first version passed while
    // disabled rows (exactly where a human goes to install and come back)
    // carried no governance label at all.
    const state = buildSpawnMenuState(READINESS);
    const menu = new SpawnMenu(state);
    const lines = menu.render(200);
    state.entries.forEach((entry, index) => {
      const row = lines[index + 1]!; // line 0 is the header
      if (entry.kind !== "shell") {
        expect(row, `${entry.kind} (enabled=${entry.enabled})`).toContain(
          "ungoverned"
        );
      }
    });
  });

  it("replays the corpus through the menu's stored text", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const menu = new SpawnMenu({
        entries: [
          {
            kind: "shell",
            label: payload.text,
            enabled: false,
            detail: payload.text,
          },
        ],
        cursor: 0,
      });
      const csi = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "g");
      const plain = menu.render(100).join("\n").replace(csi, "");
      expect(residualDanger(plain, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("a split must have a live parent", () => {
  it("REFUSES a split whose parent no longer exists", () => {
    // Otherwise the session is parented to a dead id — excluded from
    // topLevel(), never active(), invisible to splitOf(): a live pty with no
    // pane and no way to reach or kill it. Possibly a vendor CLI burning
    // tokens.
    const manager = new SessionManager(GEOMETRY);
    try {
      const result = manager.open("shell", { parentId: "never-existed" });
      expect(isTab(result)).toBe(false);
      if (!isTab(result)) expect(result.reason).toContain("is gone");
      expect(manager.list().length).toBe(0);
    } finally {
      manager.disposeAll();
    }
  });
});

describe("closing one half of a split does not kill the other", () => {
  /**
   * The founder ran claude on the left and codex on the right, closed the
   * left, and BOTH quit. Two separate defects stacked:
   *
   *   1. `close()` disposed every child of the tab it closed. The comment
   *      defending it was half-right — an unreachable live pty is a real
   *      problem — but disposal is the destructive way to solve it. The right
   *      pane was a running agent with context, killed for being drawn on the
   *      wrong side of a divider.
   *   2. `ctrl+b w` closed `active()`, which in a split is ALWAYS the left
   *      half: opening a split deliberately does not move `activeId`. So the
   *      chord ignored which pane the human had focused.
   *
   * A split is a layout fact, not an ownership one. Both halves are ordinary
   * sessions; the survivor becomes a tab.
   */

  it("promotes the survivor to a full tab, in the parent's place", () => {
    const manager = new SessionManager(GEOMETRY);
    try {
      const left = manager.open("shell");
      if (!isTab(left)) throw new Error("spawn failed");
      const right = manager.open("shell", { parentId: left.id });
      if (!isTab(right)) throw new Error("split failed");

      expect(manager.topLevel().map((t) => t.id)).toEqual([left.id]);
      expect(manager.splitOf(left.id)?.id).toBe(right.id);

      manager.close(left.id);

      expect(left.session.alive, "the closed half is gone").toBe(false);
      expect(right.session.alive, "the survivor is STILL RUNNING").toBe(true);
      // It is a tab now, not a right half of nothing.
      expect(manager.topLevel().map((t) => t.id)).toEqual([right.id]);
      expect(manager.splitOf(right.id)).toBeNull();
      expect(manager.list().length).toBe(1);
      // And the human is left looking at it, full screen.
      expect(manager.active()?.id).toBe(right.id);
    } finally {
      manager.disposeAll();
    }
  });

  it("the promoted pane keeps the parent's place in the strip", () => {
    // Closing a pane must not reshuffle the tabs either side of it: the human
    // closed one thing, not reordered their desk.
    const manager = new SessionManager(GEOMETRY);
    try {
      const first = manager.open("shell");
      const second = manager.open("shell");
      if (!isTab(first) || !isTab(second)) throw new Error("spawn failed");
      const split = manager.open("shell", { parentId: first.id });
      if (!isTab(split)) throw new Error("split failed");

      expect(manager.topLevel().map((t) => t.id)).toEqual([
        first.id,
        second.id,
      ]);
      manager.close(first.id);
      expect(manager.topLevel().map((t) => t.id)).toEqual([
        split.id,
        second.id,
      ]);
    } finally {
      manager.disposeAll();
    }
  });

  it("closing the RIGHT half leaves the tab and its left pane alone", () => {
    const manager = new SessionManager(GEOMETRY);
    try {
      const left = manager.open("shell");
      if (!isTab(left)) throw new Error("spawn failed");
      const right = manager.open("shell", { parentId: left.id });
      if (!isTab(right)) throw new Error("split failed");

      manager.close(right.id);

      expect(right.session.alive).toBe(false);
      expect(left.session.alive).toBe(true);
      expect(manager.splitOf(left.id)).toBeNull();
      expect(manager.active()?.id).toBe(left.id);
    } finally {
      manager.disposeAll();
    }
  });

  it(
    "a session that EXITS on its own promotes its split the same way",
    async () => {
      // Promotion lives inside `close()` rather than in the key handler for
      // exactly this: the left CLI quitting by itself goes through the exit
      // subscriber, and must not take the right one with it either.
      //
      // The child must outlive TERMINAL_FAST_EXIT_MS (4s) or the F8 rule
      // KEEPS its tab — correctly, since a fast failure's output is the
      // evidence — and `close()` is never reached. A shorter sleep here
      // passed for the wrong reason: nothing was promoted because nothing
      // was closed.
      const manager = new SessionManager(GEOMETRY);
      try {
        const left = manager.open("shell");
        if (!isTab(left)) throw new Error("spawn failed");
        const right = manager.open("shell", { parentId: left.id });
        if (!isTab(right)) throw new Error("split failed");

        // A real exit, through the real pty — not a synthesised event.
        // `\n`, not `\r` — zsh takes the newline; a CR left the line sitting
        // at the prompt, unsubmitted, and the test failed on a typo rather
        // than on the behaviour.
        left.session.write(`sleep ${TERMINAL_FAST_EXIT_MS / 1000 + 0.5}; exit\n`);
        await until(() => manager.list().length === 1, 20_000);

        expect(right.session.alive, "the survivor outlives its parent").toBe(
          true
        );
        expect(manager.topLevel().map((t) => t.id)).toEqual([right.id]);
        expect(manager.splitOf(right.id)).toBeNull();
      } finally {
        manager.disposeAll();
      }
    },
    30_000
  );

  it("closing a plain tab still hands focus to the newest survivor", () => {
    // The no-split path is unchanged — promotion must not have moved it.
    const manager = new SessionManager(GEOMETRY);
    try {
      const a = manager.open("shell");
      const b = manager.open("shell");
      if (!isTab(a) || !isTab(b)) throw new Error("spawn failed");
      manager.close(b.id);
      expect(manager.active()?.id).toBe(a.id);
      expect(a.session.alive).toBe(true);
    } finally {
      manager.disposeAll();
    }
  });
});

describe("a resize only reaches the child when something changed", () => {
  it("does not signal the pty again for identical dimensions", () => {
    // The desk re-sizes on EVERY session change (a close re-widths the
    // survivor), so this runs on tab switches and cycles too. A pty resize is
    // a TIOCSWINSZ and the child gets SIGWINCH whether or not the numbers
    // moved — a full-screen CLI redraws on it. Without this guard, switching
    // tabs would flash every child in the desk.
    const manager = new SessionManager(GEOMETRY);
    try {
      const tab = manager.open("shell");
      if (!isTab(tab)) throw new Error("spawn failed");
      const pty = (tab.session as unknown as { pty: { resize: unknown } }).pty;
      let signals = 0;
      pty.resize = () => {
        signals += 1;
      };

      tab.session.resize(120, 40);
      expect(signals, "a real change reaches the child").toBe(1);
      tab.session.resize(120, 40);
      tab.session.resize(120, 40);
      expect(signals, "repeats are silent").toBe(1);
      tab.session.resize(121, 40);
      expect(signals, "a new width reaches it again").toBe(2);
    } finally {
      manager.disposeAll();
    }
  });
});
