import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalRespawnGuard,
  TERMINAL_KINDS,
} from "../src/lib/terminal-spawn.js";
import {
  shouldCloseTerminalTabOnExit,
  TERMINAL_FAST_EXIT_MS,
  VENDOR_TERMINAL_COMMANDS,
} from "../src/lib/terminal-vendor-tabs.js";
import type {
  TerminalClientFrame,
  TerminalHostFrame,
} from "../src/shared/terminal-protocol.js";

/**
 * The founder-reported defect: "cursor keeps going in recursive cursor new tab
 * opening on clicking trust this workspace."
 *
 * Two independent locks are tested here, because the loop had two halves.
 *
 * HOST — `PtyHost.detach()` reaps a session whose child has already exited, and
 * `PtyRelay.open()` is only idempotent while the host still HAS the session. So
 * "child died, then the port closed" leaves the id unowned and the NEXT open of
 * that same id spawns a second process under the first one's identity — every
 * remount, tab switch, or window reload re-triggering a launcher that already
 * failed. The guard refuses that open instead, with a sentence.
 *
 * RENDERER — the tab auto-closed on ANY exit, including one a second after the
 * spawn, erasing the vendor's own error lines. A pane that vanishes is a pane a
 * human re-opens; that is how one failed launch became a column of tabs.
 */

type FakePort = {
  postMessage: (frame: TerminalHostFrame) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  start: () => void;
  close: () => void;
  closed: boolean;
  sent: TerminalHostFrame[];
  emit: (frame: TerminalClientFrame) => void;
};

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const channels: { port1: FakePort; port2: FakePort }[] = [];
  const makePort = (): FakePort => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    const sent: TerminalHostFrame[] = [];
    const port: FakePort = {
      sent,
      closed: false,
      postMessage: (frame) => sent.push(frame),
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      start: () => undefined,
      close: () => {
        port.closed = true;
        for (const listener of listeners.get("close") ?? []) listener();
      },
      emit: (frame) => {
        for (const listener of listeners.get("message") ?? []) {
          listener({ data: frame });
        }
      },
    };
    return port;
  };
  return { handlers, channels, makePort };
});

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => {
      electronMocks.handlers.set(channel, handler);
    },
    handle: (channel: string, handler: (...args: unknown[]) => void) => {
      electronMocks.handlers.set(channel, handler);
    },
  },
  MessageChannelMain: class {
    port1: FakePort;
    port2: FakePort;
    constructor() {
      this.port1 = electronMocks.makePort();
      this.port2 = electronMocks.makePort();
      electronMocks.channels.push({ port1: this.port1, port2: this.port2 });
    }
  },
}));

// Same posture as terminal-host-ipc.test.ts: the allowlist/resume fences run for
// real, but the COMMAND is neutralized — `/bin/echo` prints one line and exits,
// which is precisely the "died on startup" shape this guard exists for. A unit
// test must never launch a vendor CLI. `spawnCommand` lets one test choose a
// child that lives long enough for the pane to be unmounted BEFORE it dies.
const spawnCalls = vi.hoisted(() => [] as { kind: string; cwd: string }[]);
const spawnCommand = vi.hoisted(() => ({
  file: "/bin/echo",
  args: ["muon-test"] as string[],
}));
vi.mock("../src/lib/terminal-spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/terminal-spawn.js")>();
  return {
    ...actual,
    resolveTerminalSpawn: (
      kind: string,
      cwd: string,
      overrides?: { cols?: number; rows?: number },
      resume?: { vendor: string; sessionId: string }
    ) => {
      const resolved = actual.resolveTerminalSpawn(kind, cwd, overrides, resume);
      spawnCalls.push({ kind, cwd });
      return {
        ...resolved,
        file: spawnCommand.file,
        args: [...spawnCommand.args],
      };
    },
  };
});

import { registerTerminalIpc } from "../src/lib/terminal-host.js";

const SESSION = "terminal-chat:chat-1:cursor.1";

