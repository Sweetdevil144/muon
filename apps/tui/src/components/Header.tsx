import { Box, Text } from "ink";
import { isVendorId, type VendorId } from "@muon/client/vendors";
import type { BrainSnapshot } from "../lib/brain-store.js";
import type { LayoutMode } from "../lib/layout.js";
import { hub } from "../lib/theme.js";

/**
 * Two-character lane codes for the width-constrained header strip.
 *
 * WAVE D: a TOTAL `Record<VendorId, string>` rather than a `?:` chain, so a new
 * vendor must STATE its code. These are not derivable from `shortLabel` — the
 * first two letters would collide ("Claude"/"Codex"/"Cursor" all start "C") —
 * which is why this is one of the few per-vendor presentation tables that stays
 * hand-written instead of collapsing into `vendorShortLabel`.
 */
const LANE_ABBREV: Record<VendorId, string> = {
  "claude-code": "CC",
  codex: "CX",
  cursor: "CU",
  opencode: "OC",
  fake: "FK",
};

/** An id MUON does not name still gets a code, never a blank cell. */
function laneAbbrev(key: string): string {
  return isVendorId(key) ? LANE_ABBREV[key] : key.slice(0, 2).toUpperCase();
}

type Props = {
  snapshot: BrainSnapshot;
  layoutMode: LayoutMode;
};

export function Header({ snapshot, layoutMode }: Props) {
  const healthOk = snapshot.health?.status === "ok";
  const laneBits = snapshot.lanes
    .map((lane) => {
      const short = laneAbbrev(lane.key);
      const doctor = snapshot.laneDoctor[lane.key];
      const dot =
        doctor === "healthy"
          ? "●"
          : doctor === "degraded"
            ? "◐"
            : doctor
              ? "○"
              : "·";
      return `${dot}${short}`;
    })
    .join(" ");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        flexDirection={layoutMode === "side-panel" ? "column" : "row"}
        justifyContent="space-between"
      >
        <Text bold color={hub.brand}>
          MUON <Text dimColor>HUB</Text>
          <Text dimColor>
            {" "}
            · OPEN WORK {snapshot.tasks.length} · APPROVALS{" "}
            {snapshot.pendingApprovals} · EVENTS {snapshot.events.length}
          </Text>
        </Text>
        <Text dimColor>
          {healthOk ? "●" : "○"} control · lanes {laneBits || "—"}
        </Text>
      </Box>
      {snapshot.error ? (
        <Text color="red">
          {" "}
          err: {snapshot.error} → {snapshot.target.base} ({snapshot.target.source}
          {snapshot.target.dataDir
            ? `, data dir ${snapshot.target.dataDir}`
            : ""}
          )
        </Text>
      ) : null}
    </Box>
  );
}
