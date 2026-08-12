import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_CONTROL_TOOL_NAMES,
} from "../src/mcp-tool-inventory.js";

// `docs/mcp-server-card.md` is the canonical public enumeration of MUON's tool
// tiers, and until this file existed NOTHING pinned it to the inventory.
// `check:docs` validates links and mermaid only, so the card drifted silently:
// it was correct through the `peer_wait` change and then went stale the moment
// `whoami` landed, and only an adversarial review caught it.
//
// This asserts the card lists exactly the tools that exist, per tier. It is
// deliberately about MEMBERSHIP and COUNT rather than prose: the card should
// stay readable, but it must not be able to claim a tier MUON does not have.

const CARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "mcp-server-card.md"
);

const card = readFileSync(CARD, "utf8");

/** The backticked tool names inside one `### <tier>` section of the card. */
function toolsInSection(heading: RegExp): {
  names: string[];
  claimedCount: number | null;
} {
  const start = card.search(heading);
  if (start < 0) throw new Error(`section not found: ${heading}`);
  const rest = card.slice(start);
  const end = rest.indexOf("\n### ", 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const headingLine = section.slice(0, section.indexOf("\n"));
  const claimed = /\((\d+)\s+tools?\)/.exec(headingLine);
  return {
    names: [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!),
    claimedCount: claimed ? Number(claimed[1]) : null,
  };
}

describe("the MCP server card matches the real inventory", () => {
  it("lists exactly the context tier, and counts it correctly", () => {
    const { names, claimedCount } = toolsInSection(/^### Context —/m);
    expect(new Set(names)).toEqual(new Set(MUON_CONTEXT_TOOL_NAMES));
    expect(claimedCount).toBe(MUON_CONTEXT_TOOL_NAMES.length);
  });

  it("lists exactly the coordination tier, and counts it correctly", () => {
    const { names, claimedCount } = toolsInSection(/^### Coordination —/m);
    expect(new Set(names)).toEqual(new Set(MUON_COORDINATION_TOOL_NAMES));
    expect(claimedCount).toBe(MUON_COORDINATION_TOOL_NAMES.length);
  });

  it("lists exactly the control tier, and counts it correctly", () => {
    const { names, claimedCount } = toolsInSection(/^### Control —/m);
    expect(new Set(names)).toEqual(new Set(MUON_CONTROL_TOOL_NAMES));
    expect(claimedCount).toBe(MUON_CONTROL_TOOL_NAMES.length);
  });
});
