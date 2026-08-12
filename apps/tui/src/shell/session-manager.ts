import {
  nextTerminalOrdinal,
  SHELL_TERMINAL_KIND,
  shouldCloseTerminalTabOnExit,
  terminalTabLabel,
  VENDOR_TERMINAL_COMMANDS,
  type TerminalCommand,
} from "@muon/client/terminal-vendor-tabs";
import type { VendorId } from "@muon/client/vendors";
import { PtySession } from "./pty-session.js";

/**
 * F2 — every live pty session in the shell, numbered per kind.
 *
 * The numbering, labels, spawn allowlist and exit rule are the SAME code the
 * desktop runs (`@muon/client/terminal-vendor-tabs`, moved there for exactly
 * this): "Claude" then "Claude 2" on both surfaces because it is one
 * function, not two implementations that happen to agree today.
 *
 * The ALLOWLIST is the authority (ADR-0022 §3.4 mechanism 4): a kind resolves
 * through `VENDOR_TERMINAL_COMMANDS`, which is TOTAL over `VendorId` with
 * `null` as a statement — a vendor that must not be spawned (the bare
 * `cursor` IDE launcher problem) cannot acquire a pty by being forgotten,
 * and an unknown kind resolves to nothing rather than to a shell.
 */

export type ManagedTab = {
  readonly id: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly label: string;
  readonly session: PtySession;
  /**
   * When set, this session is the RIGHT half of a split belonging to that
   * tab — not a tab of its own. Splits are sessions like any other (same
   * allowlist, same governance labelling); the only difference is where they
   * are drawn, so this is the one field that decides it.
   */
  readonly parentId?: string;
};

export type SpawnRefusal = { readonly reason: string };

/**
 * The live-session cap, matching the desktop's `MAX_TERMINAL_SESSIONS`.
 *
 * Not theoretical: a saturated pane's emulator costs ~8 MB (measured — see
 * the F6 note in the parity matrix), so unbounded ctrl+t would walk memory up
 * without ever refusing. Like the desktop's, this refuses at the LAST moment
 * with a reason a human can read, rather than hiding the affordance.
 */
export const MAX_LIVE_SESSIONS = 32;

function commandForKind(kind: string): TerminalCommand | null {
  if (kind === SHELL_TERMINAL_KIND) {
    return { file: process.env.SHELL || "/bin/sh", args: [] };
  }
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so five
  // prototype-named kinds ("toString", "constructor", …) passed the gate the
  // docblock calls TOTAL and then threw from the spread. Same class as the
  // catalogue's prototype-escape fix; same cure.
  if (Object.hasOwn(VENDOR_TERMINAL_COMMANDS, kind)) {
    return VENDOR_TERMINAL_COMMANDS[kind as VendorId];
  }
  return null;
}

export class SessionManager {
  private tabs: ManagedTab[] = [];
  private activeId: string | null = null;
  private onChange: (() => void) | null = null;
  private readonly geometry: () => { cols: number; rows: number };

  constructor(geometry: () => { cols: number; rows: number }) {
    this.geometry = geometry;
  }

  subscribe(listener: () => void): void {
    this.onChange = listener;
  }

  /** Spawn a kind, or refuse with a reason a human can read. Never throws. */
  open(kind: string, options?: { parentId?: string }): ManagedTab | SpawnRefusal {
    const command = commandForKind(kind);
    if (!command) {
      // `null` in the allowlist is a STATEMENT, and the refusal repeats it —
      // never silently falling back to a shell, which would hand a pty to a
      // kind the table deliberately refused.
      return { reason: `'${kind}' has no spawnable terminal command` };
    }
    // A SPLIT MUST HAVE A LIVE PARENT. Closing the tab while its split picker
    // was open left the chosen session parented to an id that no longer
    // existed — and because ordinals are recycled, it could become its OWN
    // parent: excluded from `topLevel()`, never `active()`, invisible to
    // `splitOf()`. A live vendor CLI with no pane, no tab, and no way to
    // reach or kill it. Refuse rather than orphan.
    if (
      options?.parentId !== undefined &&
      !this.tabs.some((tab) => tab.id === options.parentId)
    ) {
      return { reason: "the pane this split belonged to is gone" };
    }
    if (this.tabs.length >= MAX_LIVE_SESSIONS) {
      return {
        reason: `${MAX_LIVE_SESSIONS} terminals are already open — close one first`,
      };
    }
    const ordinal = nextTerminalOrdinal(this.tabs, kind);
    const label = terminalTabLabel(kind, ordinal);
    const { cols, rows } = this.geometry();
    const id = `${kind}-${ordinal}`;
    let session: PtySession;
    try {
      session = new PtySession({
        id,
        title: label,
        command: command.file,
        args: command.args,
        cwd: process.cwd(),
        // A login shell keeps the user's ambient GitHub authority; a vendor
        // CLI does not. MUON's own tokens are stripped for BOTH inside the
        // session (the shared sanitizer).
        envKind: kind === SHELL_TERMINAL_KIND ? "shell" : "vendor",
        // D5: every pane a HUMAN opens here is ungoverned — MUON did not
        // dispatch it and does not observe it. Governed lane panes arrive as a
        // separate feature with a separate constructor path, not a flag flip.
        ungoverned: true,
        cols,
        rows,
      });
    } catch (error) {
      // node-pty throws SYNCHRONOUSLY when a binary cannot be spawned. The
      // contract of this method is a readable refusal, never a throw that
      // rides up into the input dispatcher and kills the whole preview.
      return {
        reason: `could not start '${command.file}': ${
          error instanceof Error ? error.message.split("\n")[0] : String(error)
        }`,
      };
    }
    const tab: ManagedTab = {
      id,
      kind,
      ordinal,
      label,
      session,
      ...(options?.parentId === undefined ? {} : { parentId: options.parentId }),
    };
    this.tabs = [...this.tabs, tab];
    // A SPLIT does not steal the tab focus: the human asked for a second pane
    // beside what they were doing, not to be moved somewhere else.
    if (options?.parentId === undefined) this.activeId = id;

    session.subscribe(() => {
      const exit = session.exit;
      if (exit) {
        // F8 through the SHARED rule: a fast failure keeps the tab readable,
        // a real session's end closes it.
        const close = shouldCloseTerminalTabOnExit({
          lifetimeMs: exit.runtimeMs,
        });
        if (close) this.close(id);
      }
      this.onChange?.();
    });
    this.onChange?.();
    return tab;
  }

