import {
  terminalTakeoverVendorIds,
  vendorShortLabel,
  type VendorId,
} from "./vendors.js";
import type { VendorReadiness } from "./types.js";

/**
 * The vendor tab bar's single source of truth, renderer-safe (registry +
 * literals only — no process.env, no adapters import).
 *
 * `VENDOR_TERMINAL_COMMANDS` moved here FROM terminal-spawn.ts so the picker
 * the human sees and the allowlist the host spawns from can never drift: the
 * host builds its spawn table from this exact record (terminal-spawn.ts), and
 * the strip builds its buttons from the same one. Same rules as before the
 * move: TOTAL over `VendorId` (ADR-0022 §3.4 mechanism 4 — `null` is a
 * statement, so a new vendor cannot acquire a pty by being forgotten), and
 * `file` must be a binary the registry lists under
 * `execution.commandCandidates`, never the wider `readiness.installedCandidates`
 * (the bare `cursor` IDE launcher counts as installed and must never be
 * spawned — ADR-0022 §6.7).
 */
export type TerminalCommand = { file: string; args: readonly string[] };

export const VENDOR_TERMINAL_COMMANDS: Readonly<
  Record<VendorId, TerminalCommand | null>
> = {
  "claude-code": { file: "claude", args: [] },
  codex: { file: "codex", args: [] },
  // `cursor-agent`, NEVER the bare `cursor` IDE launcher (ADR-0022 §6.7). The
  // launcher is `/Applications/Cursor.app/…/bin/code` behind a symlink: it
  // opens a new IDE window/tab and returns immediately, so spawning it here
  // would give a human one dead pane per click and one more IDE tab per click.
  // Re-verified live (2026-07-27, cursor-agent 2026.07.08) through this exact
  // table → resolveTerminalSpawn → node-pty: the agent CLI paints its own
  // interactive TUI in the pane, accepts keystrokes, reflows on resize, and
  // STAYS — see CURSOR_FIRST_RUN_HINT for the one first-run trap it carries.
  cursor: { file: "cursor-agent", args: [] },
  // Bare `opencode` IS the interactive TUI (live-verified 1.18.5); the
  // dispatch side's one-shot `run` invocation is the adapter's business, not
  // this table's. Human terminal only — see the registry entry's
  // terminalTakeover note for why this is not a governance grant.
  opencode: { file: "opencode", args: [] },
  fake: null,
};

/** The plain-shell kind. NOT a vendor: it is the operator's own login shell,
 *  outside the registry-gated vendor set. */
export const SHELL_TERMINAL_KIND = "shell";

/**
 * The one first-run trap the Cursor agent CLI carries, stated where the human
 * is about to click.
 *
 * Measured (2026-07-27, cursor-agent 2026.07.08 on a real pty): the first run
 * in an untrusted directory paints a full-screen "Workspace Trust Required"
 * prompt — "[a] Trust this workspace / [q] Quit" — and it enables NO mouse
 * reporting whatsoever (the only private mode it sets is `?25l`, hide cursor).
 * A mouse click on that prompt therefore cannot reach it: the prompt sits
 * there, nothing happens, and the natural human read is "this pane is broken,
 * let me open another one" — which is exactly the loop of new Cursor tabs the
 * founder hit. The prompt is keyboard-only, so MUON says so BEFORE the click
 * instead of letting the pane teach it by failing.
 *
 * The interactive terminal pane never passes `--trust`/`--yolo` on the human's
 * behalf. A governed read-only review lane *does* pass `--trust` (see
 * `CursorAdapter.taskCommand`) and may already have written
 * `~/.cursor/projects/<slug>/.workspace-trusted` for this folder — in that case
 * the prompt below will not appear. The hint is for folders that have never been
 * trusted by either path.
 */
export const CURSOR_FIRST_RUN_HINT =
  "If Cursor asks “Workspace Trust Required” on first open, it is keyboard-only — press `a` to trust (or arrow keys + Enter); mouse clicks do not reach it. A prior MUON cursor review may already have trusted this folder.";

