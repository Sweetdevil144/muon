import { describe, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN_ENV_VARS } from "@muon/adapters";
import { createNodePtyDriver } from "../src/lib/node-pty-driver.js";
import {
  resolveTerminalSpawn,
  TERMINAL_STRIPPED_ENV_VARS,
} from "../src/lib/terminal-spawn.js";

/** Set env names for the duration of `run`, restoring exactly what was there. */
function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const previous = new Map<string, string | undefined>(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function fakeNodePty() {
  const state = {
    writes: [] as string[],
    resizes: [] as Array<{ c: number; r: number }>,
    killed: undefined as string | undefined,
    paused: false,
  };
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const pty = {
    onData: (cb: (d: string) => void) => (dataCb = cb),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) =>
      (exitCb = cb),
    write: (d: string) => state.writes.push(d),
    resize: (c: number, r: number) => state.resizes.push({ c, r }),
    pause: () => (state.paused = true),
    resume: () => (state.paused = false),
    kill: (s?: string) => (state.killed = s ?? "SIGHUP"),
  };
  const nodePty = { spawn: vi.fn(() => pty) };
  return {
    nodePty,
    state,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (e: { exitCode: number; signal?: number }) => exitCb?.(e),
  };
}

describe("NodePtyDriver (Wave 4 / P5 — real vendor pty adapter)", () => {
  it("maps every PtyDriver op onto node-pty and forwards data/exit", () => {
    const { nodePty, state, emitData, emitExit } = fakeNodePty();
    const driver = createNodePtyDriver(nodePty as never, {
      file: "claude",
      args: ["--repl"],
      cwd: "/ws",
      cols: 100,
      rows: 30,
    });
    expect(nodePty.spawn).toHaveBeenCalledWith(
      "claude",
      ["--repl"],
      expect.objectContaining({ cwd: "/ws", cols: 100, rows: 30 })
    );

    const out: string[] = [];
    driver.onData((d) => out.push(d));
    emitData("hello");
    expect(out).toEqual(["hello"]);

    const exits: Array<{ exitCode: number; signal?: number }> = [];
    driver.onExit((e) => exits.push(e));
    emitExit({ exitCode: 0, signal: 9 });
    expect(exits).toEqual([{ exitCode: 0, signal: 9 }]);

    driver.write("ls\r");
    expect(state.writes).toEqual(["ls\r"]);
    driver.resize(80, 24);
    expect(state.resizes).toEqual([{ c: 80, r: 24 }]);
    driver.pause();
    expect(state.paused).toBe(true);
    driver.resume();
    expect(state.paused).toBe(false);
    driver.kill("SIGTERM");
    expect(state.killed).toBe("SIGTERM");
  });
});

