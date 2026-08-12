import { describe, expect, it } from "vitest";
import {
  buildToolCards,
  conciseKey,
  toolCardProblems,
  toolTitle,
  type ToolActivityInput,
} from "../src/renderer/lib/tool-cards.js";

function activity(
  text: string,
  extra: Partial<ToolActivityInput> = {}
): ToolActivityInput {
  return { text, count: 1, needsAttention: false, live: false, ...extra };
}

describe("buildToolCards · started/completed pairing", () => {
  it("pairs a started and a completed line into ONE card", () => {
    const cards = buildToolCards([
      activity("ToolSearch started"),
      activity("ToolSearch completed"),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "Loaded tool schemas",
      tool: "ToolSearch",
      status: "ok",
      repeat: 1,
    });
    // Both wire lines are retained as the card's expand body.
    expect(cards[0]?.detail).toEqual([
      "ToolSearch started",
      "ToolSearch completed",
    ]);
  });

  it("leaves a card pending while only `started` has arrived", () => {
    const cards = buildToolCards([activity("Bash started", { live: true })]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "Ran a shell command",
      status: "pending",
      live: true,
    });
  });

  it("pairs interleaved parallel calls by tool name", () => {
    const cards = buildToolCards([
      activity("Bash started"),
      activity("Read started"),
      activity("Bash completed"),
      activity("Read failed"),
    ]);

    expect(cards.map((card) => [card.tool, card.status])).toEqual([
      ["Bash", "ok"],
      ["Read", "failed"],
    ]);
  });

  it("keeps a failure visible when only part of a batch fails", () => {
    const cards = buildToolCards([
      activity("Grep started", { count: 3 }),
      activity("Grep completed", { count: 2 }),
      activity("Grep failed", { count: 1 }),
    ]);

    const statuses = cards.map((card) => [card.status, card.repeat]);
    expect(statuses).toContainEqual(["ok", 2]);
    expect(statuses).toContainEqual(["failed", 1]);
  });

  it("degrades to a standalone card when an old chat has no `started`", () => {
    const cards = buildToolCards([activity("search completed")]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "search", status: "ok" });
  });

  it("never blanks on an unparseable or empty line", () => {
    const cards = buildToolCards([
      activity("Codex capability preflight completed"),
      activity("   "),
      activity("a totally unfamiliar ledger line about nothing in particular"),
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]?.status).toBe("note");
    expect(cards[1]?.title).toContain("unfamiliar ledger line");
  });
});

describe("buildToolCards · repeat collapsing", () => {
  it("collapses 197 consecutive ToolSearch calls into ONE card", () => {
    const activities: ToolActivityInput[] = [];
    for (let index = 0; index < 197; index += 1) {
      activities.push(activity("ToolSearch started"));
      activities.push(activity("ToolSearch completed"));
    }

    const cards = buildToolCards(activities);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      tool: "ToolSearch",
      status: "ok",
      repeat: 197,
    });
    // One card's worth of detail, not 394 lines of it.
    expect(cards[0]?.detail.length).toBeLessThanOrEqual(4);
  });

  it("honours a pre-collapsed count from the transcript projection", () => {
    const cards = buildToolCards([
      activity("ToolSearch started", { count: 4 }),
      activity("ToolSearch completed", { count: 4 }),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.repeat).toBe(4);
  });

  it("does not merge cards that differ in status", () => {
    const cards = buildToolCards([
      activity("Read started"),
      activity("Read completed"),
      activity("Read started"),
      activity("Read failed"),
    ]);

    expect(cards.map((card) => card.status)).toEqual(["ok", "failed"]);
  });
});

describe("buildToolCards · governance denials", () => {
  it("reads a denied call as denied by MUON governance, with its reason", () => {
    const cards = buildToolCards([
      activity("Write started"),
      activity(
        "[task.blocked] MUON policy denied: write to /etc/hosts is outside the task radius",
        { needsAttention: true }
      ),
      activity("Write denied", { needsAttention: true }),
    ]);

    // The policy milestone folds INTO the tool card: one governance event,
    // one card — not an orphan notice plus a generic "completed" step.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      tool: "Write",
      status: "denied",
      governance: "Denied by MUON governance",
      needsAttention: true,
    });
    expect(cards[0]?.reason).toContain("outside the task radius");
  });

  it("renders a standalone policy denial as a denial in its own right", () => {
    const cards = buildToolCards([
      activity("[task.blocked] MUON policy denied: edits outside the radius", {
        needsAttention: true,
      }),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: "denied",
      governance: "Denied by MUON governance",
    });
    expect(cards[0]?.reason).toBe("edits outside the radius");
  });

  it("explains a fail-closed approval bridge instead of showing a bare step", () => {
    const cards = buildToolCards([
      activity("shell approval failed closed", { needsAttention: true }),
    ]);

    expect(cards[0]).toMatchObject({ status: "denied" });
    expect(cards[0]?.reason).toContain("failed closed");
  });

  it("marks a call MUON governance approved", () => {
    const cards = buildToolCards([
      activity("Bash started"),
      activity("Bash approved"),
      activity("Bash completed"),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: "ok",
      governance: "Approved by MUON governance",
    });
  });
});

