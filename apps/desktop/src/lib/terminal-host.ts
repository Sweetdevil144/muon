import {
  MessageChannelMain,
  ipcMain,
  type IpcMainEvent,
  type MessagePortMain,
} from "electron";
import { PtyHost, type PtyDriver, type PtySpawnOptions } from "@muon/runner";
import { terminalSafe } from "@muon/client";
import { PtyRelay } from "./pty-relay.js";
import { EchoPtyDriver } from "./echo-pty-driver.js";
import { createNodePtyDriver } from "./node-pty-driver.js";
import {
  createTerminalRespawnGuard,
  resolveTerminalSpawn,
  TERMINAL_RESUME_KIND_SUFFIX,
  type TerminalTakeoverMode,
} from "./terminal-spawn.js";
import { isJobTerminalAttachId } from "./job-terminal-attach.js";
import { CHAT_TERMINAL_SESSION_PREFIX } from "./terminal-session-id.js";
import type {
  TerminalClientFrame,
  TerminalHostFrame,
  TerminalRelayPort,
  TerminalSpawn,
} from "../shared/terminal-protocol.js";

/** Wrap an Electron MessagePortMain as the transport-agnostic relay port. */
function adaptRelayPort(port: MessagePortMain): TerminalRelayPort {
  port.start();
  return {
    post: (frame) => port.postMessage(frame),
    onFrame: (listener) =>
      port.on("message", (event) =>
        listener(event.data as TerminalClientFrame)
      ),
    onClose: (listener) => port.on("close", listener),
  };
}

/**
 * Register the Wave 4 §2.5 terminal byte relay in Electron MAIN.
 *
 * REAL PATH (the default): Electron main spawns the operator-requested native
 * shell/vendor CLI — or RESUMES a dispatched job's own vendor session
 * (`<vendor>:resume`) — on a genuine node-pty, from a fixed host allowlist and
 * a host-resolved workspace. The renderer can name only a terminal kind, never
 * argv/env/cwd, and never a session id. Dispatched autonomous agents remain in
 * the detached confined runner; this path is the human's interactive terminal.
 *
 * WHAT THE TYPED WIRE GUARANTEES, scoped to what it actually holds: the frames
 * MUON constructs carry bytes, coordinates, and host-authored prose only —
 * `resolveTerminalSpawn` strips MUON's own control-plane tokens (and GitHub
 * tokens for a vendor kind) from the child's environment, so no MUON operator,
 * agent, or delegation capability is placed into the session. This is NOT a
 * claim that nothing sensitive can ever appear in the pane: the child inherits
 * the operator's own ambient environment (that is BYO-auth — the vendor CLI
 * must find its own credentials), and anything the child PRINTS crosses as
 * `data` bytes like any other console output. It is the human's own terminal,
 * with the human's own posture.
 *
 * FALLBACK PATH: when node-pty genuinely cannot load in this runtime (or
 * MUON_REAL_PTY=0 opts out), the PtyHost runs the dependency-free
 * EchoPtyDriver instead — a stated diagnostic, with the load error printed in
 * the pane banner, never a fake quietly posing as a terminal.
 */
export type TerminalHostDeps = {
  /**
   * Resolve a job's worktree path HOST-side, from the jobId embedded in the
   * terminal sessionId (`terminal-<jobId>`). Used only on the real-pty path so
   * a subagent's terminal opens IN its own worktree — the renderer never names
   * the cwd (it is untrusted).
   */
  resolveWorkspacePath?: (jobId: string) => Promise<string | null>;
  /**
   * Resolve a job's recorded vendor session HOST-side (vendor + the
   * `vendorSessionId` the lease-holding runner stamped, plus the MODE the
   * job's own status authorizes), for a `<vendor>:resume` open. The renderer
   * names only the takeover KIND; the id that reaches `claude --resume` /
   * `codex resume`, and the choice between continuing that session and
   * FORKING it, both come from here — the spawn resolver re-validates the
   * id's shape besides. Null (or an absent dep) refuses the open — fail
   * closed, never a fresh session mislabelled as the dispatched one.
   */
  resolveVendorSession?: (
    jobId: string
  ) => Promise<
    | {
        ok: true;
        vendor: string;
        sessionId: string;
        mode: TerminalTakeoverMode;
      }
    | { ok: false; reason: string }
  >;
};

/**
 * One HUMAN session's retained scrollback, read at the instant `before-quit`
 * begins — the raw ingredient `human-terminal-snapshot.ts` turns into a
 * cold-restore file. Scope is `terminal-chat:` ids ONLY (see
 * `snapshotHumanSessions`): a job's own worktree terminal
 * (`terminal-<jobId>`) is dispatch-adjacent and deliberately excluded — T1 is
 * "non-dispatch human tabs ONLY".
 */