describe("resolveTerminalSpawn (Wave 4 review finding 7 — host-side spawn)", () => {
  it("launches a fixed vendor command directly; renderer args/env are never used", () => {
    const spawn = resolveTerminalSpawn("codex", "/repo");
    expect(spawn.file).toBe("codex");
    expect(spawn.args).toEqual([]);
    expect(spawn.cwd).toBe("/repo");
    expect(spawn.env).toBeDefined(); // host env (BYO-auth), not renderer env
  });

  it("strips MUON control-plane capabilities from the child environment", () => {
    const previous = {
      api: process.env.MUON_API_TOKEN,
      agent: process.env.MUON_AGENT_TOKEN,
      delegation: process.env.MUON_DELEGATION_TOKEN,
      operator: process.env.MUON_OPERATOR_TOKEN,
      lease: process.env.MUON_RUNNER_LEASE_TOKEN,
      github: process.env.MUON_GITHUB_TOKEN,
      ambientGithub: process.env.GITHUB_TOKEN,
      ambientGh: process.env.GH_TOKEN,
      visible: process.env.MUON_TERMINAL_VISIBLE,
    };
    process.env.MUON_API_TOKEN = "operator-secret";
    process.env.MUON_AGENT_TOKEN = "agent-secret";
    process.env.MUON_DELEGATION_TOKEN = "delegation-secret";
    process.env.MUON_OPERATOR_TOKEN = "operator-secret-2";
    process.env.MUON_RUNNER_LEASE_TOKEN = "runner-lease-secret";
    process.env.MUON_GITHUB_TOKEN = "github-secret";
    process.env.GITHUB_TOKEN = "ambient-github-secret";
    process.env.GH_TOKEN = "ambient-gh-secret";
    process.env.MUON_TERMINAL_VISIBLE = "visible";
    try {
      const spawn = resolveTerminalSpawn("shell", "/repo");
      expect(spawn.env?.MUON_API_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_AGENT_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_DELEGATION_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_OPERATOR_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_RUNNER_LEASE_TOKEN).toBeUndefined();
      expect(spawn.env?.MUON_GITHUB_TOKEN).toBeUndefined();
      expect(spawn.env?.GITHUB_TOKEN).toBe("ambient-github-secret");
      expect(spawn.env?.GH_TOKEN).toBe("ambient-gh-secret");
      expect(spawn.env?.MUON_TERMINAL_VISIBLE).toBe("visible");

      const vendorSpawn = resolveTerminalSpawn("codex", "/repo");
      expect(vendorSpawn.env?.GITHUB_TOKEN).toBeUndefined();
      expect(vendorSpawn.env?.GH_TOKEN).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries({
        MUON_API_TOKEN: previous.api,
        MUON_AGENT_TOKEN: previous.agent,
        MUON_DELEGATION_TOKEN: previous.delegation,
        MUON_OPERATOR_TOKEN: previous.operator,
        MUON_RUNNER_LEASE_TOKEN: previous.lease,
        MUON_GITHUB_TOKEN: previous.github,
        GITHUB_TOKEN: previous.ambientGithub,
        GH_TOKEN: previous.ambientGh,
        MUON_TERMINAL_VISIBLE: previous.visible,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  /**
   * T5 — THE STRIPPED SET IS NAMED, NOT PATTERN-MATCHED.
   *
   * `hostEnv` used to strip `startsWith("MUON_") && endsWith("_TOKEN")` over
   * the whole of process.env and nothing else: a forbidden set defined by a
   * SHAPE, which is the "never derive a tier by subtraction" pattern this repo
   * has broken itself on before. It happened to be complete and nothing pinned
   * that — the test below hand-enumerated names instead of asserting against a
   * constant, so a name added to MUON's control plane could never have failed
   * anything here.
   *
   * MUTATION CHECK: dropping `MUON_OPERATOR_TOKEN_KEYCHAIN` from
   * `MUON_CONTROL_PLANE_ENV_VARS` fails "strips every name it claims"; deleting
   * the `TERMINAL_STRIPPED_ENV.has(key)` clause and leaving only the pattern
   * fails it too, on the same name.
   */
  it("strips every name it claims to strip, driven from the constant", () => {
    expect(TERMINAL_STRIPPED_ENV_VARS.length).toBeGreaterThan(0);
    const planted = Object.fromEntries(
      TERMINAL_STRIPPED_ENV_VARS.map((key) => [key, `secret-${key}`])
    );
    withEnv(planted, () => {
      for (const kind of ["shell", "codex"]) {
        const env = resolveTerminalSpawn(kind, "/repo").env ?? {};
        for (const key of TERMINAL_STRIPPED_ENV_VARS) {
          expect(env[key], `${key} survived into a '${kind}' terminal`).toBeUndefined();
        }
      }
    });
  });

  it("strips a MUON_ name that does NOT end in _TOKEN — the shape rule's blind spot", () => {
    // `MUON_OPERATOR_TOKEN_KEYCHAIN` (packages/client/src/keychain.ts) starts
    // with MUON_ and does not end with _TOKEN, so the old rule forwarded it.
    expect(TERMINAL_STRIPPED_ENV_VARS).toContain(
      "MUON_OPERATOR_TOKEN_KEYCHAIN"
    );
    withEnv({ MUON_OPERATOR_TOKEN_KEYCHAIN: "1" }, () => {
      expect(
        resolveTerminalSpawn("shell", "/repo").env?.MUON_OPERATOR_TOKEN_KEYCHAIN
      ).toBeUndefined();
    });
  });

  it("cannot drift from the shared credential policy", () => {
    // Every MUON_-prefixed name the runner/provider boundary calls operator
    // authority must also be stripped here. The unprefixed members
    // (GITHUB_TOKEN / GH_TOKEN) are deliberately NOT in this set — a plain
    // login shell keeps the operator's own ambient GitHub authority, a vendor
    // kind does not, which the test above already pins.
    for (const key of OPERATOR_TOKEN_ENV_VARS) {
      if (key.startsWith("MUON_")) {
        expect(TERMINAL_STRIPPED_ENV_VARS, `${key} is not stripped`).toContain(
          key
        );
      }
    }
    expect(TERMINAL_STRIPPED_ENV_VARS).not.toContain("GITHUB_TOKEN");
    expect(TERMINAL_STRIPPED_ENV_VARS).not.toContain("GH_TOKEN");
  });

  it("keeps the pattern as a BACKSTOP for a MUON token nobody listed", () => {
    // The named set is the claim; the shape rule can only ever strip MORE.
    expect(TERMINAL_STRIPPED_ENV_VARS).not.toContain("MUON_FUTURE_LANE_TOKEN");
    withEnv({ MUON_FUTURE_LANE_TOKEN: "not-yet-listed" }, () => {
      expect(
        resolveTerminalSpawn("shell", "/repo").env?.MUON_FUTURE_LANE_TOKEN
      ).toBeUndefined();
    });
  });

  it("still forwards the operator's own ambient environment (ADR-0023 §5)", () => {
    // This is a DENY list, not an allowlist, on purpose: a human-owned terminal
    // is the same trust boundary as the user's own shell, and the vendor CLI
    // must find the credentials the user already has (BYO-auth).
    withEnv(
      { MUON_TERMINAL_AMBIENT: "kept", ANTHROPIC_API_KEY: "byo-auth" },
      () => {
        const env = resolveTerminalSpawn("shell", "/repo").env ?? {};
        expect(env.MUON_TERMINAL_AMBIENT).toBe("kept");
        expect(env.ANTHROPIC_API_KEY).toBe("byo-auth");
      }
    );
  });

  it("rejects an unknown / injected kind — the renderer can't name what runs", () => {
    expect(() => resolveTerminalSpawn("rm -rf /", "/repo")).toThrow(/not allowed/);
    expect(() => resolveTerminalSpawn("../../evil", "/repo")).toThrow(
      /not allowed/
    );
    expect(() => resolveTerminalSpawn("", "/repo")).toThrow(/not allowed/);
  });

  /**
   * T6 — the refusal NAMES the kind, and the kind is renderer text. The prose
   * is the host's; the noun in it is not, so it is flattened and bounded here,
   * at the point it first enters a sentence.
   *
   * MUTATION CHECK: removing `terminalKindLabel` from the throw sites returns
   * the raw ESC/CR and the 5,000-character kind.
   */
  it("never carries a control byte or an unbounded kind into its own message", () => {
    let message = "";
    try {
      resolveTerminalSpawn("\u001b[2Jcodex\r\u0007", "/repo");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/not allowed/);
    expect(message).toContain("codex");
    for (const control of ["\u001b", "\r", "\n", "\u0007"]) {
      expect(message.includes(control)).toBe(false);
    }

    let long = "";
    try {
      resolveTerminalSpawn("y".repeat(5000), "/repo");
    } catch (error) {
      long = error instanceof Error ? error.message : "";
    }
    expect(long.length).toBeLessThan(200);
  });
});
