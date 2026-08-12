import { terminalSafe } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { dim, green, red, yellow } from "./theme.js";
import type { GovernedSession } from "./governed-session.js";

/**
 * The centre pane for a GOVERNED session — a dispatched agent's live console.
 *
 * Same split as `PtyPane`: the session owns the feed, this only reads. What
 * differs is the chrome, and the chrome is the point (ADR-0046 D5). An
 * ungoverned pane must say so; a governed one must say THAT, and must not
 * imply liveness it does not have — hence the honesty band, which reports
 * `available:false`, dropped frames, ring gaps and poll errors rather than
 * presenting an empty or discontinuous terminal as a healthy live one.
 *
 * There is no `handleInput`. A component without that method never receives
 * keystrokes from the engine's dispatcher — the read-only boundary is
 * therefore structural here too, matching the session's absent `write()`.
 */
export class GovernedPane implements Component {
  private readonly session: GovernedSession;

  constructor(session: GovernedSession) {
    this.session = session;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.session.snapshot();
    const lines: string[] = [];

    lines.push(
      green(` GOVERNED `) +
        dim(
          ` ${terminalSafe(this.session.title)} · ${terminalSafe(
            state.jobStatus
          )} · read-only (input would bypass the approval gate)`
        )
    );

    // THE BAND COMES FIRST, ABOVE the screen. Composed after it, the shell's
    // row budget clipped it off the bottom — at 30 rows three of the four
    // lines, including the gap notice and the attach error, were silently
    // invisible while every test asserted on the pane in isolation and
    // passed. A warning that the layout can drop is not a warning.
    const band: string[] = [];
    if (!state.available) {
      band.push(
        yellow(
          `[no live console held for this job — showing what was captured${
            state.jobStatus ? `; job is ${terminalSafe(state.jobStatus)}` : ""
          }]`
        )
      );
    }
    if (state.dropped > 0) {
      band.push(
        yellow(
          `[${state.dropped} frame(s) never reached the brain — this console is not continuous]`
        )
      );
    }
    if (state.gapped) {
      band.push(
        yellow("[the console ring trimmed past this viewer — output is missing above]")
      );
    }
    if (state.lastError) {
      band.push(red(`[attach error: ${terminalSafe(state.lastError)}]`));
    }
    lines.push(...band, ...this.session.renderScreen());

    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