  close(id: string): void {
    const index = this.tabs.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const tab = this.tabs[index]!;
    tab.session.dispose();

    // THE SURVIVOR IS PROMOTED, NOT KILLED WITH ITS PARENT.
    //
    // This used to dispose every child, and the reasoning was sound as far as
    // it went: "a pane whose parent is gone would otherwise linger as an
    // unreachable live pty". True — but disposal is not the only way to make
    // it reachable, and it is the destructive one. Closing the left half of a
    // claude|codex split killed the codex session too, which is a running
    // agent with unsaved context, terminated because of where it happened to
    // be drawn.
    //
    // A split is a LAYOUT fact, not an ownership one. Both halves are real
    // sessions from the same allowlist with the same governance; the only
    // difference is which rectangle they occupy. So when the parent goes, the
    // heir stops being a right half and becomes a tab in its own right —
    // taking the parent's place in the strip, so the surviving pane goes full
    // screen exactly where the human was already looking.
    //
    // Every reachability guarantee the old comment wanted still holds: after
    // this, the heir is in `topLevel()`, is a valid `activate()` target, and
    // owns no dangling `parentId`. Nothing is orphaned; nothing is killed.
    const [heir, ...rest] = this.tabs.filter((entry) => entry.parentId === id);
    const remaining = this.tabs.filter(
      (entry) => entry.id !== id && entry.id !== heir?.id
    );

    if (heir) {
      const promoted: ManagedTab = { ...heir, parentId: undefined };
      // The parent's slot, so closing a pane never reshuffles the strip.
      remaining.splice(Math.min(index, remaining.length), 0, promoted);
      // A parent can only hold one split today, so `rest` is always empty.
      // If that ever changes, the extras are promoted TOO — each to a tab of
      // its own.
      //
      // Re-parenting them onto the heir was the first shape here, and it was
      // wrong in the way this whole method exists to prevent: `splitOf()` is a
      // `find`, so it surfaces only the first child, and `topLevel()` excludes
      // every child. The second and later extras would have been live ptys in
      // no tab and no pane — the exact unreachable session the comment above
      // claims promotion eliminates. A rule that holds for one survivor and
      // silently breaks for two is not a rule.
      this.tabs = remaining.map((entry) =>
        rest.some((extra) => extra.id === entry.id)
          ? { ...entry, parentId: undefined }
          : entry
      );
      if (this.activeId === id) this.activeId = promoted.id;
    } else {
      this.tabs = remaining;
      if (this.activeId === id) {
        this.activeId = this.topLevel().at(-1)?.id ?? null;
      }
    }
    this.onChange?.();
  }

  activate(id: string): void {
    if (this.tabs.some((entry) => entry.id === id)) {
      this.activeId = id;
      this.onChange?.();
    }
  }

  cycle(direction: 1 | -1): void {
    // Cycles TABS, never panes: a split's right half is reached with the
    // focus chord, not by tabbing past it.
    const tabs = this.topLevel();
    if (tabs.length === 0) return;
    const index = tabs.findIndex((entry) => entry.id === this.activeId);
    const next = (index + direction + tabs.length) % tabs.length;
    this.activeId = tabs[next]!.id;
    this.onChange?.();
  }

  active(): ManagedTab | null {
    return this.tabs.find((entry) => entry.id === this.activeId) ?? null;
  }

  /** Tabs the strip shows — splits are panes, not tabs. */
  topLevel(): readonly ManagedTab[] {
    return this.tabs.filter((entry) => entry.parentId === undefined);
  }

  /** The right-hand pane of a tab, if it has been split. */
  splitOf(tabId: string): ManagedTab | null {
    return this.tabs.find((entry) => entry.parentId === tabId) ?? null;
  }

  list(): readonly ManagedTab[] {
    return this.tabs;
  }

  disposeAll(): void {
    for (const tab of this.tabs) tab.session.dispose();
    this.tabs = [];
    this.activeId = null;
  }
}
