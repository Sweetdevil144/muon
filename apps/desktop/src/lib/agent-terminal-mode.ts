/**
 * U1 — what an AGENT TAB's Terminal is allowed to be.
 *
 * The defect this exists to make impossible: the agent tab's Terminal section
 * mounted the same component the standalone "+ Terminal" tab uses, with the
 * agent's VENDOR as the spawn kind. Opening a dispatched worker therefore
 * launched a second, fresh, interactive vendor CLI in that job's worktree —
 * with its own MCP servers, its own trust prompt, and none of the job's output.
 * The human saw a stranger's session; MUON ran a process nobody asked for.
 *
 * Three modes, and the tab must always be able to say which one it is in:
 *
 *  - `live`      the job's REAL process, attached and streaming. Requires the
 *                runner to have published an attachable console session for
 *                this job (`DispatchJob.ptySessionId`, landed 0038). Read-only:
 *                the attach carries bytes OUT and has no channel back in.
 *  - `replay`    the job's LEDGER stream — the same content `read_stream`
 *                returns, polled while the job runs so it behaves as a live
 *                activity feed, and standing as the run's record afterwards.
 *                Read-only, and its note states plainly that it is not an
 *                interactive terminal.
 *  - `unavailable` no job is bound, or nothing has been recorded yet. Says so.
 *
 * There is no branch here that spawns anything. Spawning a fresh vendor session
 * from an agent tab is a separate, explicitly-clicked, separately-labelled
 * action — never the resolution of "the human opened a worker".
 */

export type AgentTerminalMode =
  | {
      kind: "live";
      /**
       * The host-side session id to ATTACH to. Never renderer-invented, and
       * never a spawn coordinate: `pty:job:<jobId>:<epoch>` is refused by the
       * terminal spawn host (lib/terminal-host.ts) by construction.
       */
      sessionId: string;
      /** The job whose console this is. The attach poll's coordinate. */
      jobId: string;
      /** True while the job is still running — bytes may still arrive. */
      following: boolean;
      label: string;
    }
  | {
      kind: "replay";
      jobId: string;
      label: string;
      /** True while the job is still running — the replay keeps growing. */
      following: boolean;
    }
  | {
      kind: "unavailable";
      label: string;
      /** Why there is nothing to show. Never a blank panel. */
      reason: string;
    };

export type AgentTerminalModeInput = {
  job: {
    id: string;
    status?: string | null;
  } | null;
  /**
   * The host-advertised live console session for THIS job, or null when there
   * is none to attach to. Callers derive it with `jobTerminalAttachId`
   * (lib/job-terminal-attach.ts), which refuses anything that is not this
   * job's own `pty:job:<jobId>:<epoch>` coordinate.
   *
   * Null on every honest fallback, and each of them means "show the recorded
   * stream, labelled": a claude-code lane (the Agent SDK runs in-process, so
   * MUON never owns that child's stdio), `codex` in session/auto kind (a
   * protocol channel, not a console), a job that printed nothing, a pre-0038
   * row, and a live pane that has since degraded.
   */
  liveSessionId?: string | null;
  /**
   * Prefer the ledger activity feed over a pipe-fed "live console".
   *
   * Vendors whose stdout is a machine contract (cursor JSON, opencode line
   * protocol) still stamp `ptySessionId` from pipe `onBytes`. Attaching those
   * bytes dumps raw protocol at the operator instead of the parsed run the
   * adapter already recorded. When true, live attach is skipped so the feed
   * (or an honest empty state) wins.
   */
  preferActivityFeed?: boolean;
  /** How many recorded stream chunks the tab currently holds. */
  recordedChunks: number;
  /** Still fetching the first page of the recorded stream. */
  loading?: boolean;
};

const RUNNING_STATUSES = new Set(["queued", "running"]);

