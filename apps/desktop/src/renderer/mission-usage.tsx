import {
  aggregateMissionTokenUsage,
  formatDurationMs,
  formatReportedUsd,
  formatTokenCount,
  type MissionTokenUsage,
} from "../lib/mission-token-usage.js";
import type { RecordedEvent } from "@muon/client";

export function MissionTokenUsagePanel(props: {
  events: readonly RecordedEvent[];
}) {
  const usage = aggregateMissionTokenUsage(props.events);
  return <MissionTokenUsageView usage={usage} />;
}

export function MissionTokenUsageView(props: { usage: MissionTokenUsage }) {
  const { usage } = props;
  return (
    <section className="mission-usage" aria-label="Mission cost and usage">
      <div className="mission-usage-head">
        <strong>Crew cost &amp; usage</strong>
        <span>
          {usage.hasCost
            ? `${formatReportedUsd(usage.reportedCostUsd)} reported · ${formatTokenCount(usage.totalTokens)} tokens`
            : usage.hasAny
              ? `Cost unavailable · ${formatTokenCount(usage.totalTokens)} tokens`
              : "No usage recorded yet"}
        </span>
      </div>
      <ul className="mission-usage-list">
        {usage.byVendor.map((row) => (
          <li key={row.vendor}>
            <span className="mission-usage-vendor">{row.label}</span>
            {!row.available ? (
              <span className="mission-usage-muted">Unavailable</span>
            ) : row.runs === 0 ? (
              <span className="mission-usage-muted">—</span>
            ) : (
              <span className="mission-usage-counts">
                {formatTokenCount(row.inputTokens)} in ·{" "}
                {formatTokenCount(row.outputTokens)} out
                {row.costAvailable
                  ? ` · ${formatReportedUsd(row.reportedCostUsd)} reported`
                  : " · cost unavailable"}
                {row.averageLatencyMs !== undefined
                  ? ` · ${formatDurationMs(row.averageLatencyMs)} avg`
                  : ""}
                {row.peakContextOccupancy !== undefined
                  ? ` · ${Math.round(row.peakContextOccupancy * 100)}% context peak`
                  : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="mission-usage-note">
        Vendor-reported measurements only. Missing dollars are unavailable,
        never treated as zero; subscription and provider-owned lanes may not
        expose a cash charge. Cursor stays blank until a managed signal exists.
      </p>
    </section>
  );
}
