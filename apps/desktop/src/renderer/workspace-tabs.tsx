import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { vendorShortLabel } from "@muon/client/vendors";
import type { SubagentTab } from "../lib/subagent-tabs.js";
import { agentCodename, agentCodenames } from "../lib/agent-codename.js";
import { VendorIcon } from "./vendor-icon.js";
import {
  paneStatusLabel,
  resolvePaneDisplayStatus,
  type PaneDisplayStatus,
} from "../lib/pane-status.js";

type Props = {
  /** "chat" (the mission chat itself), a `panel:` tab id, or a subagent
   *  tab's jobId. */
  activeId: "chat" | string;
  /** Task #130 — the open Memory/Evidence workspace tabs (panelTabId-keyed,
   *  see workspace-panels.ts), rendered AFTER "Mission chat" and BEFORE the
   *  jobId subagent tabs below. A human-driven, uncapped set — never subject
   *  to SUBAGENT_TAB_CAP or the subagent auto-open/close reducer. */
  panelTabs: Array<{ id: string; label: string }>;
  /** Task #124 — subagent tabs, jobId-keyed. Excludes the orchestrator's own
   *  job (that IS the mission chat "chat" tab) — see selectSubagentJobs. */
  tabs: SubagentTab[];
  onSelect: (id: "chat" | string) => void;
  /** Called with a panel tab id, a terminal tab id, or a jobId — the caller
   *  (app.tsx) branches on the id shape to route to the right close path. */
  onClose: (id: string) => void;
  /** The human's own interactive terminal tabs (vendor CLIs + shells),
   *  session-id-keyed, rendered AFTER the subagent tabs. Each is a real pty
   *  in this chat's workspace; closing one kills it.
   *  ROADMAP T2 — `status` is optional so a caller with no activity tracking
   *  wired up (older callers, and this file's own pre-T2 tests) still renders
   *  a plain tab with no dot, exactly as before. */
  terminalTabs?: Array<{
    id: string;
    label: string;
    kind: string;
    status?: PaneDisplayStatus;
    /** ROADMAP P7 — this tab is a runtime-registered CUSTOM agent: terminal-
     *  tab-only, no role, no dispatch, no brain/MCP access. Renders a
     *  persistent "Ungoverned" badge so the tab never reads as an ordinary
     *  vendor session. */
    ungoverned?: boolean;
  }>;
  /**
   * The vendor tab bar at the end of the strip — the primary terminal entry
   * point. One click opens that vendor's REAL interactive CLI (or a plain
   * shell) as its own named tab; a second click opens a numbered second
   * session. Entries come from buildTerminalVendorMenu (registry + readiness),
   * so a vendor with no spawnable CLI never gets a button.
   *
   * ROADMAP P7 — the SAME array also carries runtime-registered custom-agent
   * buttons, appended after the vendor entries by the caller
   * (`buildCustomAgentMenu`), each with `ungoverned: true`. One array, one
   * render path: a custom agent's button and its resulting tab are visually
   * identical in every way EXCEPT the badge, so the strip never implies a
   * second class of first-class citizen.
   */
  vendorMenu?: Array<{
    kind: string;
    label: string;
    enabled: boolean;
    detail: string | null;
    ungoverned?: boolean;
  }>;
  onOpenVendorTerminal?: (kind: string) => void;
  /** Job ids the operator has opened (TODO 3.15 seen-gating for `review`). */
  seenJobIds?: ReadonlySet<string>;
  /** Jobs with a pending approval — `permission` is never seen-gated. */
  pendingApprovalJobIds?: ReadonlySet<string>;
};

function tabPaneStatus(
  tab: SubagentTab,
  props: Pick<Props, "seenJobIds" | "pendingApprovalJobIds">
): PaneDisplayStatus {
  return resolvePaneDisplayStatus({
    jobStatus: tab.status,
    seen: props.seenJobIds?.has(tab.jobId) ?? false,
    pendingApproval: props.pendingApprovalJobIds?.has(tab.jobId) ?? false,
  });
}

/**
 * Codename per subagent tab — DISPLAY ONLY (see agent-codename.ts). Was the
 * vendor label ("Codex", "Codex #2", …); now each dispatch shows a memorable
 * codename ("Nova", "Cipher", …) with the vendor kept visible in the tab's
 * secondary line. The codename identity is the AGENT (`tab.agentId`) so the
 * same worker reads identically in the crew tree and its pane; before an agent
 * is bound we fall back to the jobId so the tab still gets a stable name. Two
 * tabs that hash to the same pool entry are disambiguated per render (never
 * persisted); the jobId keying of the tab model is untouched.
 */
function tabLabels(tabs: SubagentTab[]): Map<string, string> {
  const sourceByJob = new Map<string, string>();
  const sourceIds: string[] = [];
  for (const tab of tabs) {
    const source = tab.agentId ?? tab.jobId;
    sourceByJob.set(tab.jobId, source);
    sourceIds.push(source);
  }
  const codenames = agentCodenames(sourceIds);
  const labels = new Map<string, string>();
  for (const tab of tabs) {
    const source = sourceByJob.get(tab.jobId)!;
    labels.set(tab.jobId, codenames.get(source) ?? agentCodename(source));
  }
  return labels;
}

