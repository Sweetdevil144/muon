import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import forceAtlas2 from "graphology-layout-forceatlas2";
import noverlap from "graphology-layout-noverlap";
// `sigma` + `@sigma/edge-curve` touch WebGL at module-eval time, which crashes
// in the jsdom test env and would needlessly load on app startup. They are
// LAZY-imported inside renderGraph (only when the graph tab actually opens);
// the type-only import below is erased and never evaluates the module.
import type SigmaType from "sigma";
import type {
  GitNexusGraphData,
  GitNexusIndexStatus,
} from "../shared/ipc.js";
import {
  brightenColor,
  buildGraph,
  dimColor,
  edgeColor,
  nodeColor,
  presentEdgeTypes,
  presentLabels,
  type SigmaEdgeAttributes,
  type SigmaNodeAttributes,
} from "./lib/graph-adapter.js";
import { defaultRepoPath, GraphRepoTabs } from "./graph-repo-tabs.js";

// The Knowledge Graph center workspace tab (panel:graph): renders the workspace's
// LOCAL knowledge graph with the same sigma + @sigma/edge-curve stack GitNexus uses.
// Mounted inside workspace-panel-shell — never a floating overlay over Mission chat.
// The force layout runs INCREMENTALLY on requestAnimationFrame (never a web
// worker) so it stays CSP-clean and never blocks the UI thread for long.
//
// A run is budgeted (~LAYOUT_TOTAL_ITERATIONS), then stops on its own so the
// graph does not churn forever. That is NOT a mysterious "auto pause" — it is
// the budget ending. Pause / Continue lets the operator stop early or run
// another budget after it settles.

const LAYOUT_TOTAL_ITERATIONS = 600;
const LAYOUT_BATCH = 4;

type Selected = {
  id: string;
  label: string;
  nodeType: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
};

type Phase = "loading" | "ready" | "error";

