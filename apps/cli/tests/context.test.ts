import { Command } from "commander";
import { describe, expect, it, vi, afterEach } from "vitest";
import { buildPreEditView, type PreEditContext } from "@muon/client";
import type { MuonApiClient } from "../src/lib/api-client.js";
import {
  formatContextLines,
  registerContextCommand,
} from "../src/commands/context.js";

// P6a, `muon context` renders the shared pre-edit view-model in the terminal:
// blast-radius + governed decisions + warnings + pending-proposal count. Trust
// discipline: a pending proposal's TEXT is never printed by the context render;
// it is fetched on demand only via --view-proposal (operator note-by-id path).

function sampleContext(overrides: Partial<PreEditContext> = {}): PreEditContext {
  return {
    target: { module: "src/pay/charge.ts" },
    blastRadius: {
      modules: ["src/pay/charge.ts"],
      source: "provided",
      depth: 1,
    },
    memories: [
      {
        id: "mem-1",
        kind: "decision",
        text: "Charges are idempotent by request key",
        taskId: null,
        laneId: null,
        modules: ["src/pay/charge.ts"],
        topics: [],
        trust: "high",
        confirmed: true,
        stale: false,
        status: "active",
        createdBy: "human:carol",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
        proximity: 1,
        onTarget: true,
      },
    ],
    warnings: [],
    pendingProposals: [
      {
        proposalNoteId: "mem-hostile",
        victimNoteId: "mem-1",
        modules: ["src/pay/charge.ts"],
        detail: "An unconfirmed proposal contests a memory on the edit radius.",
      },
    ],
    activity: [],
    ...overrides,
  };
}

describe("D14 coverage in `muon context` (the terminal's honest empty state)", () => {
  // "(none)" plus "no trusted memory is anchored yet" read identically whether
  // nothing was recorded or the gate refused everything it found. On the
  // founder's install it was the second, and the terminal asserted the first.
  const emptyWithCoverage = () =>
    sampleContext({
      memories: [],
      pendingProposals: [],
      coverage: {
        anchors: {
          modules: { requested: 9, resolved: 3 },
          symbols: { requested: 1, resolved: 0 },
          unreadable: 0,
        },
        notes: { considered: 32, admitted: 0, surfaced: 0 },
        admittedBy: { humanConfirmed: 0, crewVouched: 0, trustFloor: 0 },
        crewChat: false,
        emptyReason: "withheld_no_crew_chat",
      },
    });

  it("prints the counts beside '(none)' and the measured reason, not the old assertion", () => {
    const lines = formatContextLines(buildPreEditView(emptyWithCoverage()));
    const text = lines.join("\n");
    expect(text).toMatch(/Governed decisions \(0\)/);

    // POSITIONAL, deliberately: the counts must sit on the line right after
    // "(none)", inside the governed-decisions block. Asserting them anywhere in
    // the output would also pass on the trailing `notices` copy, which would make
    // this command's own render untested — the counts have to appear where a human
    // reads the emptiness, not only in a footer.
    const noneAt = lines.findIndex((line) => line.trim() === "(none)");
    expect(noneAt).toBeGreaterThan(-1);
    const beside = lines[noneAt + 1] ?? "";
    expect(beside).toMatch(/3\/9 module anchors resolved/);
    expect(beside).toMatch(/0\/1 symbol anchors resolved/);
    expect(beside).toMatch(/32 note\(s\) considered/);
    expect(beside).toMatch(/0 admitted \(0 human-confirmed, 0 crew-vouched\)/);
    expect(beside).toMatch(/crew tier not engaged/);

    // The reason sentence (shared with the TUI + desktop panels).
    expect(text).toMatch(/none of it is human-confirmed/i);
    // …and the sentence that was false is gone.
    expect(text).not.toMatch(/No trusted memory is anchored/i);
    // Printed ONCE: the footer skips the counts line it already showed inline.
    expect(lines.filter((line) => line.includes("Gate coverage:"))).toHaveLength(
      1
    );
  });

  it("keeps the pre-D14 wording when the backend reports no coverage at all", () => {
    const text = formatContextLines(
      buildPreEditView(sampleContext({ memories: [], pendingProposals: [] }))
    ).join("\n");
    expect(text).toMatch(/No trusted memory is anchored/i);
    expect(text).not.toMatch(/Gate coverage/);
  });

  it("says nothing extra when the gate actually returned governed memory", () => {
    const text = formatContextLines(
      buildPreEditView(
        sampleContext({
          coverage: {
            anchors: {
              modules: { requested: 1, resolved: 1 },
              symbols: { requested: 0, resolved: 0 },
              unreadable: 0,
            },
            notes: { considered: 4, admitted: 1, surfaced: 1 },
            admittedBy: { humanConfirmed: 1, crewVouched: 0, trustFloor: 0 },
            crewChat: false,
          },
        })
      )
    ).join("\n");
    expect(text).toMatch(/Charges are idempotent by request key/);
    expect(text).not.toMatch(/Gate coverage/);
  });
});

