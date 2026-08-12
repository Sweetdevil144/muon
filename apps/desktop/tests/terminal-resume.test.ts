import { describe, expect, it, vi } from "vitest";
import { codexGuardHomePath } from "@muon/adapters";
import { resolveTerminalSpawn } from "../src/lib/terminal-spawn.js";
import { verifyVendorSessionInStore } from "../src/lib/vendor-session-store.js";
import {
  JOB_STATUS_DRIVES_SESSION,
  resolveTerminalVendorSession,
  resolveTerminalWorkspacePath,
} from "../src/lib/terminal-workspace-resolver.js";

// BACKLINK TAKEOVER — the pieces that open a MUON-dispatched vendor session in
// the vendor's own TUI. Three fences under test: the spawn resolver only ever
// places a HOST-validated uuid on an argv, the vendor-session lookup is bound
// to the chat selected in THIS window, and a job whose governed child is still
// driving its session is granted a FORK and never a resume.

const SESSION_ID = "019fa043-e5c2-7731-b2f3-11312f91d2d2";

describe("resolveTerminalSpawn resume", () => {
  it("resolves claude resume to `claude --resume <id>` in the job worktree", () => {
    const spawn = resolveTerminalSpawn("claude-code", "/wt", {}, {
      vendor: "claude-code",
      sessionId: SESSION_ID,
      mode: "resume",
    });
    expect(spawn.file).toBe("claude");
    expect(spawn.args).toEqual(["--resume", SESSION_ID]);
    expect(spawn.cwd).toBe("/wt");
  });

  it("resolves codex resume to `codex resume <id>` under the ISOLATED guard home", () => {
    const spawn = resolveTerminalSpawn("codex", "/wt", {}, {
      vendor: "codex",
      sessionId: SESSION_ID,
      mode: "resume",
    });
    expect(spawn.file).toBe("codex");
    expect(spawn.args).toEqual(["resume", SESSION_ID]);
    // The dispatched rollout lives under the guard CODEX_HOME, not ~/.codex —
    // resume must look where the dispatch actually wrote.
    expect(spawn.env?.CODEX_HOME).toBe(codexGuardHomePath());
  });

  it("refuses a stored id that is not the vendors' uuid shape", () => {
    for (const bad of [
      "not-a-uuid",
      `${SESSION_ID}; rm -rf /`,
      "019fa043-e5c2-7731-b2f3",
      "",
    ]) {
      expect(() =>
        resolveTerminalSpawn("codex", "/wt", {}, {
          vendor: "codex",
          sessionId: bad,
          mode: "resume",
        })
      ).toThrow(/uuid shape|not allowed/);
    }
  });

  it("refuses a vendor/kind mismatch and a vendor with no resumable session", () => {
    expect(() =>
      resolveTerminalSpawn("codex", "/wt", {}, {
        vendor: "claude-code",
        sessionId: SESSION_ID,
        mode: "resume",
      })
    ).toThrow(/does not match/);
    expect(() =>
      resolveTerminalSpawn("cursor", "/wt", {}, {
        vendor: "cursor",
        sessionId: SESSION_ID,
        mode: "resume",
      })
    ).toThrow();
    expect(() =>
      resolveTerminalSpawn("shell", "/wt", {}, {
        vendor: "shell",
        sessionId: SESSION_ID,
        mode: "shell" as never,
      })
    ).toThrow();
  });
});

