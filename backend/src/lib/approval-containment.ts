import path from "node:path";
import { managedWorktreesRoot, taskWorktreePath } from "@muon/core";
import { classifyToolAction } from "@muon/protocol";
import { realpathOfNearestExisting, isWithin } from "./workspace.js";

// ── S0-2: an isolated worktree that nothing enforces is not isolation ────────
//
// A governed job with `harness.requires.worktree` is executed in MUON's
// per-repository external worktree store and the runner records that exact tree
// as the job's `executionPath`. Nothing downstream checked it. A child that
// learned the PRIMARY checkout's absolute paths (from a code-graph tool, from
// its own `cd`) could file an approval to edit the operator's real tree, and an
// operator — or Full Auto — would approve it. The worktree stayed pristine, the
// packet reported `changedFiles: []`, and the work landed where nobody was
// reviewing it.
//
// This is the containment half of the fix: an approval whose action targets a
// path inside the job's REPOSITORY but outside the job's own execution tree is
// refused, on every surface, because the check lives at the one route that
// turns an approval into authority.
//
// Deliberately narrow, so it can only ever fire on the escape it names:
//
//   • No `executionPath` → no claim to enforce. A pre-0039 row means UNKNOWN,
//     and refusing everything unknown would fail closed on the wrong axis.
//   • With persisted workspace/task coordinates, an `executionPath` that is
//     neither today's deterministic task tree, a legacy
//     `.muon/worktrees/<name>` tree, nor the workspace itself is unverified and
//     fails closed. A path/config mismatch cannot manufacture authority.
//   • Only paths under the job's own repository count. `/usr/bin/git` in a
//     command is not an isolation escape, and refusing it would block ordinary
//     work; `<repoRoot>/apps/cli/README.md` from a worktree-bound job is
//     exactly the escape, and always is.
//   • A PROVABLY read-class action is not an escape at all. The escape this
//     module exists to stop is a child EDITING the operator's real tree (see
//     the paragraph above — "could file an approval to edit the operator's
//     real tree"). A `Read`/`Grep`/`Glob` of the primary checkout mutates
//     nothing, and the bytes it returns are the same bytes the job's own
//     worktree already contains: the worktree is a checkout of that very
//     repository, so refusing the read protects no secret and hides no diff.
//     Measured cost of getting this wrong (2026-07-28, founder's live mission):
//     three worker `Read`s of paths their OWN briefs declared were rejected —
//     with the write-shaped reason "approving would write outside the tree",
//     which was simply false of a read — and the workers burned their wall
//     budget rediscovering their worktree path instead of doing the work.
//     Classification is fail-closed: only `classifyToolAction` returning
//     `read` exempts. `null` (unknown tool, any Bash, any `mcp__*`, a read
//     tool that also carries a command) enforces containment exactly as before.

/** How many `/`-rooted tokens one evidence string may contribute. */
const MAX_PATHS_PER_FIELD = 32;
/** Absolute POSIX-shaped path tokens inside free text (a shell command, a scope line). */
const ABSOLUTE_PATH_TOKEN = /(?:\/[A-Za-z0-9._~@+-]+)+\/?/g;

export type ExecutionContainment =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * The repository a governed worktree belongs to, derived from MUON's own
 * deterministic layout (`taskWorktreePath`). Returns undefined for any path
 * that is not such a tree — which is the signal that there is nothing to
 * contain.
 */
export function worktreeRepoRoot(executionPath: string): string | undefined {
  const marker = `${path.sep}.muon${path.sep}worktrees${path.sep}`;
  const at = executionPath.indexOf(marker);
  if (at <= 0) return undefined;
  return executionPath.slice(0, at);
}

function candidatePaths(evidence: unknown): string[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const record = evidence as Record<string, unknown>;
  const details =
    typeof record["details"] === "object" && record["details"] !== null
      ? (record["details"] as Record<string, unknown>)
      : {};

  const found: string[] = [];
  const harvest = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    // The structured write target is a path in its own right, not a token
    // inside prose — take it whole so a name containing an odd character is
    // still compared, never silently skipped.
    if (value.startsWith("/")) found.push(value);
    const matches = value.match(ABSOLUTE_PATH_TOKEN) ?? [];
    found.push(...matches.slice(0, MAX_PATHS_PER_FIELD));
  };

  harvest(details["path"]);
  harvest(record["scope"]);
  for (const [key, value] of Object.entries(details)) {
    if (key === "path") continue;
    harvest(value);
  }
  return [...new Set(found)];
}

