import { buildMemoryDecision, type MemoryAction } from "@muon/client";
import { buildApprovalDecision } from "@muon/client";
import type { MuonApiClient } from "@muon/client";
import type { BrainSnapshot } from "../lib/brain-store.js";
import { Shell } from "./shell.js";
import { sidebarFromSnapshot, tabsFromState } from "./from-snapshot.js";
import { buildInboxRows } from "./inbox.js";
import { SessionManager } from "./session-manager.js";
import { PtyPane } from "./pty-pane.js";
import { GovernedSession } from "./governed-session.js";
import { GovernedPane } from "./governed-pane.js";
import { FrozenPane } from "./frozen-pane.js";
import { MemoryPane, type MemoryPaneState } from "./memory-pane.js";
import { openReview, ReviewPane, type ReviewState } from "./review-pane.js";
import {
  buildSpawnMenuState,
  resolveSpawnSelection,
  SpawnMenu,
  type SpawnMenuState,
} from "./spawn-menu.js";
import {
  intentForAction,
  routeKey,
  type ShellIntent,
  type ShellScope,
} from "./keys.js";
import { IMPLEMENTED_DESTINATIONS, Nav, navDestinationAt } from "./nav.js";
import { HelpPane } from "./help-pane.js";
import {
  noteReveal,
  topSurface,
  type RevealSurface,
  type Surface,
  type SurfaceFlags,
} from "./surfaces.js";
import { buildCrewLanes, CrewDrawer } from "./crew-drawer.js";
import { buildTimelineRows, TimelinePane } from "./timeline-pane.js";
import {
  buildSettingsRows,
  SettingsPane,
  selectedVendor,
  type SettingsState,
} from "./settings-pane.js";
import { buildGateBand, renderGateBand } from "./gate-band.js";
import { normalizeKeys } from "./normalize-keys.js";
import { firstKeystrokeLength } from "./key-stream.js";
import { DESK_PREFIX } from "./keymap.js";
import {
  childWantsMouse,
  encodeMouse,
  isFocusReport,
  isMouseReport,
  parseMouse,
  splitMouseReports,
} from "./mouse.js";
import { MIN_SIDEBAR_TOTAL } from "./shell.js";
import { DeskSidebar, type DeskSidebarState } from "./desk-sidebar.js";
import {
  Composer,
  composerChoice,
  composerMove,
  composerType,
  openComposer,
  openComposerPicker,
  type ComposerState,
} from "./composer.js";
import {
  actionLabel,
  buildActionForm,
  executeAction,
  EXECUTABLE_ACTIONS,
  type ActionContext,
} from "../lib/actions.js";
import { NAV_DESTINATIONS, type NavDestination } from "@muon/client";
import type { RestoreEntry } from "./restore-snapshot.js";

/**
 * THE DESK — every piece of mutable state and every intent handler, in one
 * class with its dependencies INJECTED.
 *
 * This exists because of a sentence in the fourth adversarial review:
 * *"making routing pure moved the tested boundary to EXCLUDE every defect
 * above."* That was exactly right. `keys.ts` made the routing RULES testable
 * and the components were already well covered — but the thing that WIRES
 * them was a 600-line top-level script that no test could import, and every
 * CRITICAL and HIGH finding lived there:
 *
 *  - the memory pane called the wrong API route and 400'd on every press,
 *    while all fifteen of its tests passed;
 *  - the inbox's call site never filtered to pending approvals;
 *  - the `scopes` literal was frozen all-false, so the dual-highlight bug was
 *    live while a commit claimed it was fixed by construction;
 *  - a write's busy flag was cleared by an unrelated re-read;
 *  - `esc` during a write re-opened the pane over whatever the human moved to.
 *
 * None of those are component bugs and none were catchable. They are here
 * now, behind an injected `client` and an injected `geometry`, so a test can
 * drive `handleKey` against a stub brain and assert on real state.
 *
 * The engine is NOT a dependency: this class never touches the terminal. It
 * renders into a `Shell` and calls `onChange` when something moved; the entry
 * decides what a repaint means.
 */

export type DeskDeps = {
  readonly client: MuonApiClient;
  readonly getSnapshot: () => BrainSnapshot;
  /** The pane's geometry — terminal size minus the chrome. */
  readonly geometry: () => { cols: number; rows: number };
  /** Terminal rows, for the shell's own row budget. */
  readonly terminalRows: () => number;
  readonly cwd: () => string;
  /** Current git branch for the SPACES row; "—" when unknown. */
  readonly branch?: () => string;
  /** Terminal width, so chrome can refuse rather than silently not draw. */
  readonly terminalColumns?: () => number;
  /** The last quit's screens, already consumed from disk (ADR-0047). */
  readonly frozen: RestoreEntry[];
  /** Called whenever anything changed and the frame should be redrawn. */
  readonly onChange: () => void;
  /** Called when the human asked to leave. */
  readonly onQuit: () => void;
  /**
   * Force a brain re-read. REQUIRED after a governed decision: without it the
   * answered approval sits on the rail until the next 2s poll and a second
   * press sends a DUPLICATE governed write, which 409s and then tells the
   * human "could not approve" about a request they just approved. The
   * extraction dropped this call and the commit claimed no behaviour change.
   */
  readonly refresh?: () => Promise<unknown> | void;
};

/**
 * Centre reveals that Tab LEAVES on its way to the next zone.
 *
 * Not `spawn-menu` (a choice in progress) and not the gates (which never reach
 * the zone cycle — the router serves them first).
 */
const ZONE_BLOCKING_SURFACES = [
  "help",
  "destinations",
  "timeline",
  "settings",
] as const satisfies readonly Surface[];

/**
 * The strip id of a restored session. Prefixed so a click can tell a corpse
 * from a live tab without a second lookup, and so the two id spaces can never
 * collide (a session id is a cuid).
 */
