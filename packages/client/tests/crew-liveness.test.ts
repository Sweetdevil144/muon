import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED_MARKER,
  budgetExhaustedResult,
} from "@muon/protocol";
import { deriveCrewLiveness, crewLivenessLabel } from "../src/crew-liveness.js";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("deriveCrewLiveness (Wave 4.2 crew state machine)", () => {
  it("queued job → queued, no attention", () => {
    const r = deriveCrewLiveness(
      { status: "queued", createdAt: iso(1_000) },
      NOW
    );
    expect(r).toEqual({ state: "queued", attention: false });
  });

  it("running, no first output, BEFORE the warn threshold → launching (calm)", () => {
    const r = deriveCrewLiveness(
      { status: "running", createdAt: iso(10_000) },
      NOW,
      { startupWarnMs: 45_000 }
    );
    expect(r.state).toBe("launching");
    expect(r.attention).toBe(false);
  });

  it("running, no first output, in [warn, watchdog) → STALLED amber BEFORE the watchdog kills it (the early-warning signal)", () => {
    const r = deriveCrewLiveness(
      { status: "running", createdAt: iso(60_000) },
      NOW,
      { startupWarnMs: 45_000, startupWatchdogMs: 90_000 }
    );
    expect(r.state).toBe("stalled");
    expect(r.attention).toBe(true);
    expect(r.reason).toMatch(/no output|startup|watchdog|auth|profile|MCP/i);
  });

  it("names quota/billing among the in-flight causes without ASSERTING any of them", () => {
    // The founder's live defect: a spend-cap rejection that takes ~5 minutes to
    // arrive was reported as "likely a startup / auth / profile / MCP-handshake
    // failure" — four guesses, all wrong. With no result row there is nothing
    // observed about the cause, so the copy may only list candidates.
    const r = deriveCrewLiveness(
      { status: "running", createdAt: iso(60_000) },
      NOW,
      { startupWarnMs: 45_000, startupWatchdogMs: 90_000 }
    );
    expect(r.reason).toContain("no output yet");
    expect(r.reason).toMatch(/quota\/billing/i);
    expect(r.reason).toMatch(/unconfirmed/i);
    expect(r.reason).not.toMatch(/likely a startup/i);
    // shortReason() renders the first line alone: this must stay ONE short line.
    expect(r.reason).not.toContain("\n");
    expect(r.reason!.length).toBeLessThanOrEqual(200);
  });

  it("running with no durable output past the watchdog remains actionable", () => {
    const r = deriveCrewLiveness(
      { status: "running", createdAt: iso(600_000) },
      NOW,
      { startupWarnMs: 45_000, startupWatchdogMs: 90_000 }
    );
    expect(r.state).toBe("stalled");
    expect(r.attention).toBe(true);
    expect(r.reason).toMatch(/watchdog|runner|termination|stale/i);
  });

  it("prefers the watchdog's honest reason from the job result when stalled", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(60_000),
        result:
          "no output within 90s — verify the vendor is logged in\nmore detail…",
      },
      NOW
    );
    expect(r.state).toBe("stalled");
    expect(r.reason).toBe("no output within 90s — verify the vendor is logged in");
  });

  it("running with FRESH progress → progressing (calm)", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(120_000),
        lastProgressAt: iso(2_000),
      },
      NOW,
      { staleProgressMs: 15_000 }
    );
    expect(r.state).toBe("progressing");
    expect(r.attention).toBe(false);
    expect(r.lastProgressAgeMs).toBe(2_000);
  });

  it("running with output but briefly quiet → live", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(120_000),
        lastProgressAt: iso(40_000),
      },
      NOW,
      { staleProgressMs: 15_000 }
    );
    expect(r.state).toBe("live");
    expect(r.attention).toBe(false);
    expect(r.lastProgressAgeMs).toBe(40_000);
  });

  it("running with initial output but prolonged silence → stalled amber", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(300_000),
        lastProgressAt: iso(180_000),
      },
      NOW,
      { staleProgressMs: 15_000, idleWarnMs: 120_000 }
    );
    expect(r.state).toBe("stalled");
    expect(r.attention).toBe(true);
    expect(r.lastProgressAgeMs).toBe(180_000);
    expect(r.reason).toMatch(/no provider|inactivity|progress/i);
  });

  it("an open human gate is explicit and exempt from idle-stall semantics", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(600_000),
        lastProgressAt: iso(500_000),
        waitingApproval: true,
      },
      NOW,
      { idleWarnMs: 120_000 }
    );
    expect(r.state).toBe("waiting-approval");
    expect(r.reason).toMatch(/operator approval/i);
  });

  it("running, budget nearly exhausted → budget-low + amber (even with recent progress)", () => {
    const r = deriveCrewLiveness(
      {
        status: "running",
        createdAt: iso(500_000),
        lastProgressAt: iso(1_000),
        remainingBudgetMs: 30_000,
      },
      NOW,
      { budgetLowMs: 60_000 }
    );
    expect(r.state).toBe("budget-low");
    expect(r.attention).toBe(true);
  });

  it("done + exit 0 → done, no attention", () => {
    const r = deriveCrewLiveness(
      { status: "done", exitCode: 0, createdAt: iso(200_000) },
      NOW
    );
    expect(r).toEqual({ state: "done", attention: false });
  });

  it("done + non-zero exit → needs-attention + reason", () => {
    const r = deriveCrewLiveness(
      {
        status: "done",
        exitCode: 1,
        createdAt: iso(200_000),
        result: "check failed: 3 tests red\n…",
      },
      NOW
    );
    expect(r.state).toBe("needs-attention");
    expect(r.attention).toBe(true);
    expect(r.reason).toBe("check failed: 3 tests red");
  });

  it("failed / interrupted → needs-attention (red)", () => {
    for (const status of ["failed", "interrupted", "cancelled"]) {
      const r = deriveCrewLiveness({ status, createdAt: iso(5_000) }, NOW);
      expect(r.state).toBe("needs-attention");
      expect(r.attention).toBe(true);
    }
  });

  it("labels are operator-facing words", () => {
    expect(crewLivenessLabel("stalled")).toBe("Stalled");
    expect(crewLivenessLabel("waiting-approval")).toBe("Awaiting approval");
    expect(crewLivenessLabel("progressing")).toBe("Working");
    expect(crewLivenessLabel("needs-attention")).toBe("Needs attention");
  });
});

