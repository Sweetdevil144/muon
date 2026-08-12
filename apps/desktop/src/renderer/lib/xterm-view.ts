// Wave 4 §5.0.3 — the production TerminalView, backed by XTerm.js.
//
// XTerm.js is pure JS (MIT) — it is NOT the native-module gate; only node-pty is
// (Founder Decision D1/P5). This adapter is intentionally thin: it maps the
// framework-agnostic TerminalView contract onto an XTerm instance so the tested
// wiring (wireTerminal / TerminalTab) drives a real terminal in production while
// tests inject a fake view. It renders to a DOM element, so it is exercised in
// the Electron renderer, not in headless unit tests.

import { Terminal, type ILinkHandler } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalSearchController, TerminalView } from "./terminal-wire.js";
import { resolveTerminalKeySequence } from "./terminal-keybindings.js";
import {
  classifyTerminalLink,
  isTerminalLinkActivationClick,
  type TerminalLinkTarget,
} from "./terminal-link-security.js";
import { bridgeOpenTerminalLink } from "./terminal-link-open.js";

export type { TerminalSearchController };

export type XtermViewOptions = {
  /**
   * 0038 — the pane is a VIEWER of a dispatched agent's console, so the
   * terminal itself must not accept keystrokes. Nothing subscribes to this
   * view's input either; `disableStdin` is the second lock, so a stray focus +
   * keypress cannot even produce a local echo that would read as "I typed into
   * the agent". Typing at a governed worker would bypass the approval path.
   */
  readOnly?: boolean;
  /**
   * Translate a bare `\n` to `\r\n` on write. REQUIRED for any pane fed from
   * PIPES: a non-tty vendor child emits `\n`-only line endings, and xterm
   * renders those as line-feed-without-return — the ragged right-shifted
   * staircase the founder rejected. Idempotent for real pty streams (their
   * `\r\n` gains a harmless extra return), so read-only job consoles set it
   * unconditionally. The interactive pty tab keeps the default (false):
   * a live TUI owns its own line discipline.
   */
  convertEol?: boolean;
  /**
   * U3 — render at the SOURCE console's grid instead of fitting the pane.
   *
   * Set only for a read-only VIEWER of a console MUON does not own: a
   * dispatched job's pty is spawned at a fixed size and there is no resize
   * channel back to it, so its bytes (wraps, absolute cursor positions, `\r`
   * redraws) are only correct when replayed at that same geometry. See
   * agent-console-grid.ts.
   *
   * Columns are pinned exactly; rows are pinned as a FLOOR, because a taller
   * emulator simply leaves the extra rows blank while a shorter one would put
   * the source's absolute row coordinates off the bottom of the screen.
   * Anything wider than the pane scrolls (styles.css) rather than re-wrapping.
   */
  fixedGrid?: { cols: number; rows: number };
  /**
   * ROADMAP T4 — OSC-8 hyperlinks: the workspace root path-shaped links are
   * allowlisted against (`terminal-link-security.ts`). Null/omitted denies
   * every path-shaped link outright; http(s) links are allowed regardless
   * (they need no workspace context). Never trusted alone — the main-process
   * open handler re-validates independently before touching the filesystem
   * or the OS's own URL opener.
   */
  workspaceRoot?: string | null;
  /**
   * Where an ALLOWLISTED, ⌘-clicked link actually goes. Defaults to the real
   * bridge (main re-validates, then `shell.openExternal` for a URL or a
   * reveal-in-Finder for an in-workspace path); injectable so a test can
   * assert on it without Electron. Never called for a denied target or a
   * plain (non-modifier) click — see `isTerminalLinkActivationClick`.
   */
  onOpenLink?: (target: TerminalLinkTarget) => void;
};

/**
 * The EXACT constructor options every MUON terminal is built with — exported
 * as a pure function so a test can construct a REAL headless Terminal from
 * them and load the real addons, with no DOM and no mocks.
 *
 * `allowProposedApi: true` is load-bearing: Unicode11Addon's activate reads
 * `terminal.unicode`, which xterm guards as proposed API — without the flag,
 * `loadAddon` THROWS inside the mounting React effect, and (before the addon
 * loads became best-effort) that unmounted the entire App to the error
 * boundary the moment any terminal tab opened. The addon-mocking unit tests
 * could never see it; only a real Terminal does.
 */
export function xtermTerminalOptions(input: {
  readOnly?: boolean;
  convertEol?: boolean;
}): ConstructorParameters<typeof Terminal>[0] {
  const readOnly = input.readOnly === true;
  return {
    allowProposedApi: true,
    convertEol: input.convertEol === true,
    cursorBlink: !readOnly,
    disableStdin: readOnly,
    // Option acts as Meta so ⌥ combos reach the pty the way Ghostty/iTerm do.
    macOptionIsMeta: true,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: 13,
    scrollback: 5000,
  };
}

/**
 * UTF-8-safe base64 for the clipboard addon (OSC 52). Built lazily so a host
 * without TextEncoder (older test doubles) fails at load time inside the
 * best-effort addon guard, not at module import.
 */
