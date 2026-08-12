/**
 * What the RUNNING MCP server actually serves, compared against what this tree
 * defines.
 *
 * `buildMcpStatusReport` answers "is MUON registered, resolvable, and would it
 * get a token" — all of it computed from config and from the inventory
 * constants compiled into this build. That is the right shape for that
 * command, and it is also its blind spot: `toolCount` is a compile-time
 * constant, so status reported 44 tools while the process a vendor had
 * actually spawned served 27.
 *
 * That gap was not hypothetical. On 2026-08-10 the attached server was found
 * serving 27 tools: every context tool, but only six of nine coordination
 * tools. `publish_finding` had landed that morning; `question_ask` and
 * `question_status` had landed with ADR-0043 days earlier. All three were
 * green in CI, registered in the inventory, handler-tested — and callable by
 * nobody, because the vendor's symlink pointed at a `dist/` built on 7 August.
 * A tool an agent cannot see does not exist, and nothing in the repo said so.
 *
 * The only honest way to answer "what does an agent hold" is to ask the
 * process. This module splits that into the part worth testing (the
 * comparison, pure) and the part that must do I/O (the spawn, injected), so
 * the verdict logic is exercised without launching anything.
 */

import {
  MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_DELEGATE_CAPABILITY_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
} from "@muon/protocol";

/**
 * Every server mode this comparison knows how to score.
 *
 * A POSITIVE list (ADR-0022 rule 2). An unknown mode is not scored against
 * some default inventory — it returns `unevaluated`, because a mode we cannot
 * name is a mode whose expected toolset we do not know, and guessing would
 * turn "we did not check" into a green tick.
 */
/** The one mode entitled to serve zero tools (ADR-0049). */
const ATTACHED_COORDINATOR_MODE = "attached-coordinator";

export const MCP_PROBE_MODES = [
  "base",
  "observer",
  "orchestrator",
  "delegate",
  "attached-coordinator",
] as const;
export type McpProbeMode = (typeof MCP_PROBE_MODES)[number];

/**
 * The toolset this tree defines for a mode, or `null` when the mode is not one
 * we can score.
 *
 * `base` is the sub-agent seat — shared brain plus peer coordination. It is
 * what a vendor gets with no `MUON_MCP_MODE` at all, which is the overwhelming
 * majority of live servers and the one that was stale.
 */
export function expectedToolNamesForMode(
  mode: string | null | undefined
): readonly string[] | null {
  const key = (mode ?? "base").trim() || "base";
  switch (key) {
    case "base":
      return [...MUON_CONTEXT_TOOL_NAMES, ...MUON_COORDINATION_TOOL_NAMES];
    case "observer":
      return MUON_OBSERVER_TOOL_NAMES;
    case "orchestrator":
      return MUON_ORCHESTRATOR_TOOL_NAMES;
    case "delegate":
      return MUON_DELEGATE_CAPABILITY_TOOL_NAMES;
    case "attached-coordinator":
      return MUON_ATTACHED_COORDINATOR_TOOL_NAMES;
    default:
      return null;
  }
}

/**
 * `stale` is the case that motivated this file and is deliberately its own
 * level rather than a flavour of `diverged`: it is the only one where a
 * capability this repo believes it shipped is absent from the surface an agent
 * holds, and the fix is a rebuild rather than an investigation.
 *
 * `unevaluated` is NOT a pass. A probe that could not reach the server tells
 * you nothing about the server, and the failure this module exists to catch is
 * exactly a silence being read as a yes.
 */
export type McpProbeLevel =
  | "ok"
  | "stale"
  | "ahead"
  | "diverged"
  | "unevaluated";

export type McpProbeVerdict = {
  readonly level: McpProbeLevel;
  /** Defined here, absent from the live server — an agent cannot call these. */
  readonly missing: readonly string[];
  /** Served live, absent from this tree — the binary is built from elsewhere. */
  readonly extra: readonly string[];
  readonly liveCount: number | null;
  readonly expectedCount: number | null;
  readonly detail: string;
};

const REBUILD_HINT =
  "npm run build -w packages/protocol -w packages/client -w packages/mcp, then restart the vendor so it respawns the server";

/**
 * Score a live tool list against the tree.
 *
 * Set comparison, not count comparison: two builds can serve the same NUMBER
 * of tools and disagree about which, and a count would call that a pass. Order
 * is not compared — `tools/list` ordering is the server's business, and the
 * inventory test in @muon/protocol already pins canonical order at the source.
 */