function fakeEvent() {
  const posted: { channel: string; payload: unknown }[] = [];
  return {
    posted,
    sender: {
      // The host asks before every reply now (a destroyed WebContents throws
      // on postMessage); this window is alive for the whole of these tests.
      isDestroyed: () => false,
      postMessage: (channel: string, payload: unknown) => {
        posted.push({ channel, payload });
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition did not become true within ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.channels.length = 0;
  spawnCalls.length = 0;
  spawnCommand.file = "/bin/echo";
  spawnCommand.args = ["muon-test"];
});

describe("respawn guard — the unit", () => {
  it("refuses the next open after a child that died on startup", () => {
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 1, lifetimeMs: 200 });
    const refusal = guard.refuseRespawn("s");
    expect(refusal).toMatch(/exited immediately \(code 1\)/);
    expect(refusal).toMatch(/did not start another one/);
  });

  it("treats a fast exit 0 exactly like a fast exit 1", () => {
    // How a signed-out `cursor-agent` fails (live-verified): rc=0, no session.
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 0, lifetimeMs: TERMINAL_FAST_EXIT_MS });
    expect(guard.refuseRespawn("s")).toMatch(/code 0/);
  });

  it("allows a session that RAN and then finished to be reopened", () => {
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 0, lifetimeMs: TERMINAL_FAST_EXIT_MS + 1 });
    expect(guard.refuseRespawn("s")).toBeNull();
  });

  it("never blocks a live session's reconnect", () => {
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    expect(guard.refuseRespawn("s")).toBeNull();
  });

  it("judges the CHILD'S lifetime, not how long ago the exit was reported", () => {
    // The bug this pins: the guard used to time the death from the moment
    // `noteExit` ran — i.e. when a consumer OBSERVED the exit frame. A pane
    // unmounted before its child died only observes the exit on the next
    // attach, so a 300ms launch failure read as a minutes-long session and the
    // guard let the very next look spawn another one. The lifetime now arrives
    // measured by the PtyHost and this only compares it.
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 1, lifetimeMs: 300 }); // observed 60s late
    expect(guard.refuseRespawn("s")).toMatch(/exited immediately/);
  });

  it("ignores a REPEATED exit report, so a replay cannot re-arm the guard", () => {
    // The host reports the exit once, at the exit; a consumer attaching later
    // gets a REPLAY. Counting that as a second death would refuse a session
    // that finished normally minutes ago.
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 0, lifetimeMs: 60_000 });
    guard.noteExit("s", { exitCode: 0, lifetimeMs: 10 });
    expect(guard.refuseRespawn("s")).toBeNull();
  });

  it("clears on a deliberate close — the human may always start fresh", () => {
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("s");
    guard.noteExit("s", { exitCode: 127, lifetimeMs: 10 });
    expect(guard.refuseRespawn("s")).not.toBeNull();
    guard.forget("s");
    expect(guard.refuseRespawn("s")).toBeNull();
  });

  it("scopes the record to ONE session id", () => {
    const guard = createTerminalRespawnGuard();
    guard.noteSpawn("a");
    guard.noteExit("a", { exitCode: 1, lifetimeMs: 10 });
    expect(guard.refuseRespawn("b")).toBeNull();
  });
});

