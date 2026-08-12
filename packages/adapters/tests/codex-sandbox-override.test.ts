import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import { CodexAdapter } from "../src/codex-adapter.js";
import {
  CODEX_NESTED_SANDBOX_OVERRIDE_ARGS,
  CODEX_NESTED_SANDBOX_NOTICE,
  MUON_OWNED_CONFIG_OVERRIDES,
  codexSandboxOverrideArgs,
  effectiveCodexSandboxMode,
  guardedCodexArgs,
} from "../src/codex-guard.js";
import type { LanePtyProcess, LanePtySpawn } from "../src/lane-runner.js";

describe("codexSandboxOverrideArgs (nested-sandbox lockout fix)", () => {
  it("overrides sandbox_mode only inside MUON's own confined runner", () => {
    expect(codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" })).toEqual(
      CODEX_NESTED_SANDBOX_OVERRIDE_ARGS
    );
    expect(codexSandboxOverrideArgs({})).toEqual([]);
    expect(codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "0" })).toEqual([]);
  });

  it("never widens a read-only profile — a reviewer must not gain writes from a rendering fix", () => {
    // `profile.sandbox: "read-only"` reaches the argv as this compiled pair.
    expect(
      codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [
        "-c",
        'sandbox_mode="read-only"',
      ])
    ).toEqual([]);
    // Codex exec's own default is workspace-write (measured), so an UNSET
    // profile sandbox is write-authority by vendor default and is overridden.
    expect(codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [])).toEqual(
      CODEX_NESTED_SANDBOX_OVERRIDE_ARGS
    );
    expect(
      codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [
        "-c",
        'sandbox_mode="workspace-write"',
      ])
    ).toEqual(CODEX_NESTED_SANDBOX_OVERRIDE_ARGS);
  });

  it("F3: honours a read-only tightening stated through rawConfig or extraArgs", () => {
    // `sandbox_mode` is reachable through THREE channels — profile.sandbox,
    // rawConfig, and extraArgs — and all three land as `-c` overrides on the
    // composed argv. Reading only `profile.sandbox` meant an operator's
    // explicit rawConfig/extraArgs read-only tightening was silently REVERSED
    // by an override appended after it.
    for (const stated of [
      // rawConfig: {sandbox_mode: "read-only"} → tomlValue quotes it
      ["-c", 'sandbox_mode="read-only"'],
      // extraArgs passthrough, unquoted and joined spellings
      ["-c", "sandbox_mode=read-only"],
      ["-c", "sandbox_mode='read-only'"],
      ["--config", 'sandbox_mode="read-only"'],
      ["-c=sandbox_mode=read-only"],
    ]) {
      expect(
        codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, stated)
      ).toEqual([]);
    }
  });

  it("F3: the LAST stated sandbox_mode decides, matching codex's own precedence", () => {
    // A widening then a tightening ⇒ read-only wins ⇒ no override.
    expect(
      codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        'sandbox_mode="read-only"',
      ])
    ).toEqual([]);
    // A tightening then a widening ⇒ workspace-write wins ⇒ override applies.
    expect(
      codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'sandbox_mode="workspace-write"',
      ])
    ).toEqual(CODEX_NESTED_SANDBOX_OVERRIDE_ARGS);
  });

  it("F3: an unrelated -c override never suppresses the fix", () => {
    expect(
      codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }, [
        "-c",
        "features.apps=false",
        "-c",
        'model="gpt-5.6"',
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
      ])
    ).toEqual(CODEX_NESTED_SANDBOX_OVERRIDE_ARGS);
  });

  it("F8: the override is MUON-owned, so a future key-guard cannot strip it", () => {
    // If `sandbox_mode` is ever added to the guarded key prefixes, MUON's own
    // fix must survive its own strip — otherwise hardening silently restores
    // the lockout that made codex children unable to run `pwd`.
    expect(MUON_OWNED_CONFIG_OVERRIDES.has('sandbox_mode="danger-full-access"')).toBe(
      true
    );
  });

  it("survives MUON's own widening-arg strip", () => {
    // The override is `-c sandbox_mode=…`, not a guarded `features.*` key and
    // not a widening flag — the categorical net must keep it, or the fix
    // would silently undo itself.
    expect(guardedCodexArgs([...CODEX_NESTED_SANDBOX_OVERRIDE_ARGS])).toEqual([
      ...CODEX_NESTED_SANDBOX_OVERRIDE_ARGS,
    ]);
  });

  it("wins over a compiled profile sandbox by coming LAST on the argv", () => {
    // Codex applies -c overrides in order (verified live); the adapters append
    // the override AFTER compiled args. This asserts the ordering contract.
    const compiled = ["-c", 'sandbox_mode="workspace-write"'];
    const composed = [
      ...compiled,
      ...codexSandboxOverrideArgs({ MUON_SANDBOX_ACTIVE: "1" }),
    ];
    expect(composed.lastIndexOf("-c")).toBeGreaterThan(0);
    expect(composed[composed.length - 1]).toBe(
      'sandbox_mode="danger-full-access"'
    );
  });
});

/** CodexAdapter with the two host-touching seams stubbed for unit tests. */
class TestableCodexAdapter extends CodexAdapter {
  constructor(guardHome: string) {
    super({
      prepareGuardHome: () => ({ home: guardHome, authLinked: false }),
    });
  }
  protected override assertLaneBinaryAvailable(): void {
    // The fake pty below intercepts the spawn; no real binary is needed.
  }
}

