import { terminalSafe, vendorOnboardingStep } from "@muon/client";
import type {
  CapabilityPreflight,
  VendorOnboardingStep,
  VendorReadiness,
} from "@muon/client";
import type { Component } from "../vendor/pi-tui/src/tui.ts";
import { bold, cyan, dim, green, red, yellow } from "./theme.js";

/**
 * SETTINGS — vendors, workspace, posture (nav destination 9 of 9).
 *
 * READ-ONLY, and that is the design rather than an unfinished state. Every
 * field here is either a fact about the machine (is the CLI installed, is it
 * signed in, which workspace, which branch) or a posture MUON does not let a
 * terminal change. The two things a human might want to EDIT from here —
 * signing a vendor in, and changing governance posture — are both refused on
 * purpose: the first belongs to the vendor's own login flow (MUON never holds
 * those credentials, ADR-0019 §2.10), and the second is an operator act with
 * its own gated surface. A settings pane that offered either would be
 * offering something it cannot honestly do.
 *
 * WHAT IT IS FOR: a human running this as a daily driver should not have to
 * leave the desk to answer "why can't I dispatch to codex". The row says the
 * step, and the fix hint says what to type.
 *
 * The vendor rows are projected through `vendorOnboardingStep`, the SAME
 * derivation the desktop's onboarding uses — so the sentence about a lane is
 * one product fact rather than two surfaces that agree until someone edits
 * one. That is the governed-op parity rule applied to a read.
 */

export type SettingsRow =
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "fact"; readonly label: string; readonly value: string }
  | {
      readonly kind: "vendor";
      readonly step: VendorOnboardingStep;
      readonly version: string | null;
    };

export type SettingsState = {
  readonly rows: readonly SettingsRow[];
  readonly cursor: number;
  /** Rows a cursor may land on — headings are not selectable. */
  readonly selectable: readonly number[];
};

export function buildSettingsRows(input: {
  readonly readiness: readonly VendorReadiness[] | null;
  readonly cwd: string;
  readonly branch: string;
  readonly brainReachable: boolean;
  /**
   * The doctor contract every surface projects from. Read rather than
   * re-derived: MUON already polls it, and the code-graph's health is one of
   * the things it carries — so "is my graph fresh" is a question this pane can
   * answer without the TUI growing an index supervisor of its own.
   */
  readonly preflight?: CapabilityPreflight | null;
}): SettingsState {
  const rows: SettingsRow[] = [
    { kind: "heading", text: "WORKSPACE" },
    { kind: "fact", label: "directory", value: terminalSafe(input.cwd) },
    { kind: "fact", label: "branch", value: terminalSafe(input.branch) },
    {
      kind: "fact",
      label: "brain",
      // HONEST ABOUT ITS OWN BACKEND. A settings pane that cannot say whether
      // the thing it reads from is reachable is describing a cache.
      value: input.brainReachable ? "reachable" : "UNREACHABLE",
    },
    { kind: "heading", text: "VENDORS" },
  ];

  if (input.readiness === null) {
    // NOT "none configured". Unprobed and empty are different facts, and
    // collapsing them tells a human their vendors are missing when MUON simply
    // has not looked yet.
    rows.push({
      kind: "fact",
      label: "readiness",
      value: "not probed yet — MUON has not asked your CLIs anything",
    });
  } else if (input.readiness.length === 0) {
    rows.push({ kind: "fact", label: "readiness", value: "no vendors known" });
  } else {
    for (const readiness of input.readiness) {
      rows.push({
        kind: "vendor",
        step: vendorOnboardingStep(readiness),
        version: readiness.cliVersion ?? null,
      });
    }
  }

  // CODE GRAPH — the founder asked for "gitnexus indexing/indexed/re-index"
  // in the chrome, and this is the honest amount of it MUON actually knows:
  // the doctor's own verdict on whether graph evidence is usable, plus the
  // remediation it already computes. The desktop runs an index SUPERVISOR;
  // this desk deliberately does not — a terminal that silently started
  // indexing your repo would be doing work you did not ask for. It reports.
  rows.push({ kind: "heading", text: "CODE GRAPH" });
  const graph = input.preflight?.degradations.find(
    (entry) => entry.surface === "graph"
  );
  if (!input.preflight) {
    rows.push({
      kind: "fact",
      label: "index",
      value: "not probed yet — MUON has not checked the graph",
    });
  } else if (!graph) {
    rows.push({ kind: "fact", label: "index", value: "usable" });
  } else {
    rows.push(
      { kind: "fact", label: "index", value: terminalSafe(graph.reason) },
      { kind: "fact", label: "fix", value: terminalSafe(graph.nextAction) }
    );
  }

  rows.push(
    { kind: "heading", text: "POSTURE" },
    {
      kind: "fact",
      label: "credentials",
      value: "vendor-owned — MUON never stores a vendor token",
    },
    {
      kind: "fact",
      label: "governance",
      value: "policy and approvals are operator acts; this pane cannot change them",
    }
  );

  const selectable = rows
    .map((row, index) => (row.kind === "vendor" ? index : -1))
    .filter((index) => index >= 0);
  return { rows, cursor: 0, selectable };
}

/** The row a cursor position actually points at, or null on an empty pane. */
export function selectedVendor(state: SettingsState): VendorOnboardingStep | null {
  const index = state.selectable[state.cursor];
  if (index === undefined) return null;
  const row = state.rows[index];
  return row?.kind === "vendor" ? row.step : null;
}

function stepGlyph(step: VendorOnboardingStep): string {
  switch (step.step) {
    case "ready":
      return green("●");
    case "login":
      return yellow("◐");
    default:
      return red("○");
  }
}

export class SettingsPane implements Component {
  private readonly state: SettingsState;

  constructor(state: SettingsState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [
      `${bold(" SETTINGS ")}${dim(" vendors, workspace, posture · read-only")}`,
    ];
    let selectableSeen = -1;
    for (const row of this.state.rows) {
      if (row.kind === "heading") {
        lines.push("", dim(row.text));
        continue;
      }
      if (row.kind === "fact") {
        lines.push(`   ${dim(row.label.padEnd(12))} ${row.value}`);
        continue;
      }
      selectableSeen += 1;
      const selected = selectableSeen === this.state.cursor;
      const marker = selected ? cyan("›") : " ";
      const version = row.version ? dim(` ${terminalSafe(row.version)}`) : "";
      lines.push(
        ` ${marker} ${stepGlyph(row.step)} ${terminalSafe(row.step.label).padEnd(10)}${version}`
      );
      // The GUIDANCE under the row it belongs to, and the fix hint under that
      // — a human who cannot dispatch to a lane needs the sentence that says
      // what to type, not a status glyph they have to interpret.
      lines.push(`     ${dim(terminalSafe(row.step.guidance))}`);
      if (row.step.step !== "ready" && row.step.fixHint) {
        lines.push(`     ${yellow(terminalSafe(row.step.fixHint))}`);
      }
    }
    return lines.map((line) =>
      line.length > width * 4 ? line.slice(0, width * 4) : line
    );
  }
}