/**
 * How long after a spawn an exit still means "it never really started".
 *
 * A vendor CLI that dies inside this window did not run a session — it failed
 * to launch (missing binary, unusable cwd, a `cursor-agent` that exits 0
 * because it is signed out). Shared by the RENDERER's tab-lifecycle decision
 * below and by the HOST's respawn guard (terminal-spawn.ts) so "immediately"
 * can never mean two different things on the two sides of the IPC bridge —
 * and both now measure it against the SAME number, the child's host-measured
 * lifetime that rides on the exit frame.
 */
export const TERMINAL_FAST_EXIT_MS = 4_000;

/**
 * Whether a human terminal tab should CLOSE ITSELF when its pty child exits.
 *
 * The defect this closes: the tab auto-closed on every exit, including an exit
 * that happened a second after the spawn. That erased the only evidence the
 * human had — the vendor's own last lines and the `[session exited: code N]`
 * marker — leaving a pane that "just vanished". The rational next move is to
 * click the vendor button again, which starts the whole thing over: an exit
 * that silently re-arms its own trigger.
 *
 * So: a session that ran and then finished (the human typed `exit`, the TUI
 * quit) closes its tab, exactly as before. A session that died in its first
 * seconds KEEPS its tab, with its output and exit code on screen, and the
 * human decides what to do next.
 *
 * The input is the CHILD'S LIFETIME, measured by the host at the OS-level
 * exit — not "how long ago this tab asked for a pty". Those differ by the
 * host's spawn latency (the node-pty load and the workspace lookup), and they
 * differ without bound when the exit is observed late: a pane that was
 * unmounted when its child died sees the replayed exit whenever the human
 * comes back, and judging by the renderer's clock would call a 300ms launch
 * failure a minute-long session and auto-close the tab that held the evidence.
 */
export function shouldCloseTerminalTabOnExit(input: {
  /** How long the child actually lived, host-measured (exit frame). */
  lifetimeMs: number;
}): boolean {
  return input.lifetimeMs > TERMINAL_FAST_EXIT_MS;
}

/**
 * Vendors a human terminal tab can actually spawn: registry-granted takeover
 * AND a declared command. Both must agree (terminal-spawn.ts enforces the
 * same conjunction host-side); a vendor missing either never gets a button —
 * a control that fails on click teaches the human nothing.
 */
export function spawnableTerminalVendorIds(): VendorId[] {
  return terminalTakeoverVendorIds().filter(
    (id) => VENDOR_TERMINAL_COMMANDS[id] !== null
  );
}

export type TerminalVendorMenuEntry = {
  /** The spawn KIND the renderer sends (a vendor id, or "shell"). */
  kind: string;
  /** Short label, also the tab's base name ("Claude", "Codex", "Terminal"). */
  label: string;
  /** False only on POSITIVE evidence the CLI is absent — the button then says
   *  why instead of spawning a session that dies unexplained. */
  enabled: boolean;
  /** Hover/assistive sentence: the install gap, the not-signed-in caveat, or
   *  null when there is nothing to add. */
  detail: string | null;
};

/**
 * The vendor tab bar entries: every spawnable vendor, states resolved from
 * the SAME readiness rows the crew surfaces read, plus the plain shell.
 *
 * State mapping is deliberately honest rather than strict:
 *  - readiness says NOT INSTALLED  → disabled, with the fix hint. The host
 *    would refuse anyway; a dead button with a reason beats a dead pane.
 *  - readiness says not signed in  → ENABLED. Opening the vendor's own TUI is
 *    exactly how the human fixes that (its own /login flow) — MUON drives the
 *    user's binary, never their credentials.
 *  - no readiness row / not probed → ENABLED. The registry grant is the real
 *    boundary; if the binary is missing the pane states it in one sentence.
 */
/**
 * The sentence a vendor button carries when MUON WILL open it. `base` is the
 * readiness caveat (or null when there is none); the per-vendor first-run note
 * is appended, never substituted — a signed-out Cursor needs both facts.
 */
function openableDetail(id: VendorId, base: string | null): string | null {
  const note = id === "cursor" ? CURSOR_FIRST_RUN_HINT : null;
  if (!note) {
    return base;
  }
  return base ? `${base} ${note}` : note;
}

