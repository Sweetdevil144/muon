import { Box, Text } from "ink";
import type { MemoryNote } from "@muon/client";
import {
  memoryMarkerTag,
  memoryNoteMarkers,
  memoryNoteTier,
  terminalSafe,
} from "@muon/client";
import { hub, panelBorder } from "../lib/theme.js";

type Props = {
  title: string;
  notes: MemoryNote[];
  selectedIndex: number;
  /**
   * R3 TTL posture for THIS result set. `showExpired` is a parameter on the
   * governed search (operator-tier, silently downgraded for agent callers) —
   * never a local filter — so this only reports which read produced `notes`.
   * Default OFF everywhere, matching the desktop and the CLI.
   */
  showExpired?: boolean;
  /**
   * ADR-0026 §9 — WHICH WORKSPACE this result set is for. The panel previously
   * rendered no partition at all, and §1 measured the two `searchMemory` calls
   * behind it sending no coordinate, so the same screen could show two repos'
   * memory with nothing saying which was which. Required rather than optional: a
   * panel that can be constructed without stating its partition is a panel that
   * will be.
   */
  workspacePath: string;
  /** True while the toggle is re-asking the backend. */
  busy?: boolean;
  /**
   * The operator's crew-visible posture (`autoConfirmAgentMemory`), read from
   * the brain by the caller. Optional, strict (OFF) when absent — the
   * fail-closed direction: a note is never described as MORE settled than the
   * rule allows.
   */
  autoConfirmAgentMemory?: boolean;
};

export function MemoryPanel({
  title,
  notes,
  selectedIndex,
  showExpired = false,
  workspacePath,
  busy = false,
  autoConfirmAgentMemory = false,
}: Props) {
  // P0-3 — the SHARED tier rule (@muon/client memoryNoteTier), not a local
  // restatement: this panel's private copy drifted (it never learned the
  // crew-visible "auto" tier), so the same note read "Auto · crew memory" on
  // the desktop and sat here as review homework. Only "open" is a debt.
  const isSettled = (note: MemoryNote): boolean =>
    memoryNoteTier(note, autoConfirmAgentMemory) !== "open";
  const rows = notes.slice(0, 10);
  // Does anything ON SCREEN still owe the operator a decision? A rejected note
  // owes nothing (it is retired), and a settled one owes nothing by definition.
  const awaiting = rows.filter(
    (note) => !isSettled(note) && note.status === "active"
  ).length;
  // The keybar advertises `c` against the SELECTED row, so it must say what the
  // key does to THAT row: confirm a pending note, or promote a settled one.
  // Advertising "c confirm" over settled crew memory is the terminal's version
  // of a Confirm button on an auto-approved card.
  const selectedSettled = rows[selectedIndex]
    ? isSettled(rows[selectedIndex]!)
    : false;
  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="80%"
    >
      <Text bold>
        MEMORY, {title}
        {showExpired ? " · including expired" : ""}
        {busy ? " · loading…" : ""}
      </Text>
      {/* ADR-0026: the partition, stated on its own line rather than folded into
          the title, because it is a claim about WHOSE memory this is and the title
          is the query. Dim so it never competes with the notes. */}
      <Text dimColor wrap="truncate">
        workspace: {workspacePath}
      </Text>
      {notes.length === 0 ? (
        // Empty-state honesty: with expired notes hidden, "no notes match" is
        // only half the truth — the other half is one keystroke away, so say so.
        <Text dimColor>
          {showExpired
            ? "No notes match, including expired — Ctrl+K → Add memory note"
            : "No notes match — press e to include expired · Ctrl+K → Add memory note"}
        </Text>
      ) : (
        rows.map((note, index) => {
          // The SHARED derivation (`@muon/client memoryNoteMarkers`), not a
          // local restatement — the same reason P0-3 moved the tier rule out
          // of this file. The shell desk renders the same markers from the
          // same function, so `·review` cannot mean two things on two desks.
          const markers = memoryNoteMarkers(note, autoConfirmAgentMemory);
          const expired = markers.expired;
          return (
            <Text
              key={note.id}
              wrap="truncate"
              color={index === selectedIndex ? hub.focus : undefined}
              bold={index === selectedIndex}
            >
              {index === selectedIndex ? "› " : "  "}
              {memoryMarkerTag(note, autoConfirmAgentMemory)}{" "}
              {expired ? <Text color={hub.lapsed}>EXPIRED </Text> : null}
              {terminalSafe(note.text).slice(0, 90)}
            </Text>
          );
        })
      )}
      {showExpired ? (
        <Text dimColor>
          An expired note is hidden from recall, never deleted — c confirms it
          and clears the expiry for good.
        </Text>
      ) : null}
      {/* P0-3: when nothing on screen owes a decision, SAY so. Silence here read
          as "a review screen with no instructions", which is how settled crew
          memory started looking like homework on every other surface. */}
      {rows.length > 0 && awaiting === 0 ? (
        <Text dimColor>
          Settled — MUON approved these; nothing is waiting on you.
        </Text>
      ) : null}
      <Text dimColor>
        j/k select · {selectedSettled ? "c promote" : "c confirm"} · p pause · x reject · e{" "}
        {showExpired ? "hide" : "show"} expired · Esc close
      </Text>
    </Box>
  );
}
