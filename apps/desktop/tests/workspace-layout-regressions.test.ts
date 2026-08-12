import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8"
);

describe("workspace layout regressions", () => {
  it("keeps tabs atomic and scrollable instead of shrinking them into each other", () => {
    expect(styles).toMatch(
      /\.workspace-agent-tab\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*max-content;/s
    );
    expect(styles).toMatch(
      /\.workspace-tabs\s*\{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;/s
    );
  });

  it("bounds crew streams and gives session tabs a constrained flex shell", () => {
    expect(styles).toMatch(
      /\.panes\.open\s*\{[^}]*max-height:\s*min\(42vh,\s*360px\);/s
    );
    expect(styles).toMatch(
      /\.workspace-session-shell\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;/s
    );
  });

  /**
   * A BACKGROUNDED pane must actually be invisible, and only CSS can say so.
   *
   * `hidden` is a UA `display: none`, which every author `display: flex` in
   * this file beats. The human terminal shells already carry an explicit
   * override for exactly that reason; the SESSION pane and the job terminal
   * body now need it too, because a pane holding a live vendor takeover is
   * kept MOUNTED across workspace-tab and section switches (unmounting it
   * detaches the pty and strands the fork). Without these selectors the kept
   * panes render on top of whatever is actually on screen — and jsdom applies
   * no stylesheet, so no rendering test can catch it.
   */
  it("hides a backgrounded session pane and job terminal instead of stacking them", () => {
    expect(styles).toMatch(
      /\.workspace-session-shell\[hidden\],\s*\.job-terminal\[hidden\]\s*\{[^}]*display:\s*none;/s
    );
    // The rule must come AFTER the `display: flex` it has to beat — equal
    // specificity resolves by source order.
    expect(styles.indexOf(".workspace-session-shell[hidden]")).toBeGreaterThan(
      styles.indexOf(".workspace-session-shell {")
    );
    expect(styles.indexOf(".job-terminal[hidden]")).toBeGreaterThan(
      styles.indexOf(".job-terminal {")
    );
  });

  it("pins Memory navigation and lets terminals fill their panel", () => {
    expect(styles).toMatch(
      /\.memory-workspace-tabs\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s
    );
    expect(styles).toMatch(
      /\.terminal-tab\s*\{[^}]*height:\s*100%;[^}]*flex:\s*1;/s
    );
  });
});