describe("resolveTerminalSpawn fork — the LIVE takeover argv", () => {
  // Both argvs were verified live (claude 2.1.220, codex 0.145.0): each opens
  // the vendor's real interactive TUI on a copy of the named session.
  it("resolves claude fork to `claude --resume <id> --fork-session`", () => {
    const spawn = resolveTerminalSpawn("claude-code", "/wt", {}, {
      vendor: "claude-code",
      sessionId: SESSION_ID,
      mode: "fork",
    });
    expect(spawn.file).toBe("claude");
    expect(spawn.args).toEqual(["--resume", SESSION_ID, "--fork-session"]);
    expect(spawn.cwd).toBe("/wt");
  });

  it("resolves codex fork to `codex fork <id>` under the ISOLATED guard home", () => {
    const spawn = resolveTerminalSpawn("codex", "/wt", {}, {
      vendor: "codex",
      sessionId: SESSION_ID,
      mode: "fork",
    });
    expect(spawn.file).toBe("codex");
    expect(spawn.args).toEqual(["fork", SESSION_ID]);
    // A fork reads the SAME rollout store the dispatch wrote to, so it needs
    // the same guard home a resume does.
    expect(spawn.env?.CODEX_HOME).toBe(codexGuardHomePath());
  });

  it("a fork is still bound by every fence a resume is", () => {
    // The id shape…
    expect(() =>
      resolveTerminalSpawn("codex", "/wt", {}, {
        vendor: "codex",
        sessionId: "not-a-uuid",
        mode: "fork",
      })
    ).toThrow(/uuid shape/);
    // …the vendor/kind agreement…
    expect(() =>
      resolveTerminalSpawn("codex", "/wt", {}, {
        vendor: "claude-code",
        sessionId: SESSION_ID,
        mode: "fork",
      })
    ).toThrow(/does not match/);
    // …and the per-vendor table, which states fork independently of resume.
    expect(() =>
      resolveTerminalSpawn("cursor", "/wt", {}, {
        vendor: "cursor",
        sessionId: SESSION_ID,
        mode: "fork",
      })
    ).toThrow();
  });

  it("a mode this host does not implement is REFUSED, never silently resumed", () => {
    // The mode reaches the resolver as data. A value outside the union must
    // fall off the table rather than defaulting into the door that continues
    // a session a governed child may still be driving.
    expect(() =>
      resolveTerminalSpawn("codex", "/wt", {}, {
        vendor: "codex",
        sessionId: SESSION_ID,
        mode: "continue" as never,
      })
    ).toThrow(/no resumable vendor session/);
    expect(() =>
      resolveTerminalSpawn("codex", "/wt", {}, {
        vendor: "codex",
        sessionId: SESSION_ID,
        mode: undefined as never,
      })
    ).toThrow(/no resumable vendor session/);
  });
});

describe("resolveTerminalWorkspacePath — where the job ACTUALLY ran", () => {
  it("prefers the recorded executionPath (the worktree fact) over workspacePath", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      chatId: "chat-a",
      workspacePath: "/repo",
      executionPath: "/repo/.muon/worktrees/task-1",
    });
    const getChat = vi.fn().mockResolvedValue({ status: "active" });
    const result = await resolveTerminalWorkspacePath(
      "job-1",
      "chat-a",
      getDispatchJob,
      getChat
    );
    expect(result).toBe("/repo/.muon/worktrees/task-1");
  });

  it("falls back to workspacePath for a pre-0039 row", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      chatId: "chat-a",
      workspacePath: "/repo",
    });
    const getChat = vi.fn().mockResolvedValue({ status: "active" });
    const result = await resolveTerminalWorkspacePath(
      "job-1",
      "chat-a",
      getDispatchJob,
      getChat
    );
    expect(result).toBe("/repo");
  });
});

