import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codexGuardHomePath } from "@muon/adapters";

/**
 * DEAD-BUTTON GUARD — is this job's recorded vendor session ACTUALLY in the
 * vendor's own session store, right now?
 *
 * The defect class this closes: MUON stamps a session id at dispatch time and
 * the desktop offers "Open this job's real <vendor> session" on the strength
 * of that column alone. Between the stamp and the click, reality can diverge —
 * the founder's exact hit was a codex app-server thread started `ephemeral`
 * (codex never saved it at all), and the button answered with codex's own
 * `ERROR: No saved session found with ID …`. Other members of the class: a
 * pruned worktree (claude keys its store off the cwd), a cleaned tmpdir
 * (codex rollouts live under MUON's guard home), and a store trimmed by the
 * vendor itself. A resume affordance must never offer a session that cannot
 * be resumed, so the HOST checks the vendor's store before the button exists
 * — and again at spawn time, because the renderer is untrusted and hiding a
 * button is not a boundary.
 *
 * READ-ONLY by construction: this module only ever stats/lists the stores the
 * vendors themselves write. It never creates, touches, or repairs anything in
 * `~/.claude` or the codex guard home.
 */

export type VendorSessionStoreCheck =
  | { ok: true; evidencePath: string }
  | {
      ok: false;
      reason: string;
      /**
       * CAN THIS ANSWER CHANGE ON ITS OWN? — the store's half of "not yet" vs
       * "no", stated HERE because this is the only place that knows which fact
       * the refusal is about.
       *
       * `true` only for a store MISS: the vendor writes its session file at
       * its own pace (a `codex exec` rollout appeared about 3 seconds into a
       * 30-second run), so a miss while the child is still writing is a race.
       * `false` for everything the vendor will never fix by carrying on — an
       * unrecorded cwd, a worktree that has been merged and pruned, a vendor
       * with no reopenable session at all.
       *
       * REQUIRED, not optional, and not derived by subtraction from the miss
       * branches: the caller turns this into a "can't be opened YET" plus 40
       * seconds of polling and a "Check again" button, and a refusal that
       * forgot to classify itself would offer all three about a directory that
       * no longer exists. A new refusal is a compile error until someone says
       * which it is.
       */
      transient: boolean;
    };

/** Filesystem seam so tests never depend on this machine's real stores. */
export type StoreFs = {
  exists: (target: string) => boolean;
  /** Directory listing; a missing/unreadable dir returns []. */
  list: (dir: string) => { name: string; isDirectory: boolean }[];
  /** Resolve symlinks (claude slugs the REAL path); null when unresolvable. */
  realpath: (target: string) => string | null;
};

const realStoreFs: StoreFs = {
  exists: (target) => existsSync(target),
  list: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  realpath: (target) => {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  },
};

/**
 * Claude Code's project-store directory name for one cwd: every character
 * outside [A-Za-z0-9] becomes `-`. Verified against the live store on this
 * machine: `/Users/dev/code/muon/.muon/worktrees/<id>` →
 * `-Users-dev-code-muon--muon-worktrees-<id>` (both `/` and `.` map
 * to `-`; existing hyphens survive because `-` maps to itself).
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Claude's config ROOT — `CLAUDE_CONFIG_DIR` when the operator relocated it,
 * else `~/.claude`.
 *
 * The same env key vendor-models.ts already reads for the same reason, and a
 * declared vendor env key (packages/protocol/src/vendor.ts) that MUON forwards
 * to the child — so a dispatch under a relocated config writes its transcript
 * there, and looking only under `~/.claude` would report a perfectly resumable
 * session as gone. Read-only: nothing here creates the directory.
 */
function claudeConfigDir(input: {
  home: string;
  configDir: string | null;
}): string {
  return input.configDir ?? path.join(input.home, ".claude");
}