export function resolveAgentTerminalMode(
  input: AgentTerminalModeInput
): AgentTerminalMode {
  const job = input.job;
  if (!job) {
    return {
      kind: "unavailable",
      label: "No session",
      reason:
        "No dispatch is bound to this agent, so there is no process and no stream to show.",
    };
  }
  const following = RUNNING_STATUSES.has(job.status ?? "");
  const live =
    input.preferActivityFeed === true
      ? ""
      : input.liveSessionId?.trim() ?? "";
  if (live) {
    return {
      kind: "live",
      sessionId: live,
      jobId: job.id,
      following,
      // "Live" over a FINISHED job is a stale claim, even though the pane's
      // bytes are still the real console. The badge says which it is — and
      // neither wording claims an interactive terminal: this pane is the
      // agent's console OUTPUT, read-only by design.
      label: following
        ? "Live — this job's console output, read-only"
        : "Live console — this job has finished",
    };
  }
  if (input.recordedChunks > 0) {
    return {
      kind: "replay",
      jobId: job.id,
      // Not "Recorded stream": while the job runs this pane IS the way to
      // watch the agent work — its messages and tool activity, refreshed as
      // they land — and a label that leads with "recording" reads as "you
      // missed it". The honesty lives in the NOTE (agentTerminalModeNote):
      // this is the governed run's activity feed, never an interactive
      // vendor terminal.
      label: following
        ? "Live activity — this agent is working"
        : "Run activity — this job has finished",
      following,
    };
  }
  if (input.loading) {
    return {
      kind: "unavailable",
      label: "Loading",
      reason: "Reading this job's recorded stream…",
    };
  }
  return {
    kind: "unavailable",
    label: following ? "No output yet" : "Nothing recorded",
    reason: following
      ? "This job is running but has not written any output yet. This view follows it and will fill in."
      : "This job recorded no output. Check the Timeline for its ledger events.",
  };
}

/**
 * What the "replay" note is allowed to promise about the resume door, using
 * the SAME facts the resume button itself is gated on (`resumableVendor` in
 * session-workspace.tsx, and the trusted-main resume probe):
 *
 *  - `"unsupported"` this vendor's CLI has no takeover-able session at all
 *    (`VENDOR_TAKEOVER_COMMANDS` is `null` for it, e.g. cursor/opencode) —
 *    true for every job this vendor ever runs, finished or not.
 *  - `"pending"`     the vendor supports a takeover but the answer is "NOT
 *    YET": the probe is still in flight, no session id is stamped on a job
 *    that is still running, or trusted main refused with `pending` because the
 *    vendor has not written this session into its own store yet. The future
 *    promise is still honest, and this is where a running job's store miss
 *    belongs — routing it to `"unavailable"` printed a permanent refusal about
 *    a transient fact.
 *  - `"never-recorded"` the job is OVER and MUON holds no vendor session id
 *    for it at all — killed before the vendor reported one, or a row that
 *    predates the backlink column. Nothing is coming, so there is nothing to
 *    wait for. `"pending"` used to swallow this case (the probe never runs
 *    without a stamped id, so no refusal ever arrived to contradict it) and
 *    the pane told a human that MUON was waiting for a vendor to save a
 *    session for a job that had ended days earlier — forever. A new user
 *    reaches it on their first killed dispatch.
 *  - `"forkable"`    the job is STILL RUNNING and trusted main's probe
 *    confirmed a FORK can be opened right now: the vendor's real TUI on a copy
 *    of the agent's session so far, under a new session id.
 *  - `"available"`   the job has finished and the probe confirmed THE session
 *    can actually be reopened.
 *  - `"unavailable"` the probe refused (or the vendor recorded no session) —
 *    the door will not open; the specific reason is already stated in the
 *    callout above this note, so it is not repeated here.
 */
export type ResumeAvailability =
  | "unsupported"
  | "pending"
  | "never-recorded"
  | "forkable"
  | "available"
  | "unavailable";

/**
 * The one-line explanation under the mode badge. Kept beside the resolver so
 * the label and the sentence can never drift into contradicting each other —
 * a replayed stream presented as live is the same class of lie as a cached
 * "ready" lane, and a resume promise this vendor/job cannot keep is the same
 * class of lie too.
 *
 * `vendorName` (e.g. "Codex") lets the sentence name whose console this is.
 * The honesty this carries: even the LIVE pane is the governed child's
 * non-interactive dispatch run streamed byte-for-byte — it is never the
 * vendor's interactive TUI, and it must never read as one. The interactive
 * TUI is the separate, explicitly-clicked resume/new-session door — and the
 * "replay" note now only promises that door when `resumeAvailability` says it
 * can actually open (defaults to the fail-closed `"unsupported"` so a caller
 * that forgets to pass it gets the honest sentence, never the promise).
 */
