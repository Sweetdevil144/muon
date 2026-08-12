import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalClientFrame,
  TerminalHostFrame,
} from "../src/shared/terminal-protocol.js";

// GAP1 + F6 — the terminal SPAWN DOOR itself, driven through the registered
// IPC handler rather than through its helpers. Every refusal here used to
// `return` after a stderr line, so the renderer's `open()` promise never
// settled and the founder got a permanently blank pane. These tests assert
// the door always answers: a port, and a typed reason.

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

// The spawn resolver is exercised for real (its allowlist and resume fences
// are the point) but the COMMAND it yields is neutralized: an admitted open
// must not launch a vendor CLI from a unit test.
const spawnCalls = vi.hoisted(
  () =>
    [] as {
      kind: string;
      cwd: string;
      resume?: unknown;
      overrides?: { cols?: number; rows?: number };
    }[]
);
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
      spawnCalls.push({ kind, cwd, resume, ...(overrides ? { overrides } : {}) });
      return { ...resolved, file: "/bin/echo", args: ["muon-test"] };
    },
  };
});

import {
  MAX_TERMINAL_SESSIONS,
  registerTerminalIpc,
  TERMINAL_TAKEOVER_SESSION_SUFFIXES,
} from "../src/lib/terminal-host.js";
import {
  authorizeRendererTerminalClose,
  createRendererChatOwnership,
  TAKEOVER_SESSION_SUFFIXES,
} from "../src/lib/renderer-chat-scope.js";

const JOB = "job-abc";
const SESSION = `terminal-${JOB}`;
const RESUME_SESSION = `terminal-${JOB}.resume`;
const FORK_SESSION = `terminal-${JOB}.fork`;
const VENDOR_SESSION_ID = "019fa043-e5c2-7731-b2f3-11312f91d2d2";

/**
 * The renderer's WebContents, as much of it as this door touches — INCLUDING
 * `isDestroyed`, because the host is now required to ask. `destroyed: true`
 * models the window that went away while the open was still awaiting its three
 * async hops, and postMessage on a real destroyed sender throws.
 */
function fakeEvent(
  options: { destroyed?: boolean; throwOnPost?: boolean } = {}
) {
  const posted: { channel: string; payload: unknown }[] = [];
  let destroyed = options.destroyed === true;
  return {
    posted,
    destroy: () => {
      destroyed = true;
    },
    sender: {
      // `throwOnPost` models the RACE the guard cannot win: the window dies
      // between the check and the post, so `isDestroyed()` answers false and
      // `postMessage` throws anyway. That is the case the entry point's
      // `.catch` exists for, and the only way to exercise it deterministically.
      isDestroyed: () => destroyed,
      postMessage: (channel: string, payload: unknown) => {
        if (destroyed || options.throwOnPost === true) {
          throw new TypeError("Object has been destroyed");
        }
        posted.push({ channel, payload });
      },
    },
  };
}

async function open(
  deps: Parameters<typeof registerTerminalIpc>[0],
  sessionId: string,
  file: string,
  /** The pane's measured grid, as the renderer states it on the open. */
  geometry?: Record<string, unknown>
) {
  electronMocks.channels.length = 0;
  spawnCalls.length = 0;
  registerTerminalIpc(deps);
  const handler = electronMocks.handlers.get("muon:openTerminal");
  expect(handler).toBeTypeOf("function");
  const event = fakeEvent();
  handler!(event, {
    sessionId,
    spawn: { file, cwd: ".", ...(geometry ?? {}) },
  });
  // The open path awaits the native module load before deciding anything.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const channel = electronMocks.channels.at(-1);
  return {
    event,
    frames: channel?.port1.sent ?? [],
    errors: (channel?.port1.sent ?? []).filter(
      (frame): frame is Extract<TerminalHostFrame, { type: "error" }> =>
        frame.type === "error"
    ),
  };
}

const worktree = { resolveWorkspacePath: async () => "/tmp" };

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.channels.length = 0;
  spawnCalls.length = 0;
});

