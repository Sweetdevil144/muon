import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { createToolDefinitions } from "../src/handlers.js";
import { muonServerInstructions } from "../src/instructions.js";

// ── §3.3: the first thing an attached session is told ────────────────────────
//
// A human-launched session has no MUON system prompt — MUON never compiled its
// profile and never spawned it. The `instructions` field on `initialize` and the
// tool descriptions are the ONLY two channels MUON owns, and for one commit after
// `muon mcp install` shipped, this one was empty: a session could hold 24 MUON
// tools and be told nothing about what they were for.
//
// These tests pin the properties that would rot silently, not the prose.

describe("muonServerInstructions", () => {
  it("DERIVES the tool count instead of asserting one", () => {
    // A hardcoded "24 tools" is drift this repo has already paid for, and a model
    // cannot check it — it would simply be believed. The count must come from the
    // list actually registered, so the number a session is told can never disagree
    // with the number it holds.
    expect(muonServerInstructions({ toolCount: 24 })).toContain("24 tools");
    expect(muonServerInstructions({ toolCount: 41 })).toContain("41 tools");
    expect(muonServerInstructions({ toolCount: 41 })).not.toContain("24 tools");
  });

  it("teaches the pre-edit gate FIRST, because that is the whole moat", () => {
    const text = muonServerInstructions({ toolCount: 24 });
    expect(text).toContain("memory_preedit");
    expect(text).toContain("code_query");
    // §3.3 fixes the ORDER as "the order in which a wrong belief costs the most",
    // and the workflow comes before the prohibitions: a session that never learns
    // to call the gate cannot be saved by learning what it may not do.
    expect(text.indexOf("memory_preedit")).toBeLessThan(
      text.indexOf("cannot dispatch")
    );
  });

  it("states the attached tier's limits POSITIVELY, and calls them absent not withheld", () => {
    const text = muonServerInstructions({ toolCount: 24 });
    expect(text).toContain("cannot dispatch");
    // The distinction is load-bearing: a session told a verb is "withheld" may try
    // it and route around the refusal; one told it is ABSENT stops.
    expect(text).toContain("absent");
    expect(text).toContain("UNCONFIRMED PROPOSAL");
  });

  it("keeps the HONEST BOUNDARY — MUON does not govern the filesystem here", () => {
    // §3.3: "this matters more than it looks". "Superagent in your terminal"
    // invites the reader to assume MUON interposes on native tools, and it does
    // not — MUON never runs its approval hook for a process it did not spawn.
    // Omitting this would let a session believe it is sandboxed when it is not.
    const text = muonServerInstructions({ toolCount: 24 });
    expect(text).toContain("does not govern what you do to the filesystem");
    expect(text).toContain("vendor permissions");
    // And the compensating fact, which is genuinely good and must be said too.
    expect(text).toContain("human is at this terminal");
  });

  it("an UNKNOWN mode falls back to the NARROWEST voice, never the widest", () => {
    // A mode string MUON does not recognise must never be described as holding
    // more than the read tier. This is the same posture as deriving a tier
    // positively rather than by subtracting from a superset — a rule this repo
    // broke twice before writing it down.
    const unknown = muonServerInstructions({
      toolCount: 24,
      mode: "some-future-mode",
    });
    expect(unknown).toContain("cannot dispatch");
    expect(unknown).not.toContain("dispatch a crew");
  });

  it("A WORKER is NOT told it is a human-started, ungoverned session", () => {
    // THE REVIEW FINDING, pinned. The runner declared a mode only for
    // `orchestrator` and `delegate`, so every plain worker — the governed editing
    // agent, the most common session MUON spawns — fell to the attached voice and
    // read three false sentences: MUON had not spawned it, MUON did not interpose
    // on its tools, and a human was sitting at its terminal. False in the
    // direction that invites an editing agent to behave as if ungoverned.
    const worker = muonServerInstructions({ toolCount: 24, mode: "worker" });
    expect(worker).toContain("MUON spawned you");
    expect(worker).toContain("DOES interpose");
    expect(worker).toContain("MUON inbox");
    expect(worker).not.toContain("human is at this terminal");
    expect(worker).not.toContain("MUON never interposes");
    expect(worker).not.toContain("did NOT spawn");
  });

  it("and the ATTACHED session still gets the opposite, because for it that is true", () => {
    // Both voices must exist and must not converge: an attached session really is
    // ungoverned at the filesystem, and telling IT that MUON interposes would be
    // the mirror-image lie.
    const attached = muonServerInstructions({ toolCount: 24 });
    expect(attached).toContain("did NOT spawn");
    expect(attached).toContain("human is at this terminal");
    expect(attached).not.toContain("DOES interpose");
  });

  it("an OBSERVER is human-attached, read-only, and never described as spawned", () => {
    const observer = muonServerInstructions({
      toolCount: 31,
      mode: "observer",
    });
    expect(observer).toContain("attached-observer tier");
    expect(observer).toContain("read one mission's fleet");
    expect(observer).toContain("cannot dispatch");
    expect(observer).toContain("did NOT spawn");
    expect(observer).toContain("human is at this terminal");
    expect(observer).not.toContain("DOES interpose");
  });

  it("tells a spawned session the TRUTH about where its memory goes", () => {
    // `AUTO_CONFIRM_AGENT_MEMORY_DEFAULT` is TRUE and `vouchedForCrew` admits
    // `confirmedBy === "orchestrator"`, so a crew-authored note reaches other
    // agents' brief preambles by default. The old text said the opposite — "it
    // does not reach another agent's gate before then, so writing it is cheap and
    // safe" — which is false, and reassuring about the wrong thing.
    for (const mode of ["worker", "orchestrator", "delegate"]) {
      const text = muonServerInstructions({ toolCount: 24, mode });
      expect(text).not.toContain("does not reach another agent");
      expect(text).toContain("coordinator vouches");
      expect(text).toContain("briefs IN THIS MISSION");
    }
    // The attached session is the one case where "unconfirmed proposal" is the
    // whole truth, because no coordinator vouches for a human-attached session.
    expect(muonServerInstructions({ toolCount: 24 })).toContain(
      "UNCONFIRMED PROPOSAL"
    );
  });

  it("an ORCHESTRATOR is told what it MAY do, positively", () => {
    const text = muonServerInstructions({ toolCount: 41, mode: "orchestrator" });
    expect(text).toContain("dispatch a crew");
    // It still learns the boundary and the proposal rule — those are not
    // orchestrator exemptions.
    expect(text).toContain("coordinator vouches");
  });

  it("DRIFT LOCK: every tool the instructions name actually ships", () => {
    // The instructions teach a workflow by naming two tools. A rename would leave
    // the first thing an attached session reads pointing at nothing — and unlike a
    // broken import, nothing would fail to build. This is the same failure the
    // brief contract drifted into five times before it was locked to one constant.
    const client = new MuonApiClient(
      "http://localhost:4000",
      vi.fn() as unknown as typeof fetch
    );
    const shipped = new Set(
      createToolDefinitions(client, { taskId: "task-1", laneKey: "codex" }).map(
        (tool) => tool.name
      )
    );
    const text = muonServerInstructions({ toolCount: shipped.size });
    const named = [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);
    // The prose also back-ticks non-tool words; only assert on the ones that LOOK
    // like MUON tool names (a namespace prefix), so this lock stays about tools.
    const toolish = named.filter((word) => /^(memory|code|dispatch|crew)_/.test(word));
    expect(toolish.length).toBeGreaterThan(0);
    for (const name of toolish) {
      expect(shipped, `instructions name \`${name}\`, which no longer ships`).toContain(
        name
      );
    }
  });
});