describe("CodexAdapter real-terminal run", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "muon-codex-pty-test-"));
    scratchDirs.push(dir);
    return dir;
  }

  it("adds --output-last-message, captures the session id, and appends the final message", async () => {
    const guardHome = scratch();
    const adapter = new TestableCodexAdapter(guardHome);
    const events: LaneEvent[] = [];
    let spawnedArgs: string[] = [];
    let reportedSessionId: string | null = null;

    const spawn: LanePtySpawn = (options) => {
      spawnedArgs = options.args;
      const flagIndex = options.args.indexOf("--output-last-message");
      const lastMessagePath =
        flagIndex >= 0 ? options.args[flagIndex + 1] : undefined;
      let exitListener:
        | ((event: { exitCode: number; signal?: number }) => void)
        | undefined;
      const child: LanePtyProcess = {
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: (listener) => {
          queueMicrotask(() => {
            listener(
              "\x1b[1msession id:\x1b[0m 019fa043-e5c2-7731-b2f3-11312f91d2d2\r\n"
            );
            listener("transcript noise\r\n");
            if (lastMessagePath) {
              writeFileSync(lastMessagePath, "GOAL: authoritative report\n");
            }
            queueMicrotask(() => exitListener?.({ exitCode: 0 }));
          });
        },
        onExit: (listener) => {
          exitListener = listener;
        },
      };
      return child;
    };

    const result = await adapter.runTask(
      { taskId: "task-1", brief: "do the thing" },
      (event) => events.push(event),
      {
        cwd: scratch(),
        pty: { spawn },
        onVendorSessionId: (sessionId) => {
          reportedSessionId = sessionId;
        },
      }
    );

    expect(result.exitCode).toBe(0);
    // The brief stays the FINAL positional, after the injected flag.
    const flagIndex = spawnedArgs.indexOf("--output-last-message");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(spawnedArgs[spawnedArgs.length - 1]).toBe("do the thing");
    // Session id captured from the banner bytes — the resume/backlink handle.
    expect(reportedSessionId).toBe("019fa043-e5c2-7731-b2f3-11312f91d2d2");
    // The authoritative final message is appended LAST so report anchors
    // resolve to the agent's actual report, not transcript noise.
    expect(result.output.trimEnd().endsWith("GOAL: authoritative report")).toBe(
      true
    );
  });

  it("F11: keeps the authoritative last-message file in a 0700 private directory", async () => {
    // The file holds the agent's final report verbatim. In a shared /tmp with
    // a default umask it was world-readable, and another local user could also
    // have pre-created the path.
    const adapter = new TestableCodexAdapter(scratch());
    let lastMessagePath: string | undefined;
    let modeDuringRun: number | undefined;

    const spawn: LanePtySpawn = (options) => {
      const flagIndex = options.args.indexOf("--output-last-message");
      lastMessagePath = options.args[flagIndex + 1];
      let exitListener:
        | ((event: { exitCode: number; signal?: number }) => void)
        | undefined;
      return {
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: () => {
          queueMicrotask(() => {
            if (lastMessagePath) {
              writeFileSync(lastMessagePath, "GOAL: done\n");
              modeDuringRun =
                statSync(dirname(lastMessagePath)).mode & 0o777;
            }
            queueMicrotask(() => exitListener?.({ exitCode: 0 }));
          });
        },
        onExit: (listener) => {
          exitListener = listener;
        },
      } satisfies LanePtyProcess;
    };

    await adapter.runTask(
      { taskId: "task-perms", brief: "brief" },
      () => undefined,
      { cwd: scratch(), pty: { spawn } }
    );

    expect(lastMessagePath).toBeDefined();
    // Owner-only: no group or other bits at all.
    expect(modeDuringRun).toBe(0o700);
    // And the whole directory is removed with the run, not just the file.
    expect(existsSync(dirname(lastMessagePath!))).toBe(false);
  });

  it("states the nested-sandbox override and puts it after compiled args when confined", async () => {
    const previous = process.env.MUON_SANDBOX_ACTIVE;
    process.env.MUON_SANDBOX_ACTIVE = "1";
    try {
      const adapter = new TestableCodexAdapter(scratch());
      const events: LaneEvent[] = [];
      let spawnedArgs: string[] = [];
      const spawn: LanePtySpawn = (options) => {
        spawnedArgs = options.args;
        let exitListener:
          | ((event: { exitCode: number; signal?: number }) => void)
          | undefined;
        return {
          write: () => undefined,
          resize: () => undefined,
          kill: () => undefined,
          onData: () => {
            queueMicrotask(() => exitListener?.({ exitCode: 0 }));
          },
          onExit: (listener) => {
            exitListener = listener;
          },
        } satisfies LanePtyProcess;
      };

      await adapter.runTask(
        { taskId: "task-2", brief: "brief" },
        (event) => events.push(event),
        { cwd: scratch(), pty: { spawn } }
      );

      expect(spawnedArgs).toContain('sandbox_mode="danger-full-access"');
      expect(
        events.some((event) => event.message === CODEX_NESTED_SANDBOX_NOTICE)
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MUON_SANDBOX_ACTIVE;
      } else {
        process.env.MUON_SANDBOX_ACTIVE = previous;
      }
    }
  });
});