describe("F6 — a refused open always answers, never a blank pane", () => {
  it("refuses a governed live-console ATTACH id with a stated reason", async () => {
    // `pty:job:<id>:<epoch>` names an already-running governed process; opening
    // it here would launch an ungoverned second one.
    const { event, errors } = await open(
      worktree,
      "pty:job:job-abc:a1b2c3d4e5f60718",
      "codex"
    );
    expect(event.posted).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/live console|attach/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses when the job's worktree cannot be resolved (foreign chat)", async () => {
    const { event, errors } = await open(
      { resolveWorkspacePath: async () => null },
      SESSION,
      "codex"
    );
    expect(event.posted).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/worktree|workspace/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses a resume with no recorded vendor session", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: false as const,
          reason: "MUON has no recorded vendor session for this job.",
        }),
      },
      RESUME_SESSION,
      "codex:resume"
    );
    expect(errors[0]?.reason).toMatch(/no recorded|resume/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses a resume KIND presented without a resume session id", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: true as const,
          vendor: "codex",
          sessionId: VENDOR_SESSION_ID,
          mode: "resume" as const,
        }),
      },
      SESSION,
      "codex:resume"
    );
    expect(errors[0]?.reason).toMatch(/together|resume/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses a terminal kind outside the host allowlist", async () => {
    const { errors } = await open(worktree, SESSION, "bash-with-my-flags");
    expect(errors[0]?.reason).toMatch(/not allowed|refused/i);
  });

  it("refuses an invalid session id without throwing", async () => {
    const { event } = await open(worktree, "bad id with spaces!", "codex");
    // Nothing to attach a port to (no channel was opened), but the handler
    // must not throw or hang.
    expect(event.posted).toHaveLength(0);
  });
});

describe("GAP1 — resume routing through the real IPC door", () => {
  it("routes a `.resume` session + `<vendor>:resume` kind to the resume spawn", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: true as const,
          vendor: "codex",
          sessionId: VENDOR_SESSION_ID,
          mode: "resume" as const,
        }),
      },
      RESUME_SESSION,
      "codex:resume"
    );
    expect(errors).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    // The KIND reaching the resolver is the bare vendor, and the resume data
    // is the HOST's lookup — never anything the renderer said.
    expect(spawnCalls[0]?.kind).toBe("codex");
    expect(spawnCalls[0]?.resume).toEqual({
      vendor: "codex",
      sessionId: VENDOR_SESSION_ID,
      mode: "resume",
    });
  });

  it("routes a plain session to a FRESH spawn, with no resume data", async () => {
    const { errors } = await open(worktree, SESSION, "codex");
    expect(errors).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.kind).toBe("codex");
    expect(spawnCalls[0]?.resume).toBeUndefined();
  });

  it("F7: a running job's FORK grant reaches the spawn as a fork, never a resume", async () => {
    // The renderer sends the same `<vendor>:resume` kind either way — it does
    // not know, and must not choose, which door it gets. The MODE travels with
    // the host's own grant, so a running job cannot be routed to the door that
    // would put a second writer on its transcript.
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: true as const,
          vendor: "codex",
          sessionId: VENDOR_SESSION_ID,
          mode: "fork" as const,
        }),
      },
      FORK_SESSION,
      "codex:resume"
    );
    expect(errors).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.resume).toEqual({
      vendor: "codex",
      sessionId: VENDOR_SESSION_ID,
      mode: "fork",
    });
  });

  /**
   * F1 — THE SLOT MUST MATCH THE GRANT.
   *
   * A fork and a resume are different vendor sessions and now hold different
   * ptys. The suffix is renderer-supplied, so it grants nothing: the host takes
   * the MODE from its own lookup and refuses any slot that disagrees.
   *
   * Both directions are a real defect, not symmetry for its own sake:
   *  - `.fork` after the job stopped is the stale pane whose re-open used to be
   *    served the STILL-LIVE fork pty under "the session MUON dispatched";
   *  - `.resume` while the job runs is the coordinate half of the two-writers
   *    hazard — refused here as well as by the mode rule.
   */
  it("refuses a `.fork` slot when the job's grant is a resume", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: true as const,
          vendor: "codex",
          sessionId: VENDOR_SESSION_ID,
          mode: "resume" as const,
        }),
      },
      FORK_SESSION,
      "codex:resume"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/did not authorize|status decides/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses a `.resume` slot when the job's grant is a fork", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: true as const,
          vendor: "codex",
          sessionId: VENDOR_SESSION_ID,
          mode: "fork" as const,
        }),
      },
      RESUME_SESSION,
      "codex:resume"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/did not authorize|status decides/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("a fork and a resume are DIFFERENT ptys, so the resume open really spawns", async () => {
    // The reproduced failure: one shared coordinate meant `PtyRelay.open`
    // no-op'd for the second open (the host still held the id, because
    // `PtyHost.detach` keeps a session whose child has not exited), so the
    // freshly-authorized `codex resume` argv was computed and DISCARDED and
    // the human was re-attached to the live fork. Two slots, two spawns.
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    let mode: "fork" | "resume" = "fork";
    const controller = registerTerminalIpc({
      ...worktree,
      resolveVendorSession: async () => ({
        ok: true as const,
        vendor: "codex",
        sessionId: VENDOR_SESSION_ID,
        mode,
      }),
    });
    expect(controller).toBeTruthy();
    const handler = electronMocks.handlers.get("muon:openTerminal")!;

    handler(fakeEvent(), {
      sessionId: FORK_SESSION,
      spawn: { file: "codex:resume", cwd: "." },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.resume).toMatchObject({ mode: "fork" });

    // The pane is closed (detach only — the fork's child is still alive) and
    // the job finishes, so the grant flips.
    mode = "resume";
    handler(fakeEvent(), {
      sessionId: RESUME_SESSION,
      spawn: { file: "codex:resume", cwd: "." },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]?.resume).toMatchObject({ mode: "resume" });
  });

  it("still relays a lookup REFUSAL as a typed reason, spawning nothing", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: false as const,
          reason:
            "Codex has no way to fork a session that is still being written.",
        }),
      },
      RESUME_SESSION,
      "codex:resume"
    );
    expect(errors[0]?.reason).toMatch(/fork/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it("never lets the renderer's own cwd reach the spawn", async () => {
    await open(
      { resolveWorkspacePath: async () => "/host/resolved/worktree" },
      SESSION,
      "codex"
    );
    expect(spawnCalls[0]?.cwd).toBe("/host/resolved/worktree");
  });
});