const FROZEN_TAB_PREFIX = "frozen:";
function frozenTabId(index: number): string {
  return `${FROZEN_TAB_PREFIX}${index}`;
}
/** The index a frozen tab id names, or null when the id is a live tab. */
export function frozenTabIndex(id: string): number | null {
  if (!id.startsWith(FROZEN_TAB_PREFIX)) return null;
  const index = Number(id.slice(FROZEN_TAB_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export class Desk {
  readonly shell: Shell;
  readonly sessions: SessionManager;

  private readonly deps: DeskDeps;
  private crewCursor = 0;
  private inboxCursor = 0;
  private inboxFocused = false;
  private spawnMenu: SpawnMenuState | null = null;
  private review: ReviewState | null = null;
  private memory: MemoryPaneState | null = null;
  private governed: GovernedSession | null = null;
  private frozen: RestoreEntry[];
  /**
   * WHICH RESTORED SESSION THE HUMAN IS LOOKING AT, or `null` for a live tab.
   *
   * This used to be a plain index and `centreKind()` read it as a FALLBACK —
   * "the active session, or else a corpse". So closing a live tab did not
   * leave you on an empty desk, it RESURRECTED whichever corpse happened to be
   * next: quit MUON with codex and claude open, start a new claude, close it,
   * and the old claude reappeared as if it had been running. A restored
   * session is a TAB the human chooses, not a layer that surfaces underneath
   * whatever they just closed.
   */
  private frozenIndex: number | null = null;
  private navOpen = false;
  /**
   * REVEALED, NEVER DEFAULT (founder law 2 and 3). First paint is the
   * terminal plus three lines of chrome; the sidebar is a compact session
   * list and crew is a drawer, and both start closed. A desk that opens with
   * Spaces + Crew + Inbox visible is a dashboard, not a terminal.
   */
  private sidebarOpen = false;
  private crewOpen = false;
  private helpOpen = false;
  /**
   * The reveal STACK, most recent last. `Esc` pops this, so popping really is
   * the inverse of the order a human opened things in — the docstring used to
   * claim that while the code used a FIXED precedence, so opening crew then
   * the inbox and pressing Esc closed the crew drawer, not the inbox. A test
   * caught it. Gates (review/composer/memory) are not on the stack: they are
   * always innermost by definition and pop first.
   */
  private revealStack: RevealSurface[] = [];
  /** True for exactly one keystroke after the desk prefix. */
  private prefixArmed = false;
  /** Which pane of the active tab has the keyboard: 0 = main, 1 = split. */
  private focusedPane = 0;
  /** Last laid-out geometry — see `resizeIfGeometryChanged`. */
  private geometryKey = "";
  /** Bumped on every governed attach — see `resizeIfGeometryChanged`. */
  private governedSeq = 0;
  /**
   * A press landed on MUON's chrome, so the rest of that gesture is MUON's
   * too — the release, and any drag between them. Cleared by the release.
   */
  private chromeHoldsMouse = false;
  /** The composer — the desk's way to CREATE work, not only watch it. */
  private composer: ComposerState | null = null;
  private navCursor = 0;
  private destination: NavDestination = "mission";
  /**
   * TIMELINE — the ledger, in order. Held as state rather than derived per
   * frame because it carries a CURSOR: a human scrolling an audit trail must
   * not have their place reset by the 2s brain poll landing underneath them.
   * The rows themselves are rebuilt from the snapshot on every render.
   */
  private timeline: { cursor: number } | null = null;
  /** SETTINGS — read-only, cursor over the vendor rows only. */
  private settings: { cursor: number } | null = null;

  /** One page of the library — matches the pane's own viewport arithmetic. */
  private static readonly MEMORY_PAGE = 200;

  constructor(deps: DeskDeps) {
    this.deps = deps;
    this.frozen = deps.frozen;
    // First paint lands on the first restored session, as it always has — the
    // difference is that this is now a SELECTION the human can leave and come
    // back to, not a floor they fall through to.
    this.frozenIndex = deps.frozen.length > 0 ? 0 : null;
    // GEOMETRY COMES FROM THE LAYOUT, not from a guess about it. `deps.geometry`
    // is the fallback for callers that have no terminal width to give (tests,
    // and any surface constructing a Desk headlessly); when the width IS known
    // the shell answers with the numbers it actually lays out with.
    this.sessions = new SessionManager(() => this.paneGeometry());
    this.shell = new Shell(this.shellState());
    this.sessions.subscribe(() => {
      this.syncCentre();
      this.deps.onChange();
    });
    this.syncCentre();
  }

  /**
   * FIRST PAINT MUST NOT BE EMPTY. A desk that opens on a placeholder and a
   * footer full of chords is a bug, not a state: the founder saw exactly that
   * and it is the reason this method exists. Open the picker so the very
   * first keystroke starts real work.
   *
   * The picker rather than an auto-spawn, deliberately: auto-starting a
   * vendor CLI would spend the human's tokens without being asked. Showing
   * the choice costs one keystroke and assumes nothing.
   */
  bootstrap(): void {
    if (this.sessions.topLevel().length > 0) return;
    // A RESTORED SESSION IS CONTENT. Opening the picker over a corpse would
    // hide the last quit's screen behind a menu — the desk is not empty, it
    // is showing you what you left. (Caught by the compiled-entry smoke test,
    // which is exactly the class of regression it exists for.)
    if (this.frozen.length > 0) return;
    this.spawnMenu = buildSpawnMenuState(
      this.deps.getSnapshot().readiness ?? null
    );
    this.syncCentre();
  }

  // ── state derivation ────────────────────────────────────────────────────

  /**
   * The scopes that take the cursor OFF the crew rail. Derived, never a
   * frozen literal: the first version was `{paletteOpen:false, …}` that
   * nothing ever updated, so the crew rail kept its cursor while three other
   * surfaces owned input.
   */
  private cursorScopes() {
    return {
      paletteOpen: this.spawnMenu !== null,
      formOpen: this.inboxFocused,
      reviewOpen: this.review !== null,
      memoryOpen: this.memory !== null,
    };
  }

  private shellState() {
    return {
      sidebar: sidebarFromSnapshot(
        this.deps.getSnapshot(),
        this.crewCursor,
        this.cursorScopes(),
        this.deps.cwd()
      ),
      tabs: tabsFromState(
        [
          { id: "chat", title: "chat" },
          // RESTORED SESSIONS ARE TABS. They used to be invisible — a stack
          // behind the desk that surfaced when you closed something — so a
          // human could not see what had been restored, could not choose
          // between two of them, and met one by surprise. A tab you can see is
          // a tab you can manage.
          ...this.frozen.map((entry, index) => ({
            id: frozenTabId(index),
            title: `${entry.label} ⏹`,
          })),
          // TOP-LEVEL ONLY. A split is a PANE of its parent tab, not a tab of
          // its own — listing it in the strip made one session look like two
          // and gave the human a tab they could never focus.
          ...this.sessions
            .topLevel()
            .map((tab) => ({ id: tab.id, title: tab.label })),
        ],
        this.frozenIndex !== null
          ? frozenTabId(this.frozenIndex)
          : this.sessions.active()?.id ?? "chat"
      ),
      rows: this.deps.terminalRows(),
    };
  }

  /** Record (or forget) a reveal so `Esc` pops in the order things opened. */
  private noteReveal(layer: RevealSurface): void {
    this.revealStack = noteReveal(
      this.revealStack,
      layer,
      this.surfaceFlags()[layer]
    );
  }

  /**
   * Close ONE surface — the single place a surface stops being open, so
   * "what closes" can never disagree with `top()`'s "what is on top".
   */
  private closeSurface(surface: Surface | null): void {
    switch (surface) {
      case "composer":
        this.composer = null;
        return;
      case "review":
        this.review = null;
        return;
      case "memory":
        this.memory = null;
        return;
      case "help":
        this.helpOpen = false;
        break;
      case "spawn-menu":
        this.spawnMenu = null;
        break;
      case "destinations":
        this.navOpen = false;
        break;
      case "crew":
        this.crewOpen = false;
        break;
      case "timeline":
        this.timeline = null;
        break;
      case "settings":
        this.settings = null;
        break;
      case "inbox":
        this.inboxFocused = false;
        break;
      default:
        // Nothing revealed: a governed ATTACH is the last thing Esc closes,
        // because it is a VIEW rather than a surface that owns keys.
        if (this.governed) {
          this.governed.dispose();
          this.governed = null;
        }
        return;
    }
    this.revealStack = this.revealStack.filter((entry) => entry !== surface);
  }

  /**
   * Put the human on a tab, live or restored.
   *
   * ONE entry point, because the two kinds must be mutually exclusive:
   * choosing a live tab has to leave the corpse layer, or the restored pane
   * keeps winning `centreKind()` and the click appears to do nothing.
   */
  private selectTab(id: string): void {
    const frozen = frozenTabIndex(id);
    if (frozen !== null) {
      if (this.frozen[frozen]) this.frozenIndex = frozen;
      return;
    }
    this.frozenIndex = null;
    if (id !== "chat") this.sessions.activate(id);
  }

  /**
   * ctrl+b n / p across EVERY tab, restored ones included.
   *
   * A restored tab the strip shows but a chord cannot reach is a tab that
   * exists for the mouse and not the keyboard — the same advertised-but-inert
   * shape the keymap law forbids. One ordered list, one cursor.
   */
  private cycleTab(delta: 1 | -1): void {
    const ids = [
      ...this.frozen.map((_, index) => frozenTabId(index)),
      ...this.sessions.topLevel().map((tab) => tab.id),
    ];
    if (ids.length === 0) return;
    const current =
      this.frozenIndex !== null
        ? frozenTabId(this.frozenIndex)
        : this.sessions.active()?.id;
    const at = current ? ids.indexOf(current) : -1;
    const next = ids[(at + delta + ids.length) % ids.length]!;
    this.selectTab(next);
    this.deps.onChange();
  }

  /** The session whose child receives keystrokes right now. */
  private focusedSession() {
    const active = this.sessions.active();
    if (!active) return null;
    if (this.focusedPane === 1) {
      return this.sessions.splitOf(active.id)?.session ?? active.session;
    }
    return active.session;
  }

  /** Test seam: which pane owns the keyboard. */
  focusedPaneIndex(): number {
    return this.focusedPane;
  }

  /** The left rail's content — spaces, sessions, chat, session meta. */
  sidebarState(): DeskSidebarState {
    const active = this.sessions.active();
    const split = active ? this.sessions.splitOf(active.id) : null;
    const cwd = this.deps.cwd();
    return {
      spaces: [
        {
          name: cwd.replace(/\/+$/, "").split("/").pop() || cwd,
          branch: this.deps.branch?.() ?? "—",
          active: true,
          ...(this.deps.getSnapshot().health === null
            ? { note: "brain unreachable" }
            : {}),
        },
      ],
      sessions: this.sessions.topLevel().map((tab) => ({
        id: tab.id,
        label: tab.label,
        kind: tab.kind,
        active: tab.id === active?.id,
        paneCount: this.sessions.splitOf(tab.id) ? 2 : 1,
        ungoverned: tab.session.spec.ungoverned,
      })),
      chat: active ? [] : ["no session — ctrl+b t to start one"],
      info: [
        { label: "space", value: cwd.replace(/\/+$/, "").split("/").pop() || cwd },
        { label: "tab", value: active?.label ?? "—" },
        { label: "panes", value: String(split ? 2 : active ? 1 : 0) },
        {
          label: "focus",
          value: split ? (this.focusedPane === 1 ? split.label : active!.label) : active?.label ?? "—",
        },
        {
          label: "mode",
          value: active ? (active.session.spec.ungoverned ? "UNGOVERNED" : "governed") : "—",
        },
      ],
    };
  }

  /** The crew lanes, DERIVED — blocked first (see `crew-drawer.ts`). */
  crewLanes() {
    const snapshot = this.deps.getSnapshot();
    return buildCrewLanes({
      agents: snapshot.agents ?? [],
      jobs: snapshot.dispatchJobs ?? [],
      approvals: snapshot.approvals ?? [],
    });
  }

  /** The inbox rail's state, DERIVED — never a second copy of the approvals. */
  inboxState() {
    const rows = buildInboxRows(this.deps.getSnapshot().approvals ?? []);
    if (this.inboxCursor > rows.length - 1) {
      this.inboxCursor = Math.max(0, rows.length - 1);
    }
    return {
      rows,
      cursor: this.inboxCursor,
      focused: this.inboxFocused,
      questions: this.deps.getSnapshot().questions ?? [],
    };
  }

  /** Test seam and render seam: what is actually on screen right now. */
  activeDestination(): NavDestination {
    return this.destination;
  }

  /** The open/closed truth. Every precedence question reads THIS. */
  /**
   * The settings rows, rebuilt from the CURRENT snapshot every time they are
   * needed. Held nowhere: the only state settings owns is a cursor, and a
   * cached row list would go stale against a readiness probe that landed
   * underneath it.
   */
  private settingsState(): SettingsState {
    const snapshot = this.deps.getSnapshot();
    const built = buildSettingsRows({
      readiness: snapshot.readiness,
      cwd: this.deps.cwd(),
      branch: this.deps.branch?.() ?? "—",
      brainReachable: snapshot.health !== null,
      preflight: snapshot.preflight,
    });
    return {
      ...built,
      cursor: Math.min(
        this.settings?.cursor ?? 0,
        Math.max(0, built.selectable.length - 1)
      ),
    };
  }

  private surfaceFlags(): SurfaceFlags {
    return {
      composer: this.composer !== null,
      review: this.review !== null,
      memory: this.memory !== null,
      help: this.helpOpen,
      "spawn-menu": this.spawnMenu !== null,
      destinations: this.navOpen,
      crew: this.crewOpen,
      timeline: this.timeline !== null,
      settings: this.settings !== null,
      inbox: this.inboxFocused,
    };
  }

  /** The surface that owns the keyboard right now, or null for the desk. */
  top(): Surface | null {
    return topSurface(this.surfaceFlags(), this.revealStack);
  }

  centreKind():
    | "composer"
    | "crew"
    | "timeline"
    | "settings"
    | "help"
    | "nav"
    | "memory"
    | "review"
    | "spawn-menu"
    | "pty"
    | "governed"
    | "frozen"
    | "none" {
    // ONE precedence rule (`surfaces.ts`), not a fifth copy of it.
    switch (this.top()) {
      case "composer":
        return "composer";
      case "review":
        return "review";
      case "memory":
        return "memory";
      case "help":
        return "help";
      case "spawn-menu":
        return "spawn-menu";
      case "destinations":
        return "nav";
      case "crew":
        return "crew";
      case "timeline":
        return "timeline";
      case "settings":
        return "settings";
      case "inbox":
        break; // the inbox is a RAIL, not a centre pane — fall through
      default:
        break;
    }
    // SELECTION FIRST. A restored tab the human is on wins over a live session
    // in another tab, exactly as one live tab wins over another.
    if (this.frozenIndex !== null && this.frozen[this.frozenIndex]) {
      return "frozen";
    }
    if (this.sessions.active()) return "pty";
    if (this.governed) return "governed";
    return "none";
  }

  memoryState(): MemoryPaneState | null {
    return this.memory;
  }

  reviewState(): ReviewState | null {
    return this.review;
  }

  private syncCentre(): void {
    // NEVER DRAW A TAB STRIP OVER A VOID.
    //
    // The founder's screenshot: a strip reading `chat  OpenCode ⏹  +` above an
    // entirely black screen. Nothing was broken in the renderer — the desk had
    // no live sessions left, and `frozenIndex` was null because OPENING a
    // session clears the corpse selection and nothing ever put it back. So
    // `centreKind()` walked past a frozen tab it could see, found no live
    // session, and returned "none", which draws nothing at all.
    //
    // A strip that advertises a tab the centre refuses to draw is the
    // advertised-but-inert shape in another costume. This is a SELECTION
    // default, not a new authority: it picks an existing tab when the human
    // has no other tab to be on, and it sits in `syncCentre` rather than in
    // the close handler because a session can also end on its own — a vendor
    // CLI quitting must not leave the same void.
    if (
      this.frozenIndex === null &&
      this.frozen.length > 0 &&
      this.sessions.topLevel().length === 0
    ) {
      this.frozenIndex = 0;
    }
    switch (this.centreKind()) {
      case "composer":
        this.shell.setCentre(new Composer(this.composer!));
        break;
      case "timeline": {
        const built = buildTimelineRows(
          this.deps.getSnapshot().events ?? [],
          Date.now()
        );
        this.shell.setCentre(
          new TimelinePane(
            { ...built, cursor: Math.min(this.timeline!.cursor, Math.max(0, built.rows.length - 1)) },
            this.deps.terminalRows() - 5
          )
        );
        break;
      }
      case "settings":
        this.shell.setCentre(new SettingsPane(this.settingsState()));
        break;
      case "crew":
        this.shell.setCentre(
          new CrewDrawer({
            lanes: this.crewLanes(),
            cursor: this.crewCursor,
            focused: true,
          })
        );
        break;
      case "help":
        this.shell.setCentre(new HelpPane());
        break;
      case "nav":
        this.shell.setCentre(
          new Nav({
            active: this.destination,
            cursor: this.navCursor,
            focused: true,
            // PENDING APPROVALS, not folded rows. The rail folds same-job
            // siblings into one row for readability; a BADGE that inherits
            // that fold says "1" when five decisions are waiting. The badge
            // counts decisions, the rail groups them.
            pendingDecisions: (this.deps.getSnapshot().approvals ?? []).filter(
              (approval) => approval.status === "pending"
            ).length,
            crewActive: (this.deps.getSnapshot().agents ?? []).some(
              (agent) => agent.status === "working"
            ),
            rows: Math.max(4, this.deps.terminalRows() - 2),
          })
        );
        break;
      case "memory":
        this.shell.setCentre(new MemoryPane(this.memory!));
        break;
      case "review":
        this.shell.setCentre(new ReviewPane(this.review!));
        break;
      case "spawn-menu":
        // REBUILT AND WRITTEN BACK. The first attempt rebuilt only the
        // RENDERED component, so the row visibly said "codex — not installed"
        // while Enter still resolved against the state captured when the menu
        // opened and spawned it anyway: strictly more deceptive than the bug
        // it replaced. The decision path and the display must read the same
        // object. The first version wrapped the state captured when the menu
        // OPENED, so the boot picker — built before the brain had ever
        // answered — permanently showed every vendor enabled and permanently
        // warned "readiness still loading", even once readiness said a CLI
        // was missing. Choosing then spawned a pane that died as a bare exit
        // code: exactly what that warning exists to prevent.
        this.spawnMenu = {
          ...buildSpawnMenuState(
            this.deps.getSnapshot().readiness ?? null,
            this.spawnMenu!.cursor
          ),
          ...(this.spawnMenu!.intoSplitOf === undefined
            ? {}
            : { intoSplitOf: this.spawnMenu!.intoSplitOf }),
        };
        this.shell.setCentre(new SpawnMenu(this.spawnMenu));
        break;
      case "pty": {
        const active = this.sessions.active()!;
        const split = this.sessions.splitOf(active.id);
        const focused = split ? this.focusedPane : 0;
        // Only the pane that takes the keystrokes draws a cursor — see
        // `PtyPane.focused`. A split with two carets says the keyboard is in
        // two places at once, which is a lie the human has to resolve.
        const panes = split
          ? [
              new PtyPane(active.session, { focused: focused === 0 }),
              new PtyPane(split.session, { focused: focused === 1 }),
            ]
          : [new PtyPane(active.session, { focused: true })];
        this.shell.setPanes(panes, focused);
        break;
      }
      case "governed":
        this.shell.setCentre(new GovernedPane(this.governed!));
        break;
      case "frozen":
        this.shell.setCentre(new FrozenPane(this.frozen[this.frozenIndex!]!));
        break;
      case "none":
        this.shell.setCentre(null);
        break;
    }
  }

  render(): void {
    // RE-DERIVE THE CENTRE TOO. `render` used to update only the frame and
    // the rail, so a Nav built at construction kept its pending count and its
    // crew dot forever: every brain poll refreshed the inbox and left the
    // badge frozen, and the two disagreed from the next tick onward.
    this.syncCentre();
    this.shell.update(this.shellState());
    // TERMINAL IS THE HERO. The rails are attached ONLY when revealed — the
    // frame's default is chrome-minimal, and a rail that is always mounted is
    // a dashboard by another name.
    this.shell.setInbox(this.inboxFocused ? this.inboxState() : null);
    this.shell.setSidebarVisible(this.sidebarOpen);
    this.shell.setDeskSidebar(new DeskSidebar(this.sidebarState()));
    // THE GATE ARRIVES. Derived every paint from the same pending-only
    // source as the rail and the badge, so it cannot disagree with them, and
    // it appears the moment an agent blocks rather than when a human thinks
    // to look. Suppressed only while the review it would announce is already
    // open — announcing what is on screen is noise.
    const gate =
      this.review === null
        ? buildGateBand(this.deps.getSnapshot().approvals ?? [])
        : null;
    this.shell.setGateBand(
      gate ? renderGateBand(gate, this.deps.terminalRows() * 4) : null
    );
    // LAST, because it measures what the lines above just decided.
    this.resizeIfGeometryChanged();
  }

  /**
   * Re-size the children when the LAYOUT changed — which is a wider class than
   * the session set.
   *
   * `resize()` originally had one caller, just after a split opened, so the
   * reverse never happened: closing a half left the survivor's child believing
   * it still owned half a centre. The first fix hooked the SessionManager
   * subscription, and that was the wrong trigger twice over. Too narrow —
   * `ctrl+b s` and the inbox move `centreWidth` by tens of columns without
   * touching a single session, and the child kept the old width until the
   * human resized the terminal by hand. And too broad — that subscription also
   * fires on every chunk of child OUTPUT, so geometry was recomputed per byte
   * for a layout that cannot have changed.
   *
   * Rendering is the honest moment: it is exactly when the frame is decided,
   * and it happens after every one of those causes.
   *
   * The key is taken from the SHELL rather than reconstructed from the desk's
   * own flags. A hand-built key over `sidebarOpen`/`inboxFocused`/gate/width
   * would be a second copy of `layout()`'s inputs, and the next input added to
   * one and not the other is a silent stale-width bug — this codebase's most
   * repeated shape. This costs one `layout()` per paint and cannot drift.
   */
  private resizeIfGeometryChanged(): void {
    const width = this.deps.terminalColumns?.();
    if (width === undefined) return;
    const centre = this.shell.paneViewportAt(width, 0, 1);
    // The split SHAPE matters too: the same centre divides differently once a
    // tab gains or loses a second pane.
    const shape = this.sessions
      .topLevel()
      .map((tab) => (this.sessions.splitOf(tab.id) ? `${tab.id}+` : tab.id))
      .join(",");
    // A governed ATTACH changes neither the centre nor the pty shape, and it
    // constructs its session from the FALLBACK terminal geometry rather than
    // the pane viewport — so without this it kept the terminal's width until
    // some unrelated layout change corrected it. Counted rather than flagged:
    // detaching and attaching again is a new session that also needs sizing,
    // and a boolean cannot tell those apart.
    const key = `${centre.cols}x${centre.rows}|${shape}|g${this.governedSeq}`;
    if (key === this.geometryKey) return;
    this.geometryKey = key;
    this.resize();
  }

  /** Test seam: what chrome is actually revealed right now. */
  revealed(): { sidebar: boolean; crew: boolean; inbox: boolean; help: boolean } {
    return {
      sidebar: this.sidebarOpen,
      crew: this.crewOpen,
      inbox: this.inboxFocused,
      help: this.helpOpen,
    };
  }

  prefixIsArmed(): boolean {
    return this.prefixArmed;
  }

  /**
   * What the focused pane's child is told it has.
   *
   * Asks the SHELL, which computes it from the same state it lays out with —
   * so a hidden sidebar gives the child its columns back, and a split gives
   * each half its real width. The injected `geometry` remains the answer when
   * no terminal width is available.
   */
  paneGeometry(): { cols: number; rows: number } {
    const width = this.deps.terminalColumns?.();
    return width === undefined
      ? this.deps.geometry()
      : this.shell.paneViewport(width);
  }

  /** F16 — the child's geometry follows the pane. */
  resize(): void {
    const { cols, rows } = this.paneGeometry();
    // EACH HALF GETS ITS OWN WIDTH. The two halves of an odd centre differ by
    // a column, and resizing both to the left one left the right child
    // rendering into a dead or wrapped edge.
    const width = this.deps.terminalColumns?.();
    // TOP-LEVEL only: a split child is resized as its parent's right half.
    // Iterating every session re-resized that child to the LEFT width on its
    // own pass, undoing the fix a line earlier.
    for (const tab of this.sessions.topLevel()) {
      const split = this.sessions.splitOf(tab.id);
      if (width === undefined) {
        tab.session.resize(cols, rows);
        continue;
      }
      if (split === null) {
        // `1` EXPLICITLY, for the same reason the split branch below passes
        // `2`: this tab is not split, whether or not the shell is currently
        // drawing two panes. `paneGeometry()` defaults to `shell.panes.length`,
        // so sizing an unsplit tab through it read the layout still on screen
        // — and closing one half of a split made the SURVIVOR 49 columns of a
        // 100-column centre, narrower than the 50 it had as a half. A tab's
        // geometry follows the tab, never the frame it is being measured in.
        const only = this.shell.paneViewportAt(width, 0, 1);
        tab.session.resize(only.cols, only.rows);
        continue;
      }
      // `2` explicitly: this tab IS split, whether or not it is the one on
      // screen. Reading the shell's pane count would size a background split
      // tab as if it owned the whole centre.
      const left = this.shell.paneViewportAt(width, 0, 2);
      const right = this.shell.paneViewportAt(width, 1, 2);
      tab.session.resize(left.cols, left.rows);
      split.session.resize(right.cols, right.rows);
    }
    this.governed?.resize(cols, rows);
  }

  // ── input ───────────────────────────────────────────────────────────────

  /**
   * Route a keypress and execute the resulting intent.
   *
   * NORMALIZED FIRST. The host may be speaking the kitty keyboard protocol or
   * xterm's modifyOtherKeys — modern terminals say yes to the engine's
   * startup query — in which case ctrl+q arrives as `ESC[113;5u`, not 0x11.
   * Translating here means the router stays a pure byte-matcher AND the child
   * receives bytes it understands, which is the same fix twice.
   */
  /**
   * The router's view of the desk right now.
   *
   * Extracted so `handleKey` and `childTakesKey` cannot answer the same
   * question differently. They did not, once, and that is the point: a scope
   * copied into a second call site drifts the first time a field is added to
   * one of them, and the field that drifts is always an authority field.
   */
  private scope(): ShellScope {
    return {
      reviewOpen: this.review !== null,
      reviewApprovable: this.review?.review.approvable ?? false,
      reviewResolving: this.review?.resolving ?? false,
      memoryOpen: this.memory !== null,
      memoryBusy: this.memory?.busy ?? false,
      helpOpen: this.helpOpen,
      navOpen: this.navOpen,
      spawnMenuOpen: this.spawnMenu !== null,
      crewOpen: this.crewOpen,
      timelineOpen: this.timeline !== null,
      settingsOpen: this.settings !== null,
      sidebarOpen: this.sidebarOpen,
      inboxFocused: this.inboxFocused,
      inboxHasRows: this.inboxState().rows.length > 0,
      livePane: this.sessions.active() !== null,
      governedOpen: this.governed !== null,
      corpseOnScreen: this.centreKind() === "frozen",
      prefixArmed: this.prefixArmed,
      composerOpen: this.composer !== null,
      composerBusy: this.composer?.busy ?? false,
    };
  }

  /**
   * Would this exact byte be handed to a child, verbatim?
   *
   * THE P0 THIS ANSWERS. The vendored engine registers its own input listener
   * for alt-screen scrollback, and that listener runs BEFORE the focused
   * component and can end the dispatch. Its default bindings are `pageUp`,
   * `pageDown`, `home`, `end` and `ctrl+shift+up/down` — so Home, End, PgUp,
   * PgDn and ctrl+shift+arrow were consumed by a scroll view that has nothing
   * to scroll (this desk renders exactly one screen, no scrollback) and never
   * reached the vendor CLI in the pane. Line-start and line-end in someone
   * else's editor, silently dead.
   *
   * The guard is deliberately phrased over the ACTUAL data rather than over a
   * derived "is a child focused" boolean. Re-deriving the router's decision is
   * how these two would disagree; asking the router the real question cannot.
   */
  childTakesKey(raw: string): boolean {
    return routeKey(normalizeKeys(raw), this.scope()).kind === "to-child";
  }

  /**
   * A CLICK, ROUTED BY WHO DREW THE PIXEL.
   *
   * Chrome MUON drew is MUON's; everything inside a pane belongs to whatever
   * is running there. A vendor CLI may have armed mouse tracking of its own —
   * Claude Code, an editor, a pager — and stealing those clicks would break
   * the tools this desk exists to host.
   *
   * Returns true when MUON consumed the event. False means "not mine": the
   * caller forwards the original bytes to the child untouched.
   */
  handleMouse(raw: string, width: number): boolean {
    const event = parseMouse(raw);
    if (!event) return false;
    // A CLICK IS A PRESS AND A RELEASE, and they belong together. Consuming
    // only the press sent the matching release on to the child: with a
    // release-capable mouse mode armed, clicking a TAB delivered an unpaired
    // release at terminal-relative coordinates, which is a phantom gesture in
    // whatever was running there.
    if (this.chromeHoldsMouse) {
      if (event.kind === "release") this.chromeHoldsMouse = false;
      return true;
    }
    // Only a PRESS acts. Acting on release as well would fire twice per click,
    // and a drag that began in the pane must not become a chrome click when it
    // happens to end over the rail.
    if (event.kind !== "press" || event.button !== 0) return false;

    const hit = this.shell.hitTest(width, event.col, event.row);
    // A press claims the gesture only where MUON will ACT on it. `zone: "none"`
    // — the split divider, the rail divider, the empty right of the footer, the
    // gate-band row — falls through to the child, so claiming it would consume
    // the matching RELEASE while the press had already gone to the child: a
    // stuck button, which is the exact failure this flag exists to prevent, in
    // the other direction.
    if (hit.zone !== "pane" && hit.zone !== "none") this.chromeHoldsMouse = true;
    switch (hit.zone) {
      case "tab":
        if (hit.target.kind === "new-tab") {
          this.openNewTab();
          return true;
        }
        this.selectTab(hit.target.id);
        this.deps.onChange();
        return true;

      case "sidebar":
        if (hit.target.kind === "session") {
          this.selectTab(hit.target.id);
          this.deps.onChange();
          return true;
        }
        if (hit.target.kind === "new-session") {
          this.openNewTab();
          return true;
        }
        // A space row, a heading, a detail line: drawn, not clickable. Consume
        // it anyway — a click on MUON's own rail must never be typed into the
        // child as escape bytes.
        return true;

      case "pane": {
        // AN OVERLAY OWNS THE CENTRE IT IS DRAWN IN. `hitTest` answers about
        // the LAYOUT — where a pane would be — and the centre region is also
        // where settings, help, the nav, the composer and a frozen corpse are
        // drawn. Forwarding a click there sent it THROUGH the overlay to a
        // mouse-tracking child, which then acted on something the human could
        // not even see. Only a live pty pane is the child's.
        if (this.centreKind() !== "pty") return true;
        // CLICK TO FOCUS, like every windowed thing. A click in the half that
        // does not have focus was being DELIVERED to the focused child — the
        // wrong session, at coordinates past its right edge. Focusing first
        // means the next click reaches the child the human is looking at, and
        // costs one click rather than a wrong action.
        if (hit.pane !== this.focusedPane) {
          this.focusedPane = hit.pane;
          this.deps.onChange();
          return true;
        }
        return false;
      }

      case "hint": {
        // Runs the SAME intent the chord would. Synthesising the keystrokes
        // instead would re-run the prefix bookkeeping and let the two paths
        // drift; the executor is handed the action directly.
        this.prefixArmed = false;
        // Through the SAME mapper the chord uses. This used to cast the action
        // string to an intent, and the two vocabularies are not the same — so
        // `focus-other-pane` (action) never matched `focus-pane` (intent) and
        // the advertised `ctrl+b o focus` hint did nothing when clicked.
        this.execute(intentForAction(hit.action), this.inboxState().rows);
        this.deps.onChange();
        return true;
      }

      case "inbox":
        // MUON drew the inbox, so a click there is MUON's — consumed even
        // though the rows are not clickable yet. Falling through forwarded the
        // untranslated report to the vendor pane, where a click on an approval
        // fired something unrelated at unrelated coordinates.
        return true;

      default:
        // Chrome below the body: not ours.
        return false;
    }
  }

  /**
   * The same report, in the child's coordinate space.
   *
   * Unchanged when the click was not in a pane — there is nothing to
   * translate, and inventing coordinates would be worse than passing it on.
   */
  private mouseForChild(raw: string, width: number): string {
    const event = parseMouse(raw);
    if (!event) return raw;
    const hit = this.shell.hitTest(width, event.col, event.row);
    return hit.zone === "pane" ? encodeMouse(event, hit.col, hit.row) : raw;
  }

  handleKey(raw: string): ShellIntent {
    // A mouse report is not a keystroke. It reaches here because the engine
    // forwards anything the desk might want, and normalizing it as a chord
    // would type `<0;12;3M` into the pane.
    // Chrome the ENGINE armed, not the human: never the child's business.
    if (isFocusReport(raw)) return { kind: "none" };
    // A read can carry SEVERAL mouse reports (a press and its release are
    // microseconds apart). Matched as one they matched nothing and were typed
    // into the child — the same failure as the motion reports, in a costume.
    const reports = splitMouseReports(raw);
    if (reports && reports.length > 1) {
      for (const report of reports) this.handleKey(report);
      return { kind: "none" };
    }
    if (isMouseReport(raw)) {
      const width = this.deps.terminalColumns?.() ?? 100;
      if (this.handleMouse(raw, width)) return { kind: "none" };
      // THE CHILD'S OWN MODE DECIDES, exactly as it would in a real terminal.
      //
      // MUON's host terminal has all-motion tracking armed for the engine's
      // selection handling, so pointer movement produces a report continuously
      // whether or not the program in the pane wants one. A child that armed
      // nothing — which is most of them — received those as ordinary bytes and
      // TYPED them: a pane filling with `<35;46;32M<35;47;31M…` on every
      // mouse move across it.
      const event = parseMouse(raw);
      const mode = this.focusedSession()?.mouseTracking ?? "none";
      if (event && !childWantsMouse(mode, event)) return { kind: "none" };
      // The child is drawn INSIDE the frame, so it must be told where the
      // event landed in ITS coordinates, not the terminal's.
      raw = this.mouseForChild(raw, width);
    }
    return this.handleDecoded(normalizeKeys(raw));
  }

  /**
   * ONE READ CAN CARRY TWO KEYSTROKES.
   *
   * `ctrl+b` and its command key are typed a fraction of a second apart, so a
   * terminal routinely hands both over in one read — `\x02s` here, after
   * normalization collapses whatever form the protocol used. Routing that as a
   * single key finds no match and forwards BOTH bytes to the child: the chord
   * silently does nothing and an `s` appears in the pane.
   *
   * Splitting is deliberately narrow. It happens only when the prefix is armed
   * or the read begins with it, so ordinary typing and pastes still travel as
   * one write — a paste routed character by character would be slow AND would
   * let a `\x02` in its contents arm the prefix.
   *
   * The key doctor learned this lesson first and the desk did not, which meant
   * the measuring tool would have reported a chord as working while the desk
   * dropped it.
   */
  private handleDecoded(data: string): ShellIntent {
    let rest = data;
    let intent: ShellIntent = { kind: "none" };
    while (rest.length > 0) {
      const first = firstKeystrokeLength(rest);
      const coalesced =
        first > 0 &&
        first < rest.length &&
        (this.prefixArmed || rest.startsWith(DESK_PREFIX));
      if (!coalesced) return this.dispatchKey(rest);
      intent = this.dispatchKey(rest.slice(0, first));
      rest = rest.slice(first);
    }
    return intent;
  }

  private dispatchKey(data: string): ShellIntent {
    const rows = this.inboxState().rows;
    const intent = routeKey(data, this.scope());
    // The prefix arms for ONE keystroke. Disarm before executing, so an
    // intent that opens a scope cannot leave it armed underneath.
    if (intent.kind !== "arm-prefix") this.prefixArmed = false;
    this.execute(intent, rows);
    return intent;
  }

  /**
   * One new-tab action, reached by the chord AND by clicking `+`.
   *
   * Shared rather than duplicated, and never by synthesising a keystroke: a
   * fake chord would run the prefix bookkeeping and the router again, and the
   * two paths would drift the first time either changed.
   */
  private openNewTab(): void {
    this.spawnMenu = buildSpawnMenuState(this.deps.getSnapshot().readiness ?? null);
    this.deps.onChange();
  }

  private execute(
    intent: ShellIntent,
    rows: ReturnType<Desk["inboxState"]>["rows"]
  ): void {
    switch (intent.kind) {
      case "quit":
        this.deps.onQuit();
        return;

      case "arm-prefix":
        this.prefixArmed = true;
        break;

      case "to-child": {
        // The FOCUSED pane, not the main one. Writing to the wrong half of a
        // split is the defect that makes splits useless.
        const target = this.focusedSession();
        target?.write(intent.data);
        return;
      }

      // ESC POPS EXACTLY ONE LAYER, innermost first — the inverse of the
      // order a human opened things in.
      case "pop-layer": {
        // The SAME rule `centreKind` and the router read — closing what is on
        // top cannot disagree with what is drawn on top.
        this.closeSurface(this.top());
        break;
      }

      case "toggle-sidebar":
        // REFUSE WITH A REASON when the terminal cannot hold the rail. The
        // width guard in `Shell` correctly declines to draw it below 47
        // columns — but flipping the flag anyway made the chord silently do
        // nothing while the footer still advertised it. `split-pane` already
        // models this: say why.
        if (
          !this.sidebarOpen &&
          this.deps.terminalColumns !== undefined &&
          this.deps.terminalColumns() < MIN_SIDEBAR_TOTAL
        ) {
          this.status(
            `✗ too narrow for the sidebar — needs ${MIN_SIDEBAR_TOTAL} columns`
          );
          break;
        }
        this.sidebarOpen = !this.sidebarOpen;
        break;

      case "toggle-crew":
        this.crewOpen = !this.crewOpen;
        this.crewCursor = 0;
        this.noteReveal("crew");
        break;

      case "toggle-inbox":
        this.inboxFocused = !this.inboxFocused;
        this.inboxCursor = 0;
        this.noteReveal("inbox");
        break;

      case "open-help":
        this.helpOpen = !this.helpOpen;
        this.noteReveal("help");
        break;

      case "open-destinations":
        this.navOpen = true;
        this.noteReveal("destinations");
        this.navCursor = Math.max(
          0,
          NAV_DESTINATIONS.findIndex((e) => e.target === this.destination)
        );
        break;

      case "open-spawn-menu":
        this.spawnMenu = buildSpawnMenuState(
          this.deps.getSnapshot().readiness ?? null
        );
        this.noteReveal("spawn-menu");
        break;

      case "open-memory":
        void this.openMemory();
        break;

      case "new-tab":
        this.openNewTab();
        break;

      case "next-tab":
        this.cycleTab(1);
        return;

      case "prev-tab":
        this.cycleTab(-1);
        return;

      case "corpse-discard":
        this.frozen = this.frozen.filter((_, i) => i !== this.frozenIndex);
        // Land on the next restored tab if there is one; otherwise leave the
        // corpse layer entirely rather than clamping to a tab that is gone.
        this.frozenIndex = this.frozen.length > 0 ? 0 : null;
        break;

      case "answer-gate": {
        // Opens the REVIEW for the gate the band is announcing — the same
        // approval, so what a human answers is what they were told about.
        // The DECISION is the second press, against the evidence.
        const pending = (this.deps.getSnapshot().approvals ?? []).filter(
          (approval) => approval.status === "pending"
        );
        const gate = buildGateBand(pending);
        if (!gate) {
          // BE SPECIFIC. Saying "no gate is waiting" while the nav badge and
          // the inbox both say 1 made the desk contradict itself three ways.
          // If something IS pending but this desk cannot answer it, say THAT
          // and name where it can be answered.
          this.status(
            pending.length === 0
              ? "no gate is waiting"
              : `✗ ${pending.length} gate(s) pending, none answerable here — desktop, or \`npm run tui:ink\``
          );
          break;
        }
        this.review = openReview(gate.next);
        break;
      }

      case "open-composer": {
        // OPEN ON THE CHOICE, not on one command. `ctrl+b a` used to hard-code
        // `task-new`, so the desk could create a task and nothing else — while
        // the shared action layer already knew how to run, assign and set a
        // status. The list is DERIVED from the action registry, so it can only
        // ever offer commands that have an executor, and no form is built here
        // at all: choosing has nothing to do with one.
        this.composer = openComposerPicker(
          EXECUTABLE_ACTIONS.map((id) => ({ id, label: actionLabel(id) }))
        );
        break;
      }

      case "composer-type":
        if (this.composer) this.composer = composerType(this.composer, intent.data);
        break;

      case "split-pane": {
        const active = this.sessions.active();
        if (!active) {
          this.status("✗ nothing to split — open a terminal first");
          break;
        }
        if (this.sessions.splitOf(active.id)) {
          // Toggle: a second `ctrl+b |` closes the split rather than stacking
          // panes a human cannot reach.
          this.sessions.close(this.sessions.splitOf(active.id)!.id);
          this.focusedPane = 0;
          break;
        }
        // The split picks its own kind, so a human can put a shell beside
        // Claude or a second Claude beside the first.
        this.spawnMenu = {
          ...buildSpawnMenuState(this.deps.getSnapshot().readiness ?? null),
          intoSplitOf: active.id,
        };
        break;
      }

      case "focus-pane": {
        const active = this.sessions.active();
        if (!active || !this.sessions.splitOf(active.id)) {
          this.status("✗ no split — ctrl+b | opens one");
          break;
        }
        this.focusedPane =
          intent.which === "left" ? 0 : intent.which === "right" ? 1 : 1 - this.focusedPane;
        break;
      }

      case "close-tab": {
        const active = this.sessions.active();
        if (active) {
          // CLOSE WHAT THE HUMAN IS LOOKING AT.
          //
          // This closed `active()` unconditionally, and in a split `active()`
          // is always the LEFT half: opening a split deliberately does not
          // steal the tab focus (see SessionManager.open), so `activeId`
          // stays on the parent while `focusedPane` moves. The result was
          // that ctrl+b w aimed at the left pane no matter which one the
          // human had focused — and, before the promotion fix below it, took
          // the right pane down as well.
          const split = this.sessions.splitOf(active.id);
          const target = this.focusedPane === 1 && split ? split : active;
          this.sessions.close(target.id);
          // Whichever half went, one pane is left and it is pane 0. Leaving
          // this at 1 would point focus at a rectangle that is no longer
          // drawn, and the next keystroke would go nowhere.
          this.focusedPane = 0;
        }
        // AND OFFER THE NEXT THING. Closing the last tab used to leave a tab
        // strip, 22 blank rows and a footer, with the only recovery hint
        // ("ctrl+b t to start one") inside the sidebar, which is hidden by
        // default. An empty desk must offer the picker for the same reason
        // the boot does.
        if (this.sessions.topLevel().length === 0 && this.frozen.length === 0) {
          this.spawnMenu = buildSpawnMenuState(
            this.deps.getSnapshot().readiness ?? null
          );
          this.noteReveal("spawn-menu");
        }
        break;
      }

      // ONE move intent. Which list it moves is decided by what is on top,
      // so "↑↓ move the focused list" is true by construction rather than by
      // remembering to add a branch per list.
      case "move":
        this.moveFocused(intent.delta, rows);
        break;

      case "cycle-zone":
        // Tab cycles the reveal zones, and is LIVE inside every overlay —
        // the founder's reported break was Tab dying with `/` open.
        this.cycleZone(intent.delta);
        break;

      case "activate":
        this.activateFocused(rows);
        break;

      case "review-decide": {
        if (!this.review) break;
        const approvalId = this.review.approval.id;
        this.review = { ...this.review, resolving: true };
        void this.decide(approvalId, intent.status).then((ok) => {
          // CLOSE ONLY ON SUCCESS. `decide` catches its own errors, so the
          // promise always resolves — an unconditional close threw away the
          // evidence on a 409 or a transient failure and made the operator
          // reopen a still-pending approval to retry. The gate stays up, with
          // the reason in the footer, until the decision actually lands.
          if (ok) this.review = null;
          else if (this.review) this.review = { ...this.review, resolving: false };
          this.syncCentre();
          this.deps.onChange();
        });
        break;
      }

      case "memory-act": {
        if (!this.memory) break;
        const note = this.memory.notes[this.memory.cursor];
        if (!note) break;
        const action: MemoryAction =
          intent.action === "pause" && note.status === "paused"
            ? "resume"
            : intent.action === "pin" && note.pinned === true
              ? "unpin"
              : intent.action;
        this.memory = { ...this.memory, busy: true };
        void this.writeMemory(note.id, action);
        break;
      }

      case "memory-toggle-expired":
        if (this.memory) {
          void this.openMemory(!this.memory.showExpired, this.memory.cursor);
        }
        break;

      case "none":
        break;
    }

    // AN EMPTY DESK IS NEVER A RESTING STATE. Esc on the boot picker used to
    // leave ten blank rows and a footer — the same thing the close-tab fix
    // called unacceptable, on the path a first-run user is MORE likely to
    // take. Whatever closed, if nothing is left, offer the picker again.
    // `top() === null` is NOT redundant with `centreKind() === "none"`. The
    // inbox is a focused RAIL, not a centre pane, so `centreKind` reports
    // "none" while the human is very much using something — and without this
    // guard, focusing the inbox opened the spawn picker underneath them and
    // the next Enter spawned a vendor CLI instead of opening the review. A
    // test caught it; the rule is "nothing is revealed AND nothing is
    // running", not "the centre happens to be empty".
    if (
      this.top() === null &&
      this.centreKind() === "none" &&
      this.sessions.topLevel().length === 0 &&
      this.frozen.length === 0
    ) {
      this.spawnMenu = buildSpawnMenuState(
        this.deps.getSnapshot().readiness ?? null
      );
      this.noteReveal("spawn-menu");
    }

    this.syncCentre();
    this.deps.onChange();
  }

  /** Move the selection in whatever surface is on top. */
  private moveFocused(
    delta: number,
    rows: ReturnType<Desk["inboxState"]>["rows"]
  ): void {
    const clamp = (value: number, max: number) =>
      Math.min(Math.max(0, max), Math.max(0, value));
    // ONE precedence rule — this used to be its own if-chain, and a chain
    // that disagrees with what is DRAWN moves a cursor the human cannot see.
    switch (this.top()) {
      case "composer":
        this.composer = composerMove(this.composer!, delta);
        return;
      case "memory":
        this.memory = {
          ...this.memory!,
          cursor: clamp(this.memory!.cursor + delta, this.memory!.notes.length - 1),
        };
        return;
      case "spawn-menu":
        this.spawnMenu = {
          ...this.spawnMenu!,
          cursor: clamp(
            this.spawnMenu!.cursor + delta,
            this.spawnMenu!.entries.length - 1
          ),
        };
        return;
      case "destinations":
        this.navCursor = clamp(this.navCursor + delta, NAV_DESTINATIONS.length - 1);
        return;
      case "crew":
        this.crewCursor = clamp(this.crewCursor + delta, this.crewLanes().length - 1);
        return;
      case "settings":
        this.settings = {
          cursor: clamp(
            this.settings!.cursor + delta,
            this.settingsState().selectable.length - 1
          ),
        };
        return;
      case "timeline":
        // Clamped against the LIVE row count, not a remembered one: the brain
        // poll lands underneath a human who is scrolling, and a cursor held
        // past the end would silently select nothing.
        this.timeline = {
          cursor: clamp(
            this.timeline!.cursor + delta,
            buildTimelineRows(this.deps.getSnapshot().events ?? [], Date.now())
              .rows.length - 1
          ),
        };
        return;
      case "inbox":
        this.inboxCursor = clamp(this.inboxCursor + delta, rows.length - 1);
        return;
      case "review":
      case "help":
        // A gate and the help list take no cursor movement.
        return;
      default:
        break;
    }
    // The SAME ordering the drawer renders (blocked-first). This used to fall
    // back to the snapshot's raw order, so moving the cursor in the drawer,
    // closing it and pressing Enter attached to a DIFFERENT agent than the
    // one that had been highlighted.
    this.crewCursor = clamp(this.crewCursor + delta, this.crewLanes().length - 1);
  }

  /** Tab: cycle the reveal zones. Live in every scope, including overlays. */
  private cycleZone(delta: number): void {
    // TAB MEANS "GO TO THE NEXT ZONE", and a centre reveal is not a zone — so
    // LEAVING one is part of the move.
    //
    // An adversarial review found the alternative, which is what this used to
    // do: with the timeline or settings open, Tab toggled the rail flags
    // underneath while the overlay stayed on top, so nothing on screen changed
    // and Tab read as dead. That is the advertised-but-inert defect on exactly
    // the surfaces a human is most likely to press Tab on, and the help pane
    // and destination list had it too.
    //
    // The SPAWN MENU is deliberately not in this set. It is a choice a human
    // is in the middle of making, and dismissing it on a Tab — the key people
    // press to look around — would throw that away. Gates never reach here at
    // all: the router hands them their keys before the overlay branch.
    const top = this.top();
    if (ZONE_BLOCKING_SURFACES.includes(top as (typeof ZONE_BLOCKING_SURFACES)[number])) {
      this.closeSurface(top);
      this.revealStack = this.revealStack.filter((entry) => entry !== top);
    }

    const zones: Array<"terminal" | "inbox" | "crew" | "sidebar"> = [
      "terminal",
      "inbox",
      "crew",
      "sidebar",
    ];
    const current = this.inboxFocused
      ? "inbox"
      : this.crewOpen
        ? "crew"
        : this.sidebarOpen
          ? "sidebar"
          : "terminal";
    const next =
      zones[(zones.indexOf(current) + delta + zones.length) % zones.length]!;
    this.inboxFocused = next === "inbox";
    this.crewOpen = next === "crew";
    this.sidebarOpen = next === "sidebar";
  }

  /** Enter: act on whatever surface is on top. */
  private activateFocused(rows: ReturnType<Desk["inboxState"]>["rows"]): void {
    switch (this.top()) {
      case "composer": {
        // Enter means CHOOSE while picking and SUBMIT once a form is up. The
        // two are one surface on purpose (see `ComposerState.choices`), so the
        // Esc stack and the centre pane still see exactly one composer.
        const choice = composerChoice(this.composer!);
        if (choice) {
          // The context is REAL now: `/answer` numbers the open questions the
          // inbox is already showing, so the human picks the one they can see.
          const form = buildActionForm(choice, this.actionContext());
          if (!form) {
            this.composer = { ...this.composer!, result: { ok: false, message: `'${choice}' has no form` } };
            return;
          }
          this.composer = openComposer(form);
          return;
        }
        void this.submitComposer();
        return;
      }

      case "settings": {
        // READ-ONLY, so Enter cannot change anything — it restates the
        // selected lane's fix hint in full, which is the one line a human
        // stuck on "why can't I dispatch to codex" actually needs and which
        // the frame may have clipped.
        const vendor = selectedVendor(this.settingsState());
        if (vendor) {
          this.status(
            vendor.step === "ready"
              ? `${vendor.label}: ${vendor.guidance}`
              : `${vendor.label}: ${vendor.fixHint ?? vendor.guidance}`
          );
        }
        return;
      }

      case "timeline": {
        // A LONG MESSAGE IS CLIPPED BY THE FRAME, so Enter re-states the
        // selected row in full on the status line. Small, and the difference
        // between an audit trail you can read and one you can only skim.
        const built = buildTimelineRows(
          this.deps.getSnapshot().events ?? [],
          Date.now()
        );
        const row = built.rows[this.timeline!.cursor];
        if (row) this.status(`${row.kind} · ${row.who} · ${row.message}`);
        return;
      }

      case "spawn-menu": {
        const resolved = resolveSpawnSelection(this.spawnMenu!);
        if ("kind" in resolved) {
          const parentId = this.spawnMenu!.intoSplitOf;
          this.spawnMenu = null;
          this.revealStack = this.revealStack.filter((e) => e !== "spawn-menu");
          const opened = this.sessions.open(
            resolved.kind,
            parentId === undefined ? undefined : { parentId }
          );
          // A NEW SESSION IS THE TAB YOU ARE ON. Without this the corpse layer
          // still won `centreKind()`, so starting a session while looking at a
          // restored one appeared to do nothing at all.
          if (!("reason" in opened)) this.frozenIndex = null;
          if ("reason" in opened) this.status(`✗ ${opened.reason}`);
          else if (parentId !== undefined) {
            // ORDER MATTERS, and it was wrong. `sessions.open` emits its
            // change SYNCHRONOUSLY, so the frame was rendered — and the new
            // pty created — while `focusedPane` was still 0: the split opened
            // showing the LEFT half focused, and the right child was sized as
            // if it had the whole centre. Nothing resized afterwards, so it
            // stayed wrong until some unrelated repaint.
            this.focusedPane = 1;
            // Publish the focus, so the shell knows there are two panes and
            // which one has the caret…
            this.render();
            // …and only THEN measure, because each half's width depends on
            // the shell knowing it is split.
            this.resize();
            this.deps.onChange();
          }
        } else {
          this.status(`✗ ${resolved.refused}`);
        }
        return;
      }

      case "destinations": {
        const target = navDestinationAt(this.navCursor);
        this.closeSurface("destinations");
        if (!IMPLEMENTED_DESTINATIONS.has(target)) {
          this.status(
            `✗ ${target} is not on this desk yet — desktop app, or \`npm run tui:ink\``
          );
          return;
        }
        this.destination = target;
        switch (target) {
          case "memory":
            void this.openMemory();
            break;
          case "control":
            this.inboxFocused = true;
            this.inboxCursor = 0;
            this.noteReveal("inbox");
            break;
          case "crew":
            this.crewOpen = true;
            this.crewCursor = 0;
            this.noteReveal("crew");
            break;
          case "timeline":
            this.timeline = { cursor: 0 };
            this.noteReveal("timeline");
            break;
          case "settings":
            this.settings = { cursor: 0 };
            this.noteReveal("settings");
            break;
          case "mission":
            this.inboxFocused = false;
            this.crewOpen = false;
            this.timeline = null;
            this.settings = null;
            this.helpOpen = false;
            this.revealStack = [];
            break;
          default:
            break;
        }
        return;
      }

      case "crew": {
        // Enter on a BLOCKED lane opens the gate holding it — evidence-first,
        // so the DECISION is still a second press.
        const lane = this.crewLanes()[this.crewCursor];
        if (lane?.blockedBy) {
          const approval = (this.deps.getSnapshot().approvals ?? []).find(
            (candidate) => candidate.id === lane.blockedBy
          );
          if (approval) {
            this.closeSurface("crew");
            this.review = openReview(approval);
          }
          return;
        }
        if (lane) this.status(`${lane.agent.name ?? lane.agent.id} is ${lane.state}`);
        return;
      }

      case "inbox": {
        // EVIDENCE-FIRST: opens the review; the DECISION is a second press.
        const row = rows[this.inboxCursor];
        if (row) this.review = openReview(row.approval);
        return;
      }

      default:
        break;
    }

    if (this.centreKind() === "frozen") {
      const corpse = this.frozen[this.frozenIndex!]!;
      const opened = this.sessions.open(corpse.kind);
      if ("reason" in opened) {
        this.status(`✗ ${opened.reason}`);
        return;
      }
      this.frozen = this.frozen.filter((_, i) => i !== this.frozenIndex);
      // The corpse became a live session; the human is on THAT tab now.
      this.frozenIndex = null;
      return;
    }
    this.attachGoverned();
  }

  // ── governed operations ─────────────────────────────────────────────────

  private status(text: string): void {
    this.shell.footer.setStatus(text);
  }

  private attachGoverned(): void {
    const snapshot = this.deps.getSnapshot();
    // Indexed through the SAME lane ordering the crew drawer shows, so the
    // agent attached to is the agent that was highlighted.
    const agent = this.crewLanes()[this.crewCursor]?.agent;
    if (!agent) return;
    const job = (snapshot.dispatchJobs ?? []).find(
      (record) => record.agentId === agent.id
    );
    if (!job) {
      this.status(
        `no dispatched job for ${agent.name ?? agent.id} — nothing to attach to`
      );
      return;
    }
    this.governed?.dispose();
    const { cols, rows } = this.deps.geometry();
    this.governedSeq += 1;
    this.governed = new GovernedSession({
      client: this.deps.client,
      jobId: job.id,
      title: agent.name ?? agent.id,
      cols,
      rows,
    });
    this.governed.subscribe(this.deps.onChange);
    this.governed.start(1000);
  }

  /**
   * Answer an approval — through the SHARED payload builder, so this desk
   * cannot develop a dialect of a governed write.
   */
  private async decide(
    approvalId: string,
    status: "approved" | "rejected"
  ): Promise<boolean> {
    this.status(`… ${status} ${approvalId}`);
    this.deps.onChange();
    try {
      await this.deps.client.resolveApproval(
        buildApprovalDecision({ approvalId, status, surface: "MUON TUI" })
      );
      this.status(`${status === "approved" ? "✓" : "✗"} ${status} ${approvalId}`);
      await this.deps.refresh?.();
      this.deps.onChange();
      return true;
    } catch (error) {
      // A governed write that FAILED must say so: a silent failure reads as
      // "decided" while the agent is still blocked.
      this.status(`✗ could not ${status}: ${message(error)}`);
      this.deps.onChange();
      return false;
    }
  }

  /**
   * Open (or re-run) the governed memory read.
   *
   * THE LIBRARY, NOT SEARCH. The first version called `searchMemory("", …)`
   * and `GET /api/memory/search` validates `q: min(1)`, so every press 400'd
   * and the pane never opened once. The library route answers "show me the
   * queue" without a query, and takes `status`, which is what makes PAUSED
   * notes reachable at all.
   *
   * The workspace fence is sent optimistically and DEGRADES: a desk launched
   * outside the configured roots gets the unscoped view with the fence
   * stated, not a pane that refuses to open (ADR-0026 §9).
   */
  async openMemory(showExpired = false, cursor = 0): Promise<void> {
    if (this.memory) this.memory = { ...this.memory, busy: true };
    this.syncCentre();
    this.deps.onChange();
    const load = (workspace: string | undefined) =>
      this.deps.client.listMemoryLibrary({
        status: "all",
        showExpired,
        limit: Desk.MEMORY_PAGE,
        ...(workspace === undefined ? {} : { workspace }),
      });
    try {
      let workspace: string | undefined = this.deps.cwd();
      let snapshot;
      try {
        snapshot = await load(workspace);
      } catch {
        workspace = undefined;
        snapshot = await load(undefined);
      }
      const autoConfirm = await this.deps.client
        .getAutoConfirmAgentMemory()
        // FAILS CLOSED to strict: an unreadable posture must not silently
        // mark crew notes settled — that is the direction that hides work.
        .catch(() => false);
      this.memory = {
        notes: snapshot.notes,
        cursor: Math.min(cursor, Math.max(0, snapshot.notes.length - 1)),
        showExpired,
        autoConfirmAgentMemory: Boolean(autoConfirm),
        busy: false,
        workspace,
        total: snapshot.total,
      };
    } catch (error) {
      this.memory = null;
      this.status(`✗ memory unavailable: ${message(error)}`);
    }
    this.syncCentre();
    this.deps.onChange();
  }

  /**
   * Submit the composer through the SHARED `executeAction` — the same
   * validation and the same governed client call the classic desk makes.
   * The result STAYS on screen: a form that clears itself on failure tells
   * the human it worked.
   */
  async submitComposer(): Promise<void> {
    if (!this.composer || this.composer.busy) return;
    // A CHOICE IS NOT A SUBMIT. The phases are a discriminated union now, so
    // this is a type guard rather than a convention — Enter while choosing is
    // handled by `activateFocused`, which swaps the phase.
    if (this.composer.phase !== "editing") return;
    const { form, values } = this.composer;
    this.composer = { ...this.composer, busy: true, result: null };
    this.syncCentre();
    this.deps.onChange();
    const result = await executeAction(
      this.deps.client,
      form,
      values,
      // The SAME context the form was built from, so a positional pick
      // resolves against the list the human read.
      this.actionContext()
    );
    if (!this.composer) return;
    this.composer = { ...this.composer, busy: false, result };
    if (result.ok) {
      this.status(`✓ ${result.message}`);
      await this.deps.refresh?.();
    }
    this.syncCentre();
    this.deps.onChange();
  }

  /**
   * What an action form and its executor may both see.
   *
   * Built ONCE per use and passed to both halves: a form that offered "pick
   * question #2" while the executor resolved against a different list would be
   * the worst kind of wrong — it would answer the wrong agent.
   *
   * `selectedTask` / `selectedLane` are deliberately absent, and that is not an
   * omission to be fixed: THIS desk is terminal-first and tracks no task or
   * lane selection at all, so there is nothing to prefill a form from. Those
   * ActionContext fields exist for cockpit surfaces that do have a selection.
   */
  private actionContext(): ActionContext {
    const snapshot = this.deps.getSnapshot();
    // The SAME agent → job resolution `attachGoverned` uses, so a control acts
    // on the lane the human has highlighted rather than one they retyped.
    const agent = this.crewLanes()[this.crewCursor]?.agent;
    const job = agent
      ? (snapshot.dispatchJobs ?? []).find(
          (record) => record.agentId === agent.id
        )
      : undefined;
    return {
      openQuestions: snapshot.questions ?? [],
      ...(job ? { selectedJobId: job.id } : {}),
      ...(agent ? { selectedJobLabel: agent.name ?? agent.id } : {}),
    };
  }

  /** Test seam. */
  composerState(): ComposerState | null {
    return this.composer;
  }

  /** A governed brain write, through the SHARED payload builder. */
  async writeMemory(noteId: string, action: MemoryAction): Promise<void> {
    try {
      await this.deps.client.updateMemoryNote(buildMemoryDecision(noteId, action));
      this.status(`✓ ${action} ${noteId}`);
      // Only re-read if the pane is STILL open. `esc` is allowed mid-write,
      // and an unconditional re-open re-mounted the pane over whatever the
      // human had moved to.
      if (this.memory) {
        await this.openMemory(this.memory.showExpired, this.memory.cursor);
      }
    } catch (error) {
      if (this.memory) this.memory = { ...this.memory, busy: false };
      this.status(`✗ ${action} failed: ${message(error)}`);
      this.syncCentre();
      this.deps.onChange();
    }
  }

  /** The live sessions, for the ADR-0047 capture on the way out. */
  liveSessions() {
    return this.sessions.list();
  }

  /**
   * The geometry ONE session was rendered at.
   *
   * ADR-0047 stores a screen with the size it was drawn for, and the restore
   * re-wraps to that size. Shutdown used `paneGeometry()` — the FOCUSED pane —
   * for every session, so in a split the other half was saved at the wrong
   * width and came back re-wrapped into nonsense. The same defect as the
   * resize path, in the one place a human sees it after a restart.
   */
  geometryOf(sessionId: string): { cols: number; rows: number } {
    const width = this.deps.terminalColumns?.();
    if (width === undefined) return this.paneGeometry();
    const parent = this.sessions
      .topLevel()
      .find((tab) => this.sessions.splitOf(tab.id)?.id === sessionId);
    // Is the TAB this session belongs to split? Read from the session tree,
    // never from the shell's current panes — those describe the tab in front.
    const split = parent !== undefined || this.sessions.splitOf(sessionId) !== null;
    // A split CHILD is the right half of its parent; anything else is a
    // whole-centre pane or the left half, which share the pane-0 geometry.
    return this.shell.paneViewportAt(width, parent ? 1 : 0, split ? 2 : 1);
  }

  dispose(): void {
    this.governed?.dispose();
    this.sessions.disposeAll();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}