export function compareLiveTools(
  liveNames: readonly string[] | null | undefined,
  mode: string | null | undefined
): McpProbeVerdict {
  const expected = expectedToolNamesForMode(mode);
  if (!expected) {
    return {
      level: "unevaluated",
      missing: [],
      extra: [],
      liveCount: liveNames?.length ?? null,
      expectedCount: null,
      detail: `unknown server mode ${JSON.stringify(
        mode
      )} — this tree cannot say which tools it should serve, so nothing was checked`,
    };
  }
  if (!liveNames) {
    return {
      level: "unevaluated",
      missing: [],
      extra: [],
      liveCount: null,
      expectedCount: expected.length,
      detail:
        "the server could not be probed — this is not a pass, it is an unknown",
    };
  }

  // ZERO TOOLS MEANS DIFFERENT THINGS IN DIFFERENT MODES.
  //
  // Zero tools means the process answered the handshake and declined to offer
  // a surface — which is exactly what a lapsed attached-coordinator seat now
  // does on purpose (ADR-0049: serve the handshake, hold nothing, name the
  // remedy). Scored as a set difference that reads as "missing all 44", and
  // the operator was told their tree was BEHIND and to rebuild it. On the
  // machines that hold a coordinator seat that was the DEFAULT probe, so the
  // one check that exists to catch a stale build became a false alarm about
  // one.
  //
  // `unevaluated` is the honest answer: nothing was measured about which build
  // is running, because the server never claimed a surface to compare.
  // In `base` (and every other mode MUON itself launches) a server that
  // answers with nothing is the worst possible surface and IS damning — that
  // is a broken or ancient build, and calling it "unevaluated" would hide the
  // exact failure this probe was written for.
  //
  // `attached-coordinator` is the one mode entitled to serve nothing: a lapsed
  // seat completes the handshake and holds no tools ON PURPOSE (ADR-0049), and
  // this probe cannot supply the capability file that would give it any. Scored
  // as a set difference, that read as "missing all 44 tools, rebuild your
  // tree" — on a healthy tree, and by DEFAULT on exactly the machines holding
  // a coordinator seat, since the desk probes the mode the vendor declares.
  if (
    liveNames.length === 0 &&
    mode === ATTACHED_COORDINATOR_MODE
  ) {
    return {
      level: "unevaluated",
      missing: [],
      extra: [],
      liveCount: 0,
      expectedCount: expected.length,
      detail:
        "the server answered with NO tools, and in this mode that is not a stale build: an attached-coordinator seat with no valid capability file serves the handshake and holds nothing, on purpose. This probe does not supply a capability file, so nothing was measured about which build is running. Run `muon mcp attach <vendor>` to restore the seat, and probe `base` to check the build itself.",
    };
  }

  const live = new Set(liveNames);
  const want = new Set(expected);
  const missing = expected.filter((name) => !live.has(name));
  const extra = [...live].filter((name) => !want.has(name)).sort();

  const shape = {
    missing,
    extra,
    liveCount: live.size,
    expectedCount: want.size,
  };

  if (missing.length > 0 && extra.length > 0) {
    return {
      ...shape,
      level: "diverged",
      detail: `the running server disagrees with this tree in both directions — missing ${missing.join(
        ", "
      )}; serving unknown ${extra.join(", ")}. It was built from a different tree.`,
    };
  }
  if (missing.length > 0) {
    return {
      ...shape,
      level: "stale",
      detail: `the running server is BEHIND this tree: ${missing.join(
        ", "
      )} ${missing.length === 1 ? "is" : "are"} defined here but absent from the live surface, so no agent can call ${
        missing.length === 1 ? "it" : "them"
      }. Rebuild: ${REBUILD_HINT}`,
    };
  }
  if (extra.length > 0) {
    return {
      ...shape,
      level: "ahead",
      detail: `the running server serves tools this tree does not define (${extra.join(
        ", "
      )}) — the binary on PATH belongs to another checkout or an older install`,
    };
  }
  return {
    ...shape,
    level: "ok",
    detail: `the live surface matches this tree exactly (${want.size} tools)`,
  };
}

/** True when the operator should act on this verdict. */
export function probeVerdictIsProblem(verdict: McpProbeVerdict): boolean {
  return verdict.level !== "ok";
}