/**
 * Where claude MAY have written this session's transcript. Two candidates
 * because claude slugs the cwd AS RESOLVED: a dispatch under `/tmp/...` lands
 * under the `/private/tmp/...` slug on macOS, while the job record often
 * carries the unresolved spelling. Checking both is cheaper and more honest
 * than guessing which spelling the vendor saw.
 */
export function claudeTranscriptCandidates(input: {
  home: string;
  /** `CLAUDE_CONFIG_DIR`, or null to use `<home>/.claude`. */
  configDir?: string | null;
  cwd: string;
  realCwd: string | null;
  sessionId: string;
}): string[] {
  const root = claudeConfigDir({
    home: input.home,
    configDir: input.configDir ?? null,
  });
  const cwds = new Set([input.cwd, ...(input.realCwd ? [input.realCwd] : [])]);
  return [...cwds].map((cwd) =>
    path.join(
      root,
      "projects",
      claudeProjectSlug(cwd),
      `${input.sessionId}.jsonl`
    )
  );
}

/** Hard cap on rollout-store entries inspected; the walk is date-sharded
 *  (`sessions/YYYY/MM/DD/`), so even a busy store stays far below this. */
const CODEX_ROLLOUT_SCAN_CAP = 20_000;

/**
 * The rollout file codex saved for one session id, under one CODEX_HOME —
 * `sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl` (measured,
 * 0.145.0) — or null when the store has none. Newest date shards first, so
 * the common hit (a session dispatched today) answers after one directory.
 */
export function findCodexRolloutFile(
  codexHome: string,
  sessionId: string,
  fs: StoreFs = realStoreFs
): string | null {
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  let inspected = 0;
  const walk = (dir: string, depth: number): string | null => {
    const entries = fs.list(dir);
    // Date-sharded directories sort lexicographically = chronologically;
    // newest first finds a fresh dispatch immediately.
    const ordered = [...entries].sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of ordered) {
      if ((inspected += 1) > CODEX_ROLLOUT_SCAN_CAP) return null;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory) {
        if (depth >= 3) continue; // sessions/ is exactly YYYY/MM/DD deep
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      } else if (entry.name.toLowerCase().endsWith(suffix)) {
        return full;
      }
    }
    return null;
  };
  return walk(path.join(codexHome, "sessions"), 0);
}

/**
 * The verdict, with the honest sentence a refusal must carry. `cwd` is where
 * the job actually ran (`executionPath ?? workspacePath`) — claude keys its
 * store off it, and BOTH vendors need it alive to reopen a session in it.
 *
 * `mode` changes NOTHING about what is checked — resume and fork read the same
 * transcript, so one store fact answers both. It changes the refusal's WORDING
 * and its TENSE, and both matter:
 *
 *  - the COMMAND, because telling a human "`codex resume` would refuse it"
 *    about a button labelled fork is the same class of small lie this module
 *    exists to stop;
 *  - the TENSE, because a fork is only ever asked for while the job is still
 *    RUNNING, and a running job's store entry appears at the VENDOR's pace, not
 *    at the dispatch's. Measured on this machine: a live claude session's
 *    `<uuid>.jsonl` and a mid-turn `codex exec` rollout both exist while the
 *    child is still writing them — but the codex rollout took about 3 seconds
 *    of a 30-second run to appear at all. A miss inside that window is a race,
 *    so a running job's refusal says "not yet", never "cannot".
 */
