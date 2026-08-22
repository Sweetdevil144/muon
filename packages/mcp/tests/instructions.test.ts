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

/**
 * Every case in this file except the code-graph block at the bottom is about
 * the VOICE, so it fixes `codeGraph` at the state a working install is in.
 * Written out field by field rather than spread over a default: a `{...input}`
 * on top of a default is how a required degrade field quietly becomes
 * overridable, which is the shape of bug this parameter exists to prevent.
 */
function instructions(input: {
  toolCount: number;
  mode?: string;
}): string {
  return muonServerInstructions({
    toolCount: input.toolCount,
    mode: input.mode,
    codeGraph: "available",
  });
}

describe("muonServerInstructions", () => {
  it("DERIVES the tool count instead of asserting one", () => {
    // A hardcoded "24 tools" is drift this repo has already paid for, and a model
    // cannot check it — it would simply be believed. The count must come from the
    // list actually registered, so the number a session is told can never disagree
    // with the number it holds.
    expect(instructions({ toolCount: 24 })).toContain("24 tools");
    expect(instructions({ toolCount: 41 })).toContain("41 tools");
    expect(instructions({ toolCount: 41 })).not.toContain("24 tools");
  });

  it("teaches the pre-edit gate FIRST, because that is the whole moat", () => {
    const text = instructions({ toolCount: 24 });
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
    const text = instructions({ toolCount: 24 });
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
    const text = instructions({ toolCount: 24 });
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
    const unknown = instructions({
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
    const worker = instructions({ toolCount: 24, mode: "worker" });
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
    const attached = instructions({ toolCount: 24 });
    expect(attached).toContain("did NOT spawn");
    expect(attached).toContain("human is at this terminal");
    expect(attached).not.toContain("DOES interpose");
  });

  it("an OBSERVER is human-attached, read-only, and never described as spawned", () => {
    const observer = instructions({
      toolCount: 34,
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
      const text = instructions({ toolCount: 24, mode });
      expect(text).not.toContain("does not reach another agent");
      expect(text).toContain("coordinator vouches");
      expect(text).toContain("briefs IN THIS MISSION");
    }
    // The attached session is the one case where "unconfirmed proposal" is the
    // whole truth, because no coordinator vouches for a human-attached session.
    expect(instructions({ toolCount: 24 })).toContain(
      "UNCONFIRMED PROPOSAL"
    );
  });

  it("an ORCHESTRATOR is told what it MAY do, positively", () => {
    const text = instructions({ toolCount: 41, mode: "orchestrator" });
    expect(text).toContain("dispatch a crew");
    // It still learns the boundary and the proposal rule — those are not
    // orchestrator exemptions.
    expect(text).toContain("coordinator vouches");
  });

  // ── H4: the one-turn babysit kit, rendered only where the verbs exist ──────
  it("H4: a crew-control mode is taught the one-turn babysit kit", () => {
    for (const mode of ["orchestrator", "attached-coordinator"]) {
      const text = instructions({ toolCount: 44, mode });
      expect(text).toContain("BABYSIT THE CREW IN ONE TURN");
      // The kit's verbs, named — the drift lock below proves they all ship.
      for (const tool of [
        "`fleet_status`",
        "`dispatch_status`",
        "`steer`",
        "`interrupt`",
        "`question_status`",
        "`peer_wait`",
      ]) {
        expect(text).toContain(tool);
      }
      // Refusals are typed, never an invitation to hammer the tool.
      expect(text).toMatch(/never an invitation to retry/);
    }
  });

  it("H4: a read-tier session is NOT taught verbs it does not hold", () => {
    for (const mode of [undefined, "worker", "observer", "delegate"]) {
      const text = instructions({ toolCount: 30, mode });
      expect(text).not.toContain("BABYSIT THE CREW IN ONE TURN");
    }
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
    const text = instructions({ toolCount: shipped.size });
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

// ── The code-graph half, told honestly ───────────────────────────────────────
//
// Measured 2026-08-17 on a release tarball: `muon-mcp` installs without
// `gitnexus`, so all seven code-graph tools stay REGISTERED (the inventory a
// probe scores against must not change) and every one of them refuses. The
// first thing that session read was "Call `code_query` before you grep" — an
// instruction to use a tool that cannot answer, given to every agent on that
// build. `whoami` already reported `grant.codeGraph: "unavailable"`; this is
// the same fact reaching the channel a session reads FIRST.
describe("the code-graph instruction matches what this install can do", () => {
  const line = (codeGraph: "available" | "unavailable") =>
    muonServerInstructions({ toolCount: 30, codeGraph });

  it("teaches `code_query` when a CLI is reachable", () => {
    const text = line("available");
    expect(text).toContain("Call `code_query` before you grep");
    expect(text).toContain("execution flows rather than string matches");
  });

  it("names the DEGRADE and both remedies when none is", () => {
    const text = line("unavailable");
    expect(text).toContain("THE CODE GRAPH IS ABSENT FROM THIS INSTALL");
    // What actually happens, so the agent does not discover it by calling.
    expect(text).toContain("listed but will refuse");
    // What to do instead — a prohibition with no substitute gets retried.
    expect(text).toContain("grep and read the files instead");
    // The two remedies, both of them, because they are the only two.
    expect(text).toContain("MUON_GITNEXUS_BIN");
    expect(text).toContain("installing GitNexus");
  });

  it("NEVER both, in either direction", () => {
    // The failure this test exists for is an additive fix — appending the
    // degrade beside the advice — which leaves the false instruction in place
    // and merely contradicts it two clauses later.
    expect(line("available")).not.toContain("THE CODE GRAPH IS ABSENT");
    expect(line("available")).not.toContain("MUON_GITNEXUS_BIN");
    expect(line("unavailable")).not.toContain("Call `code_query` before you grep");
  });

  it("keeps everything that is still TRUE on a degraded install", () => {
    const text = line("unavailable");
    // `memory_preedit` is local-first — it fuses governed memory over the
    // modules the CALLER passes, and makes no code-graph call of its own. It
    // still works, so the pre-edit gate must not be collateral damage.
    expect(text).toContain("BEFORE YOU EDIT A SYMBOL, call `memory_preedit`");
    expect(text).toContain("call `whoami` rather than guessing");
    // And the graph's absence says nothing about the memory half or the
    // boundary, which are the same on every install.
    expect(text).toContain("UNCONFIRMED PROPOSAL");
    expect(text).toContain("does not govern what you do to the filesystem");
  });
});

/**
 * THE CODING KIT (2026-08-20). The attached instructions carried a
 * crew-babysitting kit and nothing about the work the human actually started
 * the session to do — so a one-module instruction got answered with recon and
 * fan-out. These pin the two halves that matter: the seats that hear it, and
 * the seats that must NOT.
 */
describe("the coding kit", () => {
  const attached = () =>
    muonServerInstructions({ toolCount: 34, codeGraph: "available" });

  it("tells an attached seat that it edits, and that MUON is not holding its Write tool", () => {
    const text = attached();
    expect(text).toContain("YOU ARE THE ONE WHO CODES HERE");
    expect(text).toContain("does not hold your Write tool");
  });

  it("names the two calls that precede an edit", () => {
    const text = attached();
    expect(text).toContain("memory_preedit");
    expect(text).toContain("code_query");
    expect(text).toContain("preflight_edit");
  });

  it("contradicts the native-subagent habit by name, not by omission", () => {
    const text = attached();
    expect(text).toContain("DO NOT SPAWN A CREW FOR A ONE-MODULE CHANGE");
    expect(text).toMatch(/subagent|Task/);
    // And it says where honest sizing comes from.
    expect(text).toContain("repo_map");
  });

  it("is ABSENT for every seat MUON spawned — a worker's edits are MUON's, and a coordinator has no Write tool", () => {
    for (const mode of ["worker", "orchestrator", "delegate"]) {
      const text = muonServerInstructions({
        toolCount: 34,
        mode,
        codeGraph: "available",
      });
      expect(text, mode).not.toContain("YOU ARE THE ONE WHO CODES HERE");
    }
  });

  it("IS present for the other human-attached seats", () => {
    for (const mode of ["observer", "attached-coordinator"]) {
      const text = muonServerInstructions({
        toolCount: 34,
        mode,
        codeGraph: "available",
      });
      expect(text, mode).toContain("YOU ARE THE ONE WHO CODES HERE");
    }
  });

  it("an unknown mode falls to the attached voice and still gets the kit", () => {
    const text = muonServerInstructions({
      toolCount: 34,
      mode: "not-a-real-mode",
      codeGraph: "available",
    });
    expect(text).toContain("YOU ARE THE ONE WHO CODES HERE");
  });
});
