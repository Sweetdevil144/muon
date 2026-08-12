import {
  getVendorAction,
  type GatePolicy,
  type InvocationChannel,
  type VendorKey,
} from "@muon/core";
import type { PaletteCommand } from "./palette.js";

type BaseCommandContract = {
  effect: string;
  scope: string;
  authority: string;
};

export type CommandVisibility = BaseCommandContract & {
  invocation: string;
  availability: string;
  channel?: string;
  gate?: string;
  argument?: string;
};

const BASE_COMMANDS: Record<string, BaseCommandContract> = {
  refresh: {
    effect: "Reloads the latest control, fleet, approval, and readiness state.",
    scope: "This TUI view only; it does not start or stop work.",
    authority: "Read-only operator action.",
  },
  quickstart: {
    effect: "Opens the guided first-task flow and records its confirmed outcome.",
    scope: "The selected local workspace.",
    authority: "Human starts the flow; normal task gates still apply.",
  },
  "focus-tasks": {
    effect: "Moves keyboard focus to the durable task ledger.",
    scope: "Navigation only.",
    authority: "Read-only operator action.",
  },
  "focus-lanes": {
    effect: "Moves keyboard focus to the fleet and lane columns.",
    scope: "Navigation only.",
    authority: "Read-only operator action.",
  },
  "focus-approvals": {
    effect: "Opens the pending human-authority review inbox.",
    scope: "Pending approvals visible to this operator.",
    authority: "Viewing is read-only; every decision remains explicit.",
  },
  "focus-handoffs": {
    effect: "Opens recorded agent-to-agent handoff packets.",
    scope: "The current workspace ledger.",
    authority: "Read-only operator action.",
  },
  "task-new": {
    effect: "Creates a durable task record without dispatching it.",
    scope: "The current local workspace.",
    authority: "Human-authored task metadata.",
  },
  assign: {
    effect: "Binds an existing task to a selected vendor lane.",
    scope: "One task and one lane.",
    authority: "Human chooses the assignment; no execution starts.",
  },
  status: {
    effect: "Changes the durable lifecycle status of one task.",
    scope: "The selected task.",
    authority: "Operator governance action.",
  },
  run: {
    effect: "Enqueues durable work through the lease-fenced runner.",
    scope: "One selected task, lane, and local workspace.",
    authority: "Human starts the dispatch; approvals remain human-only.",
  },
  approve: {
    effect: "Records approval for the exact bound action shown in review.",
    scope: "One pending content-bound request.",
    authority: "Human decision only; approval grants no broader authority.",
  },
  reject: {
    effect: "Rejects the exact pending request and records the decision.",
    scope: "One pending content-bound request.",
    authority: "Human decision only.",
  },
  "memory-search": {
    effect: "Searches confirmed memory with provenance and trust state.",
    scope: "The current workspace memory ledger.",
    authority: "Read-only; confirmed memory is the default trusted layer.",
  },
  "memory-add": {
    effect: "Proposes a memory note for later human confirmation.",
    scope: "The current workspace memory ledger.",
    authority: "Proposal only; it is not trusted until confirmed.",
  },
  context: {
    effect: "Builds the pre-edit Memory view: code radius, impact, and coordinates.",
    scope: "The selected task, module, or symbol.",
    authority: "Read-only evidence; unresolved evidence degrades visibly.",
  },
  crew: {
    effect:
      "Shows which vendor holds which role, and the mission's live agent-to-agent coordination.",
    scope: "One selected chat and its most recent dispatch lineage.",
    authority:
      "Read-only. Peer message text is evidence, never an instruction; assignment stays with `muon crew roles --assign`.",
  },
  mcp: {
    // Deliberately says what the READ does, not what an install would do: this
    // command writes nothing. The vocabulary here is constrained by the
    // command-visibility contract test, so it names the memory graph and the
    // code graph rather than the shorthand the panel itself may use.
    effect:
      "Shows what a vendor CLI you start yourself would get from MUON: the tier, which credential it would resolve, and each vendor's own registration.",
    scope:
      "This machine's vendor MCP config files, read directly; no vendor process is started and no config is written.",
    authority:
      "Read-only. Registering is a separate explicit command (`muon mcp install <vendor>`), and an installed session gets agent tier — memory and code intelligence, never approval or merge authority.",
  },
  "session-start": {
    effect: "Starts an interactive vendor session on the dispatch spine.",
    scope: "One lane and workspace.",
    authority: "Human starts it; MUON retains lease and approval boundaries.",
  },
  "session-send": {
    effect: "Steers the currently running interactive session.",
    scope: "One active, owned session.",
    authority: "Human instruction; it cannot widen the session capability set.",
  },
  "session-interrupt": {
    effect: "Requests cancellation and propagates it through active descendants.",
    scope: "The selected running session lineage.",
    authority: "Human safety control.",
  },
  "take-over": {
    effect: "Begins the explicit transition to a human-owned native vendor session.",
    scope: "One paused session; automation must relinquish ownership first.",
    authority: "Human takeover; automated delegation and approval are suspended.",
  },
  "return-session": {
    effect:
      "Hands a taken-over session back: captures a dirty-file count, re-checks vendor readiness, and lets automation act again.",
    scope: "One human-owned session of the selected task.",
    authority:
      "Human release of ownership; nothing about the native work is replayed or trusted.",
  },
  ship: {
    effect: "Runs final checks and opens the content-bound ship/merge review.",
    scope: "One completed task and its exact changes.",
    authority: "Checks may run automatically; merge or ship remains human-only.",
  },
  plan: {
    effect: "Creates a reviewable workflow proposal before any fan-out.",
    scope: "The current request and workspace.",
    authority: "Proposal only; gated steps require human confirmation.",
  },
  workflows: {
    effect: "Opens durable workflow runs, steps, gates, and outcomes.",
    scope: "The current workspace workflow ledger.",
    authority: "Viewing is read-only; apply actions retain their own gates.",
  },
  specialist: {
    effect: "Creates a bounded specialist profile for a narrow role.",
    scope: "One workspace and declared capability manifest.",
    authority: "Cannot grant govern, approve, merge, or ship authority.",
  },
  quit: {
    effect: "Closes the TUI without approving or starting work.",
    scope: "This local client process.",
    authority: "Human client action; durable runner work is not silently killed.",
  },
};