export type HumanTerminalScrollbackSnapshot = {
  sessionId: string;
  text: string;
  cols: number;
  rows: number;
};

export type TerminalHostController = {
  /** Deliberately destroy one PTY session and its renderer channel. */
  closeSession(sessionId: string): void;
  /**
   * Destroy EVERY human session this host owns (`kill` each pty child).
   * Called on app quit: these are desktop-side interactive sessions (vendor
   * tabs, shells, resume panes), and a pty child must never outlive the
   * window that owns its only keyboard — the runner-side reaper
   * (`terminateLanePtyChildren`) covers the governed lanes, this covers ours.
   */
  closeAllSessions(): void;
  /**
   * Destroy every session bound to one chat's workspace — the legacy
   * single-shell id AND all vendor-tab slots (`terminal-chat:<chatId>:…`).
   * Called on archive, where main cannot know which ordinals the renderer
   * opened; enumeration here is what keeps "Claude 2" from surviving as an
   * orphan.
   */
  closeChatSessions(chatId: string): void;
  /** What the spawn door is actually backed by right now. Honest: `fallback`
   *  means the echo diagnostic, never a claimed-but-absent real terminal. */
  realPtyState(): "loading" | "real" | "fallback" | "disabled";
  /**
   * T1 (cold-restore) — a read-only snapshot of every live HUMAN tab's
   * scrollback right now, scoped to `terminal-chat:` session ids (the vendor
   * tab bar + the plain shell tab). Never a job's own worktree terminal
   * (`terminal-<jobId>`, opened from an agent tab's "Start a new session" or
   * takeover doors) — those are dispatch-adjacent and T1 is explicitly
   * non-dispatch tabs only. Called from `before-quit`'s `onBegin`, BEFORE
   * `closeAllSessions()` destroys the very ptys this reads.
   */
  snapshotHumanSessions(): HumanTerminalScrollbackSnapshot[];
  /**
   * ROADMAP T4 — the parked-runtime LRU's "from host if available" replay
   * path: read ONE live session's retained scrollback right now, the SAME
   * `PtyHost.exportScrollback` ring `snapshotHumanSessions` reads at quit,
   * just callable at any point in the run. Read-only (no mutation, no
   * attach/detach) and never scoped to `terminal-chat:` the way
   * `snapshotHumanSessions` is — a takeover pane (`.resume`/`.fork`) and a
   * job's own worktree terminal are equally real parked panes. `null` for an
   * unknown/exited session id.
   */
  scrollbackSnapshot(
    sessionId: string
  ): { text: string; cols: number; rows: number } | null;
};

const TERMINAL_SESSION_ID = /^[A-Za-z0-9._:-]{1,300}$/;

/**
 * THE CAP ON LIVE TERMINAL SESSIONS in this window.
 *
 * Every session id in `terminal-chat:<chatId>:<kind>.<1..9999>` is authorized
 * by the SAME chat, and the slot pattern admits four-digit ordinals across
 * every terminal kind — so "authorized" said nothing at all about how many. A
 * renderer loop (hostile, or an ordinary remount bug) could therefore ask for
 * ~10k real vendor children, each with a 256 KiB scrollback ring, inside
 * Electron main. That is a machine-level denial of service reachable without
 * any authority escalation whatsoever, which makes it a consumer-readiness
 * defect as much as a security one.
 *
 * The number is deliberately generous for a human — nobody keeps 32 terminals
 * open — and deliberately finite. Reaching it is a REFUSAL with a sentence
 * (refuseOpen), never a silent drop: a pane that explains why it did not start
 * is the whole point of the typed error frame. `PtyHost` carries the same bound
 * as a backstop for any other caller.
 */
export const MAX_TERMINAL_SESSIONS = 32;

/**
 * Bound + flatten prose before it leaves this host on a frame or on stderr.
 *
 * The protocol says a `reason` is HOST-authored prose only (see
 * terminal-protocol.ts), and until now that was a claim rather than a fact: the
 * spawn resolver's "terminal kind '…' is not allowed" carries `spawn.file`,
 * which is arbitrary renderer text — ANSI, a bare CR, C1 introducers, any
 * length. Nothing was demonstrably escalated by it (the renderer already owns
 * its own DOM), but a control byte that reaches main's stderr repaints the
 * operator's real terminal, and an unbounded string is an unbounded frame.
 * `terminalSafe` is the repo's one sanitizer for exactly this
 * (packages/client/src/terminal-safe.ts); the length bound is the other half it
 * does not do.
 */
