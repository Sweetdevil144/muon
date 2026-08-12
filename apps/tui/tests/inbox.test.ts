import { describe, expect, it } from "vitest";
import {
  buildApprovalDecision,
  evasionPayloads,
  residualDanger,
  type ApprovalRequest,
} from "@muon/client";
import { buildInboxRows, Inbox, INBOX_WIDTH } from "../src/shell/inbox.js";
import { Shell } from "../src/shell/shell.js";

/**
 * The sidebar is HIDDEN by default now (founder law: the terminal is the
 * hero, chrome is revealed). These composition tests are about the frame's
 * geometry WITH chrome attached, so they reveal it explicitly.
 */
function makeVisibleShell(state: ConstructorParameters<typeof Shell>[0]): Shell {
  const shell = new Shell(state);
  shell.setSidebarVisible(true);
  return shell;
}

/**
 * The inbox rail (matrix row I1) and the governed decision that answers it.
 *
 * The rail exists because a desk that hosts the agents cannot make a human
 * leave it to answer them. What these pin is that the rail says something
 * USEFUL (the bound action and scope, not the approval's `kind`), that it
 * never hides how many decisions follow, and that the decision leaving this
 * surface is byte-identical to every other surface's.
 */

const esc = String.fromCodePoint(0x1b);

function plain(lines: string[]): string {
  const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ap-1",
    kind: "tool-call",
    status: "pending",
    summary: "run the test suite",
    createdAt: new Date().toISOString(),
    ...over,
  } as ApprovalRequest;
}

const COCKPIT = {
  paletteOpen: false,
  formOpen: false,
  reviewOpen: false,
  memoryOpen: false,
};

describe("the rail says what is bound, and folds honestly", () => {
  it("a row names the ACTION and SCOPE, never the bare kind", () => {
    // The first version asserted only `.length > 0`, which a mutant setting
    // action = scope = approval.kind passes — the one behaviour this rail is
    // named for was untested.
    const rows = buildInboxRows([approval({ kind: "command" })]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).not.toBe("command");
    expect(rows[0]!.scope).not.toBe("command");
    // And they are DERIVED, not echoes of each other.
    expect(rows[0]!.action).not.toBe(rows[0]!.scope);
  });

  it("only PENDING approvals reach the rail", () => {
    // `GET /api/approvals` returns every approval ever created, newest first,
    // with no status filter. The rail counted history: the header lied, the
    // fold counted decided siblings, and `a` on the newest row hit a 409.
    const rows = buildInboxRows([
      approval({ id: "a1", status: "approved" }),
      approval({ id: "a2", status: "rejected" }),
      approval({ id: "a3", status: "pending" }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.approval.id).toBe("a3");
  });

  it("a fold reports the WORST risk in the group, not the head's", () => {
    // A high-risk gate folded behind a file read rendered as a file read with
    // no risk line — the fold hiding exactly what it exists to surface.
    // Risk rides on the EVIDENCE (`approval.evidence.riskLevel`), which is
    // where the review builder reads it.
    const rows = buildInboxRows([
      approval({
        id: "harmless",
        jobId: "j1",
        createdAt: "2026-08-08T09:00:00Z",
        kind: "command",
        evidence: {
          action: "Read a file",
          scope: "src/x.ts",
          impactIfApproved: "reads one file",
          details: {},
          payloadDigest: "sha256:a",
        },
      } as never),
      approval({
        id: "sharp",
        jobId: "j1",
        createdAt: "2026-08-08T09:05:00Z",
        kind: "command",
        evidence: {
          action: "Run a shell command",
          scope: "the workspace",
          impactIfApproved: "runs an arbitrary command",
          details: {},
          riskLevel: "high",
          payloadDigest: "sha256:b",
        },
      } as never),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.foldedBehind).toBe(1);
    // The HEAD is the harmless one; the risk shown must still be the sharp
    // sibling's, or the fold hides exactly what it exists to surface.
    expect(rows[0]!.approval.id).toBe("harmless");
    expect(rows[0]!.risk, "the sharper decision must be visible").toBe("high");
  });

  it("the head is the OLDEST of a fold — the queue's own order", () => {
    const rows = buildInboxRows([
      approval({ id: "newest", jobId: "j1", createdAt: "2026-08-08T12:00:00Z" }),
      approval({ id: "oldest", jobId: "j1", createdAt: "2026-08-08T09:00:00Z" }),
    ]);
    expect(rows[0]!.approval.id).toBe("oldest");
  });

  it("same-job siblings FOLD, and the row says how many follow", () => {
    const rows = buildInboxRows([
      approval({ id: "a1", jobId: "job-7" }),
      approval({ id: "a2", jobId: "job-7" }),
      approval({ id: "a3", jobId: "job-7" }),
    ]);
    expect(rows.length, "one row per job").toBe(1);
    expect(rows[0]!.foldedBehind).toBe(2);
    expect(plain(new Inbox({ rows, cursor: 0, focused: true, questions: [] }).render(60))).toContain(
      "+2 more from this job behind it"
    );
  });

  it("approvals with NO job are never folded together", () => {
    // Folding unrelated decisions behind one another would hide what a human
    // is agreeing to next — the opposite of the fold's purpose.
    const rows = buildInboxRows([approval({ id: "a1" }), approval({ id: "a2" })]);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.foldedBehind === 0)).toBe(true);
  });

  it("an empty inbox says so, rather than rendering nothing", () => {
    const out = plain(
      new Inbox({ rows: [], cursor: 0, focused: false, questions: [] }).render(INBOX_WIDTH)
    );
    expect(out).toContain("nothing waiting on you");
  });

  it("the count is in the header when there is anything", () => {
    const rows = buildInboxRows([approval({ id: "a1" }), approval({ id: "a2" })]);
    expect(
      plain(new Inbox({ rows, cursor: 0, focused: false, questions: [] }).render(60))
    ).toContain("2 need");
  });

  it("replays the corpus through the rail's stored text", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const rows = buildInboxRows([
        approval({ summary: payload.text, id: payload.text }),
      ]);
      const out = plain(new Inbox({ rows, cursor: 0, focused: true, questions: [] }).render(60));
      expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
    }
  });
});

