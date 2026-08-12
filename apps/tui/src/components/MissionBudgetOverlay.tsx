import { Box, Text } from "ink";
import type { BudgetLineView } from "@muon/client";
import { vendorShortLabel } from "@muon/client/vendors";
import { hub, panelBorder } from "../lib/theme.js";

type Props = {
  view: BudgetLineView;
};

/**
 * Per-descendant budget breakdown for the active mission root, reachable
 * from the crew view (FleetRail: press `b` while focused). Mirrors the
 * desktop MissionTree's per-child readout; numbers/enums only (S9 wire
 * contract), READ-ONLY — no raise affordance, S9 raises stay
 * operator/desktop-gated. A poll failure replaces the breakdown outright,
 * never keeping stale ready numbers on screen.
 */
export function MissionBudgetOverlay({ view }: Props) {
  const attention = view.status === "exhausted";

  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="90%"
    >
      <Box justifyContent="space-between">
        <Text bold>Mission budget</Text>
        <Text dimColor>Esc close</Text>
      </Box>
      {view.status === "unknown" ? (
        <Text dimColor>{view.summaryLabel}</Text>
      ) : view.status === "poll-fail" ? (
        <Text color="red">budget: {view.detail ?? view.summaryLabel}</Text>
      ) : (
        <>
          <Text color={attention ? hub.warn : undefined} dimColor={!attention}>
            {view.summaryLabel}
          </Text>
          <Text dimColor>
            pool {view.poolLabel} · reserved {view.reservedLabel} · consumed{" "}
            {view.consumedLabel} · remaining {view.remainingLabel}
          </Text>
          <Text dimColor>Descendants</Text>
          {view.children.length === 0 ? (
            <Text dimColor>none</Text>
          ) : (
            view.children.map((child) => (
              <Text key={child.jobId} wrap="truncate">
                {"  "}
                {vendorShortLabel(child.vendor)} · {child.status} · depth{" "}
                {child.depth} · reserved {child.reservedLabel} · consumed{" "}
                {child.consumedLabel}
              </Text>
            ))
          )}
        </>
      )}
    </Box>
  );
}
