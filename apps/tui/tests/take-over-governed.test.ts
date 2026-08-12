import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describePaletteCommand } from "../src/lib/command-visibility.js";
import { PALETTE_COMMANDS } from "../src/lib/palette.js";

// ADR-0030 + the governed-op cross-surface parity rule.
//
// The TUI's `take-over` used to compute the native resume argv and print it to
// the status line — and nothing else. The CLI has always called
// `takeOverSession` first (apps/cli/src/commands/session.ts), so this surface
// held the ungoverned half of the same verb: the human got the means to drive
// the session natively while MUON's record still said `owner: "muon"`, which
// is the two-owners-one-session state ADR-0030's acceptance line forbids. The
// palette entry's own description said "automation must relinquish ownership
// first", and nothing relinquished anything.
//
// Asserted against the SOURCE because the handler lives inside a large Ink
// component with no seam to inject a client into. That is a weaker test than a
// behavioural one and it is named as such — what it reliably catches is the
// specific regression of the governed call being dropped.

const APP = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "components",
    "App.tsx"
  ),
  "utf8"
);

/** The body of one `if (selected.id === "<id>")` branch in the palette handler. */
function paletteBranch(id: string): string {
  const start = APP.indexOf(`if (selected.id === "${id}")`);
  expect(start, `palette branch for ${id}`).toBeGreaterThan(-1);
  const rest = APP.slice(start);
  const end = rest.indexOf('if (selected.id === "', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the TUI take-over is a governed write", () => {
  it("calls takeOverSession, not just the argv helper", () => {
    const branch = paletteBranch("take-over");
    expect(branch).toContain("takeOverSession");
  });

  it("tells the human automation is suspended, not merely what to type", () => {
    // The status line is the whole feedback surface here. If it reports only a
    // command, a reader cannot tell a governed transfer from a printed string.
    const branch = paletteBranch("take-over");
    expect(branch).toMatch(/automation suspended/i);
  });

  it("points at the way back, so take-over is not a one-way door", () => {
    expect(paletteBranch("take-over")).toMatch(/return/i);
  });
});

describe("the return half exists on this surface too", () => {
  it("calls returnSession", () => {
    expect(paletteBranch("return-session")).toContain("returnSession");
  });

  it("surfaces the snapshot, including a DEGRADED readiness re-check", () => {
    // ADR-0030: the return still completes when readiness degrades — ownership
    // must never be stuck on an offline probe — but the audit row says so, and
    // so should the human's screen.
    const branch = paletteBranch("return-session");
    expect(branch).toMatch(/dirtyFiles/);
    expect(branch).toMatch(/DEGRADED/);
  });

  it("is reachable from the palette and describes its own authority", () => {
    const command = PALETTE_COMMANDS.find(
      (entry) => entry.id === "return-session"
    );
    expect(command).toBeDefined();
    // Through the real accessor, so a palette entry with no contract is caught
    // the same way the surface would catch it.
    const visibility = describePaletteCommand(command!);
    expect(visibility.authority).toMatch(/human/i);
    expect(visibility.effect).toMatch(/automation act again/i);
  });
});

// A one-time sweep found take-over was the ONLY ungoverned governance command
// on this surface. This turns that sweep into a standing check, because the
// pattern has now bitten twice (the reject drift, then this one) and a result
// nobody re-runs is a result that expires.
//
// The map is what each command must ultimately reach. Deliberately per-command
// and hand-maintained: there is no generic rule that says which palette entries
// write, and inventing one would either miss a case or flag every read.
describe("every governance-bearing palette command reaches a governed call", () => {
  const GOVERNED: Record<string, { via: string; where: string }> = {
    "take-over": { via: "takeOverSession", where: "App.tsx" },
    "return-session": { via: "returnSession", where: "App.tsx" },
    approve: { via: "resolveApproval", where: "lib/actions.ts" },
    reject: { via: "resolveApproval", where: "lib/actions.ts" },
    ship: { via: "requestApproval", where: "lib/ship.ts" },
  };

  const read = (relative: string): string =>
    readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        ...relative.split("/")
      ),
      "utf8"
    );
  const SOURCE_BY_FILE: Record<string, string> = {
    "lib/actions.ts": read("lib/actions.ts"),
    "lib/ship.ts": read("lib/ship.ts"),
  };

  it("is reachable from the palette", () => {
    for (const id of Object.keys(GOVERNED)) {
      expect(
        PALETTE_COMMANDS.some((command) => command.id === id),
        id
      ).toBe(true);
    }
  });

  it("calls the governed client method on ITS OWN path", () => {
    // This used to concatenate three whole files and assert the method name
    // appeared ANYWHERE — so `reject → resolveApproval` passed as long as any
    // file mentioned `resolveApproval`, and a specific command losing its
    // governed call was exactly what it could not catch. Scoped now: a
    // palette branch is checked in its own branch body, and a helper-routed
    // command is checked in the helper that owns it.
    for (const [id, { via, where }] of Object.entries(GOVERNED)) {
      const source =
        where === "App.tsx"
          ? paletteBranch(id)
          : SOURCE_BY_FILE[where] ?? "";
      expect(source, `${id} must reach ${via} in ${where}`).toContain(via);
    }
  });

  it("states an authority for each, so no governed act is undescribed", () => {
    for (const id of Object.keys(GOVERNED)) {
      const command = PALETTE_COMMANDS.find((entry) => entry.id === id)!;
      expect(describePaletteCommand(command).authority.length, id).toBeGreaterThan(0);
    }
  });
});
