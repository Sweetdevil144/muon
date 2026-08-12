import { describe, expect, it } from "vitest";
import type { JobTerminalView } from "@muon/client";
import {
  INITIAL_JOB_TERMINAL_ATTACH_STATE,
  applyJobTerminalPoll,
  isJobTerminalAttachId,
  jobTerminalAttachId,
  jobTerminalGapNotice,
} from "../src/lib/job-terminal-attach.js";

/**
 * 0038 — the live console's honesty rules, where they are testable: which jobs
 * may claim a live attach at all, and what the viewer must SAY when output went
 * missing or the console closed.
 */

const EPOCH = "a1b2c3d4";
const ATTACH = `pty:job:job-1:${EPOCH}`;

function view(over: Partial<JobTerminalView> = {}): JobTerminalView {
  return {
    sessionId: ATTACH,
    available: true,
    jobStatus: "running",
    frames: [],
    firstSeq: null,
    lastSeq: 0,
    dropped: 0,
    ...over,
  };
}

describe("jobTerminalAttachId", () => {
  it("accepts the runner's coordinate for THIS job", () => {
    expect(jobTerminalAttachId({ id: "job-1", ptySessionId: ATTACH })).toBe(
      ATTACH
    );
  });

  it("is null for every honest fallback (claude-code, codex session/auto, silent job, old row)", () => {
    // claude-code runs in-process: MUON never owns that child's stdio.
    expect(jobTerminalAttachId({ id: "job-1", ptySessionId: null })).toBeNull();
    expect(jobTerminalAttachId({ id: "job-1" })).toBeNull();
    expect(jobTerminalAttachId({ id: "job-1", ptySessionId: "   " })).toBeNull();
    expect(jobTerminalAttachId(null)).toBeNull();
  });

  it("refuses ANOTHER job's console rather than attaching to it", () => {
    expect(
      jobTerminalAttachId({ id: "job-1", ptySessionId: `pty:job:job-2:${EPOCH}` })
    ).toBeNull();
  });

  it("refuses a malformed epoch and a spawn-shaped id", () => {
    expect(
      jobTerminalAttachId({ id: "job-1", ptySessionId: "pty:job:job-1:zzzz" })
    ).toBeNull();
    // `terminal-<jobId>` means SPAWN. It must never resolve as an attach.
    expect(
      jobTerminalAttachId({ id: "job-1", ptySessionId: "terminal-job-1" })
    ).toBeNull();
  });

  it("recognises an attach coordinate by shape, so the spawn door can refuse it", () => {
    expect(isJobTerminalAttachId(ATTACH)).toBe(true);
    expect(isJobTerminalAttachId("terminal-job-1")).toBe(false);
    expect(isJobTerminalAttachId("shell")).toBe(false);
    expect(isJobTerminalAttachId("chat:chat-1")).toBe(false);
  });
});