/**
 * The top workspace tab strip. "Mission chat" is always first and never closes;
 * every subagent a mission has fired gets its OWN tab (task #124), keyed by
 * jobId so a reused agent slot across dispatches can never collide two
 * subagents onto one tab. Completed tabs dim (`.tab-closing`, driven by
 * `pendingCloseAt`) then auto-remove; failed/interrupted tabs never dim —
 * they stay full-strength until a human closes them (they need review).
 * `overflow-x: auto` on `.workspace-tabs` (styles.css) handles a large
 * fan-out without evicting a tab the operator might be watching.
 */
export function WorkspaceTabs(props: Props) {
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const ids = [
    "chat",
    ...props.panelTabs.map((tab) => tab.id),
    ...props.tabs.map((tab) => tab.jobId),
    ...(props.terminalTabs ?? []).map((tab) => tab.id),
  ];
  const move = (event: KeyboardEvent<HTMLButtonElement>, currentId: string) => {
    const index = ids.indexOf(currentId);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % ids.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else return;
    event.preventDefault();
    props.onSelect(ids[next]!);
  };
  const labels = tabLabels(props.tabs);

  useEffect(() => {
    const active = tablistRef.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    );
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.activeId]);

  return (
    <div
      aria-label="Open workspace tabs"
      className="workspace-tabs"
      ref={tablistRef}
      role="tablist"
    >
      <button
        aria-controls="workspace-panel-chat"
        aria-selected={props.activeId === "chat"}
        className={props.activeId === "chat" ? "active" : ""}
        id="workspace-tab-chat"
        onClick={() => props.onSelect("chat")}
        onKeyDown={(event) => move(event, "chat")}
        role="tab"
        tabIndex={props.activeId === "chat" ? 0 : -1}
      >
        Mission chat
      </button>
      {props.panelTabs.map((tab) => (
        <div className="workspace-agent-tab" key={tab.id}>
          <button
            aria-controls={`workspace-panel-${tab.id}`}
            aria-selected={props.activeId === tab.id}
            className={props.activeId === tab.id ? "active" : ""}
            id={`workspace-tab-${tab.id}`}
            onClick={() => props.onSelect(tab.id)}
            onKeyDown={(event) => move(event, tab.id)}
            role="tab"
            tabIndex={props.activeId === tab.id ? 0 : -1}
          >
            <span>{tab.label}</span>
          </button>
          <button
            aria-label={`Close ${tab.label} tab`}
            className="workspace-tab-close"
            onClick={() => props.onClose(tab.id)}
            type="button"
          >
            ×
          </button>
        </div>
      ))}
      {props.tabs.map((tab) => {
        const label =
          labels.get(tab.jobId) ?? agentCodename(tab.agentId ?? tab.jobId);
        const vendor = vendorShortLabel(tab.vendor);
        const closing = tab.pendingCloseAt !== null;
        const paneStatus = tabPaneStatus(tab, props);
        const statusText = paneStatusLabel(paneStatus);
        return (
          <div
            className={`workspace-agent-tab${closing ? " tab-closing" : ""}`}
            key={tab.jobId}
          >
            <button
              aria-controls={`workspace-panel-${tab.jobId}`}
              aria-selected={props.activeId === tab.jobId}
              aria-label={`${label} · ${vendor} ${statusText}`}
              className={props.activeId === tab.jobId ? "active" : ""}
              id={`workspace-tab-${tab.jobId}`}
              onClick={() => props.onSelect(tab.jobId)}
              onKeyDown={(event) => move(event, tab.jobId)}
              role="tab"
              tabIndex={props.activeId === tab.jobId ? 0 : -1}
            >
              <span className={`activity-dot ${paneStatus}`} aria-hidden="true" />
              <VendorIcon vendor={tab.vendor} />
              <span>{label}</span>
              <small>{vendor} · {statusText}</small>
            </button>
            <button
              aria-label={`Close ${label} tab`}
              className="workspace-tab-close"
              onClick={() => props.onClose(tab.jobId)}
              type="button"
            >
              ×
            </button>
          </div>
        );
      })}
      {(props.terminalTabs ?? []).map((tab) => {
        // T2: display-only heuristic status — see pane-status.ts and
        // terminal-activity.ts for the derivation. `undefined` (no tracker
        // wired up) renders the plain pre-T2 tab, unchanged.
        const statusText = tab.status ? paneStatusLabel(tab.status) : null;
        // ROADMAP P7 — a custom (ungoverned) agent tab is visually identical
        // to a vendor tab except for this one badge: it is never dispatchable,
        // never a coordinator, and holds no role, so it must never be
        // mistakable for a governed session at a glance.
        const ariaLabelSuffix = [statusText, tab.ungoverned ? "Ungoverned" : null]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            className={
              "workspace-agent-tab workspace-terminal-tab" +
              (tab.ungoverned ? " workspace-terminal-tab-ungoverned" : "")
            }
            key={tab.id}
          >
            <button
              aria-controls={`workspace-panel-${tab.id}`}
              aria-selected={props.activeId === tab.id}
              {...(ariaLabelSuffix
                ? { "aria-label": `${tab.label} · ${ariaLabelSuffix}` }
                : {})}
              className={props.activeId === tab.id ? "active" : ""}
              id={`workspace-tab-${tab.id}`}
              onClick={() => props.onSelect(tab.id)}
              onKeyDown={(event) => move(event, tab.id)}
              role="tab"
              tabIndex={props.activeId === tab.id ? 0 : -1}
            >
              {tab.status ? (
                <span className={`activity-dot ${tab.status}`} aria-hidden="true" />
              ) : null}
              {tab.kind !== "shell" ? <VendorIcon vendor={tab.kind} /> : null}
              <span>{tab.label}</span>
              {tab.ungoverned ? (
                <span className="workspace-tab-ungoverned-badge" title="Ungoverned — terminal-tab only, no role, no dispatch, no brain/MCP access">
                  Ungoverned
                </span>
              ) : null}
            </button>
            <button
              aria-label={`Close ${tab.label} tab`}
              className="workspace-tab-close"
              onClick={() => props.onClose(tab.id)}
              type="button"
            >
              ×
            </button>
          </div>
        );
      })}
      {props.onOpenVendorTerminal && (props.vendorMenu?.length ?? 0) > 0 ? (
        <TerminalSpawnMenu
          menu={props.vendorMenu!}
          onOpen={props.onOpenVendorTerminal}
        />
      ) : null}
    </div>
  );
}