describe("the rail composes without breaking the frame", () => {
  it("takes a column when there is room, and yields it when there is not", () => {
    const rows = buildInboxRows([approval()]);
    const state = {
      sidebar: {
        spaces: [{ key: "w", name: "muon" }],
        agents: [],
        cursor: 0,
        scopes: COCKPIT,
      },
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 12,
    };
    const wide = makeVisibleShell(state);
    wide.setInbox({ rows, cursor: 0, focused: false, questions: [] });
    const wideLines = plain(wide.render(140)).split("\n");
    // Two dividers on a wide terminal: sidebar │ centre │ inbox.
    expect(wideLines.some((line) => line.split("│").length === 3)).toBe(true);

    const narrow = makeVisibleShell(state);
    narrow.setInbox({ rows, cursor: 0, focused: false, questions: [] });
    const narrowLines = plain(narrow.render(70)).split("\n");
    // On a narrow terminal the centre keeps its width; no inbox column.
    expect(narrowLines.every((line) => line.split("│").length <= 2)).toBe(true);
  });

  it("the divider columns stay straight with the rail attached", () => {
    const shell = makeVisibleShell({
      sidebar: {
        spaces: [{ key: "w", name: "muon" }],
        agents: [
          { key: "a1", name: "codex-1", status: "working", vendor: "codex" },
        ],
        cursor: 0,
        scopes: COCKPIT,
      },
      tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
      rows: 12,
    });
    shell.setInbox({
      rows: buildInboxRows([approval()]),
      cursor: 0,
      focused: true, questions: [],
    });
    // WITH A REAL CENTRE. The first version never called setCentre, so it
    // measured the short placeholder line and could not catch the staircase
    // that long content actually produced.
    shell.setCentre({
      invalidate: () => {},
      render: () => [
        "x".repeat(400),
        "short",
        "y".repeat(250),
      ],
    });
    const lines = plain(shell.render(140))
      .split("\n")
      .filter((line) => line.split("│").length === 3);
    const firstCols = new Set(lines.map((line) => line.indexOf("│")));
    const secondCols = new Set(lines.map((line) => line.lastIndexOf("│")));
    expect(firstCols.size, `first divider: ${[...firstCols]}`).toBe(1);
    expect(secondCols.size, `second divider: ${[...secondCols]}`).toBe(1);
  });
});