// ── F2: budget exhaustion renders honestly on the crew surfaces ──────────────
describe("deriveCrewLiveness on a wall-budget kill", () => {
  const budgetResult = budgetExhaustedResult({
    vendor: "claude-code",
    budgetMs: 600_000,
    elapsedMs: 603_297,
  });

  it("a budget-killed job still needs attention (failed is red, exactly like interrupted was)", () => {
    const r = deriveCrewLiveness(
      {
        status: "failed",
        exitCode: 130,
        createdAt: iso(603_297),
        lastProgressAt: iso(1_000),
        result: budgetResult,
      },
      NOW
    );
    expect(r.state).toBe("needs-attention");
    expect(r.attention).toBe(true);
  });

  it("renders the human sentence, not the machine marker", () => {
    const r = deriveCrewLiveness(
      { status: "failed", exitCode: 130, createdAt: iso(1_000), result: budgetResult },
      NOW
    );
    expect(r.reason).not.toContain(BUDGET_EXHAUSTED_MARKER);
    expect(r.reason).toMatch(/wall-clock budget of 600s ran out after 603s/);
    // The one thing the old record could not say.
    expect(r.reason).toMatch(/No human interrupted this run/);
  });

  it("keeps the mirrored startup watchdog in step with the runner's own window", () => {
    // The mirror MUST be at least the runner's window, or a healthy worker in
    // its second silent minute reads as a termination failure. 90s (the old
    // value) would now do exactly that.
    const stillLaunching = deriveCrewLiveness(
      { status: "running", createdAt: iso(120_000) },
      NOW
    );
    expect(stillLaunching.state).toBe("stalled");
    expect(stillLaunching.reason).not.toMatch(/watchdog window|no longer/i);
  });
});
