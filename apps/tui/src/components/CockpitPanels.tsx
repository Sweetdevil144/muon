import { Box, Text } from "ink";
import { vendorShortLabel } from "@muon/client/vendors";
import type { ReactNode } from "react";
import type {
  ApprovalReceipt,
  ApprovalRequest,
  PreflightDegradation,
  PreflightVendor,
  Task,
} from "@muon/client";
import type { BrainSnapshot } from "../lib/brain-store.js";
import { formatActiveReceiptsLine } from "../lib/receipts-view.js";
import { hub, preflightTone } from "../lib/theme.js";
import { ZoneLabel } from "./chrome.js";
import { terminalSafe } from "@muon/client";

export type DispatchSummary = {
  target: string;
  memory: string;
  codeRadius: string;
  symbolImpact: string;
  coordinates: string;
  degraded: boolean;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function buildDispatchSummary(
  snapshot: BrainSnapshot,
  task?: Task
): DispatchSummary {
  if (!task) {
    return {
      target: "no task selected",
      memory: "shared context loads before edits",
      codeRadius: "awaiting touched modules",
      symbolImpact: "awaiting symbol evidence",
      coordinates: "no active lane coordinates",
      degraded: true,
    };
  }
  const events = snapshot.events.filter((event) => event.taskId === task.id);
  const modules = [...new Set(events.flatMap((event) => strings(event.metadata.modules)))];
  const symbols = [...new Set(events.flatMap((event) => strings(event.metadata.symbols)))];
  const activeAgents = snapshot.agents.filter(
    (agent) => agent.currentTaskId === task.id && agent.status === "working"
  );
  return {
    target: symbols[0] ?? modules[0] ?? task.title,
    memory: "confirmed notes only",
    codeRadius:
      modules.length > 0
        ? `${modules.length} module${modules.length === 1 ? "" : "s"} · ${modules[0]}`
        : "target-only · symbol unresolved",
    symbolImpact:
      symbols.length > 0
        ? `${symbols.length} symbol${symbols.length === 1 ? "" : "s"} · ${symbols[0]}`
        : "symbol unresolved — shown as degraded",
    coordinates:
      activeAgents.length > 0
        ? activeAgents.map((agent) => agent.name).join(" + ")
        : "no live collision",
    degraded: modules.length === 0 || symbols.length === 0,
  };
}

/** Borderless mission strip: why this dispatch, with its evidence channels. */
export function DispatchHero(props: {
  summary: DispatchSummary;
  width: number;
}) {
  const { summary } = props;
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text dimColor>WHY THIS DISPATCH · </Text>
          {terminalSafe(summary.target)}
        </Text>
        {summary.degraded ? (
          <Text color={hub.warn}>DEGRADED</Text>
        ) : (
          <Text dimColor>Ready</Text>
        )}
      </Box>
      <Text wrap="truncate-end">
        <Text dimColor>MEMORY </Text>
        {summary.memory}
        <Text dimColor> · CODE RADIUS </Text>
        {summary.codeRadius}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>SYMBOL IMPACT </Text>
        {summary.symbolImpact}
        <Text dimColor> · COORDINATES </Text>
        {summary.coordinates}
      </Text>
    </Box>
  );
}

/**
 * Capability word for one preflight vendor row, contract fields ONLY
 * (`auth`/`authMethod`/`installed`) — never re-derived from detail text, so
 * a usable BYOK/custom-provider account can never render as "missing" or
 * "signed out". Mirrors the desktop DiagnosticsStrip's capabilityChip.
 */
function capabilityWord(vendor: PreflightVendor): string {
  if (vendor.auth === "authenticated" && vendor.authMethod !== "vendor-login") {
    return "BYOK";
  }
  if (vendor.auth === "authenticated") return "ready";
  // Honest probe outage, NOT "signed out": the account may be fine.
  if (vendor.auth === "unknown") return "unknown";
  if (vendor.installed) return "setup";
  return "missing";
}

/** `code · reason — nextAction`, the one-line degradation format. */
function formatDegradation(d: PreflightDegradation): string {
  return `${d.code} · ${d.reason} — ${d.nextAction}`;
}

/**
 * Borderless control strip: the ONE P0.5 capability-preflight contract
 * (built in the store's poll loop, same projection as `muon doctor --json`
 * and the desktop DiagnosticsStrip), so the TUI can never drift from the
 * other surfaces. Fixed at 2 rows (see lib/layout.ts STRUCTURAL_CHROME) —
 * content changes with status, the row count never grows.
 */