const MAX_REASON_CHARS = 400;

function hostReason(reason: string): string {
  const flattened = terminalSafe(reason);
  return flattened.length > MAX_REASON_CHARS
    ? `${flattened.slice(0, MAX_REASON_CHARS)}…`
    : flattened;
}

/**
 * The bound on a renderer-supplied terminal geometry.
 *
 * The renderer may state the size it will READ the child at — the same class
 * of fact the `resize` frame already carries, and the reason a vendor TUI's
 * FIRST paint can be at the right width instead of the driver's 80×24. It is
 * still untrusted input reaching a native spawn, so it is bounded here rather
 * than trusted: a non-integer, a zero, or an absurd value is dropped and the
 * host keeps its own defaults. Nothing about WHAT is spawned, or WHERE, can be
 * influenced by these two numbers.
 */
const MIN_TERMINAL_COLS = 2;
const MAX_TERMINAL_COLS = 1000;
const MIN_TERMINAL_ROWS = 2;
const MAX_TERMINAL_ROWS = 500;

export function boundTerminalGeometry(spawn: {
  cols?: unknown;
  rows?: unknown;
}): { cols?: number; rows?: number } {
  const bound = (
    value: unknown,
    min: number,
    max: number
  ): number | undefined =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
      ? value
      : undefined;
  const cols = bound(spawn.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
  const rows = bound(spawn.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
  // BOTH or NEITHER: half a geometry is not a geometry, and pairing a measured
  // width with a defaulted height is a shape no pane ever actually has.
  return cols !== undefined && rows !== undefined ? { cols, rows } : {};
}

/**
 * A takeover open reuses the job's spawn coordinate with one of these suffixes,
 * so it can coexist with (and never join) the plain new-session pty for the
 * same job.
 *
 * ONE SUFFIX PER MODE, and that is load-bearing — a fork and a resume are
 * DIFFERENT vendor sessions, so they must not share a pty slot.
 *
 * What sharing one cost: `PtyHost.detach` keeps a session whose child has not
 * exited, and `PtyRelay.open` no-ops while the host still holds the id. So a
 * fork opened mid-run stayed alive after its pane closed, and the re-open once
 * the job finished — freshly authorized as `codex resume <id>`, argv duly
 * computed — was DISCARDED and the human was re-attached to the old fork,
 * under a pane that now said "this is the session MUON dispatched". Two
 * coordinates make that structurally impossible: the resume open names a slot
 * the host has never spawned, so it really spawns.
 *
 * The suffix is renderer-supplied and grants NOTHING: `openTerminal` requires
 * it to MATCH the mode the host's own lookup granted, and refuses otherwise.
 * That is what stops an untrusted renderer from opening two `codex resume`
 * ptys on one finished transcript by naming both slots.
 */
export const TERMINAL_RESUME_SESSION_SUFFIX = ".resume";
export const TERMINAL_FORK_SESSION_SUFFIX = ".fork";

/** Every takeover slot, keyed by the mode that is allowed to occupy it. */
const TERMINAL_TAKEOVER_SESSION_SUFFIX: Readonly<
  Record<TerminalTakeoverMode, string>
> = {
  resume: TERMINAL_RESUME_SESSION_SUFFIX,
  fork: TERMINAL_FORK_SESSION_SUFFIX,
};

/**
 * THE AUTHORITATIVE LIST, derived from the total table above so a new mode
 * cannot be forgotten here.
 *
 * Exported for ONE reason: `renderer-chat-scope.ts` must know the same set to
 * authorize a close, and it cannot import this module (it is reachable from
 * the preload boundary and this one pulls in Electron main). That copy is
 * pinned against this list by `terminal-host-ipc.test.ts` — a real assertion
 * over both modules, because the drift it guards is a session id nothing in
 * the app can authorize a close for, i.e. a pty with no way to die.
 */
export const TERMINAL_TAKEOVER_SESSION_SUFFIXES: readonly string[] =
  Object.values(TERMINAL_TAKEOVER_SESSION_SUFFIX);

/** The takeover slot this session id names, or null for a plain session. */
function takeoverSessionSuffix(sessionId: string): string | null {
  return (
    TERMINAL_TAKEOVER_SESSION_SUFFIXES.find((suffix) =>
      sessionId.endsWith(suffix)
    ) ?? null
  );
}

export function registerTerminalIpc(
  deps: TerminalHostDeps = {}
): TerminalHostController {
  // REAL BY DEFAULT. node-pty ≥1.x is N-API based, so the prebuilt binary
  // loads under this Electron without an ABI rebuild (verified live); the
  // dependency-free echo driver remains ONLY as a stated diagnostic fallback
  // for a runtime where the native module genuinely cannot load, and
  // MUON_REAL_PTY=0 remains an explicit escape hatch. The open path awaits
  // this promise: without that fence, a fast renderer open can permanently
  // create an echo session milliseconds before the native module finishes
  // loading.
  let nodePty: unknown = null;
  let nodePtyLoadError: string | null = null;
  const realPtyRequested = process.env.MUON_REAL_PTY !== "0";
  const nodePtyReady: Promise<unknown | null> = realPtyRequested
    ? import("node-pty")
      .then((mod) => {
        nodePty = mod;
        return mod;
      })
      .catch((error) => {
        nodePtyLoadError =
          error instanceof Error ? error.message : "unknown native-module error";
        process.stderr.write(
          `muon: real pty requested but node-pty failed to load (${nodePtyLoadError}); using the diagnostic fallback.\n`
        );
        return null;
      })
    : Promise.resolve(null);
  const makeDriver = (options: PtySpawnOptions): PtyDriver =>
    nodePty
      ? createNodePtyDriver(
          nodePty as Parameters<typeof createNodePtyDriver>[0],
          options
        )
      : new EchoPtyDriver(options);

  // A spawn must never re-trigger itself: an id whose child died on startup is
  // not spawned again by a remount/reload, it is refused with a sentence.
  const respawnGuard = createTerminalRespawnGuard();
  // The guard is armed by the PTY HOST, at the OS-level exit — NOT by the exit
  // frame a consumer happens to receive. The frame only reaches a consumer
  // that is attached, and the founder's loop is precisely the case where none
  // is: open "+ Cursor", switch tabs within a moment (the pane unmounts and
  // its port closes), let `cursor-agent` exit unwatched. Armed from the frame,
  // the guard never saw that death at all, and the next look at the pane
  // started another one.
  const host = new PtyHost(makeDriver, {
    // The same bound the door below enforces, restated where the sessions
    // actually live. The door's refusal is the one a human reads; this one is
    // what holds if a future call path reaches the host without passing it.
    maxSessions: MAX_TERMINAL_SESSIONS,
    onSessionExit: (sessionId, exit) => {
      respawnGuard.noteExit(sessionId, {
        exitCode: exit.exitCode,
        lifetimeMs: exit.lifetimeMs,
      });
    },
  });
  const relay = new PtyRelay(host);
  // The main-side port per live session, so a reconnect can free the prior one
  // (the port + its listeners would leak otherwise).
  const activePorts = new Map<string, MessagePortMain>();
  // Every open/close advances the session generation. This is stronger than a
  // tombstone: if open(A) awaits the native module, close(A) runs, and the human
  // immediately reopens A, the first stale open still cannot resurrect or steal
  // the new renderer port after the second open clears the close state.
  const sessionGenerations = new Map<string, number>();
  const advanceSession = (sessionId: string): number => {
    const generation = (sessionGenerations.get(sessionId) ?? 0) + 1;
    sessionGenerations.set(sessionId, generation);
    return generation;
  };

  const tearDownSession = (sessionId: string): void => {
    advanceSession(sessionId);
    // A deliberate close clears the fast-exit record: the human may always
    // start a fresh session; only the AUTOMATIC re-open is guarded.
    respawnGuard.forget(sessionId);
    activePorts.get(sessionId)?.close();
    activePorts.delete(sessionId);
    if (host.has(sessionId)) {
      host.close(sessionId);
    }
  };

  const closeSession = (sessionId: string): void => {
    if (!TERMINAL_SESSION_ID.test(sessionId)) {
      return;
    }
    tearDownSession(sessionId);
    // A job's TAKEOVER panes hang off the same coordinate with a `.resume` or
    // `.fork` suffix, and every close call site in the renderer names the
    // plain one (closing a job tab, archiving a chat, ⌘W). Without this the
    // takeover pty outlived the tab that owned its keyboard, and — worse — its
    // fast-exit record was never forgotten, so one `claude` that was not yet on
    // PATH refused that job's resume for the life of the app process with no
    // way back. EVERY suffix is swept, not just the first one that existed: a
    // slot nothing can close is a slot that leaks a live vendor child. No
    // authority is widened — both siblings are authorized by the SAME job as
    // the id being closed (renderer-chat-scope.ts strips either suffix).
    if (!takeoverSessionSuffix(sessionId)) {
      for (const suffix of TERMINAL_TAKEOVER_SESSION_SUFFIXES) {
        tearDownSession(`${sessionId}${suffix}`);
      }
    }
  };

  /** Every id this host currently knows: live ptys plus ports still waiting
   *  on an open that has not registered yet. */
  const knownSessionIds = (): string[] => [
    ...new Set([...host.list(), ...activePorts.keys()]),
  ];

  const closeAllSessions = (): void => {
    for (const sessionId of knownSessionIds()) {
      closeSession(sessionId);
    }
  };

  const snapshotHumanSessions = (): HumanTerminalScrollbackSnapshot[] => {
    const entries: HumanTerminalScrollbackSnapshot[] = [];
    for (const sessionId of knownSessionIds()) {
      if (!sessionId.startsWith(CHAT_TERMINAL_SESSION_PREFIX)) {
        continue; // dispatch/job worktree terminal — excluded by scope, above.
      }
      const exported = host.exportScrollback(sessionId);
      if (exported) {
        entries.push({ sessionId, ...exported });
      }
    }
    return entries;
  };

  const closeChatSessions = (chatId: string): void => {
    if (!chatId) {
      return;
    }
    const exact = `terminal-chat:${chatId}`;
    const slotted = `${exact}:`;
    for (const sessionId of knownSessionIds()) {
      if (sessionId === exact || sessionId.startsWith(slotted)) {
        closeSession(sessionId);
      }
    }
  };

  ipcMain.on(
    "muon:openTerminal",
    (
      event: IpcMainEvent,
      input: { sessionId: string; spawn: TerminalSpawn }
    ): void => {
      // `openTerminal` awaits three async hops (the native module, the
      // worktree lookup, the vendor-session lookup), so this is a REAL promise
      // that can reject long after the handler returned — and an unhandled
      // rejection in Electron main takes the process down on a runtime that
      // enables `--unhandled-rejections=throw`. There is no `unhandledRejection`
      // handler in this app. The window closing mid-open is the ordinary way to
      // reach it, and losing the window is not a reason to lose the app.
      void openTerminal(event, input).catch((error) => {
        process.stderr.write(
          `muon: terminal open failed (${
            error instanceof Error ? error.message : "unknown error"
          })\n`
        );
      });
    }
  );

  /**
   * Is the renderer that asked still there to be answered?
   *
   * Every reply below crosses to a WebContents this host does not own, and a
   * destroyed one throws on `postMessage`. Main guards its other sends the same
   * way (main.ts's assistant/status relays). Nothing is spawned or torn down on
   * a false answer — the open simply has no one to tell.
   */
  function senderAlive(event: IpcMainEvent): boolean {
    return !event.sender.isDestroyed();
  }

  /**
   * Answer a refused open with a typed reason instead of silence.
   *
   * Every refusal below used to be a stderr line plus an early `return`, which
   * left the renderer awaiting a port that never arrived — a permanently blank
   * pane the human could not tell from a hung terminal. A refusal is a normal
   * outcome, so it gets a channel and a sentence: the renderer renders it and
   * the pane is honest about why nothing started. Nothing is spawned, and no
   * session is registered, on this path.
   */
  function refuseOpen(
    event: IpcMainEvent,
    sessionId: string,
    reason: string
  ): void {
    // SANITIZED ONCE, HERE, for both destinations. Most reasons below are
    // literals, but the spawn resolver's are built around the renderer's kind
    // hint, so this path is not host-authored end to end and must not be
    // trusted as if it were (see hostReason).
    const safeReason = hostReason(reason);
    process.stderr.write(`muon: refused terminal open (${safeReason})\n`);
    // The stderr line above is the record; a gone window still gets one, it
    // just gets no port. Building the channel first and discarding it would
    // leak two ports per closed window.
    if (!senderAlive(event)) {
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    port1.postMessage({
      type: "error",
      reason: safeReason,
    } satisfies TerminalHostFrame);
    try {
      event.sender.postMessage("muon:terminal-port", { sessionId }, [port2]);
    } catch (error) {
      // The transfer did NOT happen, so this side still owns port2 as well —
      // an untransferred port is not closed by the throw that prevented it.
      port2.close();
      throw error;
    } finally {
      // The channel exists only to carry this one frame — INCLUDING when the
      // post above throws. `isDestroyed()` is a check, not a lock: the window
      // can die between it and the transfer, and a bare `port1.close()` placed
      // after the post never ran on that path. The rejection is absorbed by
      // the entry point's `.catch`, which is exactly what kept the leaked pair
      // invisible — one per lost race, in a process that never restarts.
      port1.close();
    }
  }

  async function openTerminal(
    event: IpcMainEvent,
    input: { sessionId: string; spawn: TerminalSpawn }
  ): Promise<void> {
    {
      if (!TERMINAL_SESSION_ID.test(input.sessionId)) {
        // The one case with no answer: an id this malformed cannot be echoed
        // back safely, and no renderer of ours produces it.
        process.stderr.write("muon: refused terminal open (invalid session id).\n");
        return;
      }
      // 0038 — an ATTACH coordinate is not a SPAWN coordinate. `pty:job:<jobId>
      // :<epoch>` names a dispatched job's already-running console, which a
      // viewer READS through `muon:jobTerminal`; `terminal-<jobId>` means "start
      // a fresh interactive vendor CLI in this job's worktree". Handing the
      // first to this door would launch an ungoverned second process — the exact
      // defect U1 closed — so it is refused HERE, explicitly, rather than left
      // to fail later when the worktree lookup happens to miss.
      if (isJobTerminalAttachId(input.sessionId)) {
        refuseOpen(
          event,
          input.sessionId,
          "this is a governed agent's live console, which MUON attaches to read-only; it cannot be opened as a new terminal."
        );
        return;
      }
      // The respawn guard, checked BEFORE anything is resolved or spawned: a
      // session whose child died on startup is never silently started again
      // under the same id (see createTerminalRespawnGuard).
      const respawnRefusal = respawnGuard.refuseRespawn(input.sessionId);
      if (respawnRefusal) {
        // The refusal answers on its own one-frame channel and never attaches,
        // so a dead session still sitting in the registry (it exited while
        // nothing was attached, which is why `detach` did not reap it) can
        // never be read again. Drop it and its scrollback here, at the moment
        // we know no consumer will ever see it. The guard's record survives —
        // only an explicit close clears that.
        if (host.has(input.sessionId)) {
          host.close(input.sessionId);
        }
        refuseOpen(event, input.sessionId, respawnRefusal);
        return;
      }
      const generation = advanceSession(input.sessionId);
      if (realPtyRequested) {
        await nodePtyReady;
      }
      if (sessionGenerations.get(input.sessionId) !== generation) {
        return;
      }
      // Finding 7: for a REAL pty the command/args/env are resolved HOST-side from
      // the renderer's KIND hint (input.spawn.file), NEVER its raw file/args/env —
      // a renderer is untrusted, so it must not be able to name what gets spawned.
      // The echo path uses the (inert) renderer spawn as a banner label.
      //
      // The pane's measured grid is the ONE renderer-supplied value that
      // survives, bounded (boundTerminalGeometry): the child is born at the
      // size it will be read at, so a full-screen vendor TUI does not paint its
      // first frame at 80 columns into a 200-column pane.
      const geometry = boundTerminalGeometry(input.spawn);
      let spawn: PtySpawnOptions = { ...input.spawn, ...geometry };
      if (nodePty) {
        // The cwd is also HOST-derived: strip the `terminal-` prefix (and the
        // `.resume`/`.fork` suffix of a takeover open) to recover the jobId,
        // look up its worktree, and start the vendor THERE — never in the
        // renderer-provided cwd. If the worktree can't be resolved (no resolver
        // wired, unknown jobId, or the lookup throws), REFUSE the open rather
        // than falling back to the app's own launch directory — a real vendor
        // CLI must never run outside a job's own worktree.
        const rawId = input.sessionId.startsWith("terminal-")
          ? input.sessionId.slice("terminal-".length)
          : input.sessionId;
        const takeoverSuffix = takeoverSessionSuffix(rawId);
        const jobId = takeoverSuffix
          ? rawId.slice(0, -takeoverSuffix.length)
          : rawId;
        // `<vendor>:resume` is the renderer's HINT that this open should
        // reopen the job's own dispatched vendor session; both the hint and
        // the session-id suffix must agree, or the open is refused rather
        // than guessed at. The hint is the SAME for both doors on purpose —
        // the renderer names a takeover, never which kind of takeover.
        const resumeKindRequested = input.spawn.file.endsWith(
          TERMINAL_RESUME_KIND_SUFFIX
        );
        if ((takeoverSuffix !== null) !== resumeKindRequested) {
          refuseOpen(
            event,
            input.sessionId,
            "a resume kind and a resume session id must be presented together; MUON refused rather than guessing which one was meant."
          );
          return;
        }
        const kind = resumeKindRequested
          ? input.spawn.file.slice(0, -TERMINAL_RESUME_KIND_SUFFIX.length)
          : input.spawn.file;
        let cwd: string | null = null;
        try {
          cwd = deps.resolveWorkspacePath
            ? await deps.resolveWorkspacePath(jobId)
            : null;
        } catch {
          cwd = null; // resolution failure — refuse below, never fall back
        }
        if (sessionGenerations.get(input.sessionId) !== generation) {
          return;
        }
        if (!cwd) {
          refuseOpen(
            event,
            input.sessionId,
            "MUON could not resolve this job's worktree — it may belong to another mission, or the mission may have been archived. A vendor CLI is never started outside a job's own worktree."
          );
          return;
        }
        // Resume data is HOST-looked-up from the job record; the renderer's
        // only contribution is the kind hint above. No recorded session, a
        // vendor mismatch, or a malformed id all refuse (in the resolver).
        let resume:
          | { vendor: string; sessionId: string; mode: TerminalTakeoverMode }
          | undefined;
        if (resumeKindRequested) {
          let recorded:
            | {
                ok: true;
                vendor: string;
                sessionId: string;
                mode: TerminalTakeoverMode;
              }
            | { ok: false; reason: string } = {
            ok: false,
            reason:
              "this build cannot look up a job's vendor session, so it cannot reopen one.",
          };
          try {
            if (deps.resolveVendorSession) {
              recorded = await deps.resolveVendorSession(jobId);
            }
          } catch {
            recorded = {
              ok: false,
              reason:
                "MUON could not read this job while authorizing the resume.",
            };
          }
          if (sessionGenerations.get(input.sessionId) !== generation) {
            return;
          }
          if (!recorded.ok) {
            // The lookup's OWN sentence: "still running", "different mission",
            // and "never recorded one" are different problems and must not
            // collapse into a single misleading message.
            refuseOpen(event, input.sessionId, recorded.reason);
            return;
          }
          // THE SLOT MUST MATCH THE GRANT. The mode is the host's (a running
          // job is granted `fork`, a stopped one `resume`), and the suffix is
          // the renderer's — so this is where the two are made to agree.
          //
          // Both directions are real. A stale pane asking for `.fork` after
          // its job finished would otherwise be served the STILL-LIVE fork pty
          // under a pane relabelled "the session MUON dispatched"; and a
          // renderer naming both slots for one stopped job would otherwise get
          // two `codex resume <id>` children on one transcript — the exact
          // two-writers hazard the mode rule exists to prevent, re-entered
          // through the coordinate instead of the mode.
          const grantedSuffix = TERMINAL_TAKEOVER_SESSION_SUFFIX[recorded.mode];
          if (takeoverSuffix !== grantedSuffix) {
            refuseOpen(
              event,
              input.sessionId,
              "this pane asked for a takeover slot MUON did not authorize for this job right now — its status decides whether the door is a resume or a fork. Reopen the tab to get the current one."
            );
            return;
          }
          // The MODE travels with the grant. The renderer never sends one, so
          // it cannot ask for a resume of a session a governed child is still
          // driving — the lookup above already decided that from the job's own
          // status.
          resume = {
            vendor: recorded.vendor,
            sessionId: recorded.sessionId,
            mode: recorded.mode,
          };
        }
        try {
          spawn = resolveTerminalSpawn(kind, cwd, geometry, resume);
        } catch (error) {
          refuseOpen(
            event,
            input.sessionId,
            // The resolver's sentence is host-authored PROSE, but the KIND it
            // names is the renderer's own `spawn.file` echoed back, so it is
            // not host-authored end to end. The resolver bounds and flattens
            // that kind (terminalSafe + a length cap, see terminalKindLabel),
            // and `refuseOpen` sanitizes whatever reaches it a second time.
            // Never vendor output, and never a path.
            `MUON refused this terminal: ${
              error instanceof Error ? error.message : "invalid terminal request"
            }`
          );
          return;
        }
      }
      if (realPtyRequested && !nodePty) {
        spawn = {
          ...spawn,
          file: `terminal unavailable: ${nodePtyLoadError ?? "native PTY failed to load"}`,
        };
      }
      // THE SESSION CAP (MAX_TERMINAL_SESSIONS), applied at the LAST
      // synchronous instant before a child could be created — and that
      // placement is the whole control. Every one of a burst of opens runs its
      // synchronous prefix before any of them registers a session, so a check
      // made before the awaits would be read 10,000 times against a count of
      // zero. From here to `relay.open` nothing yields, so this count is the
      // one the spawn actually happens under.
      //
      // A RECONNECT IS NEVER REFUSED: an id this host already knows is being
      // re-attached (renderer reload, tab remount), not created, so the cap
      // cannot strand a pane that is already open behind a full registry.
      const knownIds = knownSessionIds();
      if (
        !knownIds.includes(input.sessionId) &&
        knownIds.length >= MAX_TERMINAL_SESSIONS
      ) {
        refuseOpen(
          event,
          input.sessionId,
          `MUON already has ${MAX_TERMINAL_SESSIONS} terminal sessions open in this window, which is the most it will keep alive at once. Close one you are done with, then open this again.`
        );
        return;
      }
      // The window went away while the three async hops above were in flight.
      // Checked BEFORE the spawn, not after: starting a vendor CLI whose only
      // keyboard no longer exists is an orphan, and the port that would carry
      // its bytes cannot be delivered anyway.
      //
      // THE ONLY CHECK ON THIS PATH, and that is deliberate. Everything from
      // here to the port hand-over is synchronous — no `await`, so no chance
      // for Electron to run the destroy that would change the answer. A second
      // `senderAlive` before the hand-over could therefore never be false; it
      // read as a guard while pinning nothing, which is its own small lie. The
      // race it appeared to cover (the window dying inside those synchronous
      // lines) is not winnable by any check and is absorbed by the entry
      // point's `.catch` instead — the session survives for the reconnect that
      // follows a reload, exactly as it does after a plain port close.
      if (!senderAlive(event)) {
        return;
      }
      // Idempotent: a reconnect (renderer reload) re-opens the same id and gets a
      // fresh port re-attached to the SAME live session, replaying scrollback.
      // A pty is only actually created when the host does not already hold this
      // id — which is exactly the run the respawn guard records.
      const spawnedNow = !host.has(input.sessionId);
      // BEFORE the spawn, not after: a driver that reports its exit
      // synchronously would otherwise fire the host's exit hook while the
      // guard still had no record to arm, and the record minted afterwards
      // would say "still running" forever.
      if (spawnedNow) {
        respawnGuard.noteSpawn(input.sessionId);
      }
      relay.open(input.sessionId, spawn);
      // Free the prior channel for this session before wiring a new one. The
      // host's detach is identity-scoped, so the new attach below wins even if the
      // old port's close arrives late.
      activePorts.get(input.sessionId)?.close();
      const { port1, port2 } = new MessageChannelMain();
      activePorts.set(input.sessionId, port1);
      port1.on("close", () => {
        if (activePorts.get(input.sessionId) === port1) {
          activePorts.delete(input.sessionId);
        }
      });
      // node-pty does NOT throw on a missing binary or an unusable cwd: the
      // child is created and exits non-zero having written nothing, which
      // renders as the same blank pane a refusal used to. Turn that silence
      // into the one diagnosis it almost always is.
      const relayPort = adaptRelayPort(port1);
      let sawOutput = false;
      const spawnedFile = spawn.file;
      relay.attach(input.sessionId, {
        post: (frame) => {
          // The respawn guard is NOT armed here: this callback only runs while
          // a consumer is attached, and it also runs for a REPLAYED exit. It
          // is armed from the host's own exit hook (see the PtyHost
          // construction above), which fires once, when the child actually
          // dies. What stays here is the diagnostic below, which is about what
          // this pane printed and therefore belongs to this pane.
          if (frame.type === "data" && frame.data.length > 0) {
            sawOutput = true;
          } else if (
            frame.type === "exit" &&
            frame.exitCode !== 0 &&
            !sawOutput
          ) {
            relayPort.post({
              type: "error",
              // `spawnedFile` is host-resolved on the real-pty path, but the
              // ECHO fallback (MUON_REAL_PTY=0, or node-pty absent) carries the
              // renderer's own `spawn.file` straight through — so this frame is
              // sanitized on the same rule as every refusal.
              reason: hostReason(
                `'${spawnedFile}' exited immediately (code ${frame.exitCode}) without printing anything. It is usually not installed, or not on the PATH this app was launched with.`
              ),
            });
          }
          relayPort.post(frame);
        },
        onFrame: (listener) => relayPort.onFrame(listener),
        onClose: (listener) => relayPort.onClose(listener),
      });
      event.sender.postMessage(
        "muon:terminal-port",
        { sessionId: input.sessionId },
        [port2]
      );
    }
  }

  return {
    closeSession,
    closeAllSessions,
    closeChatSessions,
    snapshotHumanSessions,
    scrollbackSnapshot: (sessionId) => {
      if (!TERMINAL_SESSION_ID.test(sessionId)) {
        return null;
      }
      return host.exportScrollback(sessionId);
    },
    realPtyState: () =>
      !realPtyRequested
        ? "disabled"
        : nodePty
          ? "real"
          : nodePtyLoadError
            ? "fallback"
            : "loading",
  };
}