function utf8Base64Codec(): {
  encodeText(data: string): string;
  decodeText(data: string): string;
} {
  return {
    encodeText: (data: string): string => {
      const bytes = new TextEncoder().encode(data);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    },
    decodeText: (data: string): string => {
      const binary = atob(data);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    },
  };
}

/**
 * Disarm the emulator's TUI input/screen modes. Written into the terminal
 * when the SESSION ENDS: a vendor TUI (claude/codex are TUIs) killed while
 * attached leaves kitty-keyboard, mouse-tracking, focus-report, bracketed-
 * paste, a hidden cursor, or the alternate screen armed — the "[session
 * exited]" pane then renders mouse escape garbage on selection and hides the
 * exit banner on the alt screen. These sequences reset the EMULATOR (the pty
 * is already gone, so nothing receives them as input).
 */
const DISARM_TUI_MODES =
  "\x1b[<u" + // kitty keyboard: pop
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // mouse tracking off
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?25h" + // cursor visible
  "\x1b[?1049l"; // leave the alternate screen

/** `createXtermView`'s return type, widened with the T4 companions that live
 *  outside the framework-agnostic `TerminalView` contract (search, and a
 *  narrower serialize signature) — `TerminalView` itself only grows the
 *  `serialize()` member so a fake test view is never forced to implement
 *  search too. */
export type XtermView = TerminalView & {
  search: TerminalSearchController;
};

