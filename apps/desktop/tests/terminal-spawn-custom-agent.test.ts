import { afterEach, describe, expect, it } from "vitest";
import type { UngovernedAgentEntry } from "@muon/client";
import { UNGOVERNED_AUTHORITY } from "@muon/client";
import {
  resolveTerminalSpawn,
  setCustomAgentLookup,
  TERMINAL_KINDS,
} from "../src/lib/terminal-spawn.js";

/**
 * ROADMAP P7 — custom (ungoverned) agent spawn resolution.
 *
 * The invariant under test: `resolveTerminalSpawn` treats a `custom:<id>`
 * kind exactly like every other kind from the RENDERER's point of view (an
 * opaque string), but resolves `command`/`args` from the HOST's own read of
 * the persisted registry — never from the caller — and applies a STRICTER env
 * strip than a vendor shell.
 */
function entry(overrides: Partial<UngovernedAgentEntry> = {}): UngovernedAgentEntry {
  return {
    id: "custom:demo-agent",
    slug: "demo-agent",
    displayName: "Demo Agent",
    shortLabel: "Demo",
    iconKey: "custom-agent",
    command: "demo-agent-bin",
    args: ["--flag", "value"],
    createdAt: new Date().toISOString(),
    authority: UNGOVERNED_AUTHORITY,
    ...overrides,
  };
}

afterEach(() => {
  setCustomAgentLookup(null);
});

describe("resolveTerminalSpawn — custom agents", () => {
  it("resolves command/args from the HOST's lookup, never from the kind string alone", () => {
    setCustomAgentLookup((id) => (id === "custom:demo-agent" ? entry() : null));
    const spawn = resolveTerminalSpawn("custom:demo-agent", "/wt");
    expect(spawn.file).toBe("demo-agent-bin");
    expect(spawn.args).toEqual(["--flag", "value"]);
    expect(spawn.cwd).toBe("/wt");
  });

  it("refuses an unregistered custom agent id (host resolves, never trusts the kind alone)", () => {
    setCustomAgentLookup(() => null);
    expect(() => resolveTerminalSpawn("custom:missing", "/wt")).toThrow(
      /not a registered custom agent/
    );
  });

  it("refuses resume/fork outright — no session driver, ever", () => {
    setCustomAgentLookup(() => entry());
    expect(() =>
      resolveTerminalSpawn("custom:demo-agent", "/wt", {}, {
        vendor: "custom:demo-agent",
        sessionId: "019fa043-e5c2-7731-b2f3-11312f91d2d2",
        mode: "resume",
      })
    ).toThrow(/no resumable\/forkable session/);
  });

  it("strips EVERY MUON_-prefixed var, stricter than the vendor shell path", () => {
    setCustomAgentLookup(() => entry());
    const previousToken = process.env.MUON_OPERATOR_TOKEN;
    const previousNovel = process.env.MUON_SOME_FUTURE_NAME;
    process.env.MUON_OPERATOR_TOKEN = "secret-token";
    // A name that is NOT on the named vendor strip list and does not end in
    // `_TOKEN` — the vendor path's pattern backstop would NOT catch this, but
    // the custom-agent path's blanket `MUON_` strip must.
    process.env.MUON_SOME_FUTURE_NAME = "still-muon-owned";
    try {
      const spawn = resolveTerminalSpawn("custom:demo-agent", "/wt");
      expect(spawn.env?.MUON_OPERATOR_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_SOME_FUTURE_NAME).toBeUndefined();
    } finally {
      if (previousToken === undefined) delete process.env.MUON_OPERATOR_TOKEN;
      else process.env.MUON_OPERATOR_TOKEN = previousToken;
      if (previousNovel === undefined) delete process.env.MUON_SOME_FUTURE_NAME;
      else process.env.MUON_SOME_FUTURE_NAME = previousNovel;
    }
  });

  it("strips GitHub tokens, same as a vendor (non-shell) terminal", () => {
    setCustomAgentLookup(() => entry());
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-secret";
    try {
      const spawn = resolveTerminalSpawn("custom:demo-agent", "/wt");
      expect(spawn.env?.GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it("still forwards ordinary ambient env (BYO-auth posture preserved)", () => {
    setCustomAgentLookup(() => entry());
    const previous = process.env.MUON_TEST_AMBIENT_VAR;
    process.env.PATH_LIKE_TEST_VAR = "/usr/local/bin";
    try {
      const spawn = resolveTerminalSpawn("custom:demo-agent", "/wt");
      expect(spawn.env?.PATH_LIKE_TEST_VAR).toBe("/usr/local/bin");
    } finally {
      delete process.env.PATH_LIKE_TEST_VAR;
      if (previous !== undefined) process.env.MUON_TEST_AMBIENT_VAR = previous;
    }
  });

  it("never appears in the static TERMINAL_KINDS allowlist (it is resolved dynamically, not statically)", () => {
    // Custom agent ids are runtime data, not a compile-time vendor/shell kind
    // — TERMINAL_KINDS stays exactly {vendors with terminalTakeover, shell}.
    for (const kind of TERMINAL_KINDS) {
      expect(kind.startsWith("custom:")).toBe(false);
    }
  });

  it("applies cols/rows overrides identically to the vendor path", () => {
    setCustomAgentLookup(() => entry());
    const spawn = resolveTerminalSpawn("custom:demo-agent", "/wt", {
      cols: 120,
      rows: 40,
    });
    expect(spawn.cols).toBe(120);
    expect(spawn.rows).toBe(40);
  });
});