describe("buildToolCards · failures are never buried", () => {
  it("turns 198 rows into a handful of cards with the failure at the surface", () => {
    const activities: ToolActivityInput[] = [];
    for (let index = 0; index < 98; index += 1) {
      activities.push(activity("ToolSearch started"));
      activities.push(activity("ToolSearch completed"));
    }
    activities.push(
      activity(
        "[contract.failed] Coordinator dispatch contract failed after roots 'job-1' and 'job-2': no admitted child jobs.",
        { needsAttention: true }
      )
    );

    const cards = buildToolCards(activities);

    expect(cards.length).toBeLessThanOrEqual(3);
    const failure = cards.find((card) => card.status === "failed");
    expect(failure).toBeDefined();
    expect(failure?.title).toBe("Dispatch contract failed");
    expect(failure?.reason).toContain("no admitted child jobs");
    expect(failure?.needsAttention).toBe(true);

    const problems = toolCardProblems(cards);
    expect(problems.failed).toBe(1);
    expect(problems.label).toBe("1 failed");
  });

  it("rolls failures and denials up for the turn header", () => {
    const cards = buildToolCards([
      activity("Bash started"),
      activity("Bash failed", { needsAttention: true }),
      activity("Write started"),
      activity("Write denied", { needsAttention: true }),
    ]);

    expect(toolCardProblems(cards).label).toBe("1 failed · 1 denied");
  });

  it("reports no problem label for a clean turn", () => {
    const cards = buildToolCards([
      activity("Read started"),
      activity("Read completed"),
    ]);

    expect(toolCardProblems(cards).label).toBeUndefined();
  });
});

describe("buildToolCards · titles by intent", () => {
  it("titles MUON code-graph MCP tools by what they are for", () => {
    expect(toolTitle("mcp__muon__code_query")).toBe("Code graph · code_query");
    expect(toolTitle("mcp__muon__memory_recall")).toBe(
      "Shared memory · memory_recall"
    );
    expect(toolTitle("mcp__muon__dispatch")).toBe("Crew · dispatch");
    expect(toolTitle("mcp__gitnexus__impact")).toBe("Code graph · impact");
  });

  it("falls back to the exact wire name for an unknown tool", () => {
    expect(toolTitle("SomeVendorTool")).toBe("SomeVendorTool");
    expect(toolTitle("mcp__acme__do_thing")).toBe("acme · do_thing");
  });

  it("keeps the wire name on the card so a title cannot overstate it", () => {
    const cards = buildToolCards([
      activity("mcp__muon__code_query started"),
      activity("mcp__muon__code_query completed"),
    ]);

    expect(cards[0]?.title).toBe("Code graph · code_query");
    expect(cards[0]?.tool).toBe("mcp__muon__code_query");
  });

  it("never treats session lifecycle prose as a tool call", () => {
    const cards = buildToolCards([
      activity("[task.started] Claude session started"),
      activity("[task.blocked] Claude session failed"),
    ]);

    expect(cards[0]).toMatchObject({ title: "Session started", status: "note" });
    expect(cards[1]).toMatchObject({ title: "Blocked", status: "failed" });
    expect(cards.every((card) => card.tool === undefined)).toBe(true);
  });

  it("summarises arguments on the header when the ledger carries them", () => {
    const cards = buildToolCards([
      activity("Bash(git status --short) started"),
      activity("Bash(git status --short) completed"),
    ]);

    expect(cards[0]).toMatchObject({
      title: "Ran a shell command",
      tool: "Bash",
      summary: "git status --short",
    });
  });
});

