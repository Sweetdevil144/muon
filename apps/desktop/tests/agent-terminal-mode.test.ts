import { describe, expect, it } from "vitest";
import {
  agentTerminalModeNote,
  resolveAgentTerminalMode,
} from "../src/lib/agent-terminal-mode.js";

/**
 * U1 — an agent tab's Terminal resolves to one of three honest modes, and none
 * of them is "start a process". The resolver is the guarantee: there is no
 * input that makes it ask for a spawn.
 */
describe("resolveAgentTerminalMode", () => {
  it("shows the run's activity feed when chunks exist", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 12,
    });
    expect(mode.kind).toBe("replay");
    // The founder's third ask: while the agent works, the pane is how a human
    // WATCHES it work — the label leads with that, and the note (asserted
    // below) carries the honesty about what it is not.
    expect(mode.label).toBe("Live activity — this agent is working");
    if (mode.kind === "replay") expect(mode.following).toBe(true);
  });

  it("says a finished job's stream is finished, not live", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      recordedChunks: 3,
    });
    expect(mode.label).toContain("finished");
    expect(agentTerminalModeNote(mode)).not.toMatch(/real process/);
  });

  it("never claims live for a job with no attachable session", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      liveSessionId: null,
      recordedChunks: 40,
    });
    expect(mode.kind).not.toBe("live");
  });

  it("attaches when — and only when — the host advertises a session", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      liveSessionId: "pty-job-1",
      recordedChunks: 0,
    });
    expect(mode).toMatchObject({ kind: "live", sessionId: "pty-job-1" });
    expect(agentTerminalModeNote(mode)).toContain("Input is disabled");
  });

  it("skips pipe-JSON live attach when preferActivityFeed is set", () => {
    // Cursor/opencode stamp ptySessionId from machine stdout; attaching that
    // dumps raw protocol. Prefer the ledger feed instead.
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      liveSessionId: "pty:job:job-1:deadbeef",
      preferActivityFeed: true,
      recordedChunks: 4,
    });
    expect(mode.kind).toBe("replay");
    expect(mode.label).toContain("finished");
  });

  /**
   * 0038 — a finished job's console is still its REAL console, and the pane
   * keeps showing it. But "Live" over a job that ended is a stale claim, so the
   * badge and the sentence both change with the job's status.
   */
  it("stops saying 'Live' once the attached job has finished", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      liveSessionId: "pty:job:job-1:a1b2c3d4",
      recordedChunks: 0,
    });
    expect(mode.kind).toBe("live");
    expect(mode.label).toBe("Live console — this job has finished");
    expect(agentTerminalModeNote(mode)).toMatch(/This job has finished/);
    // Input stays refused in every mode; a finished agent has nothing to type into.
    expect(agentTerminalModeNote(mode)).toContain("Input is disabled");
  });

  it("explains a running job that has not written anything yet", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 0,
    });
    expect(mode.kind).toBe("unavailable");
    if (mode.kind === "unavailable") {
      expect(mode.reason).toContain("has not written any output yet");
    }
  });

  it("explains an unbound tab instead of leaving it blank", () => {
    const mode = resolveAgentTerminalMode({ job: null, recordedChunks: 0 });
    expect(mode.kind).toBe("unavailable");
    if (mode.kind === "unavailable") {
      expect(mode.reason).toContain("No dispatch is bound");
    }
  });

  it("shows a loading state rather than a false 'nothing recorded'", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 0,
      loading: true,
    });
    expect(mode.label).toBe("Loading");
  });

  it("never lets the activity feed claim to be an interactive terminal", () => {
    // The label may honestly say "Live activity" — the feed IS refreshed as
    // the agent works — but the note must state what the pane is NOT: an
    // interactive terminal. The two claims are different, and only the second
    // one would be a lie. `"pending"`: Codex supports resume and the job is
    // still running, so the future promise is still honest.
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 5,
    });
    const note = agentTerminalModeNote(mode, "Codex", "pending");
    expect(note).toContain("not an interactive terminal");
    // …and it names the door to the real one, so "where is the actual
    // terminal" has an answer inside the pane itself.
    expect(note).toMatch(/FORKS that session into Codex's own terminal/);
  });

  /**
   * F2 — THE WAIT MUST NAME THE DOOR IT IS WAITING FOR.
   *
   * `pending` is only ever set by trusted main while the job is RUNNING
   * (terminal-workspace-resolver.ts), and a running job is granted a FORK,
   * never a resume. The sentence said "the button at the top of this pane
   * opens the real <vendor> session in the vendor's own terminal" — the
   * RESUME's copy — and when the wait ended the button read "Fork into
   * <vendor>". Every other surface distinguishes the two doors; this is the
   * one sentence the human reads WHILE waiting, and it is reachable on every
   * running claude-code job, because claude has no live console and its pane
   * is always the replay feed.
   */
  it("a running job's wait promises a FORK, never the resume door", () => {
    const note = agentTerminalModeNote(
      resolveAgentTerminalMode({
        job: { id: "job-1", status: "running" },
        recordedChunks: 5,
      }),
      "Claude",
      "pending"
    );
    expect(note).toMatch(/waiting for Claude to save this job's session/);
    expect(note).toMatch(/FORKS that session/);
    expect(note).toMatch(/keeps working in its own session/);
    // The resume's own promise must not appear on a door that will be a fork.
    expect(note).not.toMatch(/opens the real Claude session/);
  });

  it("a finished job still waiting on its probe promises nothing but a look", () => {
    // The other reachable `pending`: the probe is in flight on a job that has
    // already stopped, where the door WOULD be a resume. A short wait, so it
    // states the check rather than promising either door.
    const note = agentTerminalModeNote(
      resolveAgentTerminalMode({
        job: { id: "job-1", status: "done" },
        recordedChunks: 5,
      }),
      "Codex",
      "pending"
    );
    expect(note).toMatch(/checking whether this job's Codex session/);
    expect(note).not.toMatch(/FORKS/);
  });

  /**
   * F2, second half — A FINISHED JOB THAT NEVER RECORDED A SESSION IS NOT
   * WAITING FOR ONE.
   *
   * The probe only runs once an id is stamped, so a job killed before its
   * vendor reported one produces no probe answer ever: no refusal, no reason,
   * and `pending` as the fall-through. The pane then said MUON was waiting for
   * the vendor to save a session for a job that ended days ago, permanently. A
   * new user reaches this on their first killed dispatch.
   */
  it("a finished job with no recorded session says so, instead of waiting forever", () => {
    const note = agentTerminalModeNote(
      resolveAgentTerminalMode({
        job: { id: "job-1", status: "failed" },
        recordedChunks: 5,
      }),
      "Claude",
      "never-recorded"
    );
    expect(note).toMatch(/holds no Claude session id for this job/);
    expect(note).toMatch(/no session to reopen/);
    expect(note).not.toMatch(/waiting/);
    expect(note).not.toMatch(/as soon as/i);
  });

  it("a finished job's note still says the feed is not an interactive terminal", () => {
    // "available": the probe confirmed the session can actually be reopened.
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      recordedChunks: 5,
    });
    const note = agentTerminalModeNote(mode, "Claude", "available");
    expect(note).toContain("not an interactive terminal");
    expect(note).toMatch(/recorded/);
    expect(note).toMatch(/real Claude session/);
  });

  /**
   * Finding 5 — the note used to promise "its real {vendor} session opens
   * from this pane" unconditionally, even for a vendor with no resumable CLI
   * session at all (cursor, opencode: VENDOR_RESUME_COMMANDS is null for
   * them) or a job whose recorded session the resume probe refused. The note
   * must now mirror the SAME gating the resume button itself uses
   * (`resumableVendor` in session-workspace.tsx / the resume probe), never an
   * unconditional promise.
   */
  it("never promises a resume door for a vendor with no resumable session, running or finished", () => {
    const running = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 5,
    });
    const runningNote = agentTerminalModeNote(running, "Cursor", "unsupported");
    expect(runningNote).toContain("not an interactive terminal");
    expect(runningNote).not.toMatch(/opens from this pane/);
    expect(runningNote).toMatch(/no interactive session/);

    const finished = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      recordedChunks: 5,
    });
    const finishedNote = agentTerminalModeNote(finished, "Cursor", "unsupported");
    expect(finishedNote).toContain("not an interactive terminal");
    expect(finishedNote).not.toMatch(/reopens from the button/);
    expect(finishedNote).toMatch(/no interactive session/);
  });

  it("never promises a resume door once the resume probe has refused it", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "done" },
      recordedChunks: 5,
    });
    const note = agentTerminalModeNote(mode, "Codex", "unavailable");
    expect(note).toContain("not an interactive terminal");
    expect(note).not.toMatch(/reopens from the button/);
    // Says the door will not open, WITHOUT repeating the callout's own
    // headline ("…can't be reopened"): the callout above already states the
    // refusal and its reason, and the same sentence twice reads as two
    // separate problems (and renders as two matching nodes in the DOM).
    expect(note).toMatch(/could not open this job's real Codex session/);
    expect(note).toMatch(/reason is above/);
  });

  it("a RUNNING job whose session can be forked is told so, and told it need not wait", () => {
    // `"forkable"` is the live-takeover grant: the job is still running and
    // main's probe confirmed a fork can open right now. The note must NOT tell
    // the human to wait for the job to finish — that sentence was true only
    // while a running job had no door at all.
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 5,
    });
    const note = agentTerminalModeNote(mode, "Codex", "forkable");
    expect(note).toContain("not an interactive terminal");
    expect(note).toMatch(/do not have to wait/i);
    expect(note).toMatch(/forks this agent's own Codex session/);
    // …and it still states that the governed agent is unaffected.
    expect(note).toMatch(/keeps working in its own session/);
    expect(note).not.toMatch(/When the job finishes/);
  });

  it("a LIVE console pane points at the fork door instead of just refusing input", () => {
    // The live pane is read-only by design, so "input is disabled" needs an
    // answer to "then where do I type". It must appear only when the door can
    // actually open.
    const live = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      liveSessionId: "pty:job:job-1:a1b2c3d4",
      recordedChunks: 0,
    });
    expect(agentTerminalModeNote(live, "Codex", "forkable")).toMatch(
      /forks this agent's own session into Codex's real terminal/
    );
    // Pending/unsupported must add nothing — a promise MUON cannot keep.
    expect(agentTerminalModeNote(live, "Codex", "pending")).not.toMatch(
      /fork/i
    );
    expect(agentTerminalModeNote(live, "Codex", "unsupported")).not.toMatch(
      /fork/i
    );
  });

  it("defaults to the honest, non-promising note when no resume info is passed", () => {
    // Fail-closed default: a caller that forgets to pass resumeAvailability
    // must never get an unconditional resume promise.
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      recordedChunks: 5,
    });
    const note = agentTerminalModeNote(mode, "Codex");
    expect(note).not.toMatch(/opens from this pane/);
  });

  // Honesty in labels (founder, third ask): even the LIVE pane is the
  // governed child's NON-INTERACTIVE run streamed byte-for-byte — it must
  // never read as the vendor's interactive TUI.
  it("names the vendor and says plainly the live console is not its interactive TUI", () => {
    const mode = resolveAgentTerminalMode({
      job: { id: "job-1", status: "running" },
      liveSessionId: "pty:job:job-1:a1b2c3d4",
      recordedChunks: 0,
    });
    const note = agentTerminalModeNote(mode, "Codex");
    expect(note).toContain("non-interactive");
    expect(note).toContain("not the interactive Codex terminal");
    // The badge itself claims output, never a terminal.
    expect(mode.label).toBe("Live — this job's console output, read-only");
  });
});