describe("session reaping — no desktop-side orphans", () => {
  async function openMany(): Promise<{
    controller: ReturnType<typeof registerTerminalIpc>;
    ports: Record<string, FakePort>;
  }> {
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    const controller = registerTerminalIpc({
      resolveWorkspacePath: async () => "/tmp",
    });
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const ports: Record<string, FakePort> = {};
    for (const [sessionId, file] of [
      ["terminal-chat:chat-a", "shell"],
      ["terminal-chat:chat-a:claude-code.1", "claude-code"],
      ["terminal-chat:chat-b:shell.1", "shell"],
      ["terminal-job-1", "codex"],
    ] as const) {
      handler(fakeEvent(), { sessionId, spawn: { file, cwd: "." } });
      await new Promise((resolve) => setTimeout(resolve, 60));
      ports[sessionId] = electronMocks.channels.at(-1)!.port1;
    }
    return { controller, ports };
  }

  it("closeChatSessions reaps the chat's plain shell AND its vendor tabs, nothing else", async () => {
    const { controller, ports } = await openMany();
    controller.closeChatSessions("chat-a");
    expect(ports["terminal-chat:chat-a"]!.closed).toBe(true);
    expect(ports["terminal-chat:chat-a:claude-code.1"]!.closed).toBe(true);
    expect(ports["terminal-chat:chat-b:shell.1"]!.closed).toBe(false);
    expect(ports["terminal-job-1"]!.closed).toBe(false);
  });

  it("closeAllSessions (app quit) reaps every human session", async () => {
    const { controller, ports } = await openMany();
    controller.closeAllSessions();
    for (const port of Object.values(ports)) {
      expect(port.closed).toBe(true);
    }
  });

  /**
   * ROADMAP T1 — the read side of cold-restore, exercised through the same
   * live registry `closeAllSessions` above tears down. Scope must match: any
   * `terminal-chat:` id is a candidate, the job's own worktree terminal never
   * is — a dispatch/job pty is dispatch-adjacent, never a cold-restore
   * candidate under T1.
   */
  it("snapshotHumanSessions returns every terminal-chat: session, never the job's", async () => {
    const { controller } = await openMany();
    const snapshot = controller.snapshotHumanSessions();
    expect(snapshot.map((entry) => entry.sessionId).sort()).toEqual(
      [
        "terminal-chat:chat-a",
        "terminal-chat:chat-a:claude-code.1",
        "terminal-chat:chat-b:shell.1",
      ].sort()
    );
    for (const entry of snapshot) {
      expect(typeof entry.text).toBe("string");
      expect(entry.cols).toBeGreaterThan(0);
      expect(entry.rows).toBeGreaterThan(0);
    }
  });

  /**
   * F1's other half: giving the fork its own coordinate is only safe if the
   * new coordinate is CLOSABLE. Every close call site in the app names the
   * plain `terminal-<jobId>` (closing a job tab, archiving a chat, ⌘W), so a
   * suffix the sweep does not know is a pty with no way to die — and a
   * fast-exit record with no way to be forgotten, which is what once refused a
   * job's resume for the life of the app process.
   */
  it("closing the plain job coordinate sweeps BOTH takeover slots", async () => {
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    let mode: "fork" | "resume" = "fork";
    const controller = registerTerminalIpc({
      resolveWorkspacePath: async () => "/tmp",
      resolveVendorSession: async () => ({
        ok: true as const,
        vendor: "codex",
        sessionId: VENDOR_SESSION_ID,
        mode,
      }),
    });
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const ports: Record<string, FakePort> = {};
    for (const [sessionId, file, grant] of [
      [SESSION, "codex", "fork"],
      [FORK_SESSION, "codex:resume", "fork"],
      [RESUME_SESSION, "codex:resume", "resume"],
    ] as const) {
      mode = grant;
      handler(fakeEvent(), { sessionId, spawn: { file, cwd: "." } });
      await new Promise((resolve) => setTimeout(resolve, 60));
      ports[sessionId] = electronMocks.channels.at(-1)!.port1;
    }

    controller.closeSession(SESSION);
    for (const sessionId of [SESSION, FORK_SESSION, RESUME_SESSION]) {
      expect(ports[sessionId]!.closed).toBe(true);
    }
  });
});

