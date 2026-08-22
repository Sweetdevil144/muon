import { terminalSafe } from "@muon/client";
import type { DeskDigest, DeskDigestSection } from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, yellow } from "./theme.js";

/**
 * ADR-0085 D2 — the desk's first frame after an absence.
 *
 * NAVIGATION, never a second rendering of the objects themselves: every
 * line is a kind word + a coordinate the existing panes can jump to. D3 is
 * the rendering rule that matters here: every section says its TOTAL count
 * and whether the window clipped — "3 gates" and "41 events (showing 20)"
 * are different sentences, and this pane never lets the second read as the
 * first.
 */

/** One section header: honest about its window (D3). */
function heading(label: string, section: DigestSectionLike): string {
  // countExact === false ⇔ the count is a FLOOR (the server's scan capped)
  // — "≥N" and "N total" are different sentences (review finding).
  const total =
    section.countExact === false ? `≥${section.count}` : `${section.count} total`;
  const window = section.truncated
    ? yellow(` (${total}, showing ${section.items.length})`)
    : dim(` (${section.count}, complete)`);
  return cyan(` ${label}`) + window;
}

type DigestSectionLike = Pick<
  DeskDigestSection,
  "count" | "truncated" | "items"
> & { countExact?: boolean };

function when(value: unknown): string {
  const at = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toISOString().slice(11, 16)
    : "--:--";
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  // EVERY rendered field passes the transcript sanitizer (review finding):
  // fork titles and finding subjects are AGENT-AUTHORED, and a raw string
  // into the terminal is an ANSI-escape channel.
  return typeof value === "string" ? terminalSafe(value) : "";
}

export function digestHasContent(digest: DeskDigest): boolean {
  if (!digest.sections) return false;
  return Object.values(digest.sections).some(
    (section) => (section as DigestSectionLike).count > 0
  );
}

export class DigestPane implements Component {
  constructor(private readonly digest: DeskDigest) {}

  invalidate(): void {}

  render(width: number): string[] {
    const digest = this.digest;
    const lines: string[] = [];
    const sinceLabel = digest.since
      ? new Date(digest.since).toISOString().replace("T", " ").slice(0, 16)
      : "unknown";
    lines.push(bold(" since you last looked"));
    lines.push(dim(` boundary: ${sinceLabel} — the crew kept working; this is what landed`));
    lines.push("");
    const sections = digest.sections;
    if (!sections) {
      lines.push(dim(` ${digest.note ?? "no boundary recorded yet"}`));
      lines.push("");
      lines.push(dim(" esc closes this"));
      return lines;
    }

    if (sections.gatesOpened.count > 0 || sections.gatesDecided.count > 0) {
      lines.push(heading("gates", {
        count: sections.gatesOpened.count + sections.gatesDecided.count,
        truncated: sections.gatesOpened.truncated || sections.gatesDecided.truncated,
        items: [...sections.gatesOpened.items, ...sections.gatesDecided.items],
      }));
      // ONE chronological stream (review finding: opened-then-decided
      // blocks re-ordered the absence) — the digest replays what landed,
      // in the order it landed.
      const gateRows = [
        ...sections.gatesOpened.items.map((row) => ({
          at: row.createdAt,
          verb: "opened",
          row,
        })),
        ...sections.gatesDecided.items.map((row) => ({
          at: row.decidedAt,
          verb: String(row.status ?? "decided"),
          row,
        })),
      ].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
      for (const entry of gateRows) {
        lines.push(`   ${when(entry.at)} ${bold(entry.verb.padEnd(9))} ${str(entry.row, "kind")} on ${dim(str(entry.row, "taskId").slice(0, 12))}`);
      }
      lines.push("");
    }
    if (sections.packets.count > 0) {
      lines.push(heading("packets", sections.packets));
      for (const row of sections.packets.items) {
        const contract = str(row, "classification");
        const word = contract === "typed" ? contract : yellow(contract);
        lines.push(`   ${when(row.at)} ${word.padEnd(20)} task ${dim(str(row, "taskId").slice(0, 12))}`);
      }
      const receipts = sections.packets.receiptsMinted;
      // PAGE-LOCAL, and says so (review finding): receipts are counted
      // over the rows shown, not the clipped total.
      if (receipts > 0)
        lines.push(
          dim(
            `   ${receipts} of the ${sections.packets.items.length} shown carried a session receipt`
          )
        );
      lines.push("");
    }
    if (sections.questions.count > 0) {
      lines.push(heading("questions", sections.questions));
      for (const row of sections.questions.items) {
        lines.push(`   ${when(row.timestamp)} ${str(row, "kind").replace("question.", "").padEnd(16)} task ${dim(str(row, "taskId").slice(0, 12))}`);
      }
      lines.push("");
    }
    if (sections.forks.count > 0 || sections.forks.truncated) {
      // Rendered even at count 0 when the scan capped: a capped window
      // with zero roots in it must say "≥0, window capped", never hide
      // fork activity entirely (review finding).
      lines.push(heading("forks taken", sections.forks));
      for (const row of sections.forks.items) {
        lines.push(`   ${when(row.at)} ${str(row, "title").slice(0, 40)} ${dim(`from ${str(row, "forkSourceTaskId").slice(0, 12)}`)}`);
      }
      lines.push("");
    }
    if (sections.findings.count > 0) {
      lines.push(heading("findings", sections.findings));
      for (const row of sections.findings.items) {
        lines.push(`   ${when(row.at)} ${str(row, "subject").slice(0, 60)}`);
      }
      lines.push("");
    }
    if (sections.contradictions.count > 0) {
      lines.push(heading("disputes filed", sections.contradictions));
      for (const row of sections.contradictions.items) {
        lines.push(`   ${when(row.at)} ${dim(`note ${str(row, "fromId").slice(0, 10)} contradicts ${str(row, "toId").slice(0, 10)}`)}`);
      }
      lines.push("");
    }
    if (lines.length === 3) {
      lines.push(dim(" nothing landed while you were away"));
      lines.push("");
    }
    lines.push(dim(" esc dismisses this — the desk is behind it"));
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
