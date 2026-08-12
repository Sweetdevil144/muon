import { useEffect, useRef, useState } from "react";
import type { StreamChunk, StreamChunkDetail } from "@muon/client";
import {
  agentTerminalModeNote,
  type AgentTerminalMode,
  type ResumeAvailability,
} from "../lib/agent-terminal-mode.js";
import { JobTerminalAttach } from "./job-terminal-attach.js";
import {
  agentConsoleGrid,
  type ConsoleGrid,
} from "./lib/agent-console-grid.js";
import { isNearBottom } from "./lib/stick-scroll.js";
import type { TerminalView } from "./lib/terminal-wire.js";
import { createXtermView } from "./lib/xterm-view.js";
import { TerminalPreview } from "./terminal-preview.js";
import type {
  JobResumeProbe,
  JobTerminalQuery,
  JobTerminalResponse,
} from "../shared/ipc.js";

/**
 * U1 — the agent tab's Terminal body.
 *
 * It shows THIS job's output and nothing else. It does not spawn on open.
 * Opening a worker used to launch a fresh interactive vendor CLI in the job's
 * worktree; a spawn now happens only from an explicit, separately-labelled
 * click. Two such doors exist, and the PRIMARY one sits at the TOP of the
 * pane: it opens THIS job's dispatched session in the vendor's own interactive
 * TUI (backlink takeover). It has two forms, and trusted main — not this
 * component — decides which, from the job's own status:
 *   - the job has STOPPED  → "Open this job's real <vendor> session": the
 *     exact dispatched session, continued, on the `.resume` pty slot.
 *   - the job is RUNNING   → "Take over ... now": a FORK of that session under
 *     a new session id, on the `.fork` pty slot. The governed child keeps sole
 *     ownership of its own transcript, so a live takeover is a second session
 *     rather than a second writer — which is why this used to be refused
 *     outright and no longer is.
 * TWO FORMS, TWO SLOTS, AND THE OPEN PANE LATCHES WHICH IT TOOK. The grant
 * flips under a mounted pane the moment the job finishes; a pane that read the
 * live grant told a human sitting in a fork that they were in the dispatched
 * session, and a shared slot handed the finished job's "resume" open the
 * still-live fork pty. Neither is possible now.
 * The secondary door at the bottom starts a NEW session that announces in
 * words that it is not this job.
 *
 * THE RESUME DOOR MUST BE REAL BEFORE IT EXISTS. The button renders only when
 * trusted main's resume probe (`muon:jobResumeProbe`) has verified the whole
 * chain — recorded id, finished job, chat binding, and the vendor's OWN
 * session store. A recorded id whose session the store cannot back renders
 * the probe's reason in the button's place instead: the founder clicked a
 * confident button and got `codex resume`'s own "No saved session found", and
 * that class of dead affordance is what the probe exists to prevent.
 *
 * TWO BODIES, ONE BADGE. In `live` mode the body is the ATTACH pane (0038):
 * the vendor child's real console bytes, relayed by the runner and polled
 * read-only through trusted main. In `replay` mode it is the governed run's
 * ACTIVITY FEED — the agent's messages as prose, its tool calls as compact
 * expandable lines — rendered from the same ledger stream `read_stream`
 * returns, refreshed on a sub-second cadence while the job runs. The mode
 * badge above them is resolved by ONE function (resolveAgentTerminalMode), so
 * the words and the pane can never disagree — and when the live attach turns
 * out to be unavailable, the parent degrades the MODE, so the badge changes
 * at the same instant the pane does.
 *
 * Every string the agent produced is rendered as a React text node (feed
 * blocks, tool detail) or written to an XTerm (live). There is no HTML
 * interpretation on either path — the stream is untrusted vendor output and
 * is treated as data, exactly like the tool cards do.
 */

/** One rendered element of the activity feed. */
type FeedBlock =
  | {
      kind: "message";
      key: string;
      text: string;
      /** Token-delta run still absorbing consecutive `output` chunks. */
      merging: boolean;
    }
  | {
      kind: "activity";
      key: string;
      text: string;
      detail: StreamChunkDetail | null;
    }
  | { kind: "meta"; key: string; text: string };