/**
 * Is this approval's action PROVABLY a read?
 *
 * Reads the tool name the evidence recorded (`action`) and runs it through the
 * shared classifier. Anything the classifier cannot prove is read-class —
 * including a read tool that also carries a `command` — returns false, so the
 * containment check below runs exactly as it did before.
 */
function isProvenReadAction(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const record = evidence as Record<string, unknown>;
  const toolName = record["action"];
  if (typeof toolName !== "string" || toolName.length === 0) return false;

  const details =
    typeof record["details"] === "object" && record["details"] !== null
      ? (record["details"] as Record<string, unknown>)
      : {};
  const rawPath = details["path"];
  const rawCommand = details["command"];

  const classified = classifyToolAction({
    toolName,
    ...(typeof rawPath === "string" ? { path: rawPath } : {}),
    ...(typeof rawCommand === "string" ? { command: rawCommand } : {}),
  });
  return classified?.class === "read";
}

/**
 * Refuse an approval whose action reaches outside the tree the job actually
 * ran in. `evidence` is the approval's stored evidence blob; `executionPath` is
 * the runner-recorded, lease-fenced cwd.
 */
export function checkExecutionContainment(input: {
  executionPath: string | null | undefined;
  workspacePath?: string | null;
  taskId?: string | null;
  evidence: unknown;
}): ExecutionContainment {
  const recorded = input.executionPath?.trim();
  if (!recorded) return { ok: true };

  // A proven read grants no write authority — the evidence blob says so in its
  // own `impactIfApproved` — so it cannot be the escape this module names.
  // Derived from the SAME canonical classifier the receipt mint and the core
  // enforcement seam use, so "read" means one thing across all three.
  if (isProvenReadAction(input.evidence)) return { ok: true };

  const box = realpathOfNearestExisting(recorded);
  let repoRoot =
    worktreeRepoRoot(box) ?? worktreeRepoRoot(path.resolve(recorded));
  let managedFamily: string | undefined;
  let workspace: string | undefined;
  const recordedWorkspace = input.workspacePath?.trim();
  const recordedTaskId = input.taskId?.trim();
  if (recordedWorkspace && recordedTaskId) {
    workspace = realpathOfNearestExisting(recordedWorkspace);
    try {
      const expected = realpathOfNearestExisting(
        taskWorktreePath(workspace, recordedTaskId)
      );
      managedFamily = realpathOfNearestExisting(managedWorktreesRoot(workspace));
      if (!repoRoot && box === expected) repoRoot = workspace;
    } catch {
      // Invalid path configuration cannot manufacture authority. A legacy tree
      // still resolves above; any other non-workspace cwd is refused below.
    }
  }
  if (!repoRoot && workspace && box !== workspace) {
    return {
      ok: false,
      reason:
        `MUON cannot verify recorded execution path '${box}' as the workspace ` +
        `'${workspace}' or this task's exact managed worktree. It refuses approval ` +
        "until the runner records a path bound to the persisted job coordinates.",
    };
  }
  if (!repoRoot) return { ok: true };
  const repo = realpathOfNearestExisting(repoRoot);

  for (const candidate of candidatePaths(input.evidence)) {
    const resolved = realpathOfNearestExisting(candidate);
    const reachesPrimary = isWithin(repo, resolved);
    const reachesSibling =
      managedFamily !== undefined && isWithin(managedFamily, resolved);
    if (!reachesPrimary && !reachesSibling) continue;
    if (isWithin(box, resolved)) continue; // inside the job's own tree
    return {
      ok: false,
      reason:
        `This job runs in the isolated worktree '${box}', but the action targets ` +
        `'${resolved}' outside that tree (primary checkout '${repo}'). MUON refuses it: approving ` +
        `could mutate the tree outside the one the job's diff and review evidence are ` +
        `read from. Re-run the action against a path inside '${box}'. ` +
        `(Reading the primary checkout is allowed and never reaches this refusal — ` +
        `only an action MUON cannot prove is read-only does.)`,
    };
  }

  return { ok: true };
}
