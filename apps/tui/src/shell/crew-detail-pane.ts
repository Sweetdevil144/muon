import { terminalSafe } from "@muon/client";
import { sessionSlug } from "@muon/client/session-slug";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import {
  UNTRUSTED_PEER_HEADER,
  type CrewPanelLoad,
} from "../lib/crew-view.js";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * ADR-0087 M7 — the crew DETAIL: roles + A2A coordination, folded into the
 * crew family as its own surface (`d` from the crew drawer).
 *
 * Renders the SHARED `crew-view` sections verbatim — the same loader
 * (`loadCrewPanel`) the classic panel and `muon crew` read, with its own
 * sanitization and the mission-root rule, so the two desks cannot disagree
 * about a crew. The two honesty bars carried through:
 *  - `planStatus` renders the DISTINCTION: a proposed plan is a preview,
 *    never presented as a commitment;
 *  - peer traffic renders under the UNTRUSTED header — evidence, not
 *    instructions — with the total count beside the bounded page.
 */

export type CrewDetailState =
  | { readonly phase: "loading" }
  | { readonly phase: "unavailable"; readonly reason: string }
  | { readonly phase: "ready"; readonly load: CrewPanelLoad };

export class CrewDetailPane implements Component {
  constructor(private readonly state: CrewDetailState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [
      bold(" crew detail ") + dim("roles + coordination · esc back"),
      "",
    ];
    const clip = (all: string[]) =>
      all.map((line) => (line.length > width * 4 ? line.slice(0, width * 4) : line));
    if (this.state.phase === "loading") {
      lines.push(dim(" loading the crew's roles and coordination…"));
      return clip(lines);
    }
    if (this.state.phase === "unavailable") {
      // Backend-provided text — sanitized (review finding: a compromised
      // backend's error message is an ANSI channel like any other) and
      // clipped like every other path (second finding: the early returns
      // bypassed the cap).
      lines.push(yellow(` ${terminalSafe(this.state.reason)}`));
      return clip(lines);
    }
    const { roles, coordination } = this.state.load;

    if (roles.status === "loading") {
      lines.push(dim(" roles loading…"));
    } else if (roles.status === "error") {
      lines.push(red(` roles unavailable: ${terminalSafe(roles.reason)}`));
    } else {
      const statusWord =
        roles.planStatus === "assigned"
          ? green("assigned")
          : roles.planStatus === "proposed"
            ? yellow("proposed — a preview, nobody has committed this crew")
            : dim("none — no plan stored");
      lines.push(cyan(" roles ") + statusWord);
      for (const row of roles.rows) {
        const marker = row.blocked ? red("⛔ ") : "   ";
        lines.push(
          `${marker}${row.role.padEnd(14)} ${row.vendor.padEnd(12)} ${dim(
            `${row.authority} · fit ${row.fit} · by ${row.assignedBy}`
          )}${row.blocked && row.blockedReason ? red(` · ${row.blockedReason}`) : ""}`
        );
      }
      if (roles.unfilled.length > 0) {
        lines.push(yellow(`   unfilled: ${roles.unfilled.join(", ")}`));
      }
      if (roles.lanes.length > 0) {
        lines.push(
          dim(
            `   lanes: ${roles.lanes
              .map((lane) => `${lane.displayName} (${lane.health})`)
              .join(" · ")}`
          )
        );
      }
    }
    lines.push("");

    if (coordination.status === "loading") {
      lines.push(dim(" coordination loading…"));
    } else if (coordination.status === "unavailable") {
      lines.push(dim(` coordination: ${terminalSafe(coordination.reason)}`));
    } else {
      lines.push(
        cyan(" coordination ") +
          dim(`mission ${sessionSlug(coordination.missionId)}`)
      );
      const shownParticipants = coordination.participants.slice(0, 8);
      for (const participant of shownParticipants) {
        lines.push(
          `   ${sessionSlug(participant.jobId).padEnd(16)} ${participant.role.padEnd(12)} ${participant.vendor.padEnd(10)} ${dim(
            `${participant.status} · ${participant.claimedPaths} claim(s) · ${participant.unreadMessages} unread`
          )}`
        );
      }
      if (coordination.participants.length > 8) {
        lines.push(
          dim(
            `   … and ${coordination.participants.length - 8} more participant(s) — \`muon crew coord\` prints the full set`
          )
        );
      }
      if (coordination.conflicts.length > 0) {
        lines.push(red("   contested paths"));
        for (const conflict of coordination.conflicts.slice(0, 6)) {
          lines.push(
            red(`     ${conflict.path}`) +
              dim(` held by ${conflict.heldBy} · lease to ${conflict.expiresAt}`)
          );
        }
      }
      if (coordination.messages.length > 0) {
        lines.push("");
        lines.push(yellow(`   ${UNTRUSTED_PEER_HEADER}`));
        const shown = Math.min(coordination.messages.length, 8);
        lines.push(
          dim(
            `   showing ${shown} of ${coordination.messageCount} message(s) — \`muon crew coord\` prints the page in full`
          )
        );
        for (const message of coordination.messages.slice(0, 8)) {
          lines.push(
            dim(`   ${message.from} → ${message.to} [${message.kind}] `) +
              message.subject.slice(0, 60)
          );
          // ADR-0086 D2 — every cited note id renders WITH its derived
          // offered provenance (the shared classifier's sentence, built in
          // crew-view). Dim like the address line, never a pass/fail
          // color: this is provenance about the citer, not a verdict on
          // the work — and a relay line renders exactly like an offered
          // one, just labelled.
          for (const citation of message.citations) {
            lines.push(dim(`     ◦ ${citation}`));
          }
          if (message.finding) {
            // The announced finding is a COORDINATE (the sender's own
            // minted note) — rendered beside the citations but never with
            // an offers claim.
            lines.push(dim(`     ◦ ${message.finding} — finding`));
          }
        }
      } else {
        lines.push(dim("   no peer traffic on this mission yet"));
      }
    }
    return clip(lines);
  }
}