/**
 * F6 — the window can go away in the middle of an open.
 *
 * `openTerminal` awaits three async hops, and both reply paths post to a
 * WebContents this host does not own. A destroyed sender THROWS on
 * `postMessage`, and that throw lands in a promise nothing was awaiting: an
 * unhandled rejection in Electron main, with no `unhandledRejection` handler
 * in this app to catch it.
 */
describe("a window that closes mid-open takes nothing down with it", () => {
  it("builds no channel at all when the sender is gone by the time a refusal is written", async () => {
    electronMocks.channels.length = 0;
    registerTerminalIpc({ resolveWorkspacePath: async () => null });
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const event = fakeEvent();
    handler(event, { sessionId: SESSION, spawn: { file: "codex", cwd: "." } });
    // The worktree lookup is in flight; the human closes the window.
    event.destroy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(event.posted).toHaveLength(0);
    // A refusal answers on its own one-frame channel. Building one for a window
    // that cannot receive it leaks both ports, once per closed window — so the
    // host must ask BEFORE it constructs the channel, not after.
    expect(electronMocks.channels).toHaveLength(0);
  });

  it("survives a sender that dies BETWEEN the check and the post", async () => {
    // The guard cannot win this race by construction, so the entry point must
    // not leave the rejection unhandled: `openTerminal` awaits three async
    // hops, so this is a real promise, and Electron main has no
    // `unhandledRejection` handler to fall back on.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      registerTerminalIpc(worktree);
      const handler = electronMocks.handlers.get("muon:openTerminal")!;
      const event = fakeEvent({ throwOnPost: true });
      handler(event, { sessionId: SESSION, spawn: { file: "codex", cwd: "." } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("creates no pty and no channel when the sender is gone before the port is handed over", async () => {
    electronMocks.channels.length = 0;
    registerTerminalIpc(worktree);
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const event = fakeEvent();
    handler(event, { sessionId: SESSION, spawn: { file: "codex", cwd: "." } });
    // The worktree + native-module hops are in flight; the window goes away.
    event.destroy();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(event.posted).toHaveLength(0);
    // The host builds its MessageChannel only AFTER `relay.open`, so a channel
    // count of zero is evidence that no pty was created either — a vendor CLI
    // whose only keyboard no longer exists is an orphan. (The argv is computed
    // before the check; computing a command line spawns nothing.)
    expect(electronMocks.channels).toHaveLength(0);

    // …and the id is left CLEAN: the next open from a live window really
    // opens, rather than reattaching to a half-registered ghost.
    const alive = fakeEvent();
    handler(alive, { sessionId: SESSION, spawn: { file: "codex", cwd: "." } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(alive.posted).toHaveLength(1);
    expect(electronMocks.channels).toHaveLength(1);
  });
});

// U1/U3 — a pty is born at the size the pane will be READ at.
//
// The renderer may state the grid it measured; it may not state anything else
// about the spawn. So the host takes the two numbers, bounds them, and drops
// them wholesale on anything that is not a plausible measurement — a wrong
// width is how a full-screen vendor TUI ends up painting its first frame into
// the wrong rectangle and reading as a distorted stream.
describe("the pane's measured geometry reaches the pty, bounded", () => {
  it("passes a measured grid through to the spawn resolver", async () => {
    await open(worktree, SESSION, "codex", { cols: 214, rows: 57 });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.overrides).toEqual({ cols: 214, rows: 57 });
  });

  it("keeps the host defaults when the renderer states no geometry", async () => {
    await open(worktree, SESSION, "codex");
    expect(spawnCalls).toHaveLength(1);
    // An EMPTY override set: the resolver is told nothing, so PtyHost's own
    // 80x24 stands and the first real fit resizes the child as before.
    expect(spawnCalls[0]?.overrides).toEqual({});
  });

  it.each([
    ["a zero width", { cols: 0, rows: 40 }],
    ["a negative height", { cols: 100, rows: -5 }],
    ["a fractional grid", { cols: 100.5, rows: 40 }],
    ["an absurd width", { cols: 999_999, rows: 40 }],
    ["a string smuggled in as a number", { cols: "200", rows: 40 }],
    ["only half a geometry", { cols: 200 }],
    ["a null", { cols: null, rows: null }],
  ])("drops %s and spawns at the host default instead", async (_label, bad) => {
    await open(worktree, SESSION, "codex", bad as Record<string, unknown>);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.overrides).toEqual({});
  });

  it("still refuses the open when the KIND is not allowlisted, geometry or not", async () => {
    const { errors } = await open(worktree, SESSION, "bash", {
      cols: 200,
      rows: 50,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/not allowed/i);
  });
});

/**
 * F3 — THE TAKEOVER SUFFIX LIST IS COPIED, SO THE COPY IS PINNED HERE.
 *
 * `renderer-chat-scope.ts` cannot import `terminal-host.ts` (it is reachable
 * from the preload boundary and that module pulls in Electron main), so the
 * set of takeover slots exists twice. Its comment claimed this file pinned the
 * pair; it did not — both constants were module-private, no test imported
 * either, and both suites only ever asserted string literals. A third suffix
 * added on one side would have shipped green, and a session id the close
 * authorizer does not recognise is a pty with no way to die and a fast-exit
 * record with no way to be forgotten.
 *
 * The claim is now the code: both lists are imported, and the close path is
 * driven from the HOST's list rather than from literals.
 */
describe("the two copies of the takeover slot list cannot drift", () => {
  it("names exactly the same slots on both sides of the preload boundary", () => {
    // Non-empty first: two empty lists would satisfy any equality check while
    // pinning nothing at all.
    expect(TERMINAL_TAKEOVER_SESSION_SUFFIXES.length).toBeGreaterThan(0);
    expect([...TAKEOVER_SESSION_SUFFIXES].sort()).toEqual(
      [...TERMINAL_TAKEOVER_SESSION_SUFFIXES].sort()
    );
  });

  it("authorizes a close for EVERY slot the host can open", async () => {
    // The behavioural half: a suffix the host knows must resolve back to its
    // JOB here, or nothing in the app can close that pty.
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
      getDispatchJob: vi.fn(async (jobId: string) => ({
        id: jobId,
        chatId: "chat-a",
      })),
    };
    const owned = createRendererChatOwnership();
    owned.note("chat-a");
    for (const suffix of TERMINAL_TAKEOVER_SESSION_SUFFIXES) {
      await expect(
        authorizeRendererTerminalClose(
          client as never,
          `${SESSION}${suffix}`,
          owned
        )
      ).resolves.toBeUndefined();
      expect(client.getDispatchJob).toHaveBeenLastCalledWith(JOB);
    }
  });

  it("sweeps EVERY slot the close authorizer knows from the plain job id", async () => {
    // …and the other direction: a suffix `renderer-chat-scope.ts` will
    // authorize a close for must be one the host's own sweep actually reaps,
    // or the close is authorized and then does nothing.
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    let mode: "fork" | "resume" = "fork";
    const controller = registerTerminalIpc({
      resolveWorkspacePath: async () => "/tmp",
      resolveVendorSession: async () => ({
        ok: true as const,
        vendor: "codex",
        sessionId: VENDOR_SESSION_ID,
        mode,
      }),
    });
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const ports = new Map<string, FakePort>();
    for (const suffix of TAKEOVER_SESSION_SUFFIXES) {
      mode = suffix === ".fork" ? "fork" : "resume";
      handler(fakeEvent(), {
        sessionId: `${SESSION}${suffix}`,
        spawn: { file: "codex:resume", cwd: "." },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      ports.set(`${SESSION}${suffix}`, electronMocks.channels.at(-1)!.port1);
    }
    expect(ports.size).toBe(TAKEOVER_SESSION_SUFFIXES.length);

    controller.closeSession(SESSION);
    for (const [sessionId, port] of ports) {
      expect(port.closed, `${sessionId} was never swept`).toBe(true);
    }
  });
});

/**
 * T1 — THE SESSION CAP.
 *
 * Every `terminal-chat:<chatId>:<kind>.<1..9999>` slot is authorized by the
 * same chat, across every terminal kind, so "authorized" said nothing about
 * HOW MANY. A renderer loop — hostile, or an ordinary remount bug — could ask
 * for ~10k real vendor children, each with a 256 KiB scrollback ring, inside
 * Electron main. No authority escalation required, which is what makes it a
 * consumer-readiness defect as much as a security one.
 *
 * MUTATION CHECK: deleting the `knownIds.length >= MAX_TERMINAL_SESSIONS`
 * refusal in terminal-host.ts fails "refuses the open past the cap" (the
 * (cap+1)-th open spawns and gets a port instead of an error frame).
 */
describe("the number of live terminal sessions is bounded", () => {
  /**
   * The echo driver, on purpose, for the tests that need a session to STAY
   * alive: the real path here spawns `/bin/echo` (the spawn mock neutralizes
   * the command), which exits instantly and arms the respawn guard, so a
   * reconnect would be refused for an unrelated reason. It also means these
   * tests create no OS processes at all.
   */
  function registerEchoTerminalIpc(
    deps: Parameters<typeof registerTerminalIpc>[0]
  ): ReturnType<typeof registerTerminalIpc> {
    const previous = process.env.MUON_REAL_PTY;
    process.env.MUON_REAL_PTY = "0";
    try {
      return registerTerminalIpc(deps);
    } finally {
      if (previous === undefined) {
        delete process.env.MUON_REAL_PTY;
      } else {
        process.env.MUON_REAL_PTY = previous;
      }
    }
  }

  /**
   * WHAT COUNTS AS ADMITTED. `spawnCalls` is the wrong measure here — the argv
   * is composed before the cap is read (computing a command line starts
   * nothing), so it counts attempts, not ptys. An ADMITTED open hands over a
   * port on a channel that never carries an error frame; a REFUSED one answers
   * on a one-frame channel whose only frame is the error.
   */
  const errorFrames = (): string[] =>
    electronMocks.channels
      .flatMap((channel) => channel.port1.sent)
      .filter(
        (frame): frame is Extract<TerminalHostFrame, { type: "error" }> =>
          frame.type === "error"
      )
      .map((frame) => frame.reason);

  const capRefusals = (): string[] =>
    errorFrames().filter((reason) => /most it will keep alive/.test(reason));

  const admittedChannels = (): number =>
    electronMocks.channels.filter((channel) =>
      channel.port1.sent.every((frame) => frame.type !== "error")
    ).length;

  async function openSlots(
    handler: (...args: unknown[]) => void,
    from: number,
    to: number
  ): Promise<ReturnType<typeof fakeEvent>[]> {
    const events: ReturnType<typeof fakeEvent>[] = [];
    for (let index = from; index <= to; index += 1) {
      const event = fakeEvent();
      events.push(event);
      handler(event, {
        sessionId: `terminal-chat:chat-a:shell.${index}`,
        spawn: { file: "shell", cwd: "." },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return events;
  }

  it("refuses the open past the cap, with a stated reason and no session", async () => {
    electronMocks.channels.length = 0;
    registerEchoTerminalIpc(worktree);
    const handler = electronMocks.handlers.get("muon:openTerminal")!;

    await openSlots(handler, 1, MAX_TERMINAL_SESSIONS);
    expect(admittedChannels()).toBe(MAX_TERMINAL_SESSIONS);
    expect(errorFrames()).toHaveLength(0);

    const [refused] = await openSlots(
      handler,
      MAX_TERMINAL_SESSIONS + 1,
      MAX_TERMINAL_SESSIONS + 3
    );
    // No new sessions…
    expect(admittedChannels()).toBe(MAX_TERMINAL_SESSIONS);
    // …and every refused pane was TOLD, rather than left blank.
    expect(capRefusals()).toHaveLength(3);
    const frames = electronMocks.channels.at(-1)!.port1.sent;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "error" });
    expect(refused!.posted).toHaveLength(1);
  });

  it("still admits a RECONNECT to an id it already holds while at the cap", async () => {
    // The cap must bound CREATION, never re-attachment: a renderer reload at a
    // full registry would otherwise permanently blank every open pane.
    electronMocks.channels.length = 0;
    registerEchoTerminalIpc(worktree);
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    await openSlots(handler, 1, MAX_TERMINAL_SESSIONS);

    const reconnect = fakeEvent();
    handler(reconnect, {
      sessionId: "terminal-chat:chat-a:shell.1",
      spawn: { file: "shell", cwd: "." },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(capRefusals()).toHaveLength(0);
    expect(reconnect.posted).toHaveLength(1);
  });

  it("frees a slot when a session is closed", async () => {
    electronMocks.channels.length = 0;
    const controller = registerEchoTerminalIpc(worktree);
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    await openSlots(handler, 1, MAX_TERMINAL_SESSIONS);

    controller.closeSession("terminal-chat:chat-a:shell.1");
    await openSlots(handler, MAX_TERMINAL_SESSIONS + 1, MAX_TERMINAL_SESSIONS + 1);
    expect(capRefusals()).toHaveLength(0);
    expect(admittedChannels()).toBe(MAX_TERMINAL_SESSIONS + 1);
  });

  it("holds even when every open is fired in one synchronous burst", async () => {
    // THE ACTUAL ATTACK SHAPE, and the reason this test runs on the REAL path:
    // every handler runs its synchronous prefix and parks on an await before
    // any of them registers a session, so a cap read before those awaits would
    // answer "0 live" 96 times. That is what pins the check to the last
    // synchronous instant before `relay.open`.
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    registerTerminalIpc(worktree);
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    const burst = MAX_TERMINAL_SESSIONS * 3;
    for (let index = 1; index <= burst; index += 1) {
      handler(fakeEvent(), {
        sessionId: `terminal-chat:chat-a:shell.${index}`,
        spawn: { file: "shell", cwd: "." },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Every one of them composed an argv (that starts nothing)…
    expect(spawnCalls).toHaveLength(burst);
    // …and exactly the cap became real sessions.
    expect(admittedChannels()).toBe(MAX_TERMINAL_SESSIONS);
    expect(capRefusals()).toHaveLength(burst - MAX_TERMINAL_SESSIONS);
  });
});

/**
 * T6 — RENDERER TEXT IN A HOST-AUTHORED FRAME.
 *
 * `spawn.file` is the renderer's kind hint and it is echoed back by the
 * un-allowlisted-kind refusal, so the protocol's "reason is HOST-authored prose
 * only" was false as written. Nothing was demonstrably escalated by it (the
 * renderer already owns its DOM), but a control byte reaching Electron main's
 * stderr repaints the operator's REAL terminal, and an unbounded kind is an
 * unbounded frame. `terminalSafe` already existed and was simply not used here.
 *
 * MUTATION CHECK: removing `hostReason` from `refuseOpen` (or
 * `terminalKindLabel` from the resolver's throws) fails both of these — the ESC
 * and the CR come back through verbatim.
 */
describe("a refusal never echoes renderer control bytes", () => {
  it("flattens ANSI/CR out of the kind it names", async () => {
    const hostile = "\u001b[2Jcodex\rWIPED\u0007";
    const { errors } = await open(worktree, SESSION, hostile);
    expect(errors).toHaveLength(1);
    const reason = errors[0]!.reason;
    expect(reason).toMatch(/not allowed/);
    // The kind is still NAMED (that is what makes the refusal useful)…
    expect(reason).toContain("codex");
    // …but nothing in it can move a cursor or clear a screen.
    for (const byte of ["\u001b", "\r", "\n", "\u0007"]) {
      expect(reason.includes(byte)).toBe(false);
    }
  });

  it("bounds the length of what it echoes", async () => {
    const { errors } = await open(worktree, SESSION, "x".repeat(50_000));
    expect(errors).toHaveLength(1);
    // Bounded twice over: the kind label first, then the whole reason.
    expect(errors[0]!.reason.length).toBeLessThan(500);
  });

  /**
   * `refuseOpen`'s own sanitize, pinned on the ONE reason that does not come
   * from a literal in this module: a lookup dep's refusal sentence is forwarded
   * verbatim (`refuseOpen(event, id, recorded.reason)`), and that sentence is
   * composed elsewhere — including, in production, by the vendor's own session
   * store. The kind label upstream cannot help here, so this is what makes
   * `hostReason` load-bearing rather than decorative.
   */
  it("flattens a lookup dep's refusal sentence too, not just the kind", async () => {
    const { errors } = await open(
      {
        ...worktree,
        resolveVendorSession: async () => ({
          ok: false as const,
          reason: "\u001b[2Jthe store said\rno\u0007",
        }),
      },
      RESUME_SESSION,
      "codex:resume"
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toContain("the store said");
    for (const control of ["\u001b", "\r", "\n", "\u0007"]) {
      expect(errors[0]!.reason.includes(control)).toBe(false);
    }
  });
});

/**
 * F5 — A REFUSAL MUST NOT LEAK ITS OWN CHANNEL.
 *
 * `refuseOpen` asks `isDestroyed()` before it builds the MessageChannelMain,
 * which is right — but a check is not a lock. When the window dies in the gap
 * between the check and the transfer, `event.sender.postMessage` throws, and
 * the `port1.close()` that used to sit AFTER it never ran: port1 stayed open,
 * port2 was never transferred and therefore never closed by the transfer
 * either, and the entry point's `.catch` swallowed the throw. One leaked pair
 * per lost race, in a main process that never restarts.
 */
describe("a refusal that cannot be delivered still closes its channel", () => {
  it("closes BOTH ports when the transfer throws mid-refusal", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      electronMocks.channels.length = 0;
      // A refusal path (the worktree cannot be resolved) on a sender that
      // passes `isDestroyed()` and then throws on the transfer.
      registerTerminalIpc({ resolveWorkspacePath: async () => null });
      const handler = electronMocks.handlers.get("muon:openTerminal")!;
      handler(fakeEvent({ throwOnPost: true }), {
        sessionId: SESSION,
        spawn: { file: "codex", cwd: "." },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(electronMocks.channels).toHaveLength(1);
      const channel = electronMocks.channels[0]!;
      // The frame was written before the transfer — that part always worked.
      expect(channel.port1.sent).toHaveLength(1);
      expect(channel.port1.closed).toBe(true);
      expect(channel.port2.closed).toBe(true);
      // …and the throw is still absorbed, exactly as before.
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

/**
 * ROADMAP T4 — `scrollbackSnapshot`, the parked-runtime LRU's "from host if
 * available" replay path: a read-only export of a LIVE session's retained
 * scrollback, callable at any point in the run (not just at quit, which is
 * `exportScrollback`'s original T1 caller). The underlying ring itself —
 * what it retains, how it joins frames — is exercised at the `PtyHost` level
 * in `packages/runner/tests/pty-host.test.ts`; this is just the desktop-side
 * wrapper's own two rules: validate the id shape, and answer null rather
 * than throw for anything it does not recognize.
 */
describe("scrollbackSnapshot — ROADMAP T4 host-scrollback bridge", () => {
  it("returns the retained scrollback for a live session, geometry included", async () => {
    electronMocks.channels.length = 0;
    spawnCalls.length = 0;
    const controller = registerTerminalIpc({ ...worktree });
    const handler = electronMocks.handlers.get("muon:openTerminal")!;
    handler(fakeEvent(), {
      sessionId: SESSION,
      spawn: { file: "shell", cwd: ".", cols: 100, rows: 30 },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const snapshot = controller.scrollbackSnapshot(SESSION);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({ cols: 100, rows: 30 });
    expect(typeof snapshot?.text).toBe("string");
  });

  it("answers null for a session id it has never opened", () => {
    const controller = registerTerminalIpc({ ...worktree });
    expect(controller.scrollbackSnapshot("terminal-chat:never-opened")).toBeNull();
  });

  it("answers null (never throws) for a malformed/oversized session id", () => {
    const controller = registerTerminalIpc({ ...worktree });
    expect(controller.scrollbackSnapshot("../../etc/passwd")).toBeNull();
    expect(controller.scrollbackSnapshot("x".repeat(400))).toBeNull();
    expect(controller.scrollbackSnapshot("")).toBeNull();
  });
});