export function DiagnosticsPanel(props: {
  snapshot: BrainSnapshot;
  width: number;
  /** Compact height profile: count-only summary, no code/reason/nextAction lines. */
  compact?: boolean;
}) {
  const preflight = props.snapshot.preflight;

  // Not yet polled once: honest "checking", never a guessed "ready".
  if (!preflight) {
    return (
      <Box flexDirection="column" paddingX={1} width={props.width}>
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <ZoneLabel text="DOCTOR" />
            {" · "}
            <Text dimColor>checking…</Text>
          </Text>
          <Text dimColor>! Stop all</Text>
        </Box>
        <Text dimColor>doctor evidence loading</Text>
      </Box>
    );
  }

  const tone = preflightTone(preflight.status);
  // Info-severity degradations (e.g. VENDOR_ROLE_SCOPED) are not "needs
  // attention", they're a boundary note; only warning/blocking count here.
  const actionable = preflight.degradations.filter(
    (d) => d.severity !== "info"
  );

  let summary: ReactNode;
  if (props.compact) {
    summary =
      actionable.length > 0 ? (
        <Text color={tone}>
          {actionable.length} need{actionable.length === 1 ? "s" : ""}{" "}
          attention
        </Text>
      ) : (
        <Text dimColor>
          {preflight.readiness.readyVendors.length} crew ready
        </Text>
      );
  } else if (actionable.length > 0) {
    summary = (
      <Text color={tone} wrap="truncate-end">
        {actionable.map(formatDegradation).join("   ")}
      </Text>
    );
  } else {
    summary = (
      <Text dimColor wrap="truncate-end">
        {preflight.vendors.length === 0
          ? "vendor readiness unavailable"
          : preflight.vendors
              .map((v) => `${vendorShortLabel(v.vendor)} ${capabilityWord(v)}`)
              .join(" · ")}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <ZoneLabel text="DOCTOR" />
          {" · "}
          <Text color={tone}>{preflight.headline}</Text>
        </Text>
        <Text dimColor>! Stop all</Text>
      </Box>
      {summary}
    </Box>
  );
}

/** Borderless decision block: pending approvals with a scrolled window. */
export function ReviewInbox(props: {
  approvals: ApprovalRequest[];
  proposalCount: number;
  memoryReviewCount: number;
  width: number;
  focused?: boolean;
  selectedIndex?: number;
  maxRows?: number;
  /** Compact height profile drops the hint row. */
  compact?: boolean;
  /**
   * P0.4 TUI parity: live (unexpired, unrevoked) content-bound receipts for
   * the CURRENT scope (mirrors the desktop inbox's `activeReceipts`
   * annotation). `null`/`undefined` = honest absence — not yet polled OR the
   * last poll failed — so the line simply doesn't render, never a stale
   * count. Informational only: no mint/revoke affordance here (the operator
   * desktop/CLI acts), so this always renders plain/dim, never the
   * needs-you yellow reserved for actual pending approvals (the desktop
   * inbox draws the SAME distinction — no CSS color rule targets its
   * receipt-status line either).
   */
  activeReceipts?: ApprovalReceipt[] | null;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
}) {
  const pending = props.approvals.filter(
    (approval) => approval.status === "pending"
  );
  const max = props.maxRows ?? 4;
  const sel = props.selectedIndex ?? 0;
  const start = Math.min(
    Math.max(0, sel - max + 1),
    Math.max(0, pending.length - max)
  );
  const visible = pending.slice(start, start + max);
  const total =
    pending.length + props.proposalCount + props.memoryReviewCount;
  const receiptsLine = formatActiveReceiptsLine(
    props.activeReceipts,
    props.now ?? new Date(),
    Boolean(props.compact)
  );
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <ZoneLabel
        text="NEEDS YOUR DECISION"
        count={total}
        focused={props.focused}
        attention={total > 0}
      />
      {pending.length === 0 ? (
        <Text dimColor>Inbox clear, no blocked work</Text>
      ) : (
        visible.map((approval, index) => (
          <Text key={approval.id} wrap="truncate-end">
            <Text color={hub.focus}>
              {props.focused && start + index === sel ? "›" : " "}
            </Text>{" "}
            <Text color={hub.warn}>●</Text> {approval.kind} ·{" "}
            {terminalSafe(approval.reason)}
          </Text>
        ))
      )}
      <Text>
        {props.proposalCount} workflow proposal
        {props.proposalCount === 1 ? "" : "s"} · {props.memoryReviewCount} memory review
        {props.memoryReviewCount === 1 ? "" : "s"}
      </Text>
      {receiptsLine ? (
        <Text dimColor wrap="truncate-end">
          {receiptsLine}
        </Text>
      ) : null}
      <Text dimColor>
        {props.compact
          ? "a/r decide"
          : "a/r review selected · then a approve or r reject · j/k select"}
      </Text>
    </Box>
  );
}