export function GraphView(props: {
  open: boolean;
  onClose: () => void;
  /**
   * Live GitNexus index status, so the page can render a tab per detected
   * repo (Auto Repository Detection) when the workspace resolved to more than
   * one. Optional / possibly repo-less — the page degrades to today's single-
   * repo, tab-free behavior whenever `repos` has 0 or 1 entries.
   */
  status?: GitNexusIndexStatus | null;
}) {
  const { open, onClose } = props;
  const repos = props.status?.repos ?? [];
  const showTabs = repos.length > 1;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<SigmaType<
    SigmaNodeAttributes,
    SigmaEdgeAttributes
  > | null>(null);
  const rafRef = useRef<number | null>(null);
  /** Live graphology instance for Pause / Continue (survives the rAF closure). */
  const layoutGraphRef = useRef<ReturnType<typeof buildGraph> | null>(null);
  const layoutSettingsRef = useRef<ReturnType<
    typeof forceAtlas2.inferSettings
  > | null>(null);
  /** Iterations completed in the current layout budget. */
  const layoutDoneRef = useRef(0);
  // Mirrors `selected.id` for the sigma nodeReducer/edgeReducer closures below
  // (sigma is imperative — a React state change alone never repaints the
  // canvas; the click handlers update this ref THEN call sigma.refresh()).
  const selectedRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    nodes: number;
    edges: number;
    truncated: boolean;
  } | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [edgeTypes, setEdgeTypes] = useState<string[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [layoutRunning, setLayoutRunning] = useState(false);
  // The user's explicit tab pick; falls back to the first detected repo
  // (defaultRepoPath) and self-heals when the repo list changes underneath it
  // (e.g. a different workspace opened). Persists across close/reopen since
  // GraphView stays mounted — "restore selected tab" for free.
  const [manualRepoPath, setManualRepoPath] = useState<string | undefined>(
    undefined
  );
  /** Bumped by Refresh to re-run the fetch effect (optionally bypassing cache). */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** A re-index request is in flight (client half of the no-double-run guard). */
  const [reindexing, setReindexing] = useState(false);
  /** Main's answer to the last re-index request — an accepted note or a refusal. */
  const [reindexNote, setReindexNote] = useState<string | null>(null);
  const forceReloadRef = useRef(false);
  // NUL-joined: an absolute repo path can legitimately contain a space.
  const repoPathsKey = repos.map((r) => r.path).join("\u0000");
  // Multi-repo: pick the active tab (a detected repo's own `.gitnexus/`). Single
  // repo / no tabs: undefined ⇒ the main handler's index-aware resolver picks
  // the target — crucially, when the workspace root is a NON-git monorepo parent
  // with no `.gitnexus/`, it falls back to the first indexed member instead of
  // reading the empty root ("no indexed graph yet"). See resolveBestGraphTarget.
  const activeRepoPath = useMemo(
    () => (showTabs ? defaultRepoPath(repos, manualRepoPath) : undefined),
    // repos itself is intentionally omitted: repoPathsKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repoPathsKey, manualRepoPath, showTabs]
  );

  // ─── Re-index from the graph page ────────────────────────────────────────
  // Someone looking at an empty, stale or broken graph is already HERE. Making
  // them go back to the masthead to fix it is the gap that left the founder
  // with a failed index and nothing to click.
  const indexPhase = props.status?.status;
  const indexReason = props.status?.reason;
  const reindexTitle =
    indexReason === "cli-missing"
      ? "GitNexus CLI not found — MUON cannot re-index for you"
      : indexPhase === "indexing"
        ? "An index run is already in progress"
        : showTabs
          ? "Rebuild this repository's code graph"
          : "Rebuild this workspace's code graph";

  const requestReindex = useCallback(() => {
    if (reindexing) return;
    setReindexing(true);
    setReindexNote(null);
    void window.muon
      .gitnexusReindex(activeRepoPath)
      .then((result) => {
        // A refusal is shown verbatim. The one thing this must never do is
        // look like it worked.
        setReindexNote(result.note);
      })
      .catch((error: unknown) =>
        setReindexNote(
          error instanceof Error
            ? `Could not start indexing: ${error.message}`
            : "Could not start indexing."
        )
      )
      .finally(() => setReindexing(false));
  }, [activeRepoPath, reindexing]);

  // When an index run finishes, re-read the store bypassing the cache — the
  // graph on screen was built from the PREVIOUS index and is now a lie.
  const prevIndexPhase = useRef<typeof indexPhase>(undefined);
  useEffect(() => {
    if (prevIndexPhase.current === "indexing" && indexPhase === "ready") {
      forceReloadRef.current = true;
      setReindexNote(null);
      setReloadNonce((n) => n + 1);
    }
    prevIndexPhase.current = indexPhase;
  }, [indexPhase]);

  const stopLayout = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLayoutRunning(false);
  }, []);

  /**
   * Start or resume ForceAtlas2. If the previous budget finished (or was never
   * started), opens a fresh budget. If the operator paused mid-budget, resumes
   * from `layoutDoneRef` without resetting node positions.
   */
  const startLayout = useCallback(() => {
    const graph = layoutGraphRef.current;
    const settings = layoutSettingsRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !settings || !sigma) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (layoutDoneRef.current >= LAYOUT_TOTAL_ITERATIONS) {
      layoutDoneRef.current = 0;
    }

    setLayoutRunning(true);
    const tick = () => {
      const liveGraph = layoutGraphRef.current;
      const liveSettings = layoutSettingsRef.current;
      const liveSigma = sigmaRef.current;
      if (!liveGraph || !liveSettings || !liveSigma) {
        rafRef.current = null;
        setLayoutRunning(false);
        return;
      }
      forceAtlas2.assign(liveGraph, {
        iterations: LAYOUT_BATCH,
        settings: liveSettings,
      });
      liveSigma.refresh();
      layoutDoneRef.current += LAYOUT_BATCH;
      if (layoutDoneRef.current >= LAYOUT_TOTAL_ITERATIONS) {
        try {
          noverlap.assign(liveGraph, { maxIterations: 40 });
        } catch {
          // noverlap is cosmetic; never let it break the render
        }
        liveSigma.refresh();
        liveSigma.getCamera().animatedReset({ duration: 300 });
        rafRef.current = null;
        setLayoutRunning(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const toggleLayout = useCallback(() => {
    if (layoutRunning) stopLayout();
    else startLayout();
  }, [layoutRunning, startLayout, stopLayout]);

  const teardown = useCallback(() => {
    stopLayout();
    layoutGraphRef.current = null;
    layoutSettingsRef.current = null;
    layoutDoneRef.current = 0;
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
  }, [stopLayout]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Fetch + render whenever the graph tab opens (or the active repo tab
  // changes); fully tear down when it closes. `activeRepoPath` is undefined
  // in single-repo/no-tabs mode, which reproduces today's exact behavior
  // (gitnexusGraph() with no argument ⇒ the bound workspace root).
  useEffect(() => {
    if (!open) {
      teardown();
      return;
    }
    let cancelled = false;
    setPhase("loading");
    setError(null);
    setSelected(null);
    setMeta(null);
    setLabels([]);
    setEdgeTypes([]);
    selectedRef.current = null;

    const force = forceReloadRef.current;
    forceReloadRef.current = false;
    void window.muon
      .gitnexusGraph(activeRepoPath, force ? { force: true } : undefined)
      .then((data: GitNexusGraphData) => {
        if (cancelled) return;
        if (data.error && data.nodes.length === 0) {
          setPhase("error");
          setError(data.error);
          return;
        }
        setMeta({
          nodes: data.nodes.length,
          edges: data.relationships.length,
          truncated: data.truncated,
        });
        setLabels(presentLabels(data));
        setEdgeTypes(presentEdgeTypes(data));
        setPhase("ready");
        // Container mounts with the "ready" render; defer sigma to next frame.
        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          void renderGraph(data);
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      });

    async function renderGraph(data: GitNexusGraphData) {
      // Lazy WebGL deps: only loaded when the graph tab actually opens.
      const [{ default: Sigma }, { createEdgeCurveProgram }] =
        await Promise.all([import("sigma"), import("@sigma/edge-curve")]);
      const container = containerRef.current;
      if (cancelled || !container) return;
      const graph = buildGraph(data);
      // The factory (vs. the untyped default export) returns a program typed
      // for OUR exact node/edge attributes — the untyped default is what
      // produced the pre-existing sigma.js EdgeProgramType mismatch here.
      const EdgeCurveProgram = createEdgeCurveProgram<
        SigmaNodeAttributes,
        SigmaEdgeAttributes
      >();
      const sigma = new Sigma<SigmaNodeAttributes, SigmaEdgeAttributes>(
        graph,
        container,
        {
          renderLabels: true,
          // Quiet `--text-primary`. GitNexus OSS (useSigma.ts) uses the near-
          // identical `#e4e4ed` on its own near-black canvas; MUON ties this to
          // the actual design-token value instead of a one-off hex.
          labelColor: { color: "#F3F4F6" },
          labelFont: "JetBrains Mono, ui-monospace, monospace",
          labelSize: 11,
          labelWeight: "500",
          labelRenderedSizeThreshold: 8,
          labelDensity: 0.1,
          labelGridCellSize: 70,
          // OSS's Sigma-level fallbacks (useSigma.ts) — practically unreachable
          // since buildGraph always sets an explicit per-node/edge color, but
          // matched for fidelity.
          defaultNodeColor: "#6b7280",
          defaultEdgeColor: "#2a2a3a",
          defaultEdgeType: "curved",
          edgeProgramClasses: { curved: EdgeCurveProgram },
          // Custom hover renderer — a dark pill + node-colored ring, ported
          // from OSS's useSigma.ts `defaultDrawNodeHover`, recolored onto
          // MUON's Quiet tokens (`--panel` pill, `--text-primary` label).
          defaultDrawNodeHover: (context, hoverData, hoverSettings) => {
            const label = hoverData.label;
            if (!label) return;
            const size = hoverSettings.labelSize || 11;
            const font = hoverSettings.labelFont || "JetBrains Mono, monospace";
            const weight = hoverSettings.labelWeight || "500";
            context.font = `${weight} ${size}px ${font}`;
            const textWidth = context.measureText(label).width;
            const nodeRadius = hoverData.size || 8;
            const x = hoverData.x;
            const y = hoverData.y - nodeRadius - 10;
            const paddingX = 8;
            const paddingY = 5;
            const height = size + paddingY * 2;
            const width = textWidth + paddingX * 2;
            context.fillStyle = "#1A1A1A"; // --panel
            context.beginPath();
            context.roundRect(x - width / 2, y - height / 2, width, height, 4);
            context.fill();
            context.strokeStyle = hoverData.color || "#6366f1";
            context.lineWidth = 2;
            context.stroke();
            context.fillStyle = "#F3F4F6"; // --text-primary
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(label, x, y);
            context.beginPath();
            context.arc(hoverData.x, hoverData.y, nodeRadius + 4, 0, Math.PI * 2);
            context.strokeStyle = hoverData.color || "#6366f1";
            context.lineWidth = 2;
            context.globalAlpha = 0.5;
            context.stroke();
            context.globalAlpha = 1;
          },
          minCameraRatio: 0.002,
          maxCameraRatio: 50,
          hideEdgesOnMove: true,
          zIndex: true,
          // Click-selection highlight: dim everything but the selected node,
          // its neighbors, and the edges connecting them — the SAME shape as
          // OSS's useSigma.ts `nodeReducer`/`edgeReducer` "currentSelected"
          // branch (MUON has no search/blast-radius state on this page, so
          // only that branch applies). `selectedRef` (not React state) so the
          // reducer always reads the latest pick without recreating sigma.
          nodeReducer: (node, nodeData) => {
            const sel = selectedRef.current;
            if (!sel) return nodeData;
            const res = { ...nodeData };
            if (node === sel) {
              res.size = nodeData.size * 1.8;
              res.zIndex = 2;
              res.highlighted = true;
              return res;
            }
            const isNeighbor =
              graph.hasEdge(node, sel) || graph.hasEdge(sel, node);
            if (isNeighbor) {
              res.size = nodeData.size * 1.3;
              res.zIndex = 1;
              return res;
            }
            res.color = dimColor(nodeData.color, 0.3);
            res.size = nodeData.size * 0.6;
            res.zIndex = 0;
            return res;
          },
          edgeReducer: (edge, edgeData) => {
            const sel = selectedRef.current;
            if (!sel) return edgeData;
            const res = { ...edgeData };
            const [source, target] = graph.extremities(edge);
            const isConnected = source === sel || target === sel;
            if (isConnected) {
              res.color = brightenColor(edgeData.color, 1.5);
              res.size = Math.max(2, edgeData.size * 3);
              res.zIndex = 2;
            } else {
              res.color = dimColor(edgeData.color, 0.15);
              res.size = Math.max(0.3, edgeData.size * 0.4);
              res.zIndex = 0;
            }
            return res;
          },
        }
      );
      sigmaRef.current = sigma;

      sigma.on("clickNode", ({ node }) => {
        const a = graph.getNodeAttributes(node);
        selectedRef.current = node;
        setSelected({
          id: node,
          label: a.label,
          nodeType: a.nodeType,
          filePath: a.filePath,
          startLine: a.startLine,
          endLine: a.endLine,
        });
        sigma.refresh();
      });
      sigma.on("clickStage", () => {
        selectedRef.current = null;
        setSelected(null);
        sigma.refresh();
      });

      // Incremental force layout on rAF. Auto-stops when the iteration budget
      // ends (~a few seconds at 60fps) — use Pause / Continue to steer it.
      layoutGraphRef.current = graph;
      layoutSettingsRef.current = forceAtlas2.inferSettings(graph);
      layoutDoneRef.current = 0;
      startLayout();
    }

    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeRepoPath, teardown, reloadNonce, startLayout]);

  const zoomIn = useCallback(() => {
    sigmaRef.current?.getCamera().animatedZoom({ duration: 200 });
  }, []);
  const zoomOut = useCallback(() => {
    sigmaRef.current?.getCamera().animatedUnzoom({ duration: 200 });
  }, []);
  const fit = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 300 });
  }, []);

  if (!open) return null;

  return (
    <div
      className="graph-workspace"
      role="region"
      aria-label="GitNexus knowledge graph"
    >
      <div className="graph-masthead">
        <div className="graph-title">
          <span className="graph-title-mark">◆</span>
          <strong>Knowledge Graph</strong>
          {meta ? (
            <span className="graph-count">
              {meta.nodes.toLocaleString()} symbols ·{" "}
              {meta.edges.toLocaleString()} relationships
              {meta.truncated ? " · capped for display" : ""}
            </span>
          ) : null}
        </div>
        <div className="graph-actions">
          {phase === "ready" ? (
            <>
              <button className="graph-btn" onClick={zoomOut} title="Zoom out">
                −
              </button>
              <button className="graph-btn" onClick={zoomIn} title="Zoom in">
                +
              </button>
              <button className="graph-btn" onClick={fit} title="Fit to view">
                Fit
              </button>
              <button
                aria-pressed={layoutRunning}
                className="graph-btn"
                onClick={toggleLayout}
                title={
                  layoutRunning
                    ? "Pause the force layout (positions stay)"
                    : "Continue the force layout for another settling pass"
                }
                type="button"
              >
                {layoutRunning ? "Pause layout" : "Continue layout"}
              </button>
              <button
                className="graph-btn"
                // Say what it does NOT do. Refresh re-reads the same store; a
                // graph that is stale or broken comes back identically stale or
                // broken, and the operator concludes MUON is wedged. Re-index
                // is the button that changes the answer.
                title="Re-read the local graph store (does not re-index)"
                onClick={() => {
                  forceReloadRef.current = true;
                  void window.muon
                    .clearGitnexusGraphCache(activeRepoPath)
                    .finally(() => setReloadNonce((n) => n + 1));
                }}
              >
                Refresh
              </button>
            </>
          ) : null}
          {/* OUTSIDE the ready guard on purpose: the operator who most needs to
              re-index is the one staring at an empty or failed graph, which is
              exactly when the other controls are not rendered. */}
          {reindexNote ? (
            <span className="graph-reindex-note" role="status">
              {reindexNote}
            </span>
          ) : null}
          <button
            className="graph-btn"
            title={reindexTitle}
            disabled={
              reindexing ||
              indexPhase === "indexing" ||
              indexReason === "cli-missing" ||
              indexReason === "no-repo"
            }
            onClick={requestReindex}
          >
            {reindexing || indexPhase === "indexing"
              ? "Re-indexing…"
              : "Re-index"}
          </button>
          <button className="graph-btn graph-close" onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </div>
      </div>

      {showTabs ? (
        <GraphRepoTabs
          repos={repos}
          activePath={activeRepoPath}
          onSelect={setManualRepoPath}
        />
      ) : null}

      <div className="graph-body">
        {phase === "loading" ? (
          <div className="graph-status">Reading the local graph…</div>
        ) : null}
        {phase === "error" ? (
          <div className="graph-status graph-status-error">
            {error ?? "The local graph could not be read."}
          </div>
        ) : null}

        <div
          className="graph-canvas"
          ref={containerRef}
          style={{ visibility: phase === "ready" ? "visible" : "hidden" }}
        />

        {phase === "ready" && (labels.length > 0 || edgeTypes.length > 0) ? (
          <div className="graph-legend" aria-label="Graph legend">
            {labels.length > 0 ? (
              <div className="graph-legend-group">
                <span className="graph-legend-head">Nodes</span>
                {labels.map((l) => (
                  <span className="graph-legend-item" key={`n-${l}`}>
                    <span
                      className="graph-legend-swatch"
                      style={{ background: nodeColor(l) }}
                    />
                    {l}
                  </span>
                ))}
              </div>
            ) : null}
            {edgeTypes.length > 0 ? (
              <div className="graph-legend-group">
                <span className="graph-legend-head">Edges</span>
                {edgeTypes.map((t) => (
                  <span className="graph-legend-item" key={`e-${t}`}>
                    <span
                      className="graph-legend-line"
                      style={{ background: edgeColor(t) }}
                    />
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {selected ? (
          <div className="graph-detail" role="status">
            <button
              className="graph-detail-close"
              onClick={() => setSelected(null)}
              title="Dismiss"
            >
              ×
            </button>
            <span className="graph-detail-type" style={{ color: nodeColor(selected.nodeType) }}>
              {selected.nodeType}
            </span>
            <strong className="graph-detail-name">{selected.label}</strong>
            {selected.filePath ? (
              <span className="graph-detail-path">
                {selected.filePath}
                {selected.startLine
                  ? `:${selected.startLine}${
                      selected.endLine && selected.endLine !== selected.startLine
                        ? `–${selected.endLine}`
                        : ""
                    }`
                  : ""}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
