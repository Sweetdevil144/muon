import { Box, Text } from "ink";
import type { McpStatusReport } from "@muon/client/mcp-status";
import type { McpPanelLoad } from "../lib/mcp-view.js";
import { hub, panelBorder } from "../lib/theme.js";

/**
 * MCP — "what would a vendor CLI I start myself get from MUON", S1 of
 * docs/design/cc-as-superagent-delivery.md §5.
 *
 * READ-ONLY on purpose, and the CLI parity is the feature: every value below is
 * a field on the ONE `McpStatusReport` that `muon mcp status` renders, so the
 * two surfaces cannot disagree. This panel installs nothing — `muon mcp install
 * <vendor>` is the writer, and it stays one command rather than becoming a
 * second keystroke that writes into a file MUON does not own.
 *
 * The only thing this file decides for itself is the GLYPH and the colour for a
 * level, because those are terminal idiom (the desktop uses a 6px dot for the
 * same three levels). The level itself, the check id, the reason id and every
 * sentence of prose come from the shared evaluator verbatim.
 */

/** Vendor rows on screen at once; j/k scrolls the window. */
export const MCP_VENDOR_WINDOW = 2;

const LEVEL_GLYPH = { ok: "✓", warn: "⚠", fail: "✗" } as const;

function levelColor(level: "ok" | "warn" | "fail"): string | undefined {
  if (level === "fail") return "red";
  if (level === "warn") return hub.warn;
  return undefined;
}

type Props = {
  load: McpPanelLoad;
  busy?: boolean;
  /** First visible vendor row (scroll offset). */
  vendorIndex?: number;
};

function Summary({ report }: { report: McpStatusReport }) {
  return (
    <>
      <Text wrap="truncate-end">
        {"Tier         "}
        <Text color={report.tier === "agent" ? undefined : hub.warn}>
          {report.tier}
        </Text>
        <Text dimColor>
          {"  never operator, by construction · "}
          {report.toolCount} tools
          {report.mode ? ` · MUON_MCP_MODE=${report.mode}` : ""}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        {"Bearer from  "}
        <Text color={report.tokenSource === "none" ? "red" : undefined}>
          {report.tokenSource}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        {"Brain        "}
        {report.brainRunning ? (
          <Text>
            running
            <Text dimColor>
              {" pid "}
              {report.pid}
              {" port "}
              {report.port}
            </Text>
          </Text>
        ) : (
          <Text color="red">not running</Text>
        )}
      </Text>
      <Text wrap="truncate-end">
        {"API base     "}
        {report.apiBase}
        <Text dimColor>{"  source "}</Text>
        <Text color={report.baseSource === "explicit-env" ? hub.warn : undefined}>
          {report.baseSource}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        {"muon-mcp     "}
        {report.resolvedCommand === null ? (
          <Text color="red">NOT RESOLVABLE</Text>
        ) : (
          <Text>
            {report.resolvedCommand}
            <Text dimColor>{`  [${report.resolvedCommandSource}]`}</Text>
          </Text>
        )}
      </Text>
      <Text wrap="truncate-end">
        {"attached coordinator       "}
        {report.mode === "attached-coordinator" ? (
          <Text color={hub.warn}>
            ATTACHED · non-hermetic
            <Text dimColor>
              {"  "}
              {report.tierCReason}
            </Text>
          </Text>
        ) : (
          <Text dimColor>no — {report.tierCReason}</Text>
        )}
      </Text>
    </>
  );
}

function Checks({ report }: { report: McpStatusReport }) {
  return (
    <>
      <Text>
        Checks ({report.checks.length})
        <Text dimColor>, every reason this could be wrong</Text>
      </Text>
      {report.checks.map((check) => (
        // EVERY check, EVERY time, with its state — a status surface that shows
        // only the failures cannot say what it looked at. The full prose of each
        // one is one command away, named in the footer.
        <Box key={check.id} flexDirection="column">
          <Text wrap="truncate-end" color={levelColor(check.level)}>
            {"  "}
            {LEVEL_GLYPH[check.level]} {check.id.padEnd(20)}
            <Text dimColor={check.level === "ok"}>{check.detail}</Text>
          </Text>
        </Box>
      ))}
    </>
  );
}