export function agentTerminalModeNote(
  mode: AgentTerminalMode,
  vendorName = "the vendor CLI",
  resumeAvailability: ResumeAvailability = "unsupported"
): string {
  switch (mode.kind) {
    case "live":
      return mode.following
        ? `This is the live console of this job's governed ${vendorName} process — its non-interactive dispatch run, streamed byte-for-byte as it works. It is not the interactive ${vendorName} terminal. Input is disabled — steer it from the mission composer so every instruction still passes the approval gate.${
            // The live console is read-only BY DESIGN, so the only honest
            // answer to "I want to type" is the takeover door — and only when
            // it can actually open right now.
            resumeAvailability === "forkable"
              ? ` If you want a keyboard, the button at the top of this pane forks this agent's own session into ${vendorName}'s real terminal.`
              : ""
          }`
        : `This job has finished. You are looking at its real console — the non-interactive ${vendorName} run, exactly as MUON relayed it while it ran. Input is disabled — a finished agent has nothing to type into.${
            resumeAvailability === "available"
              ? ` Its real ${vendorName} session reopens from the button at the top of this pane.`
              : ""
          }`;
    case "replay": {
      // Both sentences state what the pane IS (the governed run's activity,
      // relayed from MUON's ledger) and what it is NOT (an interactive
      // terminal — this transport has no console to attach to). What comes
      // after depends on whether the resume door can actually open for THIS
      // vendor/job — never an unconditional promise.
      const resumeNote =
        resumeAvailability === "unsupported"
          ? `${vendorName} has no interactive session this job can resume into — this feed is the only record of its work.`
          : resumeAvailability === "unavailable"
            ? // Deliberately NOT the callout's own headline: the callout above
              // states the refusal and its reason, and repeating its sentence
              // here reads as two separate problems.
              `MUON could not open this job's real ${vendorName} session (the reason is above) — this feed is the only record of its work.`
            : resumeAvailability === "never-recorded"
              ? // NOT a wait. The probe never runs without a stamped id, so no
                // refusal ever arrives to correct a "waiting" sentence, and the
                // job is already over: nothing is going to stamp one now.
                `MUON holds no ${vendorName} session id for this job — it ended before ${vendorName} reported one — so there is no session to reopen; this feed is the only record of its work.`
              : resumeAvailability === "forkable"
                ? `You do not have to wait: the button at the top of this pane forks this agent's own ${vendorName} session into the vendor's real terminal right now, with your keyboard live. The dispatched agent keeps working in its own session.`
                : resumeAvailability === "available"
                  ? `The real ${vendorName} session for this job reopens from the button at the top of this pane.`
                  : // "pending" covers two honest waits, not one: the vendor has
                    // not reported a session id yet, OR it has not written that
                    // session into its own store yet (measured: a codex rollout
                    // appeared 3 seconds into a run). Both are "not yet", and
                    // neither may be worded as an impossibility.
                    //
                    // AND IT MUST NAME THE RIGHT DOOR. Trusted main only ever
                    // marks a refusal `pending` while the job is RUNNING, and a
                    // running job is granted a FORK — never a resume. This
                    // sentence promised "the real <vendor> session … in the
                    // vendor's own terminal", which is the resume's copy, to the
                    // one human who is reading while they wait. The remaining
                    // wait — a finished job whose probe has not answered yet —
                    // is a resume, and a short one, so it promises nothing.
                    mode.following
                    ? `MUON is waiting for ${vendorName} to save this job's session. As soon as it has, the button at the top of this pane FORKS that session into ${vendorName}'s own terminal with your keyboard live — the dispatched agent keeps working in its own session, and nothing you type reaches it.`
                    : `MUON is checking whether this job's ${vendorName} session can be reopened; the button at the top of this pane appears if it can.`;
      return mode.following
        ? `This is the governed run's live activity — ${vendorName}'s messages and tool calls, relayed as the agent works. It is not an interactive terminal (this ${vendorName} run has no console to attach to). ${resumeNote}`
        : `This is the governed run's activity — ${vendorName}'s messages and tool calls, exactly as MUON recorded them while it worked. It is not an interactive terminal; ${resumeNote}`;
    }
    case "unavailable":
      return mode.reason;
  }
}