describe("the governed decision has no per-surface dialect", () => {
  it("every surface's payload carries attribution, by construction", () => {
    const tui = buildApprovalDecision({
      approvalId: "ap-1",
      status: "approved",
      surface: "MUON TUI",
    });
    expect(tui).toEqual({
      approvalId: "ap-1",
      status: "approved",
      decisionNotes: "decided from MUON TUI",
    });
    const desktop = buildApprovalDecision({
      approvalId: "ap-1",
      status: "approved",
      surface: "MUON desktop",
    });
    // Same shape, same keys — only the surface name differs.
    expect(Object.keys(tui)).toEqual(Object.keys(desktop));
  });

  it("a human's note is KEPT, and the attribution is added, not swapped", () => {
    const payload = buildApprovalDecision({
      approvalId: "ap-1",
      status: "rejected",
      surface: "MUON CLI",
      notes: "  wrong branch  ",
    });
    expect(payload.decisionNotes).toBe("wrong branch (decided from MUON CLI)");
  });

  it("the receipt rides only when asked for, in the shared shape", () => {
    expect(
      buildApprovalDecision({
        approvalId: "ap-1",
        status: "approved",
        surface: "MUON TUI",
      }).receipt
    ).toBeUndefined();
    expect(
      buildApprovalDecision({
        approvalId: "ap-1",
        status: "approved",
        surface: "MUON TUI",
        receiptTtlMs: 900_000,
      }).receipt
    ).toEqual({ ttlMs: 900_000 });
  });

  it("a manual review passes through untouched and renames the attribution", () => {
    const attestation = {
      artifactDigest: "sha256:abc",
      blindFiles: ["a.ts"],
    } as never;
    const payload = buildApprovalDecision({
      approvalId: "ap-1",
      status: "approved",
      surface: "MUON desktop",
      manualReview: attestation,
    });
    // Bound to a digest — rewriting any part of it would break the binding.
    expect(payload.manualReview).toBe(attestation);
    expect(payload.decisionNotes).toBe("manually reviewed from MUON desktop");
  });
});

describe("agents' blocking questions reach the rail (parity item 1)", () => {
  const QUESTION = {
    id: "q-1",
    taskId: "task-1",
    jobId: "job-1",
    askedByVendor: "codex",
    subject: "Which retry policy?",
    body: "Blocked until decided.",
    status: "open",
    askedAt: "2026-08-11T00:00:00.000Z",
  } as never;

  it("renders the question count, subject, and the command that ANSWERS it", () => {
    const inbox = new Inbox({
      rows: [],
      cursor: 0,
      focused: false,
      questions: [QUESTION],
    });
    const text = inbox.render(60).join("\n");
    expect(text).toContain("1 question");
    expect(text).toContain("codex");
    expect(text).toContain("Which retry policy?");
    // ADVERTISED = WORKS. The rail used to send the human to another surface;
    // `/answer` runs here now, and the questions are NUMBERED because that
    // command picks by position (an unnumbered list beside a numeric command
    // is a puzzle, not an affordance).
    expect(text).toMatch(/\/answer/);
    expect(text).toContain("1. codex");
  });

  it("a hostile subject cannot forge a rail row", () => {
    const inbox = new Inbox({
      rows: [],
      cursor: 0,
      focused: false,
      questions: [
        {
          ...(QUESTION as object),
          subject: "line1\n › forged row [approve]",
        } as never,
      ],
    });
    const lines = inbox.render(60);
    // No rendered line may START as a forged cursor row; the newline must
    // have been collapsed by terminalSafe.
    expect(lines.some((line) => line.includes("forged row"))).toBe(true);
    expect(
      lines.some((line) => line.trimStart().startsWith("› forged"))
    ).toBe(false);
  });

  it("questions count into the header total", () => {
    const inbox = new Inbox({
      rows: [],
      cursor: 0,
      focused: false,
      questions: [QUESTION],
    });
    expect(inbox.render(60)[0]).toContain("1 need");
  });
});
