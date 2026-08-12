import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger, vendorOnboardingStep } from "@muon/client";
import type { MuonApiClient, VendorReadiness } from "@muon/client";
import {
  buildSettingsRows,
  SettingsPane,
  selectedVendor,
} from "../src/shell/settings-pane.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot, type BrainSnapshot } from "../src/lib/brain-store.js";
import { IMPLEMENTED_DESTINATIONS } from "../src/shell/nav.js";
import { NAV_DESTINATIONS } from "@muon/client";

/**
 * SETTINGS — the ninth destination, and the one whose value is entirely in
 * being HONEST rather than in being clever.
 *
 * A human running this as a daily driver should not leave the desk to answer
 * "why can't I dispatch to codex". These pin the three ways that answer could
 * become wrong: saying nothing when MUON has not looked, saying a lane is fine
 * when it is not, and re-deriving the sentence the desktop already computes.
 */

const ESC = String.fromCodePoint(0x1b);
const PREFIX = String.fromCodePoint(2);

function plain(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "g"), "");
}

function readiness(over: Partial<VendorReadiness> = {}): VendorReadiness {
  return {
    vendor: "claude-code",
    installed: true,
    authenticated: true,
    detail: "ready",
    ...over,
  } as VendorReadiness;
}

const BASE = {
  cwd: "/repo",
  branch: "dev",
  brainReachable: true,
};

function makeDesk(rows: VendorReadiness[] | null = null) {
  const snapshot: BrainSnapshot = { ...emptyBrainSnapshot(), readiness: rows };
  const desk = new Desk({
    client: {
      listMemoryLibrary: vi.fn(async () => ({ notes: [], total: 0 })),
      getAutoConfirmAgentMemory: vi.fn(async () => false),
    } as unknown as MuonApiClient,
    getSnapshot: () => snapshot,
    geometry: () => ({ cols: 60, rows: 12 }),
    terminalRows: () => 30,
    cwd: () => "/repo",
    branch: () => "dev",
    frozen: [],
    onChange: () => {},
    onQuit: () => {},
  });
  return { desk, snapshot };
}

function openSettings(desk: Desk) {
  desk.handleKey(PREFIX);
  desk.handleKey("g");
  const index = NAV_DESTINATIONS.findIndex((entry) => entry.target === "settings");
  for (let step = 0; step < index; step += 1) desk.handleKey(`${ESC}[B`);
  desk.handleKey("\r");
}

describe("the ninth destination opens", () => {
  it("is reachable from the nav", () => {
    expect(IMPLEMENTED_DESTINATIONS.has("settings")).toBe(true);
    const { desk } = makeDesk([readiness()]);
    openSettings(desk);
    expect(desk.centreKind()).toBe("settings");
    const frame = plain(desk.shell.render(120).join("\n"));
    expect(frame).toContain("SETTINGS");
    expect(frame).toContain("WORKSPACE");
    expect(frame).toContain("VENDORS");
  });

  it("Esc pops it, one layer", () => {
    const { desk } = makeDesk([readiness()]);
    openSettings(desk);
    desk.handleKey(ESC);
    expect(desk.centreKind()).not.toBe("settings");
  });
});

describe("it never claims to know something it has not looked at", () => {
  it("UNPROBED is not 'no vendors'", () => {
    // Collapsing them tells a human their vendors are missing when MUON simply
    // has not asked yet — and the fix for those two states is not the same.
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: null }))
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("not probed yet");
    expect(frame).not.toContain("no vendors known");
  });

  it("an empty probe says exactly that", () => {
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: [] }))
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("no vendors known");
  });

  it("says when its own BACKEND is unreachable", () => {
    // A settings pane that cannot say whether the thing it reads from is
    // reachable is describing a cache.
    const frame = plain(
      new SettingsPane(
        buildSettingsRows({ ...BASE, readiness: [], brainReachable: false })
      )
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("UNREACHABLE");
  });
});

