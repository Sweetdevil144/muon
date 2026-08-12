import type { JobTerminalView, MuonApiClient } from "@muon/client";
import { Screen } from "./screen.js";

/**
 * A GOVERNED pane's session: a dispatched job's live console, read-only.
 *
 * This is ADR-0046 D1's headline and the one place the TUI differs from every
 * terminal multiplexer — the pane shows an agent MUON dispatched, under
 * MUON's governance, rather than a process the human started.
 *
 * READ-ONLY IS THE GOVERNANCE, not a missing feature. The client's attach API
 * has no write counterpart on purpose: input sent to a dispatched agent would
 * bypass the approval gate that makes it governed. So this class has no
 * `write()` at all — not a method that refuses, an ABSENT method, so no
 * caller can reach past it and no future edit can quietly add a bypass
 * without deleting this comment first. A human who wants to type at that
 * agent takes it over through the approval path, which mints a different
 * (ungoverned, labelled) session.
 *
 * THREE HONESTY RULES, each from the contract's own docstrings:
 *  - `available:false` means this brain holds no console for the job (it
 *    finished, or the brain restarted and dropped its ring). Render that,
 *    never a blank pane labelled live.
 *  - `dropped > 0` means frames were lost before the brain saw them. A viewer
 *    that ignores it presents a discontinuous terminal as continuous.
 *  - a cursor below `firstSeq` means the ring trimmed past us — same class of
 *    lie, different cause, so it is reported separately.
 */

/** Consecutive skipped ticks before the pane says the tail is stalled. */
const STALLED_POLLS_BEFORE_NOTICE = 5;

export type GovernedState = {
  readonly jobStatus: string;
  readonly available: boolean;
  /** Frames the brain never saw (runner overflow, refused batch, scrub drop). */
  readonly dropped: number;
  /** True when the ring trimmed past our cursor: we missed retained bytes. */
  readonly gapped: boolean;
  readonly lastError: string | null;
};

export class GovernedSession {
  readonly jobId: string;
  /** Shown in the tab; STORED text, sanitized by the chrome that renders it. */
  readonly title: string;
  /** D5's other half: this pane IS governed, and says so. */
  readonly ungoverned = false as const;

  private readonly client: MuonApiClient;
  private readonly screen: Screen;
  private cursor = 0;
  /** The execution this cursor belongs to. A new one restarts the sequence. */
  private sessionId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stalledPolls = 0;
  private onChange: (() => void) | null = null;
  private state: GovernedState = {
    jobStatus: "unknown",
    available: false,
    dropped: 0,
    gapped: false,
    lastError: null,
  };

  constructor(input: {
    client: MuonApiClient;
    jobId: string;
    title: string;
    cols: number;
    rows: number;
  }) {
    this.client = input.client;
    this.jobId = input.jobId;
    this.title = input.title;
    this.screen = new Screen(input.cols, input.rows);
  }

  subscribe(listener: () => void): void {
    this.onChange = listener;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): GovernedState {
    return this.state;
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      this.stalledPolls += 1;
      // A request can hang for the client's full timeout. Say the tail is
      // stalled rather than letting a frozen screen read as a quiet agent.
      if (this.stalledPolls >= STALLED_POLLS_BEFORE_NOTICE) {
        this.state = { ...this.state, lastError: "attach is not responding" };
        this.onChange?.();
      }
      return;
    }
    this.stalledPolls = 0;
    this.inFlight = true;
    try {
      const view: JobTerminalView = await this.client.readJobTerminal(
        this.jobId,
        { afterSeq: this.cursor, limit: 200 }
      );
      // The ring trimmed past us: we asked for everything after `cursor` and
      // the earliest frame we got back is LATER than the next one we expected.
      //
      // NO `cursor > 0` GUARD. The first poll is the COMMON case: any agent
      // running long enough to exceed the brain's ring has already trimmed,
      // so a fresh attach at cursor 0 expecting seq 1 and receiving seq 100
      // is exactly the "you are seeing this mid-stream" the band exists to
      // announce. The guard silenced it precisely when it mattered most, and
      // the test was written to the implementation rather than to the rule.
      const expected = this.cursor + 1;
      const gapped =
        this.state.gapped ||
        (view.firstSeq !== null && view.firstSeq > expected);
      // A DIFFERENT sessionId is a fresh EXECUTION of the job: the brain's
      // store restarts at seq 0, and a stale cursor would filter out every
      // frame of the new run while the pane still said "running" — the
      // previous execution's screen, labelled live, forever. Rewind.
      if (this.sessionId !== null && view.sessionId !== this.sessionId) {
        this.cursor = 0;
        // AND CLEAR THE SCREEN. Rewinding the cursor alone left the previous
        // execution's output in the emulator, with the new run's frames
        // painting over it — a pane showing two runs at once and labelling
        // the mixture live. A fresh execution gets a fresh screen.
        this.screen.reset();
      }
      this.sessionId = view.sessionId;
      for (const frame of view.frames) {
        this.screen.write(frame.data);
        this.cursor = Math.max(this.cursor, frame.seq);
      }
      this.state = {
        jobStatus: view.jobStatus,
        available: view.available,
        // MONOTONIC: the brain's counter resets on a re-execution, and
        // un-saying a warning we already made is worse than repeating it.
        dropped: Math.max(this.state.dropped, view.dropped),
        gapped,
        lastError: null,
      };
    } catch (error) {
      // A transient failure must not kill the tail, and must not silently
      // masquerade as "the agent is quiet".
      this.state = {
        ...this.state,
        lastError:
          error instanceof Error ? error.message.split("\n")[0] : String(error),
      };
    } finally {
      this.inFlight = false;
      this.onChange?.();
    }
  }

  renderScreen(): string[] {
    return this.screen.renderScreen();
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  dispose(): void {
    this.stop();
    this.screen.dispose();
  }
}