export function buildTerminalVendorMenu(
  readiness: readonly VendorReadiness[] | null
): TerminalVendorMenuEntry[] {
  const entries: TerminalVendorMenuEntry[] = spawnableTerminalVendorIds().map(
    (id) => {
      const label = vendorShortLabel(id);
      const row = readiness?.find((entry) => entry.vendor === id) ?? null;
      if (row && !row.installed) {
        return {
          kind: id,
          label,
          enabled: false,
          detail:
            row.fixHint ??
            `The ${label} CLI is not installed, so MUON cannot open it here.`,
        };
      }
      if (row && !row.authenticated) {
        return {
          kind: id,
          label,
          enabled: true,
          detail: openableDetail(
            id,
            `${label} is not signed in yet — it opens with its own login prompt, and your keyboard is live to complete it.`
          ),
        };
      }
      return { kind: id, label, enabled: true, detail: openableDetail(id, null) };
    }
  );
  entries.push({
    kind: SHELL_TERMINAL_KIND,
    label: "Terminal",
    enabled: true,
    detail: null,
  });
  return entries;
}

/** Tab display name: "Claude", then "Claude 2" for the second session. */
export function terminalTabLabel(kind: string, ordinal: number): string {
  const base =
    kind === SHELL_TERMINAL_KIND ? "Terminal" : vendorShortLabel(kind);
  return ordinal > 1 ? `${base} ${ordinal}` : base;
}

/**
 * The ordinal for the NEXT tab of `kind`: max live ordinal + 1, so a second
 * click on the same vendor opens a distinct numbered session (and closing
 * "Claude" while "Claude 2" lives can never mint a colliding id).
 */
export function nextTerminalOrdinal(
  existing: ReadonlyArray<{ kind: string; ordinal: number }>,
  kind: string
): number {
  let max = 0;
  for (const tab of existing) {
    if (tab.kind === kind && tab.ordinal > max) {
      max = tab.ordinal;
    }
  }
  return max + 1;
}

/**
 * The env-var names MUON's OWN control plane contributes — the set a spawned
 * human terminal must NEVER inherit, whatever the kind.
 *
 * CANONICAL HOME. The desktop's `terminal-spawn.ts` carried this list first
 * (with the 40-line essay on why an allowlist would be wrong: a human's
 * terminal must feel like their own shell, so only MUON's OWN contribution is
 * enumerable and stripped). The TUI's pty spawner shipped without any strip —
 * every pane inherited the operator's bearer token, so anything running in an
 * UNGOVERNED pane could call the loopback brain with operator authority. That
 * is the cross-surface drift this module was moved to client to prevent,
 * violated at the one boundary that carries real authority. Now the list
 * lives here and both surfaces consume it.
 */
export const MUON_CONTROL_PLANE_ENV_VARS = [
  "MUON_API_TOKEN",
  "MUON_OPERATOR_TOKEN",
  "MUON_OPERATOR_TOKEN_KEYCHAIN",
  "MUON_AGENT_TOKEN",
  "MUON_DELEGATION_TOKEN",
  "MUON_RUNNER_LEASE_TOKEN",
  "MUON_GITHUB_TOKEN",
  "MUON_GITHUB_REFRESH_TOKEN",
] as const;

const STRIPPED_SET: ReadonlySet<string> = new Set(MUON_CONTROL_PLANE_ENV_VARS);
const AMBIENT_GITHUB_ENV: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

/**
 * Sanitize an environment for a spawned human terminal.
 *
 * - MUON's control-plane names are ALWAYS stripped, plus a `MUON_*_TOKEN`
 *   backstop so a future token nobody added to the list is still stripped —
 *   the backstop can only ever strip MORE, never less.
 * - `kind: "vendor"` additionally strips the operator's ambient GitHub tokens
 *   (`GITHUB_TOKEN`/`GH_TOKEN`): a login SHELL keeps the user's own ambient
 *   authority, a vendor CLI does not get handed it.
 */
export function sanitizeSpawnEnv(
  base: Readonly<Record<string, string | undefined>>,
  opts: { readonly kind: "shell" | "vendor" }
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_SET.has(key)) continue;
    if (key.startsWith("MUON_") && key.endsWith("_TOKEN")) continue;
    if (opts.kind === "vendor" && AMBIENT_GITHUB_ENV.has(key)) continue;
    out[key] = value;
  }
  return out;
}