/**
 * The ledger stream, shaped for reading instead of dumped as lines.
 *
 *  - `output` chunks are RAW SUBSTRING deltas of ONE assistant message —
 *    verified against the live ledger for both codex and claude: token-level
 *    pieces ("I", "’m", " using") that carry their own spacing and newlines.
 *    Consecutive ones concatenate verbatim; the previous newline join
 *    manufactured a one-word-per-line staircase out of every streamed
 *    sentence (founder screenshot, 2026-08-06).
 *  - `output.message` / `user.message` are explicit whole-message boundaries
 *    and always start their own block.
 *  - `activity` lines are the tool calls; their bounded, pre-redacted
 *    args/result detail hangs off the line behind an expand.
 *  - everything else (milestones, gates, reasoning) renders as subdued meta
 *    lines, prefix intact.
 */
export function buildFeedBlocks(chunks: readonly StreamChunk[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  for (const chunk of chunks) {
    const content = typeof chunk.content === "string" ? chunk.content : "";
    const key = `c${chunk.seq}`;
    if (chunk.kind === "output") {
      // Whitespace-only deltas are LOAD-BEARING inside a streamed message
      // (they are the spaces and paragraph breaks between token deltas) —
      // only sheer emptiness is skipped, and a run never STARTS on
      // whitespace alone.
      if (content === "") continue;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "message" && last.merging) {
        last.text = `${last.text}${content}`;
        continue;
      }
      if (!content.trim()) continue;
      blocks.push({ kind: "message", key, text: content, merging: true });
    } else if (chunk.kind === "output.message" || chunk.kind === "user.message") {
      if (!content.trim()) continue;
      blocks.push({ kind: "message", key, text: content, merging: false });
    } else if (chunk.kind === "activity") {
      if (!content.trim()) continue;
      blocks.push({
        kind: "activity",
        key,
        text: content,
        detail: chunk.detail ?? null,
      });
    } else {
      if (!content.trim()) continue;
      blocks.push({ kind: "meta", key, text: content });
    }
  }
  return blocks;
}

/** Bound what the DOM holds; the parent already caps its chunk buffer. */
const MAX_RENDERED_BLOCKS = 1_000;

/**
 * The live pane's XTerm, built READ-ONLY. See xterm-view.ts: `disableStdin`,
 * no key-sequence handler, and `onInput` that never subscribes. `convertEol`
 * is what kills the ragged staircase: pipe-fed frames carry `\n`-only line
 * endings, and it is idempotent for real pty frames (`\r\n`).
 *
 * U3 — `grid` pins the view to the SOURCE console's geometry when this vendor
 * dispatched onto a real pty (agent-console-grid.ts). Its bytes already carry
 * that terminal's wrapping and absolute cursor positions, and MUON cannot
 * resize a governed child's pty, so replaying them at the pane's own width is
 * what made this stream read as garbled. Null keeps today's fit-the-pane
 * behaviour for a console with no known source geometry.
 */
function readOnlyXtermView(
  container: HTMLElement,
  grid: ConsoleGrid | null
): TerminalView {
  return createXtermView(container, {
    readOnly: true,
    convertEol: true,
    ...(grid ? { fixedGrid: grid } : {}),
  });
}

/**
 * The production live read. Goes through the typed IPC bridge — the renderer
 * never talks to the brain directly, and the route is operator tier.
 *
 * A bridge that predates this method resolves `unavailable` instead of
 * throwing, which makes the tab fall back to the recorded stream with a stated
 * reason rather than mounting a pane that can never fill.
 */
async function bridgeJobTerminalRead(
  query: JobTerminalQuery
): Promise<JobTerminalResponse> {
  const read = window.muon?.jobTerminal;
  if (typeof read !== "function") {
    return {
      status: "unavailable",
      reason:
        "The live console is unavailable in this session. Restart MUON to restore it; the recorded stream below is complete.",
      retryable: false,
    };
  }
  return read(query);
}

/**
 * The production teardown for one terminal session. Optional-chained like
 * every other `terminal.close` call site: a bridge that predates the method
 * must degrade to "the retry did not clear anything", never throw inside a
 * click handler.
 */