describe("respawn guard — through the real IPC spawn door", () => {
  it("a session that exits immediately is NOT respawned by the next open", async () => {
    registerTerminalIpc({ resolveWorkspacePath: async () => "/tmp" });
    const handler = electronMocks.handlers.get("muon:openTerminal");
    expect(handler).toBeTypeOf("function");

    const first = fakeEvent();
    handler!(first, { sessionId: SESSION, spawn: { file: "cursor", cwd: "." } });
    // Let node-pty load, spawn /bin/echo, and deliver its exit frame. Poll the
    // observable instead of assuming a fixed native-module startup latency.
    await waitFor(() =>
      (electronMocks.channels.at(-1)?.port1.sent ?? []).some(
        (frame) => frame.type === "exit"
      )
    );
    expect(spawnCalls).toHaveLength(1);
    const firstFrames = electronMocks.channels.at(-1)?.port1.sent ?? [];
    expect(firstFrames.some((frame) => frame.type === "exit")).toBe(true);

    // The remount: the same pane, the same session id, opened again.
    const second = fakeEvent();
    handler!(second, { sessionId: SESSION, spawn: { file: "cursor", cwd: "." } });
    await sleep(200);

    // No second process, and the pane is TOLD why rather than left blank.
    expect(spawnCalls).toHaveLength(1);
    expect(second.posted).toHaveLength(1);
    const refusals = (electronMocks.channels.at(-1)?.port1.sent ?? []).filter(
      (frame): frame is Extract<TerminalHostFrame, { type: "error" }> =>
        frame.type === "error"
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toMatch(/exited immediately/i);
  });

  it("arms on a child that died with NOBODY WATCHING, and refuses the late remount", async () => {
    // The founder's exact sequence, and the one the old guard was blind to:
    // click "+ Cursor", switch tabs a moment later (the pane unmounts and its
    // port closes — the host DETACHES, the session survives), and the child
    // dies unwatched. Nothing observed the exit frame, so a guard armed from
    // that frame never learned the launch had failed, and the next look at the
    // pane started another process. The host now reports the exit at the exit.
    spawnCommand.file = "/bin/sleep";
    spawnCommand.args = ["0.35"];
    registerTerminalIpc({ resolveWorkspacePath: async () => "/tmp" });
    const handler = electronMocks.handlers.get("muon:openTerminal");

    handler!(fakeEvent(), {
      sessionId: SESSION,
      spawn: { file: "cursor", cwd: "." },
    });
    await sleep(150); // spawned and attached, child still alive
    expect(spawnCalls).toHaveLength(1);

    // The tab unmounts BEFORE the child dies: the renderer end goes away.
    electronMocks.channels.at(-1)!.port1.close();
    await sleep(500); // the child exits with no consumer attached

    // The human comes back much later. No second process, and the pane is told.
    const late = fakeEvent();
    handler!(late, { sessionId: SESSION, spawn: { file: "cursor", cwd: "." } });
    await sleep(200);
    expect(spawnCalls).toHaveLength(1);
    const frames = electronMocks.channels.at(-1)?.port1.sent ?? [];
    const refusals = frames.filter(
      (frame): frame is Extract<TerminalHostFrame, { type: "error" }> =>
        frame.type === "error"
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toMatch(/exited immediately/i);
    // …and it is NOT told the session ended, so the tab cannot auto-close
    // itself (and the refusal) off the screen.
    expect(frames.some((frame) => frame.type === "exit")).toBe(false);
  });

  it("puts the child's HOST-MEASURED lifetime on the exit frame, so the tab survives a launch failure", async () => {
    // The renderer's half of the same defect: it judged "did this ever become
    // a session" by subtracting its own tab-creation time from `Date.now()` at
    // the moment the frame arrived — a different epoch (it predates the host's
    // node-pty load and workspace lookup), and on a REPLAYED exit it is
    // however long the human was away. The number now comes measured, from the
    // host. (The replay's stamps are pinned in packages/runner's pty-host
    // tests, where the clock can be injected.)
    registerTerminalIpc({ resolveWorkspacePath: async () => "/tmp" });
    const handler = electronMocks.handlers.get("muon:openTerminal");
    handler!(fakeEvent(), {
      sessionId: SESSION,
      spawn: { file: "cursor", cwd: "." },
    });
    await sleep(400);

    const exit = (electronMocks.channels.at(-1)?.port1.sent ?? []).find(
      (frame): frame is Extract<TerminalHostFrame, { type: "exit" }> =>
        frame.type === "exit"
    );
    expect(exit).toBeDefined();
    expect(exit!.lifetimeMs).toBeLessThanOrEqual(TERMINAL_FAST_EXIT_MS);
    expect(
      shouldCloseTerminalTabOnExit({ lifetimeMs: exit!.lifetimeMs })
    ).toBe(false);
  });

  it("an explicit close re-arms the door for a deliberate new session", async () => {
    const controller = registerTerminalIpc({
      resolveWorkspacePath: async () => "/tmp",
    });
    const handler = electronMocks.handlers.get("muon:openTerminal");
    handler!(fakeEvent(), {
      sessionId: SESSION,
      spawn: { file: "cursor", cwd: "." },
    });
    await sleep(400);
    expect(spawnCalls).toHaveLength(1);

    controller.closeSession(SESSION);
    handler!(fakeEvent(), {
      sessionId: SESSION,
      spawn: { file: "cursor", cwd: "." },
    });
    await sleep(300);
    expect(spawnCalls).toHaveLength(2);
  });
});

/**
 * A REFUSAL MUST HAVE A WAY BACK.
 *
 * The resume pane's session id is the job's coordinate plus `.resume`, and no
 * close call site in the app named it: closing the job tab, archiving the
 * chat, and ⌘W all close the plain `terminal-<jobId>`. So the first time a
 * resume died on startup — `claude` not yet on the PATH the app was launched
 * with, a signed-out CLI — the guard refused that job's resume for the life of
 * the app process, with nothing in the UI able to clear it.
 */
describe("a refused resume can be retried", () => {
  const JOB_SESSION = "terminal-job-9";
  const RESUME_SESSION = `${JOB_SESSION}.resume`;
  const VENDOR_SESSION_ID = "019fa2c4-5f9b-70f1-9225-03dba896d740";

  function resumeHost() {
    return registerTerminalIpc({
      resolveWorkspacePath: async () => "/tmp",
      resolveVendorSession: async () => ({
        ok: true,
        vendor: "claude-code",
        sessionId: VENDOR_SESSION_ID,
        mode: "resume" as const,
      }),
    });
  }

  const openResume = (handler: (...args: unknown[]) => void) =>
    handler(fakeEvent(), {
      sessionId: RESUME_SESSION,
      spawn: { file: "claude-code:resume", cwd: "." },
    });

  it("the pane's own close clears the record, so the next open really spawns", async () => {
    const controller = resumeHost();
    const handler = electronMocks.handlers.get("muon:openTerminal");

    openResume(handler!);
    await sleep(400);
    expect(spawnCalls).toHaveLength(1);

    // Remounting the pane is refused — the guard is doing its job.
    openResume(handler!);
    await sleep(200);
    expect(spawnCalls).toHaveLength(1);

    // "Try again" closes the session by its own id (the renderer's retry), and
    // the door opens again for a deliberate attempt.
    controller.closeSession(RESUME_SESSION);
    openResume(handler!);
    await sleep(400);
    expect(spawnCalls).toHaveLength(2);
  });

  it("closing the JOB's terminal clears its resume sibling too", async () => {
    // The path every existing close call site actually takes: none of them
    // names `.resume`, so the sibling has to be torn down with the job's own
    // coordinate or it is never torn down at all.
    const controller = resumeHost();
    const handler = electronMocks.handlers.get("muon:openTerminal");

    openResume(handler!);
    await sleep(400);
    expect(spawnCalls).toHaveLength(1);

    controller.closeSession(JOB_SESSION);
    openResume(handler!);
    await sleep(400);
    expect(spawnCalls).toHaveLength(2);
  });
});

describe("a human terminal tab does not erase its own failure", () => {
  it("keeps the tab when the child died on startup", () => {
    expect(shouldCloseTerminalTabOnExit({ lifetimeMs: 0 })).toBe(false);
    expect(
      shouldCloseTerminalTabOnExit({ lifetimeMs: TERMINAL_FAST_EXIT_MS })
    ).toBe(false);
  });

  it("closes the tab when a real session finished", () => {
    expect(
      shouldCloseTerminalTabOnExit({ lifetimeMs: TERMINAL_FAST_EXIT_MS + 1 })
    ).toBe(true);
    expect(shouldCloseTerminalTabOnExit({ lifetimeMs: 600_000 })).toBe(true);
  });
});

describe("the Cursor button opens the agent CLI, never the IDE launcher", () => {
  it("spawns `cursor-agent` and keeps `cursor` off the spawn table", () => {
    // The bare `cursor` launcher is /Applications/Cursor.app/…/bin/code behind
    // a symlink: it opens an IDE window and returns, so one click would give a
    // dead pane and one more IDE tab. `cursor` is a readiness candidate only.
    expect(VENDOR_TERMINAL_COMMANDS.cursor).toEqual({
      file: "cursor-agent",
      args: [],
    });
    expect(TERMINAL_KINDS).toContain("cursor");
    for (const command of Object.values(VENDOR_TERMINAL_COMMANDS)) {
      expect(command?.file).not.toBe("cursor");
    }
  });
});
