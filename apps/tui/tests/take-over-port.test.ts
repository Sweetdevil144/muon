import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { SessionManager } from "../src/shell/session-manager.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { buildActionForm, executeAction } from "../src/lib/actions.js";

// ── ADR-0087 M15/M16 — the take-over / return-session verb family ───────────

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

describe("openCustom (the take-over spawn path)", () => {
  it("spawns a REAL explicit command in an explicit cwd, ungoverned, and refuses a missing binary readably", async () => {
    const manager = new SessionManager(GEOMETRY);
    const opened = manager.openCustom({
      kind: "take-over",
      file: process.env.SHELL || "/bin/sh",
      args: ["-c", "sleep 30"],
      cwd: "/tmp",
      labelBase: "take-over Codex",
    });
    expect("session" in opened).toBe(true);
    if (!("session" in opened)) return;
    expect(opened.label).toBe("take-over Codex");
    expect(opened.session.spec.ungoverned).toBe(true);
    expect(manager.active()?.id).toBe(opened.id);
    manager.disposeAll();

    // A missing binary: node-pty may refuse SYNCHRONOUSLY (a readable
    // reason) or defer to a fast exit (macOS posix_spawn) — both are
    // honest outcomes, and the fast-exit path keeps the tab readable
    // (F8's shared rule). What must never happen is a silent throw.
    const manager2 = new SessionManager(GEOMETRY);
    const refused = manager2.openCustom({
      kind: "take-over",
      file: "/nonexistent/vendor-cli",
      args: [],
      cwd: "/tmp",
      labelBase: "take-over X",
    });
    if ("reason" in refused) {
      expect(refused.reason).toContain("could not start");
    } else {
      await until(() => refused.session.exit !== null);
      manager2.disposeAll();
    }
  });
});

describe("the desk take-over flow", () => {
  const PREFIX = String.fromCodePoint(2);
  const SESSION = {
    id: "cmb4sess0001abcdefghijklm",
    laneId: "lane-codex",
    taskId: "task-1",
    jobId: "cmb4job0001abcdefghijklmn",
    vendorSessionId: "vend-abc123",
    // LIVE: the route takes over only sessions still running — an ended
    // session reopens with the vendor's own command instead.
    status: "running",
    owner: "muon",
    startedAt: "2026-08-22T09:00:00Z",
    lane: { id: "lane-codex", key: "codex", name: "Codex", provider: "openai", role: "implementer" },
  };

  it("empty id resolves the latest resumable session; the governed flip lands FIRST; a failed spawn names the manual command and the worktree", async () => {
    const calls = {
      listSessions: vi.fn(async () => [SESSION]),
      takeOverSession: vi.fn(async () => ({
        session: SESSION,
        alreadyOwned: false,
      })),
      getDispatchJob: vi.fn(async () => ({
        id: SESSION.jobId,
        // A REAL directory: the cwd fence refuses coordinates that do not
        // exist (a pruned worktree), and this pin is about the happy path.
        executionPath: "/tmp",
        workspacePath: "/repo",
      })),
    };
    const snapshot = emptyBrainSnapshot();
    let statusLine = "";
    const desk = new Desk({
      client: calls as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: GEOMETRY,
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    // Watch the footer through the shell's own seam.
    const original = desk.shell.footer.setStatus.bind(desk.shell.footer);
    desk.shell.footer.setStatus = (text: string) => {
      statusLine = text;
      original(text);
    };
    // THE PUBLIC FLOW (review finding: mutating private state bypassed
    // the machinery under test): the picker's filter narrows to the entry,
    // Enter opens its form (which states the cost), Enter submits.
    desk.handleKey(PREFIX);
    desk.handleKey("a"); // composer picker
    // The picker is cursor-walked (typing is meaningless while choosing);
    // the take-over entry is appended LAST, and moves clamp at the end.
    for (let i = 0; i < 40; i += 1) desk.handleKey("\u001b[B");
    desk.handleKey("\r"); // choose → the form opens
    const composer = desk.composerState();
    expect(composer?.phase).toBe("editing");
    if (composer?.phase === "editing") {
      expect(composer.form.title).toContain("JOB'S WORKTREE");
    }
    desk.handleKey("\r"); // empty sessionId → the latest LIVE session
    await until(() => calls.takeOverSession.mock.calls.length > 0);
    expect(calls.takeOverSession).toHaveBeenCalledWith(SESSION.id);
    expect(calls.getDispatchJob).toHaveBeenCalledWith(SESSION.jobId);
    await until(() => statusLine.includes("/tmp"));
    // Whether the pane opened (shell spawned; the vendor binary inside it
    // may fast-exit) or refused, the status names the JOB'S worktree —
    // the cost/location statement either way.
    expect(statusLine).toContain("/tmp");
    desk.dispose();
  });

  it("no resumable session is a stated refusal — the governed flip never fires", async () => {
    const calls = {
      listSessions: vi.fn(async () => []),
      takeOverSession: vi.fn(),
    };
    const snapshot = emptyBrainSnapshot();
    const desk = new Desk({
      client: calls as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: GEOMETRY,
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    desk.handleKey(PREFIX);
    desk.handleKey("a");
    for (let i = 0; i < 40; i += 1) desk.handleKey("\u001b[B");
    desk.handleKey("\r");
    desk.handleKey("\r");
    await until(() => calls.listSessions.mock.calls.length > 0);
    expect(calls.takeOverSession).not.toHaveBeenCalled();
  });
});

describe("return-session (M16)", () => {
  it("reports the dirty count honestly — unknown is a sentence, never zero — and the readiness degradation", async () => {
    const client = {
      listSessions: vi.fn(async () => [
        { ...{ id: "s1", laneId: "l", taskId: "t", status: "ended", startedAt: "x" }, owner: "human" },
      ]),
      returnSession: vi.fn(async () => ({
        session: {},
        alreadyOwned: false,
        snapshot: { dirtyFiles: 3, readinessDegraded: true },
      })),
    } as unknown as MuonApiClient;
    const form = buildActionForm("return-session", {})!;
    const result = await executeAction(client, form, { sessionId: "" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("3 dirty file(s)");
    expect(result.message).toContain("readiness DEGRADED");

    const unknown = {
      listSessions: vi.fn(async () => []),
      returnSession: vi.fn(async () => ({
        session: {},
        alreadyOwned: false,
        snapshot: null,
      })),
    } as unknown as MuonApiClient;
    const byId = await executeAction(unknown, form, { sessionId: "s9" });
    expect(byId.ok).toBe(true);
    expect(byId.message).toContain("dirty state unknown");
    expect(byId.message).not.toContain("0 dirty");

    // alreadyOwned from the RETURN route = the session was NOT yours:
    // nothing released, nothing inspected — and the copy says exactly that
    // (the first version claimed a record that never happened).
    const notMine = {
      listSessions: vi.fn(async () => []),
      returnSession: vi.fn(async () => ({
        session: {},
        alreadyOwned: true,
        snapshot: null,
      })),
    } as unknown as MuonApiClient;
    const refused = await executeAction(notMine, form, { sessionId: "s2" });
    expect(refused.ok).toBe(true);
    expect(refused.message).toContain("was not yours — nothing changed");
    expect(refused.message).not.toContain("dirty");
  });

  it("no owned session refuses with the take-over pointer", async () => {
    const client = {
      listSessions: vi.fn(async () => []),
      returnSession: vi.fn(),
    } as unknown as MuonApiClient;
    const form = buildActionForm("return-session", {})!;
    const result = await executeAction(client, form, { sessionId: "" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("take-over grants one first");
  });
});