async function bridgeCloseTerminalSession(sessionId: string): Promise<void> {
  await window.muon?.terminal?.close?.(sessionId);
}

function ActivityFeed(props: { chunks: readonly StreamChunk[] }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // This pane polls sub-second while the job runs (SESSION_POLL_ACTIVE_MS in
  // session-workspace.tsx). Follow the feed only while the user is already at
  // (or near) the bottom — mirrors chat.tsx's stickToBottomRef — so scrolling
  // up to read a running job's earlier activity is not yanked back to the
  // bottom by the next poll.
  const stickToBottomRef = useRef(true);
  const blocks = buildFeedBlocks(props.chunks).slice(-MAX_RENDERED_BLOCKS);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && stickToBottomRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [props.chunks]);

  return (
    <div
      className="job-feed"
      onScroll={() => {
        const body = bodyRef.current;
        if (body) {
          stickToBottomRef.current = isNearBottom(body);
        }
      }}
      ref={bodyRef}
      tabIndex={0}
    >
      {blocks.map((block) =>
        block.kind === "message" ? (
          <p className="job-feed-message" key={block.key}>
            {block.text}
          </p>
        ) : block.kind === "activity" ? (
          block.detail && (block.detail.args || block.detail.result) ? (
            <details className="job-feed-activity" key={block.key}>
              <summary>{block.text}</summary>
              {block.detail.args ? (
                <pre className="job-feed-detail">
                  {block.detail.argsTruncated
                    ? `${block.detail.args}\n[muon: input clipped]`
                    : block.detail.args}
                </pre>
              ) : null}
              {block.detail.result ? (
                <pre className="job-feed-detail job-feed-detail-result">
                  {block.detail.resultTruncated
                    ? `[muon: earlier output clipped]\n${block.detail.result}`
                    : block.detail.result}
                </pre>
              ) : null}
            </details>
          ) : (
            <p className="job-feed-activity-line" key={block.key}>
              {block.text}
            </p>
          )
        ) : (
          <p className="job-feed-meta" key={block.key}>
            {block.text}
          </p>
        )
      )}
    </div>
  );
}