describe("applyJobTerminalPoll", () => {
  it("writes the job's console bytes in order and advances the cursor", () => {
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        frames: [
          { seq: 1, data: "npm test\r\n" },
          { seq: 2, data: "PASS  parser\r\n" },
        ],
        firstSeq: 1,
        lastSeq: 2,
      })
    );
    expect(result.writes).toEqual(["npm test\r\n", "PASS  parser\r\n"]);
    expect(result.state.cursor).toBe(2);
    expect(result.state.applied).toBe(2);
    expect(result.notice).toBeNull();
    expect(result.stop).toBe(false);
    expect(result.degrade).toBeNull();
  });

  it("never re-writes a frame it already showed", () => {
    const first = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({ frames: [{ seq: 1, data: "a" }], firstSeq: 1, lastSeq: 1 })
    );
    const second = applyJobTerminalPoll(
      first.state,
      view({
        frames: [
          { seq: 1, data: "a" },
          { seq: 2, data: "b" },
        ],
        firstSeq: 1,
        lastSeq: 2,
      })
    );
    expect(second.writes).toEqual(["b"]);
  });

  /**
   * THE POINT OF THE FEATURE. `dropped` counts frames the runner lost before
   * the brain ever saw them. Rendering that hole as continuous output is the
   * same class of lie as a replayed stream labelled live.
   */
  it("says so, in band and out of band, when the runner dropped frames", () => {
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        frames: [{ seq: 9, data: "…continues\r\n" }],
        firstSeq: 9,
        lastSeq: 9,
        dropped: 4,
      })
    );
    // In band: a marker AT the point output went missing, before the new bytes.
    expect(result.writes[0]).toMatch(/output gap/);
    expect(result.writes[1]).toBe("…continues\r\n");
    // Out of band: a persistent, specific sentence.
    expect(result.notice).toMatch(/dropped before they reached MUON/);
    expect(result.notice).toMatch(/agent itself was never paused/);
    expect(result.state.lost).toBe(4);
  });

  it("reports a trimmed ring separately from a runner drop", () => {
    // A late attach: the brain's ring starts at 57, so 56 frames scrolled away.
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        frames: [{ seq: 57, data: "tail\r\n" }],
        firstSeq: 57,
        lastSeq: 57,
      })
    );
    expect(result.state.trimmed).toBe(56);
    expect(result.notice).toMatch(/scrolled out of MUON's live buffer/);
    expect(result.notice).not.toMatch(/dropped before they reached MUON/);
  });

  it("counts a gap once, not on every poll after it", () => {
    const first = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        frames: [{ seq: 5, data: "x" }],
        firstSeq: 5,
        lastSeq: 5,
        dropped: 2,
      })
    );
    const second = applyJobTerminalPoll(
      first.state,
      view({
        frames: [{ seq: 6, data: "y" }],
        firstSeq: 5,
        lastSeq: 6,
        dropped: 2,
      })
    );
    expect(second.state.trimmed).toBe(first.state.trimmed);
    expect(second.state.lost).toBe(first.state.lost);
    expect(second.writes).toEqual(["y"]);
  });

  it("degrades to the recorded stream — with a reason — when no console is held and nothing was ever shown", () => {
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({ available: false, jobStatus: "running" })
    );
    expect(result.degrade).toMatch(/not holding a live console/);
    expect(result.stop).toBe(true);
    expect(result.writes).toEqual([]);
  });

  it("keeps the bytes it already showed when the console closes mid-watch, and says the console closed", () => {
    const first = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({ frames: [{ seq: 1, data: "work\r\n" }], firstSeq: 1, lastSeq: 1 })
    );
    const second = applyJobTerminalPoll(
      first.state,
      view({ available: false, jobStatus: "done" })
    );
    // Never throws away what the human is watching for a recording.
    expect(second.degrade).toBeNull();
    expect(second.ended).toMatch(/live console is closed/);
    expect(second.stop).toBe(true);
  });

  it("stops once a finished job's console is fully drained, and says the run ended", () => {
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        jobStatus: "done",
        frames: [{ seq: 1, data: "done\r\n" }],
        firstSeq: 1,
        lastSeq: 1,
      })
    );
    expect(result.stop).toBe(true);
    expect(result.state.phase).toBe("ended");
    expect(result.ended).toMatch(/end of its console/);
  });

  it("keeps polling a finished job while the ring still holds unread frames", () => {
    const result = applyJobTerminalPoll(
      INITIAL_JOB_TERMINAL_ATTACH_STATE,
      view({
        jobStatus: "failed",
        frames: [{ seq: 1, data: "a" }],
        firstSeq: 1,
        // The page was capped: the ring holds more than it returned.
        lastSeq: 400,
      })
    );
    expect(result.stop).toBe(false);
    expect(result.more).toBe(true);
  });

  it("has nothing to say when nothing was lost", () => {
    expect(jobTerminalGapNotice(INITIAL_JOB_TERMINAL_ATTACH_STATE)).toBeNull();
  });
});