describe("formatContextLines (pure)", () => {
  it("renders the blast-radius, governed decision text, and pending-proposal count without any proposal text", () => {
    const lines = formatContextLines(buildPreEditView(sampleContext()));
    const text = lines.join("\n");
    expect(text).toMatch(/Pre-edit context for src\/pay\/charge\.ts/);
    expect(text).toMatch(/blast-radius: src\/pay\/charge\.ts/);
    // Governed decision text IS shown (confirmed/trusted).
    expect(text).toMatch(/Charges are idempotent by request key/);
    // Pending proposal is existence-only: id + count, never its (untrusted) text.
    expect(text).toMatch(/Pending proposals: 1/);
    expect(text).toMatch(/mem-hostile contests mem-1/);
    expect(text).not.toMatch(/Drop idempotency/);
  });
});

describe("muon context command", () => {
  afterEach(() => vi.restoreAllMocks());

  function run(argv: string[], client: Partial<MuonApiClient>) {
    const program = new Command();
    program.exitOverride();
    registerContextCommand(program, () => client as MuonApiClient);
    return program.parseAsync(argv, { from: "user" });
  }

  it("loads the pre-edit context and prints it (exit 0)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.exitCode = 0;
    const preEditContext = vi.fn().mockResolvedValue(sampleContext());

    await run(["context", "src/pay/charge.ts"], { preEditContext });

    expect(preEditContext).toHaveBeenCalledWith(
      expect.objectContaining({ module: "src/pay/charge.ts" })
    );
    const printed = out.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toMatch(/Charges are idempotent by request key/);
    expect(printed).toMatch(/Pending proposals: 1/);
    expect(process.exitCode).toBe(0);
  });

  it("--view-proposal fetches ONE proposal's text on demand (operator note-by-id path)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const preEditContext = vi.fn().mockResolvedValue(sampleContext());
    const getMemoryNote = vi.fn().mockResolvedValue({
      id: "mem-hostile",
      kind: "attempt",
      text: "Drop idempotency to speed up local charges",
      modules: ["src/pay/charge.ts"],
      topics: [],
      trust: "low",
      confirmed: false,
      stale: false,
      status: "active",
      createdBy: "agent:intruder",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });

    await run(
      ["context", "src/pay/charge.ts", "--view-proposal", "mem-hostile"],
      { preEditContext, getMemoryNote }
    );

    expect(getMemoryNote).toHaveBeenCalledWith("mem-hostile");
    const printed = out.mock.calls.map((call) => String(call[0])).join("");
    // Only now, on explicit demand, is the untrusted text printed.
    expect(printed).toMatch(/Drop idempotency to speed up local charges/);
  });

  it("exits non-zero when the brain call fails", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.exitCode = 0;
    const preEditContext = vi.fn().mockRejectedValue(new Error("brain offline"));

    await run(["context", "validateUser"], { preEditContext });

    expect(process.exitCode).toBe(1);
  });
});