export function JobStreamTerminal(props: {
  mode: AgentTerminalMode;
  chunks: readonly StreamChunk[];
  /** Vendor presentation name, for the explicit new-session affordance. */
  vendorLabel: string;
  /**
   * U3 — the vendor ID (not its label), used for ONE thing: looking up the
   * geometry this vendor's dispatched console was rendered at, so the live
   * pane replays it byte-faithfully. Optional; absent means "fit the pane",
   * which is what every non-pty lane wants anyway.
   */
  vendor?: string | null;
  /**
   * Terminal kind the host will resolve for an explicitly-requested NEW
   * session. Absent ⇒ this vendor has no spawnable terminal and the affordance
   * is not offered at all (never a button that fails on click).
   */
  spawnKind?: string | null;
  /** Session id for an explicitly-requested new session. */
  spawnSessionId: string;
  /**
   * BACKLINK: the vendor's own session id the runner stamped on this job, or
   * null. Display-only here — the affordance itself is unlocked by
   * `resumeProbe` below, and the terminal HOST re-looks the id up and
   * re-validates it before anything is spawned.
   */
  vendorSessionId?: string | null;
  /**
   * Takeover spawn coordinates, ONE PER DOOR (the host re-derives everything
   * else from them, and refuses a slot that does not match the mode it
   * granted). They are separate ptys because a fork and a resume are separate
   * vendor sessions: sharing a coordinate meant a live fork survived its
   * pane's close and was served back to the re-open — under the resume pane's
   * words — because the relay's open is a no-op while the host still holds the
   * id. `forkSessionId` absent ⇒ no fork door, whatever the probe grants.
   */
  resumeSessionId?: string;
  forkSessionId?: string;
  resumeKind?: string | null;
  /**
   * Trusted main's answer to "would the resume door actually open" — the SAME
   * lookup the spawn is authorized by, including the vendor's own session
   * store. `ready` renders the button; `unavailable` renders its reason in
   * the button's place; null/undefined (probe still in flight, or no job)
   * renders neither. A resume affordance must never offer a session that
   * cannot be resumed.
   */
  resumeProbe?: JobResumeProbe | null;
  /**
   * Ask trusted main again NOW. Offered only for a refusal main itself marked
   * "not yet" (`JobResumeProbe.pending`), after the parent's bounded automatic
   * re-asking has stopped — so a vendor that took longer than the retry budget
   * to save its session is still reachable, without this pane polling forever.
   */
  onRecheckTakeover?: () => void;
  /** Error from the stream poller — a failure is never a blank panel. */
  error?: string | null;
  /** Owning chat, so main can authorize the live read per poll. */
  chatId?: string | null;
  /**
   * Why this tab is showing the ledger feed even though the job advertised a
   * live console. Rendered above the feed: a fallback the human cannot see
   * the reason for is indistinguishable from a bug.
   */
  liveDegradedReason?: string | null;
  /** The live attach turned out to be unavailable; the parent drops live mode. */
  onLiveDegraded?: (reason: string) => void;
  /** The bridge read for the live pane. Injected so tests need no Electron. */
  readJobTerminal?: (query: JobTerminalQuery) => Promise<JobTerminalResponse>;
  /**
   * Deliberately tear down one terminal session (the same governed
   * `muon:closeTerminal` path every other close uses). Injected so tests need
   * no Electron; used by the resume pane's retry.
   */
  closeTerminalSession?: (sessionId: string) => Promise<void>;
  /**
   * This pane is BACKGROUNDED — another workspace tab or another session
   * section is on screen — and must show/hide only. Nothing here opens or
   * closes a session: an open takeover keeps its pty, its channel, its acks
   * and its scrollback, and only re-measures when it comes back (a hidden
   * container reports 0×0).
   */
  hidden?: boolean;
  /**
   * This pane now holds (or no longer holds) a live takeover pty.
   *
   * The parent needs this because the LATCH lives here, in plain `useState`,
   * and it dies with this component — while the pty it named does NOT. Every
   * ancestor that unmounts this subtree therefore strands a live vendor child:
   * the port closes, the host detaches, and PtyHost's backpressure pauses the
   * child the moment it writes past its unread high-water mark. Coming back
   * replays a BOUNDED byte ring into a fresh XTerm, which for a full-screen
   * vendor TUI means resuming from wherever the ring was trimmed to — the same
   * "switching stopped the terminal / the stream is distorted" corruption the
   * human terminal tabs were made keep-mounted to prevent. Worse for a job
   * that finished while the pane was gone: its grant flips to `resume`, and
   * the host then REFUSES any `.fork` open, so that child becomes permanently
   * unreachable with nothing in the UI saying so.
   *
   * So the parent keeps this subtree mounted and merely `hidden` while this is
   * true. Reported from an effect, and reported `false` on unmount, because an
   * unmount IS the latch closing however it happened.
   */
  onTakeoverOpenChange?: (open: boolean) => void;
}) {
  const { mode } = props;
  // A fresh vendor session is ONLY ever mounted after this flips, and it flips
  // only from the button below. There is no code path from "tab opened" to a
  // spawn — that conflation was the defect.
  const [newSession, setNewSession] = useState(false);
  // Same rule for the TAKEOVER pane: an explicit click, never a tab-open side
  // effect. It reopens the job's OWN dispatched session in the vendor's real
  // TUI; the host re-derives the session id from the job record.
  //
  // LATCHED AT THE CLICK, and that is the point. The probe re-fires while this
  // pane is mounted (the job finishes, and the same job's grant flips from
  // `fork` to `resume`), and reading the CURRENT grant here relabelled a pane
  // that had not changed: a human sitting in a fork was told, without anything
  // remounting, "this is the Codex session MUON dispatched, reopened — typing
  // here continues the session as you". The pane must describe the door it
  // actually opened, for as long as it holds it open.
  const [openedTakeover, setOpenedTakeover] = useState<{
    mode: "resume" | "fork";
    sessionId: string;
    kind: string;
  } | null>(null);
  // Why an explicitly-opened terminal did not start. The host answers every
  // refusal with a typed reason; showing it OUTSIDE the terminal body is what
  // turns a blank rectangle into something a human can act on.
  const [spawnError, setSpawnError] = useState<string | null>(null);
  // Bumped by the retry below to REMOUNT the resume pane (the terminal only
  // re-opens when its session identity or its mount changes).
  const [resumeAttempt, setResumeAttempt] = useState(0);

  // TELL THE PARENT THIS PANE IS HOLDING A PTY, so it can keep the subtree
  // mounted instead of unmounting it on a tab switch (see the prop's doc).
  //
  // Held in a REF, and the effect depends only on the open/closed FACT. The
  // callback's identity is not one: every ancestor rebuilds it each render, so
  // depending on it re-ran this effect on every render — cleanup reporting
  // `false`, the effect reporting `true` — which re-rendered the ancestor,
  // which rebuilt the callback. A render loop, not a notification.
  const takeoverOpen = openedTakeover !== null;
  const takeoverOpenChangeRef = useRef(props.onTakeoverOpenChange);
  useEffect(() => {
    takeoverOpenChangeRef.current = props.onTakeoverOpenChange;
  });
  useEffect(() => {
    takeoverOpenChangeRef.current?.(takeoverOpen);
    // An unmount is a close, whatever caused it: the latch is this component's
    // own state, so it cannot outlive it, and a parent still believing this
    // pane holds a pty would keep an empty session shell mounted forever.
    return () => takeoverOpenChangeRef.current?.(false);
  }, [takeoverOpen]);

  // `hidden` on the pane's own root: `.job-terminal` is `display: flex`, which
  // beats the UA's `[hidden] { display: none }`, so the CSS carries an explicit
  // override (styles.css) for exactly this attribute. Presentation only.
  const paneHidden = props.hidden === true;

  /**
   * Retry a resume that failed to start — the human's way back.
   *
   * The terminal host refuses to respawn a session id whose child died on
   * startup (that guard is what stopped one failed launch from becoming a
   * column of dead panes), and it clears that record only on an EXPLICIT
   * close. Every close call site in the app names a job's plain
   * `terminal-<jobId>`; none names its `.resume`/`.fork` siblings (the host
   * sweeps them from the plain id — terminal-host.ts). So one transient
   * failure — `claude` not yet on the PATH the app was launched with, a
   * signed-out CLI — refused this job's resume for the rest of the app's life,
   * with nothing in the UI able to undo it. This button IS that explicit
   * close: it tears the session down, which forgets the fast-exit record, then
   * remounts the pane so the next open is a genuine first attempt.
   */
  const retryResume = () => {
    // The id of the pane the human is LOOKING AT — latched — never the door
    // that happens to be authorized now. Closing the other slot would forget a
    // fast-exit record for a session this retry is not retrying.
    const sessionId = openedTakeover?.sessionId;
    if (!sessionId) {
      return;
    }
    setSpawnError(null);
    const close = props.closeTerminalSession ?? bridgeCloseTerminalSession;
    // Remount only AFTER the teardown lands, so the re-open cannot race the
    // close it depends on. A failed close still remounts: the pane then shows
    // the host's own refusal again rather than swallowing the click.
    void Promise.resolve()
      .then(() => close(sessionId))
      .catch(() => undefined)
      .then(() => setResumeAttempt((attempt) => attempt + 1));
  };

  // WHICH door main authorized. Never inferred from job status here: the
  // renderer would then be a second opinion about an authority decision, and
  // the two could disagree across a status transition. `resume` is the
  // fallback only for the shape of a probe that predates the field.
  const takeoverMode =
    props.resumeProbe?.status === "ready" ? props.resumeProbe.mode : "resume";
  // …and WHICH pty that door gets. Never one slot for both: see the prop docs.
  const takeoverSessionId =
    (takeoverMode === "fork" ? props.forkSessionId : props.resumeSessionId) ??
    null;
  const canResume = Boolean(
    props.vendorSessionId &&
      props.resumeKind &&
      takeoverSessionId &&
      props.resumeProbe?.status === "ready"
  );
  const forking = canResume && takeoverMode === "fork";
  // A recorded session the probe REFUSED: the truth belongs where the button
  // would have been, in the probe's own sentence.
  const resumeRefusedReason =
    props.vendorSessionId && props.resumeProbe?.status === "unavailable"
      ? props.resumeProbe.reason
      : null;
  // "NOT YET" vs "no", and MAIN decides which — this pane only renders the
  // tense main stated. The refusal a running job gets while its vendor has not
  // saved the session yet is transient by construction (measured: a codex
  // rollout appeared 3 seconds into a run), and wording it "can't be reopened"
  // stated a permanent impossibility about a condition that was false a second
  // later. The parent re-asks on a bounded cadence while this is true.
  const takeoverPending = Boolean(
    resumeRefusedReason &&
      props.resumeProbe?.status === "unavailable" &&
      props.resumeProbe.pending === true
  );
  // IS THIS JOB STILL GOING? Read from the MODE main handed down (which is
  // built from the job's own status), never re-derived here — the same reason
  // the takeover mode is not re-derived: a second opinion about a fact this
  // pane does not own can disagree with the first across a transition.
  const jobFollowing = mode.kind === "unavailable" ? false : mode.following;
  // Feeds the "replay" note (agentTerminalModeNote) — the SAME facts
  // `canResume`/`resumeRefusedReason` above are built from, so the note can
  // never promise a resume door this pane isn't also offering. `resumeKind`
  // is null for a vendor with no resumable CLI session at all (cursor,
  // opencode) regardless of job status; otherwise the probe decides
  // `available` vs `unavailable`, and `pending` covers the honest "don't know
  // yet" window.
  //
  // `never-recorded` is the case `pending` used to swallow: the parent only
  // runs the probe once a vendor session id is stamped, so a FINISHED job that
  // never got one produces no probe answer at all — null probe, null refusal —
  // and fell through to "pending". The pane then said MUON was waiting for the
  // vendor to save a session for a job that had ended days ago, with nothing
  // that could ever contradict it. A job that is over and holds no id is not
  // waiting for anything.
  const resumeAvailability: ResumeAvailability = !props.resumeKind
    ? "unsupported"
    : forking
      ? "forkable"
      : canResume
        ? "available"
        : resumeRefusedReason && !takeoverPending
          ? "unavailable"
          : !props.vendorSessionId && !jobFollowing
            ? "never-recorded"
            : "pending";

  if (openedTakeover) {
    // EVERY word below reads the LATCH, never the live probe: this pane is
    // whatever it opened, until the human leaves it.
    const openedFork = openedTakeover.mode === "fork";
    return (
      <div className="job-terminal" hidden={paneHidden}>
        <div className="job-terminal-head" role="status">
          <span className="job-terminal-badge job-terminal-badge-live">
            {props.vendorLabel} session {props.vendorSessionId?.slice(0, 8)}… —{" "}
            {openedFork ? "forked" : "resumed"}
          </span>
          <button
            className="ghost-btn job-terminal-back"
            onClick={() => {
              setSpawnError(null);
              setOpenedTakeover(null);
            }}
            type="button"
          >
            Back to this job's output
          </button>
        </div>
        {openedFork ? (
          <p className="job-terminal-note">
            This is a <strong>fork</strong> of the {props.vendorLabel} session
            MUON dispatched, opened in the vendor&apos;s own terminal in this
            job&apos;s worktree. It carries everything the agent had done when
            you clicked, starting with the brief MUON sent it — under a new
            session id. The dispatched agent is still working in{" "}
            <strong>its own</strong> session and cannot see this one, so
            nothing you type here steers it or passes through its approval
            gate.
          </p>
        ) : (
          <p className="job-terminal-note">
            This is the {props.vendorLabel} session MUON dispatched, reopened in
            the vendor's own terminal in this job's worktree. Its transcript
            starts with the brief MUON sent it. This pane is yours: typing here
            continues the session as you, outside MUON's dispatch gates.
          </p>
        )}
        {/* THE WORKTREE IS SHARED, AND SO IS THE EVIDENCE. This job's handoff
            packet and its review gate are `git diff HEAD` over this very
            directory, so an edit made here is not "your own copy" — it is part
            of what the agent is attested to have done and what you will later
            approve. And committing in this terminal empties that diff, which
            deletes the agent's own uncommitted work from its evidence. Saying
            only "expect to see each other's edits on disk" left both of those
            for the human to discover at the gate. */}
        <p className="job-terminal-note">
          You are in this job&apos;s own working tree
          {openedFork ? ", at the same time as the agent" : ""}. Anything you
          change here becomes part of this job&apos;s diff — the evidence MUON
          attests to and the change you approve at the review gate.{" "}
          <strong>Do not commit from this terminal:</strong> this job&apos;s
          evidence is its uncommitted diff, so a commit here makes the
          agent&apos;s own work vanish from it.
        </p>
        {spawnError ? (
          <div className="session-callout degraded" role="alert">
            <strong>This session could not be reopened</strong>
            <p>{spawnError}</p>
            <button className="ghost-btn" onClick={retryResume} type="button">
              Try again
            </button>
          </div>
        ) : null}
        <TerminalPreview
          key={`${openedTakeover.mode}-${resumeAttempt}`}
          // BACKGROUNDED, never unmounted. The pty, the channel and the
          // scrollback stay exactly as they are; this only tells the view to
          // re-measure on the way back, because a hidden container reports 0×0
          // and would otherwise leave the grid pinned at the wrong size.
          hidden={paneHidden}
          sessionId={openedTakeover.sessionId}
          spawn={{ file: openedTakeover.kind, cwd: "." }}
          onError={setSpawnError}
        />
      </div>
    );
  }

  if (newSession && props.spawnKind) {
    return (
      <div className="job-terminal" hidden={paneHidden}>
        <div className="job-terminal-head" role="status">
          <span className="job-terminal-badge job-terminal-badge-new">
            New {props.vendorLabel} session
          </span>
          <button
            className="ghost-btn job-terminal-back"
            onClick={() => {
              setSpawnError(null);
              setNewSession(false);
            }}
            type="button"
          >
            Back to this job's output
          </button>
        </div>
        <p className="job-terminal-note">
          This is a fresh {props.vendorLabel} session you started, running in
          this job's worktree. It is <strong>not</strong> the dispatched agent
          and shares none of its history.
        </p>
        {spawnError ? (
          <div className="session-callout degraded" role="alert">
            <strong>This session could not be started</strong>
            <p>{spawnError}</p>
          </div>
        ) : null}
        <TerminalPreview
          sessionId={props.spawnSessionId}
          spawn={{ file: props.spawnKind, cwd: "." }}
          onError={setSpawnError}
        />
      </div>
    );
  }

  return (
    <div className="job-terminal" hidden={paneHidden}>
      {/* THE PRIMARY ACTION, at the top where a human actually looks: the
          job's own dispatched vendor session, reopened in the vendor's real
          interactive TUI. Rendered ONLY on a verified probe — the governed
          feed below stays what it is (read-only), and this is the door to a
          keyboard. */}
      {canResume ? (
        <div className="job-terminal-primary" role="group">
          <div className="job-terminal-primary-copy">
            <strong>
              {forking
                ? `Take over this job's ${props.vendorLabel} session now`
                : `Open this job's real ${props.vendorLabel} session`}
            </strong>
            <span>
              {/* The pre-click copy said nothing about the worktree at all,
                  so the shared-tree cost was only discoverable AFTER opening
                  the door. It belongs here, before the click. */}
              {forking
                ? `The agent is still working, so MUON opens a FORK of its session (${props.vendorSessionId?.slice(
                    0,
                    8
                  )}…) in ${props.vendorLabel}'s own interactive terminal, in this job's worktree — everything it has done so far, with your keyboard live. The dispatched agent keeps its own session and carries on ungoverned by anything you type here. You share its working tree: what you change there lands in this job's diff and in the evidence you approve at the review gate, and committing from that terminal drops the agent's own work out of that evidence.`
                : `Reopens the exact session MUON dispatched (${props.vendorSessionId?.slice(
                    0,
                    8
                  )}…) in ${props.vendorLabel}'s own interactive terminal, in this job's worktree — with your keyboard live. What you change there lands in this job's diff and in the evidence you approve at the review gate, and committing from that terminal drops the job's own work out of that evidence.`}
            </span>
          </div>
          <button
            className="primary-btn"
            onClick={() =>
              setOpenedTakeover({
                mode: takeoverMode,
                sessionId: takeoverSessionId!,
                kind: props.resumeKind!,
              })
            }
            type="button"
          >
            {forking
              ? `Fork into ${props.vendorLabel}`
              : `Open ${props.vendorLabel} session`}
          </button>
        </div>
      ) : resumeRefusedReason ? (
        <div className="session-callout" role="status">
          <strong>
            {takeoverPending
              ? `This job's ${props.vendorLabel} session can't be opened yet`
              : `This job's real ${props.vendorLabel} session can't be reopened`}
          </strong>
          <p>{resumeRefusedReason}</p>
          {/* An explicit re-check, for the case the parent's bounded automatic
              re-asking ran out first. Offered only on a "not yet" — a hard
              refusal will answer the same way however many times it is asked,
              and a button that changes nothing is its own small lie. */}
          {takeoverPending && props.onRecheckTakeover ? (
            <button
              className="ghost-btn"
              onClick={props.onRecheckTakeover}
              type="button"
            >
              Check again
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="job-terminal-head">
        <span
          className={`job-terminal-badge job-terminal-badge-${mode.kind}`}
          role="status"
        >
          {mode.label}
        </span>
      </div>
      {/* For an unavailable mode the note IS the reason, and the empty state
          below prints it — saying it twice reads as two different problems. */}
      {mode.kind === "unavailable" ? null : (
        <p className="job-terminal-note">
          {agentTerminalModeNote(mode, props.vendorLabel, resumeAvailability)}
        </p>
      )}

      {/* The ledger-stream poller's failure. Not shown while the live pane is
          mounted: there the feed is not the body, and the attach has its own
          error state — two alerts about two different channels read as one
          confused surface. */}
      {props.error && mode.kind !== "live" ? (
        <div className="session-callout degraded" role="alert">
          <strong>This job's stream could not be read</strong>
          <p>{props.error}</p>
          <p>It will retry on the next refresh; the Timeline still works.</p>
        </div>
      ) : null}

      {/* WHY this is the ledger feed when the job advertised a live console.
          A silent fallback is indistinguishable from a bug. */}
      {props.liveDegradedReason && mode.kind !== "live" ? (
        <div className="session-callout" role="status">
          <strong>Showing the run&apos;s activity, not its live console</strong>
          <p>{props.liveDegradedReason}</p>
        </div>
      ) : null}

      {mode.kind === "live" ? (
        <JobTerminalAttach
          jobId={mode.jobId}
          chatId={props.chatId ?? null}
          sessionId={mode.sessionId}
          read={props.readJobTerminal ?? bridgeJobTerminalRead}
          createView={(container) =>
            readOnlyXtermView(container, agentConsoleGrid(props.vendor))
          }
          onDegrade={(reason) => props.onLiveDegraded?.(reason)}
        />
      ) : mode.kind === "unavailable" ? (
        <p className="session-empty">{mode.reason}</p>
      ) : (
        <ActivityFeed chunks={props.chunks} />
      )}

      <div className="job-terminal-foot">
        <label className="job-terminal-input-row">
          <span className="sr-only">Send input to this agent</span>
          <input
            className="job-terminal-input"
            disabled
            placeholder="Input is disabled for a governed agent"
            value=""
            readOnly
          />
        </label>
        <p className="job-terminal-foot-note">
          Typing into a dispatched agent would bypass the approval gate that
          makes it governed. Steer it from the mission composer instead — or
          {forking
            ? " fork its session into the vendor's own terminal (the button at the top of this pane)"
            : canResume
              ? " open the session yourself (the button at the top of this pane)"
              : " open the session yourself"}
          , where the keyboard is yours.
        </p>
        {props.spawnKind ? (
          <button
            className="ghost-btn"
            onClick={() => setNewSession(true)}
            type="button"
          >
            Start a new {props.vendorLabel} session in this worktree
          </button>
        ) : (
          <p className="job-terminal-foot-note">
            MUON cannot start an interactive {props.vendorLabel} session from
            here.
          </p>
        )}
      </div>
    </div>
  );
}