describe("resolveTerminalVendorSession", () => {
  it("returns the stamped vendor session for the bound chat's own finished job", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      chatId: "chat-a",
      vendor: "codex",
      status: "done",
      vendorSessionId: SESSION_ID,
    });
    const result = await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      getDispatchJob
    );
    expect(result).toEqual({
      ok: true,
      vendor: "codex",
      sessionId: SESSION_ID,
      mode: "resume",
    });
  });

  it("F7: a RUNNING job is granted a fork and NEVER a resume", async () => {
    // The rule that made this a refusal has not been relaxed: resuming a
    // session a governed child is still driving would put two writers on one
    // transcript. What changed is the answer — a fork is a SECOND vendor
    // session, so the original keeps exactly one writer. The renderer never
    // names the mode; this resolver derives it from the job's own status,
    // which is what keeps an untrusted renderer from asking for the other one.
    for (const status of ["running", "queued"]) {
      const getDispatchJob = vi.fn().mockResolvedValue({
        chatId: "chat-a",
        vendor: "codex",
        status,
        vendorSessionId: SESSION_ID,
      });
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        getDispatchJob
      );
      expect(result).toEqual({
        ok: true,
        vendor: "codex",
        sessionId: SESSION_ID,
        mode: "fork",
      });
    }
  });

  /**
   * THE PARTITION OVER THE WHOLE STATUS UNION, not over the set under test.
   *
   * This test used to iterate `["running", "queued"]` — the two members of
   * ACTIVE_JOB_STATUSES — and assert they yield `fork`. That is a tautology
   * dressed as a property: it restates the implementation's own membership
   * list, so a status forgotten by the implementation is equally forgotten by
   * the test, and the one thing worth pinning (which statuses get `resume`) was
   * never asserted at all.
   *
   * It now iterates every key of `JOB_STATUS_DRIVES_SESSION`, which is
   * `Record<DispatchStatus, boolean>` and therefore total over the protocol's
   * union by compile time, and asserts BOTH halves of the partition.
   */
  it("partitions the FULL dispatch-status union into fork and resume", async () => {
    // The DOMAIN comes from the implementation's own total table, so a status
    // added to the protocol cannot be silently skipped by this loop. The
    // EXPECTATIONS are literal, so the implementation does not get to define
    // its own correctness — flipping a row in the table fails here.
    const expected: Record<string, "fork" | "resume"> = {
      queued: "fork",
      running: "fork",
      done: "resume",
      failed: "resume",
      // Today's answer, and a KNOWN residual rather than a comfortable one:
      // the runner-lease reclaim writes `interrupted` while a prior vendor
      // process may still be alive (ADR-0025 §5.1). Pinned here so that
      // changing it is a deliberate act with a visible diff.
      interrupted: "resume",
    };
    expect(Object.keys(JOB_STATUS_DRIVES_SESSION).sort()).toEqual(
      Object.keys(expected).sort()
    );

    for (const status of Object.keys(JOB_STATUS_DRIVES_SESSION)) {
      for (const vendor of ["codex", "claude-code"]) {
        const result = await resolveTerminalVendorSession(
          "job-1",
          "chat-a",
          vi.fn().mockResolvedValue({
            chatId: "chat-a",
            vendor,
            status,
            vendorSessionId: SESSION_ID,
          })
        );
        expect(result.ok && result.mode).toBe(expected[status]);
      }
    }
  });

  it("an unknown status is treated as NOT driving — stated, not assumed", async () => {
    // Fail-closed would be the other answer, and this is deliberately not it:
    // `status` arrives as a string from a brain that may be newer than this
    // app, and an unrecognised value resolves to `resume`. It is recorded here
    // so the choice is visible; the protocol's union is closed and every member
    // of it is classified above, so reaching this branch means the brain and
    // the app disagree about what a status IS.
    const result = await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue({
        chatId: "chat-a",
        vendor: "codex",
        status: "some-future-status",
        vendorSessionId: SESSION_ID,
      })
    );
    expect(result.ok && result.mode).toBe("resume");
  });

  it("refuses a LIVE takeover for a vendor that has no fork, rather than resuming it", async () => {
    // cursor has neither door. The running-job branch must refuse on the FORK
    // question and never fall through to the resume it also lacks — the
    // fail-closed direction, stated positively from the takeover table.
    const result = await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue({
        chatId: "chat-a",
        vendor: "cursor",
        status: "running",
        vendorSessionId: SESSION_ID,
      })
    );
    expect(result).toMatchObject({ ok: false });
    expect(result && "reason" in result ? result.reason : "").toMatch(/fork/i);
  });

  it("carries the granted mode into the store check, so its sentence names the right command", async () => {
    const verifyStore = vi.fn().mockReturnValue({ ok: true, evidencePath: "/x" });
    await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue({
        chatId: "chat-a",
        vendor: "codex",
        status: "running",
        vendorSessionId: SESSION_ID,
        executionPath: "/wt",
      }),
      verifyStore
    );
    expect(verifyStore).toHaveBeenCalledWith({
      vendor: "codex",
      sessionId: SESSION_ID,
      cwd: "/wt",
      mode: "fork",
    });
  });

  it("refuses another chat's job, a missing stamp, and an attach coordinate", async () => {
    const foreign = vi.fn().mockResolvedValue({
      chatId: "chat-b",
      vendor: "codex",
      status: "done",
      vendorSessionId: SESSION_ID,
    });
    expect(
      await resolveTerminalVendorSession("job-1", "chat-a", foreign)
    ).toMatchObject({ ok: false });

    const unstamped = vi.fn().mockResolvedValue({
      chatId: "chat-a",
      vendor: "codex",
      status: "done",
      vendorSessionId: null,
    });
    expect(
      await resolveTerminalVendorSession("job-1", "chat-a", unstamped)
    ).toMatchObject({ ok: false });

    const lookup = vi.fn();
    expect(
      await resolveTerminalVendorSession(
        "pty:job:job-1:a1b2c3d4e5f60718",
        "chat-a",
        lookup
      )
    ).toMatchObject({ ok: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * F2 — "NOT YET" MUST BE DISTINGUISHABLE FROM "NO".
   *
   * The renderer probed ONCE per (jobId, sessionId, status), none of which
   * changes again during a run, so the first answer was latched for the whole
   * job. The vendor writes its session store at its own pace — a `codex exec`
   * rollout was measured appearing 3 seconds into a 30-second run, and the
   * probe fires about a second in — so the latched answer was routinely a miss,
   * and the pane spent the run stating a permanent impossibility about it.
   *
   * `pending` is the fix's authority half: main says which refusals can change
   * while the job runs, and only those are re-asked.
   */
  describe("a running job's transient refusal is marked `pending`", () => {
    const runningRow = {
      chatId: "chat-a",
      vendor: "codex",
      status: "running",
      vendorSessionId: SESSION_ID,
      executionPath: "/wt",
    };

    it("marks a running job's STORE miss as pending", async () => {
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue(runningRow),
        () => ({
          ok: false,
          reason: "no rollout saved for it yet.",
          transient: true,
        })
      );
      expect(result).toMatchObject({ ok: false, pending: true });
    });

    /**
     * F4 — `pending` NEEDS BOTH HALVES, and the store owns the second one.
     *
     * `running` alone was the test, but `verifyVendorSessionInStore` refuses
     * for four reasons and two of them never flip while a job runs: a job with
     * no recorded cwd, and a cwd whose worktree has been merged and pruned.
     * Those got "can't be opened YET", 21 probes over ~40 s, and a "Check
     * again" button that answers identically forever — the exact permanent
     * claim about a transient fact this flag exists to stop, pointing the
     * other way.
     */
    it("does NOT mark a running job's NON-transient store refusal as pending", async () => {
      const pruned = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue(runningRow),
        () => ({
          ok: false,
          reason:
            "This job's working directory no longer exists (/wt) — its worktree was likely merged and pruned.",
          transient: false,
        })
      );
      expect(pruned).toMatchObject({ ok: false });
      expect(pruned.ok === false && pruned.pending).toBeUndefined();
    });

    it("takes the transience from the REAL store check, not from the status", async () => {
      // End to end through `verifyVendorSessionInStore` itself, on a RUNNING
      // job whose worktree is gone: the store says "not transient", so the
      // resolver must not promise a wait however alive the job is.
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue(runningRow),
        (input) =>
          verifyVendorSessionInStore(input, {
            codexHome: "/guard",
            fs: {
              // The worktree itself no longer exists — a merged/pruned tree.
              exists: () => false,
              list: () => [],
              realpath: () => null,
            },
          })
      );
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.pending).toBeUndefined();
      expect(result.ok === false ? result.reason : "").toMatch(
        /working directory no longer exists/i
      );
    });

    it("marks a running job's MISSING STAMP as pending", async () => {
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue({ ...runningRow, vendorSessionId: null })
      );
      expect(result).toMatchObject({ ok: false, pending: true });
    });

    it("does NOT mark a stopped job's store miss as pending", async () => {
      // Nothing is going to write that rollout now. Re-asking would be a poll
      // with no possible new answer.
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue({ ...runningRow, status: "done" }),
        // TRANSIENT as a store fact — the job's status is what makes it moot.
        () => ({
          ok: false,
          reason: "no saved rollout for it.",
          transient: true,
        })
      );
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.pending).toBeUndefined();
    });

    it("does NOT mark a hard refusal as pending, however it is reached", async () => {
      // A foreign mission, and a vendor that has no fork at all: both are
      // answers that a running job cannot change by continuing to run.
      const foreign = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue({ ...runningRow, chatId: "chat-b" })
      );
      expect(foreign.ok === false && foreign.pending).toBeUndefined();

      const noFork = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue({ ...runningRow, vendor: "cursor" })
      );
      expect(noFork.ok === false && noFork.pending).toBeUndefined();
    });

    it("words a running job's store miss as a wait, never as an impossibility", async () => {
      // The store check is the real one here: the sentence the human reads is
      // written by vendor-session-store.ts, and the fork phrasing is what makes
      // it a "not yet".
      const result = await resolveTerminalVendorSession(
        "job-1",
        "chat-a",
        vi.fn().mockResolvedValue(runningRow),
        (input) =>
          verifyVendorSessionInStore(input, {
            codexHome: "/guard",
            fs: {
              exists: (target) => target === "/wt",
              list: () => [],
              realpath: (target) => target,
            },
          })
      );
      expect(result).toMatchObject({ ok: false, pending: true });
      const reason = result.ok === false ? result.reason : "";
      expect(reason).toMatch(/not saved this job's session .* yet/i);
      expect(reason).toMatch(/as soon as the rollout appears/i);
      expect(reason).not.toMatch(/is not offering it\./);
    });
  });

  it("fails closed on a lookup throw and on no bound chat", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("offline"));
    expect(
      await resolveTerminalVendorSession("job-1", "chat-a", throwing)
    ).toMatchObject({ ok: false });
    expect(
      await resolveTerminalVendorSession("job-1", null, vi.fn())
    ).toMatchObject({ ok: false });
  });
});