export function verifyVendorSessionInStore(
  input: {
    vendor: string;
    sessionId: string;
    cwd: string | null;
    mode?: "resume" | "fork";
  },
  deps: {
    fs?: StoreFs;
    home?: string;
    /** Claude's config root. Undefined reads `CLAUDE_CONFIG_DIR`; null forces
     *  the `<home>/.claude` default (tests pin one or the other). */
    configDir?: string | null;
    codexHome?: string;
  } = {}
): VendorSessionStoreCheck {
  const fs = deps.fs ?? realStoreFs;
  const shortId = `${input.sessionId.slice(0, 8)}…`;
  // WORDING ONLY. An absent mode falls back to the resume phrasing because
  // that is the door MUON has always offered; a caller that forgets it gets a
  // slightly generic sentence, never a different verdict.
  const fork = input.mode === "fork";
  if (!input.cwd) {
    // NOT TRANSIENT: the execution path is stamped at launch, so a job that
    // reached this point without one will not acquire one by running longer.
    return {
      ok: false,
      reason:
        "MUON recorded a vendor session for this job but not where it ran, so the session cannot be reopened in its own directory.",
      transient: false,
    };
  }
  // Both vendors reopen IN the job's directory; a pruned worktree is the
  // most common way a recorded session stops being resumable.
  if (!fs.exists(input.cwd)) {
    // NOT TRANSIENT: a merged-and-pruned worktree does not come back, and
    // reporting it as "not yet" bought the human 21 probes over 40 seconds and
    // a "Check again" that answers identically forever.
    return {
      ok: false,
      reason: `This job's working directory no longer exists (${input.cwd}) — its worktree was likely merged and pruned — so the recorded session cannot be reopened where it ran.`,
      transient: false,
    };
  }
  if (input.vendor === "claude-code") {
    const candidates = claudeTranscriptCandidates({
      home: deps.home ?? homedir(),
      // Same resolution vendor-models.ts uses for the settings cascade: an
      // operator who relocated Claude's config still has resumable sessions,
      // and this check is what decides whether the button exists.
      configDir:
        deps.configDir !== undefined
          ? deps.configDir
          : process.env["CLAUDE_CONFIG_DIR"]?.trim() || null,
      cwd: input.cwd,
      realCwd: fs.realpath(input.cwd),
      sessionId: input.sessionId,
    });
    const hit = candidates.find((candidate) => fs.exists(candidate));
    if (hit) {
      return { ok: true, evidencePath: hit };
    }
    return {
      ok: false,
      // A FORK is only ever asked for while the job is still RUNNING, and a
      // running job's transcript may simply not be on disk yet. Same fact,
      // different tense: "not yet" for a race, "no" for a verdict.
      reason: fork
        ? `Claude has not written this job's session (${shortId}) into its own store in this directory yet, so \`claude --resume --fork-session\` would refuse it right now. MUON will offer the fork as soon as the transcript appears.`
        : `MUON recorded Claude session ${shortId}, but Claude's own session store has no transcript for it in this job's directory. \`claude --resume\` would refuse it, so MUON is not offering it.`,
      // A STORE MISS is the one refusal a still-running vendor can undo by
      // itself, so it is the one that may be worded as a wait.
      transient: true,
    };
  }
  if (input.vendor === "codex") {
    // A MUON-dispatched codex session's rollout lives under the ISOLATED
    // guard home (codex-guard.ts), the same home the resume spawn points
    // CODEX_HOME at — so this checks exactly the store `codex resume` will
    // search.
    const rollout = findCodexRolloutFile(
      deps.codexHome ?? codexGuardHomePath(),
      input.sessionId,
      fs
    );
    if (rollout) {
      return { ok: true, evidencePath: rollout };
    }
    return {
      ok: false,
      reason: fork
        ? `Codex has not saved this job's session (${shortId}) to its own rollout store yet — measured on this machine, a \`codex exec\` rollout appeared about 3 seconds into a run — so \`codex fork\` would refuse it right now. MUON will offer the fork as soon as the rollout appears.`
        : `MUON recorded Codex session ${shortId}, but Codex's own session store has no saved rollout for it (sessions dispatched before rollout persistence shipped were never saved by Codex, and the store lives in the OS temp area, which the OS may clear). \`codex resume\` would refuse it, so MUON is not offering it.`,
      // Same race as claude's, and the one this number was measured for.
      transient: true,
    };
  }
  // NOT TRANSIENT: a vendor does not grow a session store while a job runs.
  return {
    ok: false,
    reason: `Sessions on '${input.vendor}' cannot be reopened in a terminal — the vendor's CLI has no session resume for MUON to drive.`,
    transient: false,
  };
}