describe("a lane that cannot run says why, and what to type", () => {
  it("shows the fix hint for a lane that is not installed", () => {
    const frame = plain(
      new SettingsPane(
        buildSettingsRows({
          ...BASE,
          readiness: [
            readiness({
              vendor: "codex",
              installed: false,
              authenticated: false,
              fixHint: "npm i -g @openai/codex",
            }),
          ],
        })
      )
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("npm i -g @openai/codex");
  });

  it("does NOT nag a lane that is ready", () => {
    const frame = plain(
      new SettingsPane(
        buildSettingsRows({
          ...BASE,
          readiness: [readiness({ fixHint: "you should never see this" })],
        })
      )
        .render(120)
        .join("\n")
    );
    expect(frame).not.toContain("you should never see this");
  });

  it("uses the SHARED derivation, not a second opinion", () => {
    // The parity rule applied to a read: the sentence about a lane is one
    // product fact, so the TUI and the desktop cannot drift into disagreeing
    // about whether codex is usable.
    const row = readiness({ vendor: "codex", authenticated: false });
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: [row] }))
        .render(200)
        .join("\n")
    );
    expect(frame).toContain(vendorOnboardingStep(row).guidance);
  });

  it("Enter restates the selected lane's fix hint in full", () => {
    // Read-only, so Enter cannot change anything — but the frame clips, and
    // the fix hint is the one line a stuck human needs whole.
    const { desk } = makeDesk([
      readiness({
        vendor: "codex",
        installed: false,
        authenticated: false,
        fixHint: "npm i -g @openai/codex",
      }),
    ]);
    openSettings(desk);
    desk.handleKey("\r");
    expect(plain(desk.shell.render(200).join("\n"))).toContain(
      "npm i -g @openai/codex"
    );
  });
});

describe("the cursor only lands where something is selectable", () => {
  it("skips headings and facts entirely", () => {
    const state = buildSettingsRows({
      ...BASE,
      readiness: [readiness({ vendor: "claude-code" }), readiness({ vendor: "codex" })],
    });
    expect(state.selectable).toHaveLength(2);
    for (const index of state.selectable) {
      expect(state.rows[index]!.kind).toBe("vendor");
    }
  });

  it("selects nothing at all when there are no vendor rows", () => {
    const state = buildSettingsRows({ ...BASE, readiness: null });
    expect(state.selectable).toEqual([]);
    expect(selectedVendor(state)).toBeNull();
  });

  it("a cursor cannot be moved past the last lane", () => {
    const { desk } = makeDesk([readiness()]);
    openSettings(desk);
    for (let step = 0; step < 20; step += 1) desk.handleKey(`${ESC}[B`);
    // Still renders, still on a real row — a cursor past the end selects
    // nothing and the pane would silently do nothing on Enter.
    expect(desk.centreKind()).toBe("settings");
    desk.handleKey("\r");
    expect(plain(desk.shell.render(200).join("\n"))).toContain("Claude");
  });
});

describe("readiness text is STORED text on a MUON surface", () => {
  it("replays the evasion corpus through every rendered field", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const state = buildSettingsRows({
        readiness: [
          readiness({
            vendor: "codex",
            installed: false,
            authenticated: false,
            detail: payload.text,
            fixHint: payload.text,
            cliVersion: payload.text,
          }),
        ],
        cwd: payload.text,
        branch: payload.text,
        brainReachable: true,
      });
      for (const line of new SettingsPane(state).render(200)) {
        expect(residualDanger(plain(line), []), payload.id).toEqual([]);
      }
    }
  });
});

describe("CODE GRAPH — what MUON honestly knows about the index", () => {
  // The founder asked for "gitnexus indexing/indexed/re-index" in the chrome.
  // This is the honest amount of it this desk actually knows: the doctor's own
  // verdict, which MUON already polls, plus the remediation it already
  // computes. The desktop runs an index SUPERVISOR; the TUI deliberately does
  // not — a terminal that silently started indexing your repo would be doing
  // work you did not ask for.
  const usable = { degradations: [] } as never;
  const stale = {
    degradations: [
      {
        code: "graph-degraded",
        surface: "graph",
        severity: "warning",
        reason: "HEAD moved since the last index",
        nextAction: "Re-index the workspace, then re-check.",
      },
    ],
  } as never;

  it("says the index is usable when the doctor reports nothing", () => {
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: [], preflight: usable }))
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("CODE GRAPH");
    expect(frame).toContain("usable");
  });

  it("reports the degradation AND the fix, in the doctor's own words", () => {
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: [], preflight: stale }))
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("HEAD moved since the last index");
    expect(frame).toContain("Re-index the workspace");
  });

  it("UNPROBED is not 'usable' — the same rule the vendors have", () => {
    const frame = plain(
      new SettingsPane(buildSettingsRows({ ...BASE, readiness: [] }))
        .render(120)
        .join("\n")
    );
    expect(frame).toContain("not probed yet");
    expect(frame).not.toContain("index        usable");
  });
});
