import fs from "node:fs";
import { resolveDataDir } from "@muon/client";
import {
  coarseMcpClient,
  coarseMcpTool,
  coarseMcpToolError,
  createSurfaceObservatory,
  gateRefusalReasonForState,
} from "@muon/client/observatory";
import type { McpIdentityGate, McpTelemetryTaps } from "./server-factory.js";

/**
 * ADR-0095 — the muon-mcp end of the observatory: turn the server factory's
 * raw taps into shape-bounded records through the SAME shared module (spool,
 * consent, uploader) the desktop and CLI use. Everything here is coerced to
 * the closed vocabulary before it is recorded; the raw tool name and the raw
 * clientInfo string never reach the spool.
 *
 * Consent is read live from the shared profile's `settings.json` inside
 * `createSurfaceObservatory` — a `muon-mcp` session honors the desktop's one
 * telemetry toggle, and with it OFF (the default) this whole file records
 * nothing and sends nothing.
 *
 * FAILURE-PROOF BY CONTRACT: telemetry may never break the server. The
 * factory already wraps each tap in try/catch (`tapSafely`); construction
 * here is additionally wrapped so a broken profile dir degrades to no taps,
 * not to a dead `muon-mcp`.
 */
/**
 * ONE surface observatory per PROCESS, however many servers this process
 * builds — the loopback HTTP listener constructs a server per session, and a
 * per-session uploader would accumulate one 30s flush interval per session
 * for the listener's lifetime (cubic's finding on the first draft). The
 * spool row lands synchronously at record time; egress pending at process
 * exit is deliberately lost — best-effort, the spool is the record.
 *
 * The one unref'd interval lives for the PROCESS lifetime by design — the
 * same lifecycle as the desktop's uploader. It cannot hold the process open,
 * consent is re-read live at every flush, and a listener closing mid-process
 * changes neither fact; stopping it per-listener would just drop the last
 * batch of a consenting operator's telemetry for no resource win.
 */
let sharedSurface:
  | ReturnType<typeof createSurfaceObservatory>
  | null
  | undefined;

function processSurface():
  | ReturnType<typeof createSurfaceObservatory>
  | null {
  if (sharedSurface === undefined) {
    try {
      sharedSurface = createSurfaceObservatory({
        dataDir: resolveDataDir(),
        appVersion: entryVersion(),
      });
    } catch {
      sharedSurface = null;
    }
  }
  return sharedSurface;
}

/** Test seam: drop the memoized process surface (and its flush timer). */
export function resetMcpObservatoryForTests(): void {
  try {
    sharedSurface?.stop();
  } catch {
    /* observability is not authority */
  }
  sharedSurface = undefined;
}

export function createMcpObservatoryTaps(options: {
  identityGate: McpIdentityGate | undefined;
  /** Read lazily — clientInfo exists only after `initialize` lands. */
  clientName: () => string | undefined;
}): McpTelemetryTaps {
  try {
    const surface = processSurface();
    if (!surface) return {};
    const { observatory } = surface;
    return {
      toolCall: (tool, durationMs, error) => {
        observatory.record({
          name: "mcp.tool_call",
          tool: coarseMcpTool(tool),
          durationMs,
          // Runtime-coerced like its siblings — `satisfies` is erased at
          // compile time and would carry free text verbatim if the tap's
          // signature ever widened (reviewer F10).
          error: coarseMcpToolError(error),
          client: coarseMcpClient(options.clientName()),
        });
      },
      gatePassed: () => {
        observatory.record({
          name: "identity.gate_passed",
          surface: "mcp",
          // Once per SESSION (the factory dedupes) — the denominator a
          // cross-surface chart needs to know (ADR-0095 D5).
          trigger: "session",
        });
      },
      gateRefused: () => {
        observatory.record({
          name: "identity.gate_refused",
          surface: "mcp",
          reason: gateRefusalReasonForState(
            options.identityGate?.state() ?? ""
          ),
          // Per refused CALL — unbounded within a session, and incomparable
          // with the desktop's one-per-launch row without this label.
          trigger: "tool_call",
        });
      },
    };
  } catch {
    return {};
  }
}

/** The nearest manifest's version — same hop walk `readDistributionBake`
 *  uses, because the bundled entry and the dev checkout keep their manifest
 *  at different depths. "0.0.0" only if no manifest resolves at all. */
function entryVersion(importMetaUrl: string = import.meta.url): string {
  for (const hop of ["./package.json", "../package.json", "../../package.json"]) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(new URL(hop, importMetaUrl), "utf8")
      ) as { version?: unknown };
      // Shape-guarded like every other wire field: a manifest is not user
      // input on the normal path, but "privacy by shape" is structural, and
      // this is one of the two string-shaped fields on every row.
      if (
        typeof manifest.version === "string" &&
        /^[\w.+-]{1,64}$/.test(manifest.version)
      ) {
        return manifest.version;
      }
    } catch {
      continue;
    }
  }
  return "0.0.0";
}
