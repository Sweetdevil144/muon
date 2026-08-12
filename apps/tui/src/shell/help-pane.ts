import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { helpSections, SCOPE_LABEL } from "./keymap.js";
import { bold, cyan, dim } from "./theme.js";

/**
 * `?` — rendered from KEYMAP, the same table `routeKey` resolves against.
 *
 * There is no second list. That is the entire design: a help pane built from
 * its own literal is a promise nobody keeps, and the drift-lock test
 * (`keymap-drift.test.ts`) fails the build if any row here has no live
 * handler. Founder law 6, made mechanical.
 */
export class HelpPane implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [
      bold(" keys"),
      dim(" every key below is dispatched from the same table this list is built from"),
      "",
    ];
    for (const section of helpSections()) {
      if (section.entries.length === 0) continue;
      lines.push(cyan(` ${SCOPE_LABEL[section.scope]}`));
      for (const entry of section.entries) {
        lines.push(`   ${bold(entry.key.padEnd(12))} ${dim(entry.help)}`);
      }
      lines.push("");
    }
    // THE MOUSE IS ADVERTISED TOO, and under the same law: every line here
    // must do something. These three are the whole of it — deliberately, so
    // that a human who cannot make a chord work in their terminal still has a
    // way to drive the desk that no keyboard protocol can take away.
    lines.push(cyan(" mouse"));
    lines.push(`   ${bold("click +".padEnd(12))} ${dim("open a new tab")}`);
    lines.push(`   ${bold("click a tab".padEnd(12))} ${dim("go to it")}`);
    lines.push(
      `   ${bold("click a session".padEnd(12))} ${dim("go to it (sidebar: ctrl+b s)")}`
    );
    lines.push(
      dim("   inside the pane the mouse belongs to whatever is running there")
    );
    lines.push("");
    lines.push(dim(" esc closes this"));
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
