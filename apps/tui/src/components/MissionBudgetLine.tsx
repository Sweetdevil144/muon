import { Text } from "ink";
import type { BudgetLineView } from "@muon/client";
import { hub } from "../lib/theme.js";

type Props = {
  view: BudgetLineView;
  /** Compact row-budget profile (80x24): count/summary only, no breakdown. */
  compact?: boolean;
};

/**
 * The active mission root's S9 budget (`GET /api/dispatch/:jobId/budget`,
 * projected through `@muon/client`'s `buildBudgetLineView` — the ONE shared
 * projection, never a local derivation). Renders in the fleet/task spacer row
 * (see `lib/layout.ts` resolveRowBudget doc comment): a fixed-chrome row that
 * already existed in both row-budget profiles, never a NEW one. Compact shows
 * the bare summary; standard/tall extends the SAME row with the reserved/
 * consumed breakdown. Numbers read plain/dim; exhausted is the sole
 * needs-you yellow (mirrors DiagnosticsPanel's tone contract). READ-ONLY: no
 * raise affordance here, by design — raises stay operator/desktop-gated.
 */
export function MissionBudgetLine({ view, compact }: Props) {
  if (view.status === "unknown") {
    return <Text dimColor>{view.summaryLabel}</Text>;
  }

  if (view.status === "poll-fail") {
    // Honest failure, never the last-known ready/exhausted numbers.
    return (
      <Text color="red" wrap="truncate-end">
        budget: {view.detail ?? view.summaryLabel}
      </Text>
    );
  }

  const attention = view.status === "exhausted";
  const color = attention ? hub.warn : undefined;

  if (compact) {
    return (
      <Text color={color} dimColor={!attention}>
        {view.summaryLabel}
      </Text>
    );
  }

  return (
    <Text color={color} dimColor={!attention} wrap="truncate-end">
      {view.summaryLabel} · reserved {view.reservedLabel} · consumed{" "}
      {view.consumedLabel}
    </Text>
  );
}