/**
 * The strip's terminal entry point, collapsed to ONE "+" trigger. It used to
 * be a row of per-vendor buttons ("+ Claude", "+ Codex", …) which put four to
 * six permanent buttons on a strip that also carries every open tab — the
 * single loudest contributor to the strip feeling crowded. The menu keeps
 * every property the bar had: one entry per spawnable vendor plus the shell
 * (buildTerminalVendorMenu), disabled-never-hidden entries with the reason
 * now VISIBLE inline instead of hover-only, and the Ungoverned badge on
 * custom agents. Cost: one extra click to spawn.
 *
 * The popover is `position: fixed` because `.workspace-tabs` scrolls
 * (overflow hidden on the cross axis) — an absolutely-positioned child would
 * be clipped to the strip's band height.
 */
function TerminalSpawnMenu(props: {
  menu: NonNullable<Props["vendorMenu"]>;
  onOpen: (kind: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // The anchor is measured once at open; if the window reflows under an
    // open menu, closing is honest — reposition math is not worth the state.
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = popoverRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])'
    );
    items?.[0]?.focus();
  }, [open]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []
    );
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (event.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  const MENU_WIDTH = 264;
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchor({
      top: (rect?.bottom ?? 0) + 4,
      left: Math.max(
        8,
        Math.min(rect?.left ?? 0, window.innerWidth - MENU_WIDTH - 8)
      ),
    });
    setOpen(true);
  };

  return (
    <div className="workspace-terminal-vendor-bar" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Open a terminal in this workspace"
        className="workspace-tab-open-terminal workspace-terminal-spawn-trigger"
        onClick={toggle}
        ref={triggerRef}
        title="New agent or terminal session (⌘J opens your shell)"
        type="button"
      >
        +
      </button>
      {open ? (
        <div
          aria-label="Open a terminal in this workspace"
          className="workspace-terminal-spawn-menu"
          onKeyDown={moveFocus}
          ref={popoverRef}
          role="menu"
          style={anchor ? { top: anchor.top, left: anchor.left } : undefined}
        >
          {props.menu.map((entry) => (
            <button
              // Disabled-never-hidden: `aria-disabled` (not `disabled`) so the
              // entry stays focusable and its reason readable — a vendor whose
              // CLI is missing is an answer, not an absence.
              aria-disabled={entry.enabled ? undefined : true}
              aria-label={`New ${entry.label} ${
                entry.kind === "shell" ? "tab" : "session"
              }${entry.ungoverned ? " (Ungoverned)" : ""}`}
              className={
                "workspace-terminal-spawn-item" +
                (entry.ungoverned ? " workspace-terminal-spawn-item-ungoverned" : "")
              }
              key={entry.kind}
              onClick={() => {
                if (!entry.enabled) return;
                setOpen(false);
                triggerRef.current?.focus();
                props.onOpen(entry.kind);
              }}
              role="menuitem"
              title={
                entry.detail ??
                (entry.kind === "shell"
                  ? "Open your shell in this workspace (⌘J)"
                  : `Open the ${entry.label} CLI in this workspace`)
              }
              type="button"
            >
              <span className="workspace-terminal-spawn-item-main">
                {entry.kind !== "shell" ? (
                  <VendorIcon vendor={entry.kind} />
                ) : null}
                <span>{entry.label}</span>
                {entry.ungoverned ? (
                  <span
                    className="workspace-tab-ungoverned-badge"
                    aria-hidden="true"
                  >
                    Ungoverned
                  </span>
                ) : null}
              </span>
              {!entry.enabled && entry.detail ? (
                <small className="workspace-terminal-spawn-item-detail">
                  {entry.detail}
                </small>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