function VendorRow({
  row,
}: {
  row: McpStatusReport["vendors"][number];
}) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {"  "}
        {row.label}
        <Text dimColor> ({row.vendor})</Text>
        {"  "}
        {row.installed ? (
          <Text color={hub.accent}>installed</Text>
        ) : (
          <Text color={hub.warn}>not installed</Text>
        )}
        <Text dimColor> · {row.scope} scope</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {"      config    "}
        {row.configPath}
      </Text>
      <Text dimColor wrap="truncate-end">
        {"      command   "}
        {row.command ?? "—"}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>{"      resolves  "}</Text>
        {row.commandResolves === null ? (
          <Text dimColor>n/a</Text>
        ) : row.commandResolves ? (
          <Text>yes</Text>
        ) : (
          <Text color="red">NO — re-run muon mcp install</Text>
        )}
      </Text>
      {/* TWO SEPARATE BOOLEANS, always printed together. Conflating "MUON can
          install into it" with "it can coordinate a crew" is the documentation
          failure ADR-0022 warns about, so neither is ever shown without the
          other — cursor and opencode are installable and hold no seat.
          They get their own short line, and the consequence gets the line after
          it, so a narrow terminal clips the explanation and never the fact. */}
      <Text wrap="truncate-end">
        <Text dimColor>{"      installable "}</Text>
        {row.installable ? "yes" : "no"}
        <Text dimColor>{"   coordinatorSeat "}</Text>
        {row.coordinatorSeat ? "yes" : "no"}
      </Text>
      <Text dimColor wrap="truncate-end">
        {row.coordinatorSeat
          ? "        it can be the superagent that dispatches a crew"
          : "        it can use MUON's memory + code graph, never coordinate a crew"}
      </Text>
      {row.reasons.map((reason) => (
        <Text key={reason.id} wrap="truncate-end" color={levelColor(reason.level)}>
          {"      "}
          {LEVEL_GLYPH[reason.level]} {reason.id}
          <Text dimColor> {reason.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function McpPanel({ load, busy, vendorIndex = 0 }: Props) {
  const report = load.status === "ready" ? load.report : null;
  const start = report
    ? Math.min(
        Math.max(0, vendorIndex),
        Math.max(0, report.vendors.length - MCP_VENDOR_WINDOW)
      )
    : 0;
  const visible = report
    ? report.vendors.slice(start, start + MCP_VENDOR_WINDOW)
    : [];

  return (
    <Box
      flexDirection="column"
      borderStyle={panelBorder}
      borderColor={hub.border}
      borderDimColor
      paddingX={1}
      width="86%"
    >
      <Text bold>
        MCP
        <Text dimColor>
          {" · what a vendor CLI you start yourself would get"}
        </Text>
        {busy ? <Text dimColor> · refreshing…</Text> : null}
      </Text>

      {load.status === "loading" ? (
        <Text dimColor>{"reading each vendor's own MCP config…"}</Text>
      ) : load.status === "error" ? (
        // Never a blank overlay: one honest line plus the way forward.
        <>
          <Text color={hub.warn}>unavailable</Text>
          <Text dimColor wrap="truncate-end">
            {"  "}
            {load.reason}
          </Text>
          <Text dimColor>
            {"  Run `muon mcp status` for the same read outside the cockpit."}
          </Text>
        </>
      ) : report ? (
        <>
          <Summary report={report} />
          <Box height={1} />
          <Checks report={report} />
          <Box height={1} />
          <Text>
            Vendors ({report.vendors.length})
            <Text dimColor>, MUON never installs or logs in to one for you</Text>
          </Text>
          {visible.map((row) => (
            <VendorRow key={row.vendor} row={row} />
          ))}
          {report.vendors.length > MCP_VENDOR_WINDOW ? (
            <Text dimColor>
              {"  showing "}
              {start + 1}
              {"–"}
              {start + visible.length}
              {" of "}
              {report.vendors.length}
              {" · j/k scrolls"}
            </Text>
          ) : null}
        </>
      ) : null}

      <Text dimColor wrap="truncate-end">
        {"status is read-only · `muon mcp install <vendor>` registers base MCP"}
      </Text>
      <Text dimColor wrap="truncate-end">
        {"attached coordinator: `/mcp-attach <claude|codex>` · `/mcp-detach <vendor>` (shared flow; no token in UI)"}
      </Text>
      <Text dimColor wrap="truncate-end">
        `muon mcp status` · r refresh · j/k scroll · Esc close
      </Text>
    </Box>
  );
}
