import { useState } from "react";
import type { ReconMapResponse } from "../shared/ipc.js";

// ROADMAP 4.1b — Reconnaissance card: the repo_map the orchestrator reads to
// auto-size + partition a crew, made legible for the human (WHY N workers, WHAT
// each owns). Lazy: it only runs the graph reads when the human expands it, so
// the Mission view never spawns CLIs unprompted.

type CardState = "collapsed" | "loading" | ReconMapResponse;

export function ReconCard() {
  const [state, setState] = useState<CardState>("collapsed");

  const reconnoiter = () => {
    setState("loading");
    void window.muon
      .reconMap()
      .then((result) => setState(result))
      .catch((error) =>
        setState({
          status: "degraded",
          reason:
            error instanceof Error ? error.message : "Reconnaissance failed.",
        })
      );
  };

  if (state === "collapsed") {
    return (
      <button className="recon-card-trigger" onClick={reconnoiter}>
        <span className="recon-card-icon" aria-hidden>
          ◇
        </span>
        Reconnoiter this workspace — repo shape &amp; crew plan
      </button>
    );
  }
  if (state === "loading") {
    return (
      <div className="recon-card">
        <p className="session-empty loading-line">Reading the code graph…</p>
      </div>
    );
  }
  if (state.status === "degraded") {
    return (
      <div className="recon-card degraded">
        <header className="recon-card-head">
          <strong>Reconnaissance unavailable</strong>
          <button className="recon-card-close" onClick={() => setState("collapsed")}>
            ×
          </button>
        </header>
        <p>{state.reason}</p>
      </div>
    );
  }

  const { map, recommendation } = state;
  const confidenceTone =
    map.confidence === "full" ? "clear" : map.confidence === "partial" ? "warn" : "blind";
  return (
    <div className="recon-card">
      <header className="recon-card-head">
        <strong>Reconnaissance</strong>
        <span className={`recon-confidence ${confidenceTone}`}>{map.confidence}</span>
        <span className="recon-card-headline">
          {map.totals.repos} repo{map.totals.repos === 1 ? "" : "s"} ·{" "}
          {map.totals.symbols.toLocaleString()} symbols · {map.totals.clusters} clusters
        </span>
        <button className="recon-card-close" onClick={() => setState("collapsed")}>
          ×
        </button>
      </header>

      <div className="recon-crew-line">
        {recommendation.crewSize === 0 ? (
          <span>Small enough to examine directly — no crew needed.</span>
        ) : (
          <span>
            Recommends <strong>{recommendation.crewSize}</strong> worker
            {recommendation.crewSize === 1 ? "" : "s"}{" "}
            <span className="recon-cap">
              (cap {recommendation.caps.maxChildren} children ·{" "}
              {recommendation.caps.maxDescendants} descendants)
            </span>
          </span>
        )}
      </div>

      {recommendation.workUnits.length > 0 ? (
        <ul className="recon-units">
          {recommendation.workUnits.map((unit, i) => (
            <li key={`${unit.repoPath}:${i}`}>
              <span className="recon-unit-scope">{unit.scope || unit.repoPath}</span>
              <span className="recon-unit-paths">
                {unit.ownedPaths.slice(0, 3).join(", ")}
                {unit.ownedPaths.length > 3 ? " …" : ""}
              </span>
              <span className="recon-unit-symbols">{unit.symbolCount} sym</span>
            </li>
          ))}
        </ul>
      ) : null}

      {map.repos.map((repo) => (
        <div key={repo.path} className="recon-repo">
          <div className="recon-repo-head">
            <code>{repo.name}</code>
            <span className="recon-repo-meta">
              {repo.totals.symbols.toLocaleString()} sym · {repo.clusters.length}
              {repo.clustersTruncated ? "+" : ""} clusters ·{" "}
              {repo.languages.slice(0, 4).join(", ")}
            </span>
            {repo.degraded ? (
              <span className="recon-degraded">{repo.degraded}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