export function createXtermView(
  container: HTMLElement,
  options: XtermViewOptions = {}
): XtermView {
  const readOnly = options.readOnly === true;
  const workspaceRoot = options.workspaceRoot ?? null;
  const openLink = options.onOpenLink ?? bridgeOpenTerminalLink;
  // OSC-8 hyperlinks are an AGENT-CONTROLLED CHANNEL INTO THE UI (whatever
  // runs inside this pane paints them) — installed on EVERY view, read-only
  // job console included, so xterm's own default fallback (a `confirm()`
  // dialog quoting the raw link text) is never reached and the allowlist is
  // the only path a click can take. See terminal-link-security.ts.
  const linkHandler: ILinkHandler = {
    activate: (event, text) => {
      if (!isTerminalLinkActivationClick(event)) {
        return; // a plain click never activates a link — ⌘/Ctrl-click only
      }
      const target = classifyTerminalLink(text, workspaceRoot);
      if (target) {
        openLink(target);
      }
    },
  };
  // Options come from the exported pure builder (so the real-Terminal
  // regression test constructs from the SAME literal); the linkHandler closes
  // over this view's security context, so it joins here.
  const term = new Terminal({
    ...xtermTerminalOptions({ readOnly, convertEol: options.convertEol }),
    linkHandler,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // ROADMAP T4 — search, unicode11 (wide-glyph/emoji width fixes), clipboard
  // (OSC 52 + native copy/paste), and serialize (the parked-runtime LRU's
  // replay source, xterm-view-addons.test.ts). Loaded on every view,
  // including read-only ones: a read-only console still benefits from
  // correct glyph widths and from being searchable/selectable/copyable, and
  // costs nothing extra to wire uniformly.
  //
  // EVERY optional addon loads BEST-EFFORT. Unicode11Addon touches xterm's
  // proposed API, and before `allowProposedApi: true` was set (see
  // xtermTerminalOptions) its loadAddon threw INSIDE the mounting effect —
  // which unmounted the whole App to the error boundary. That is the
  // blank-window class (#23): a degraded pane (wrong emoji widths, no
  // search) must never cost the operator the window.
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  const loadOptionalAddon = (name: string, load: () => void): void => {
    try {
      load();
    } catch (error) {
      console.warn(
        `[xterm-view] optional addon '${name}' failed to load; the pane degrades and keeps running:`,
        error
      );
    }
  };
  loadOptionalAddon("search", () => term.loadAddon(search));
  loadOptionalAddon("unicode11", () => {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  });
  // UTF-8-safe base64 codec: the addon's DEFAULT codec round-trips through
  // atob/btoa on raw UTF-16 code units, so an OSC 52 copy of any non-ASCII
  // text (box-drawing output, emoji, non-English prose) garbles the
  // clipboard. Encode via TextEncoder/TextDecoder instead.
  loadOptionalAddon("clipboard", () =>
    term.loadAddon(new ClipboardAddon(utf8Base64Codec()))
  );
  loadOptionalAddon("serialize", () => term.loadAddon(serialize));

  term.open(container);

  // Ghostty-like edit chords XTerm does not emit by default on macOS. Never
  // installed on a read-only viewer: its whole purpose is to synthesize input.
  if (!readOnly) {
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const sequence = resolveTerminalKeySequence(event);
      if (sequence === null) {
        return true;
      }
      event.preventDefault();
      term.input(sequence);
      return false;
    });
  }

  /** True only when the container currently has a real, measurable box. */
  const measurable = () =>
    container.clientWidth >= 2 && container.clientHeight >= 2;

  const fixedGrid = options.fixedGrid;

  const safeFit = (): boolean => {
    // Skip 0×0 fits — they produce the tiny "draggable" cell box in a
    // collapsed dock, and (worse) would resize the pty to a size no human is
    // reading at. A hidden pane reports 0 here; `pendingFit` below is what
    // brings it back when it is shown again.
    if (!measurable()) {
      return false;
    }
    if (!fixedGrid) {
      try {
        fit.fit();
        return true;
      } catch {
        // Container not measured yet — a later observer/retry tick fits it.
        return false;
      }
    }
    // PINNED to the source console. The pane's own width is irrelevant to how
    // these bytes must be laid out; it only decides how much of the result is
    // on screen at once.
    let rows = fixedGrid.rows;
    try {
      const proposed = fit.proposeDimensions();
      if (proposed && Number.isFinite(proposed.rows) && proposed.rows > rows) {
        rows = Math.floor(proposed.rows);
      }
    } catch {
      // Unmeasurable height — the source's own row count is the safe floor.
    }
    try {
      term.resize(fixedGrid.cols, rows);
      return true;
    } catch {
      return false;
    }
  };

  // A fit that could not be taken (the pane was hidden, or the container had
  // not been laid out yet) must not be forgotten. ResizeObserver covers the
  // usual show/hide transition, but a `display:none` element generates no box
  // at all, and a terminal mounted in that state used to measure 0 once and
  // never recover. This retries on animation frames until it lands, bounded so
  // a pane that is never shown costs nothing for long.
  let pendingFrame: number | null = null;
  let pendingAttempts = 0;
  const MAX_PENDING_FRAMES = 240; // ~4s at 60fps, then the observers own it.
  const cancelPending = () => {
    if (pendingFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingFrame);
    }
    pendingFrame = null;
  };
  const fitSoon = () => {
    if (pendingFrame !== null || typeof requestAnimationFrame !== "function") {
      return;
    }
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (safeFit()) {
        pendingAttempts = 0;
        return;
      }
      pendingAttempts += 1;
      if (pendingAttempts < MAX_PENDING_FRAMES) {
        fitSoon();
      }
    });
  };
  const refit = () => {
    pendingAttempts = 0;
    if (!safeFit()) {
      fitSoon();
    }
  };

  // FIT SYNCHRONOUSLY FIRST. This runs inside the mounting effect, after React
  // has committed the DOM, so reading clientWidth forces layout and returns the
  // real box — which means the FIRST frame the child ever prints is already at
  // the right width, and the open below can hand that geometry to the pty. The
  // deferred pass stays as the fallback for a container that genuinely is not
  // laid out yet.
  refit();

  // Refit on container resize; XTerm's onResize then reports the new cols/rows,
  // which wireTerminal forwards to the host so the pty's window size matches.
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => refit())
      : undefined;
  observer?.observe(container);
  // The window itself: a container whose own box does not change (a percentage
  // height inside a resized ancestor can keep the same computed size while the
  // pixels move) still needs a re-measure, and this is cheap.
  const onWindowResize = () => refit();
  window.addEventListener?.("resize", onWindowResize);

  return {
    write: (data) => term.write(data),
    refit,
    size: () =>
      measurable() && term.cols > 0 && term.rows > 0
        ? { cols: term.cols, rows: term.rows }
        : null,
    onInput: (listener) => {
      // Third lock (after `disableStdin` and the omitted key handler): a
      // read-only view never subscribes at all, so even a caller that wired
      // `wireTerminal` to one could not carry a keystroke anywhere.
      if (readOnly) {
        return { dispose: () => undefined };
      }
      const sub = term.onData(listener);
      return { dispose: () => sub.dispose() };
    },
    onResize: (listener) => {
      const sub = term.onResize(({ cols, rows }) => listener({ cols, rows }));
      return { dispose: () => sub.dispose() };
    },
    markExited: (exit) => {
      const signal = exit.signal !== undefined ? `, signal ${exit.signal}` : "";
      term.write(
        `${DISARM_TUI_MODES}\r\n\x1b[2m[session exited: code ${exit.exitCode}${signal}]\x1b[0m\r\n`
      );
    },
    markError: (reason) => {
      // Host-authored prose only (see the protocol's error frame), so writing
      // it into the terminal cannot echo vendor bytes or a credential.
      term.write(`${DISARM_TUI_MODES}\r\n\x1b[33m[MUON] ${reason}\x1b[0m\r\n`);
    },
    // ROADMAP T4 — the parked-runtime LRU's replay source (parked-terminal-
    // store.ts). Wrapped in try/catch: a disposed terminal (a park racing a
    // teardown) must never throw out of a snapshot attempt.
    serialize: () => {
      try {
        return serialize.serialize();
      } catch {
        return "";
      }
    },
    search: {
      findNext: (term_, searchOptions) => search.findNext(term_, searchOptions),
      findPrevious: (term_, searchOptions) =>
        search.findPrevious(term_, searchOptions),
      clear: () => search.clearDecorations(),
    },
    dispose: () => {
      cancelPending();
      window.removeEventListener?.("resize", onWindowResize);
      observer?.disconnect();
      term.dispose();
    },
  };
}
