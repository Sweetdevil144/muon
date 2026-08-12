import type { KeyboardEvent } from "react";
import type { GitNexusRepoStatus } from "../shared/ipc.js";

// Multi-repo "Open Graph" tab strip: Auto Repository Detection can resolve a
// workspace to several independently-indexed git repos (a monorepo of
// separate repos), each with its own `.gitnexus/` store. One tab per repo,
// Quiet hairline strip + keyboard arrow-key nav (mirrors workspace-tabs.tsx's
// pattern) + a subtle crew-liveness-style status dot per repo, reusing the
// SAME `.activity-dot` vocabulary the crew rail already renders (styles.css).
// Rendered only when there is more than one repo; single-repo workspaces keep
// today's tab-free "Open Graph" behavior untouched.

/**
 * Crew-liveness dot class per repo status. `ready`+`stale` reads as "stalled"
 * (indexed, but HEAD has since moved — a re-index is due), matching the same
 * nuance `gitnexus-status.tsx`'s `detail()` already surfaces in text ("re-
 * indexing soon"). Pure so the mapping is unit-testable without mounting Sigma.
 */
export function repoDotClass(repo: GitNexusRepoStatus): string {
  if (repo.status === "error") return "needs-attention";
  if (repo.status === "indexing") return "live";
  if (repo.status === "ready") return repo.stale ? "stalled" : "done";
  return "queued"; // idle / unknown: not indexed yet
}

/**
 * Pick which repo tab should be active: keep the current selection if it
 * still exists in the (possibly refreshed) repo list, else fall back to the
 * first repo, else undefined (no repos → single-repo/no-tabs mode). Pure so
 * the selection rule is unit-testable without mounting Sigma.
 */
export function defaultRepoPath(
  repos: GitNexusRepoStatus[],
  currentPath: string | undefined
): string | undefined {
  if (currentPath && repos.some((r) => r.path === currentPath)) {
    return currentPath;
  }
  // Prefer a repo whose index is actually BUILT (`ready`) so the graph isn't
  // empty; a still-indexing / not-yet-indexed member would read "no graph yet".
  const ready = repos.find((r) => r.status === "ready");
  return (ready ?? repos[0])?.path;
}

export function GraphRepoTabs(props: {
  repos: GitNexusRepoStatus[];
  activePath: string | undefined;
  onSelect: (path: string) => void;
}) {
  const { repos, activePath, onSelect } = props;

  const move = (event: KeyboardEvent<HTMLButtonElement>, currentPath: string) => {
    const index = repos.findIndex((r) => r.path === currentPath);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % repos.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + repos.length) % repos.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = repos.length - 1;
    else return;
    event.preventDefault();
    onSelect(repos[next]!.path);
  };

  return (
    <div
      aria-label="Graph repositories"
      className="graph-repo-tabs"
      role="tablist"
    >
      {repos.map((repo) => {
        const selected = repo.path === activePath;
        return (
          <button
            key={repo.path}
            aria-selected={selected}
            className={"graph-repo-tab" + (selected ? " active" : "")}
            onClick={() => onSelect(repo.path)}
            onKeyDown={(event) => move(event, repo.path)}
            role="tab"
            tabIndex={selected ? 0 : -1}
            title={repo.path}
            type="button"
          >
            <span
              aria-hidden="true"
              className={`activity-dot ${repoDotClass(repo)}`}
            />
            <span className="graph-repo-tab-name">{repo.name}</span>
            {typeof repo.symbolCount === "number" && repo.symbolCount > 0 ? (
              <span className="graph-repo-tab-count">
                {repo.symbolCount.toLocaleString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
