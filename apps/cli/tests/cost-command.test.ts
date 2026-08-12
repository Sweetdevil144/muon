import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { registerCostCommands } from "../src/commands/cost.js";

/**
 * ADR-0036 D1/D6 — the surface that must never show a bare number.
 *
 * Cost is vendor-reported or unknown, and today only Claude reports dollars —
 * so a MIXED crew is the normal case and a total presented as *the* cost
 * invites exactly the confident wrong decision T6 exists to let someone avoid.
 * These pin the two ways this command could start lying: printing a figure
 * without its coverage, and rendering a silent lane as free.
 */

const writes: string[] = [];
const errors: string[] = [];
let exitCode: number | undefined;

beforeEach(() => {
  writes.length = 0;
  errors.length = 0;
  exitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
});

async function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerCostCommands(program, () => client as MuonApiClient);
  await program.parseAsync(["node", "muon", ...argv]);
}

const VIEW = {
  capUsd: 10,
  capSetBy: "human",
  capSetAt: "2026-08-09T10:00:00.000Z",
  cost: { observedUsd: 4, reportingLanes: 1, totalLanes: 2, complete: false },
  laneCosts: [
    { laneId: "claude", reported: true as const, usd: 4 },
    { laneId: "codex", reported: false as const },
  ],
  silentLanes: ["codex"],
  refusesDispatch: false,
  summary:
    "$4.00 of $10.00 observed, but the cap CANNOT be enforced for 1 of 2 lanes: codex — wall-clock is what bounds those",
};

describe("muon cost show", () => {
  it("prints the ONE rendering, coverage and all", async () => {
    await run(["cost", "show", "chat-1"], {
      getMissionCost: vi.fn(async () => VIEW),
    } as unknown as Partial<MuonApiClient>);
    const out = writes.join("");
    expect(out).toContain("CANNOT be enforced");
    expect(out).toContain("codex");
  });

  it("renders a silent lane as UNKNOWN, never as $0.00", async () => {
    // The quieter version of the same lie a total tells.
    await run(["cost", "show", "chat-1"], {
      getMissionCost: vi.fn(async () => VIEW),
    } as unknown as Partial<MuonApiClient>);
    const out = writes.join("");
    expect(out).toContain("codex: unknown");
    expect(out).not.toContain("codex: $0.00");
  });

  it("says plainly when dispatch is refused, and that nothing was killed", async () => {
    // D2: the cap refuses NEW work and never interrupts a lane in flight. A
    // human reading "refused" needs to know their running work survived.
    await run(["cost", "show", "chat-1"], {
      getMissionCost: vi.fn(async () => ({ ...VIEW, refusesDispatch: true })),
    } as unknown as Partial<MuonApiClient>);
    const out = writes.join("");
    expect(out).toContain("refused");
    expect(out).toContain("nothing already running was stopped");
  });
});

describe("muon cost cap", () => {
  it("sends the parsed dollar amount", async () => {
    const setMissionCostCap = vi.fn(async () => VIEW);
    await run(["cost", "cap", "chat-1", "25"], {
      setMissionCostCap,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCap).toHaveBeenCalledWith("chat-1", 25);
  });

  it("accepts a leading $ because a human will type one", async () => {
    const setMissionCostCap = vi.fn(async () => VIEW);
    await run(["cost", "cap", "chat-1", "$25"], {
      setMissionCostCap,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCap).toHaveBeenCalledWith("chat-1", 25);
  });

  it.each(["none", "clear", "off"])("`%s` clears the cap", async (word) => {
    const setMissionCostCap = vi.fn(async () => ({ ...VIEW, capUsd: null }));
    await run(["cost", "cap", "chat-1", word], {
      setMissionCostCap,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCap).toHaveBeenCalledWith("chat-1", null);
  });

  it("REFUSES zero rather than reading it as 'no limit'", async () => {
    // A human typing 0 meaning "unlimited" would otherwise get the exact
    // opposite, silently and permanently.
    const setMissionCostCap = vi.fn();
    await run(["cost", "cap", "chat-1", "0"], {
      setMissionCostCap,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCap).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("Zero is refused");
    // 1, not 2: the documented contract reserves 2 for "the brain refused your
    // authority". A malformed argument is an ordinary failure, and a script
    // that treats it as a 403 would retry with different credentials.
    expect(process.exitCode).toBe(1);
  });

  it("exits 2 when the BRAIN refuses the authority, not 1", async () => {
    const { MuonApiHttpError } = await import("@muon/client");
    await run(["cost", "cap", "chat-1", "25"], {
      setMissionCostCap: vi.fn(async () => {
        throw new MuonApiHttpError(403, "Forbidden", "403 Forbidden");
      }),
    } as unknown as Partial<MuonApiClient>);
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("Could not set the cap");
  });

  it.each(["-5", "abc", ""])("refuses %j", async (raw) => {
    const setMissionCostCap = vi.fn();
    await run(["cost", "cap", "chat-1", raw], {
      setMissionCostCap,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCap).not.toHaveBeenCalled();
  });

  it("warns when the new cap is ALREADY met", async () => {
    await run(["cost", "cap", "chat-1", "1"], {
      setMissionCostCap: vi.fn(async () => ({ ...VIEW, refusesDispatch: true })),
    } as unknown as Partial<MuonApiClient>);
    const out = writes.join("");
    expect(out).toContain("already met that cap");
    expect(out).toContain("untouched");
  });
});

describe("muon cost default", () => {
  it("reads the default with no argument", async () => {
    const getMissionCostCapDefault = vi.fn(async () => 25);
    await run(["cost", "default"], {
      getMissionCostCapDefault,
    } as unknown as Partial<MuonApiClient>);
    expect(getMissionCostCapDefault).toHaveBeenCalled();
    expect(writes.join("")).toContain("$25.00");
  });

  it("says out loud that it does NOT touch existing missions", async () => {
    // ADR-0036 D7's copy-not-reference rule. A human who assumes otherwise
    // would think they had just re-capped everything in flight.
    await run(["cost", "default", "25"], {
      setMissionCostCapDefault: vi.fn(async () => 25),
    } as unknown as Partial<MuonApiClient>);
    expect(writes.join("")).toContain(
      "keep the cap they were created with"
    );
  });

  it("clears with `none`", async () => {
    const setMissionCostCapDefault = vi.fn(async () => null);
    await run(["cost", "default", "none"], {
      setMissionCostCapDefault,
    } as unknown as Partial<MuonApiClient>);
    expect(setMissionCostCapDefault).toHaveBeenCalledWith(null);
    expect(writes.join("")).toContain("no cost cap");
  });
});