describe("buildToolCards · bounded result on expand", () => {
  it("uses the full raw status text as the card body when the renderer has it", () => {
    const raw = "Read started\n{ \"path\": \"/repo/app.ts\", \"lines\": 40 }";
    const cards = buildToolCards([activity("Read started")], {
      rawByLine: new Map([["Read started", raw]]),
    });

    expect(cards[0]?.detail).toEqual([
      "Read started",
      '{ "path": "/repo/app.ts", "lines": 40 }',
    ]);
  });

  it("bounds a huge result so it cannot blow up the transcript", () => {
    const huge = ["Read started", ...Array.from({ length: 500 }, (_, i) => `line ${i}`)].join(
      "\n"
    );
    const cards = buildToolCards([activity("Read started")], {
      rawByLine: new Map([["Read started", huge]]),
    });

    expect(cards[0]?.detail.length).toBeLessThanOrEqual(40);
    expect(cards[0]?.detailTruncated).toBe(true);
  });

  it("keys the raw lookup the way the transcript concises a status", () => {
    const long = `${"x".repeat(400)}\nsecond line`;
    expect(conciseKey(long)).toHaveLength(180);
    expect(conciseKey("one line only")).toBe("one line only");
  });
});

describe("buildToolCards captured tool detail", () => {
  it("puts the call's args on the header and its output on the card", () => {
    const cards = buildToolCards([
      activity("Bash started", {
        detail: { args: "command: npm test", argsTruncated: false },
      }),
      activity("Bash completed", {
        detail: { result: "PASS 12 tests", resultTruncated: false },
      }),
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Ran a shell command");
    expect(cards[0]?.args).toBe("command: npm test");
    expect(cards[0]?.output).toBe("PASS 12 tests");
    // The header summary is the args, honestly clamped — Cursor's `cd, 2+`.
    expect(cards[0]?.summary).toBe("command: npm test");
    expect(cards[0]?.status).toBe("ok");
  });

  it("keeps a failure's own output on the failure card", () => {
    const cards = buildToolCards([
      activity("Bash started", { detail: { args: "command: npm run bad" } }),
      activity("Bash failed", {
        detail: { result: "npm ERR! missing script: bad", resultTruncated: true },
        needsAttention: true,
      }),
    ]);

    expect(cards[0]?.status).toBe("failed");
    expect(cards[0]?.output).toBe("npm ERR! missing script: bad");
    expect(cards[0]?.outputTruncated).toBe(true);
  });

  it("does NOT merge two calls that ran different commands", () => {
    const cards = buildToolCards([
      activity("Bash started", { detail: { args: "command: git status" } }),
      activity("Bash completed", { detail: { result: "clean" } }),
      activity("Bash started", { detail: { args: "command: npm test" } }),
      activity("Bash completed", { detail: { result: "PASS" } }),
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]?.args).toBe("command: git status");
    expect(cards[1]?.args).toBe("command: npm test");
  });

  it("still merges genuinely identical adjacent calls into one repeat row", () => {
    const activities = [];
    for (let index = 0; index < 197; index += 1) {
      activities.push(
        activity("ToolSearch started", {
          detail: { args: "query: select:Read" },
        })
      );
      activities.push(
        activity("ToolSearch completed", { detail: { result: "1 tool" } })
      );
    }

    const cards = buildToolCards(activities);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.repeat).toBe(197);
  });

  it("BOUNDS an oversized detail at the DOM boundary, tail-keeping the output", () => {
    const cards = buildToolCards([
      activity("Bash started", { detail: { args: "a".repeat(500_000) } }),
      activity("Bash completed", {
        detail: { result: `${"b".repeat(5_000_000)}Error: exit 1` },
      }),
    ]);

    expect(cards[0]!.args!.length).toBe(2048);
    expect(cards[0]?.argsTruncated).toBe(true);
    expect(cards[0]!.output!.length).toBe(8192);
    expect(cards[0]?.outputTruncated).toBe(true);
    expect(cards[0]!.output!.endsWith("Error: exit 1")).toBe(true);
  });

  it("renders exactly as before for a chunk with no detail (pre-0036 rows)", () => {
    const before = buildToolCards([
      activity("Bash started"),
      activity("Bash completed"),
    ]);

    expect(before[0]).not.toHaveProperty("args");
    expect(before[0]).not.toHaveProperty("output");
    expect(before[0]?.summary).toBeUndefined();
    expect(before[0]?.status).toBe("ok");
  });

  it("shows the human what a governance denial actually refused", () => {
    const cards = buildToolCards([
      activity("Bash started"),
      activity("[task.blocked] MUON policy denied: outside the task radius", {
        needsAttention: true,
      }),
      activity("Bash denied", {
        detail: { args: "command: rm -rf /" },
        needsAttention: true,
      }),
    ]);

    const denied = cards.find((card) => card.status === "denied");
    expect(denied?.args).toBe("command: rm -rf /");
    expect(denied?.governance).toBe("Denied by MUON governance");
  });
});
