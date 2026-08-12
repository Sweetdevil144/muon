import {
  buildVendorActionMenu,
  type VendorActionMenuItem,
  type VendorReadinessLike,
} from "@muon/core";

export type PaletteCommand = {
  id: string;
  label: string;
  keywords: string[];
  enabled: boolean;
  /** ADR-0013 #52, vendor-action decoration (absent for cockpit commands). */
  vendor?: string;
  /** Short vendor badge text (e.g. "claude"). */
  badge?: string;
  /** Parity/gate chip (e.g. "clean", "gated · sandbox+operator", "refused ⚠"). */
  chip?: string;
  /** The `/<action> [vendor]` string this command dispatches, when a vendor action. */
  invoke?: string;
};

export const PALETTE_COMMANDS: PaletteCommand[] = [
  {
    id: "refresh",
    label: "Refresh control state",
    keywords: ["reload", "poll", "sync"],
    enabled: true,
  },
  {
    id: "quickstart",
    label: "Quickstart: run your first task…",
    keywords: ["quickstart", "first", "sample", "getting started", "try", "demo"],
    enabled: true,
  },
  {
    id: "focus-tasks",
    label: "Focus task ledger",
    keywords: ["tasks", "ledger"],
    enabled: true,
  },
  {
    id: "focus-lanes",
    label: "Focus lane columns",
    keywords: ["lanes", "agents", "columns"],
    enabled: true,
  },
  {
    id: "focus-approvals",
    label: "Focus approvals inbox",
    keywords: ["approve", "inbox"],
    enabled: true,
  },
  {
    id: "focus-handoffs",
    label: "Focus handoffs",
    keywords: ["handoff", "packet"],
    enabled: true,
  },
  {
    id: "task-new",
    label: "Create task…",
    keywords: ["new", "add"],
    enabled: true,
  },
  {
    id: "assign",
    label: "Assign task to lane…",
    keywords: ["assign", "lane"],
    enabled: true,
  },
  {
    id: "status",
    label: "Update task status…",
    keywords: ["status", "move", "done", "blocked"],
    enabled: true,
  },
  {
    id: "run",
    label: "Run task on lane…",
    keywords: ["run", "dispatch", "execute"],
    enabled: true,
  },
  {
    id: "approve",
    label: "Approve selected request",
    keywords: ["approve", "accept"],
    enabled: true,
  },
  {
    id: "reject",
    label: "Reject selected request",
    keywords: ["reject", "deny"],
    enabled: true,
  },
  {
    id: "memory-search",
    label: "Search memory…",
    keywords: ["memory", "recall", "find"],
    enabled: true,
  },
  {
    id: "memory-add",
    label: "Add memory note…",
    keywords: ["memory", "note", "decision"],
    enabled: true,
  },
  {
    id: "context",
    label: "Pre-edit context (Memory)…",
    keywords: ["brain", "context", "pre-edit", "preedit", "blast", "moat", "gate"],
    enabled: true,
  },
  {
    id: "crew",
    label: "Crew roles + coordination…",
    keywords: [
      "crew",
      "role",
      "roles",
      "coordination",
      "a2a",
      "peer",
      "claims",
      "conflicts",
      "topology",
      "who does what",
    ],
    enabled: true,
  },
  {
    // S1 of docs/design/cc-as-superagent-delivery.md §5: the cockpit's half of
    // `muon mcp status`. Same read, same fields, same words — it renders the ONE
    // `McpStatusReport` the CLI renders.
    id: "mcp",
    label: "MCP registration status (your own CLI sessions)…",
    keywords: [
      "mcp",
      "install",
      "register",
      "connect",
      "claude",
      "codex",
      "cursor",
      "opencode",
      "tier",
      // NOT "token": palette.test.ts pins that no palette payload may carry the
      // substring `token` at all (renderer hygiene — the payload is serialized).
      // The keyword a user would type for the same thing is spelled out instead.
      "credential",
      "auth",
      "vendor cli",
      "superagent",
    ],
    enabled: true,
  },
  {
    id: "session-start",
    label: "Start interactive session…",
    keywords: ["session", "interactive", "live"],
    enabled: true,
  },
  {
    id: "session-send",
    label: "Steer running session…",
    keywords: ["steer", "send", "message"],
    enabled: true,
  },
  {
    id: "session-interrupt",
    label: "Interrupt running session",
    keywords: ["stop", "interrupt", "cancel"],
    enabled: true,
  },
  {
    id: "take-over",
    label: "Take over task in native tool",
    keywords: ["takeover", "resume", "native"],
    enabled: true,
  },
  {
    id: "return-session",
    label: "Return session to MUON",
    keywords: ["return", "hand back", "release", "ownership"],
    enabled: true,
  },
  {
    id: "ship",
    label: "Ship review (checks + merge approval)…",
    keywords: ["ship", "review", "merge", "done"],
    enabled: true,
  },
  {
    id: "plan",
    label: "Plan request into tasks…",
    keywords: ["plan", "superagent", "breakdown"],
    enabled: true,
  },
  {
    id: "workflows",
    label: "Workflow runs…",
    keywords: ["workflow", "runs", "apply", "steps", "gates"],
    enabled: true,
  },
  {
    id: "specialist",
    label: "Create specialist…",
    keywords: ["specialist", "factory", "harness", "agent"],
    enabled: true,
  },
  {
    id: "quit",
    label: "Quit TUI",
    keywords: ["exit", "q"],
    enabled: true,
  },
];

/** ADR-0013 #52, turn a shared vendor-action menu item into a palette entry. */
export function vendorActionToPaletteCommand(
  item: VendorActionMenuItem
): PaletteCommand {
  return {
    id: `vendor:${item.vendor}:${item.actionId}`,
    label: `${item.label}`,
    keywords: [item.command, item.actionId, item.vendor, item.badge, "vendor"],
    enabled: item.ready,
    vendor: item.vendor,
    badge: item.badge,
    chip: item.chip,
    invoke: `/${item.command} [${item.badge}]`,
  };
}

/**
 * Join the MUON cockpit commands with the readiness-aware vendor-action surface
 * so both coexist in one palette (ADR-0013 §2). The vendor half is the SAME
 * descriptor the desktop renders, filtered by live readiness + mode.
 */
export function buildPaletteCommands(
  readiness: VendorReadinessLike[] | null | undefined,
  base: PaletteCommand[] = PALETTE_COMMANDS
): PaletteCommand[] {
  const vendorCommands = buildVendorActionMenu({ readiness, mode: "one-shot" }).map(
    vendorActionToPaletteCommand
  );
  return [...base, ...vendorCommands];
}

function scoreMatch(query: string, command: PaletteCommand): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 1;
  }

  const haystacks = [command.id, command.label, ...command.keywords].map((s) =>
    s.toLowerCase()
  );

  let best = 0;
  for (const hay of haystacks) {
    if (hay === q) {
      best = Math.max(best, 100);
    } else if (hay.startsWith(q)) {
      best = Math.max(best, 80);
    } else if (hay.includes(q)) {
      best = Math.max(best, 50);
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      if (tokens.length > 0 && tokens.every((t) => hay.includes(t))) {
        best = Math.max(best, 40);
      }
    }
  }
  return best;
}

export function filterPaletteCommands(
  query: string,
  commands: PaletteCommand[] = PALETTE_COMMANDS
): PaletteCommand[] {
  const scored = commands
    .map((command) => ({ command, score: scoreMatch(query, command) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label));

  return scored.map((entry) => entry.command);
}