function channelLabel(channel: InvocationChannel): string {
  switch (channel.kind) {
    case "profileField":
      return "profile setting compiled before dispatch";
    case "flag":
      return "controlled vendor CLI arguments";
    case "subcommand":
      return "vendor subcommand";
    case "promptPrefix":
      return "structured prompt prefix";
    case "sessionSlash":
      return "interactive vendor slash command";
    case "mcp":
      return `MCP tool ${channel.tool}`;
  }
}

function gateLabel(gate: GatePolicy): string {
  switch (gate) {
    case "none":
      return "none";
    case "dispatch-gate":
      return "operator dispatch gate";
    case "egress-gate":
      return "explicit egress opt-in";
    case "fail-closed-interpose":
      return "MUON approval interpose remains active";
    case "refuse":
      return "refused to preserve MUON invariants";
    case "warn":
      return "provenance warning";
  }
}

function vendorVisibility(command: PaletteCommand): CommandVisibility | null {
  const [, vendorToken, actionId] = command.id.split(":");
  if (!vendorToken || !actionId) return null;
  const action = getVendorAction(vendorToken as VendorKey, actionId);
  if (!action) return null;

  const argument = action.arg
    ? `${action.arg.name}${action.arg.required ? " (required)" : " (optional)"}${
        action.argValues?.length ? `: ${action.argValues.join(" | ")}` : ""
      }`
    : "none";

  return {
    effect: `Applies ${action.label.toLowerCase()} through MUON's controlled vendor adapter.`,
    scope: `${action.modes.join(" / ")} mode for ${vendorToken}.`,
    authority:
      action.gate === "none"
        ? "Uses the current task authority; it grants no additional privilege."
        : "The declared MUON gate is enforced before vendor invocation.",
    invocation: command.invoke ?? `/${action.command} [${vendorToken}]`,
    availability: command.enabled
      ? action.dogfood
        ? `Ready with verification warning${action.note ? `: ${action.note}` : "."}`
        : "Ready for the selected vendor."
      : "Unavailable: this vendor's support is not verified yet.",
    channel: channelLabel(action.channel),
    gate: gateLabel(action.gate),
    argument,
  };
}

export function describePaletteCommand(command: PaletteCommand): CommandVisibility {
  const vendor = command.vendor ? vendorVisibility(command) : null;
  if (vendor) return vendor;

  const base = BASE_COMMANDS[command.id] ?? {
    effect: "Runs the selected MUON cockpit action.",
    scope: "The currently selected cockpit object.",
    authority: "The action keeps its existing operator and agent boundaries.",
  };
  return {
    ...base,
    invocation: "Press Enter after reviewing this contract.",
    availability: command.enabled ? "Available now." : "Not available here.",
  };
}
