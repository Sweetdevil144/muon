import path from "node:path";
import { redactToolDetail, type MemoryToolCallEvidence } from "@muon/core";
import {
  boundToolActivityPaths,
  type LaneEvent,
  type ToolActivityDetail,
} from "@muon/protocol";

/** A bounded tool lifecycle observed directly from a vendor machine stream. */
export type MemoryToolObservation = {
  provider: string;
  itemId?: string;
  tool: string;
  phase: "completed" | "failed";
  paths: string[];
  detail?: ToolActivityDetail;
};

type StartedMutation = Omit<MemoryToolObservation, "phase">;

const OBSERVATION_MAX = 64;

function activityRecord(event: LaneEvent): Record<string, unknown> | undefined {
  const value = event.metadata.toolActivity;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedCoordinate(value: unknown, max = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
  return clean || undefined;
}

/**
 * Collect successful/failed Edit/Write-family lifecycles without retaining the
 * final assistant prose. A `started` row holds args+paths; a terminal row proves
 * the tool actually ran and contributes its bounded result.
 */
export function createMemoryToolEvidenceCollector(): {
  observe: (event: LaneEvent) => void;
  snapshot: () => MemoryToolObservation[];
} {
  const started = new Map<string, StartedMutation>();
  const completed: MemoryToolObservation[] = [];

  return {
    observe: (event) => {
      const activity = activityRecord(event);
      if (!activity) return;
      const provider = boundedCoordinate(activity.provider, 64);
      const tool = boundedCoordinate(activity.tool, 128);
      const itemId = boundedCoordinate(activity.itemId, 256);
      const phase = boundedCoordinate(activity.phase, 32);
      if (!provider || !tool || !phase) return;
      // Repeat the protocol boundary here: current adapters already bound this
      // field, but a hostile or stale driver must not make pending capture hold
      // an unbounded path array or coordinate.
      const paths = boundToolActivityPaths(activity.paths);
      const detail = redactToolDetail(activity.detail);
      const key = itemId ? `${provider}:${itemId}` : undefined;

      if (phase === "started") {
        if (activity.fileMutation !== true || !key || paths.length === 0)
          return;
        if (started.size >= OBSERVATION_MAX) {
          started.delete(started.keys().next().value ?? "");
        }
        started.set(key, {
          provider,
          itemId,
          tool,
          paths,
          ...(detail ? { detail } : {}),
        });
        return;
      }
      if (phase !== "completed" && phase !== "failed") return;

      const prior = key ? started.get(key) : undefined;
      if (activity.fileMutation !== true && !prior) return;
      if (key) started.delete(key);
      const effectivePaths = paths.length > 0 ? paths : (prior?.paths ?? []);
      if (effectivePaths.length === 0 || completed.length >= OBSERVATION_MAX)
        return;
      const args = prior?.detail?.args ?? detail?.args;
      const argsTruncated = prior?.detail?.args
        ? prior.detail.argsTruncated
        : detail?.argsTruncated;
      const result = detail?.result ?? prior?.detail?.result;
      const resultTruncated = detail?.result
        ? detail.resultTruncated
        : prior?.detail?.resultTruncated;
      completed.push({
        provider,
        ...(itemId ? { itemId } : {}),
        tool: prior?.tool ?? tool,
        phase,
        paths: effectivePaths,
        ...(args || result
          ? {
              detail: {
                ...(args ? { args, argsTruncated } : {}),
                ...(result ? { result, resultTruncated } : {}),
              },
            }
          : {}),
      });
    },
    snapshot: () =>
      completed.map((entry) => ({ ...entry, paths: [...entry.paths] })),
  };
}

function normalizeModule(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Turn vendor coordinates into memory evidence only after two independent
 * proofs agree: containment inside the governed worktree and exact membership
 * in git's observed changed-file set. Prose and caller-supplied module lists
 * are never consulted.
 */
export function groundMemoryToolEvidence(input: {
  observations: readonly MemoryToolObservation[];
  worktreeCwd: string | undefined;
  changedFiles: readonly string[];
}): MemoryToolCallEvidence[] {
  if (!input.worktreeCwd || input.changedFiles.length === 0) return [];
  const root = path.resolve(input.worktreeCwd);
  const changed = new Set(input.changedFiles.map(normalizeModule));
  const out: MemoryToolCallEvidence[] = [];

  for (const observation of input.observations) {
    const modules = new Set<string>();
    for (const raw of observation.paths) {
      const resolved = path.resolve(root, raw);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
        continue;
      const module = normalizeModule(path.relative(root, resolved));
      if (module && changed.has(module)) modules.add(module);
    }
    if (modules.size === 0) continue;
    out.push({
      tool: observation.tool,
      outcome: observation.phase,
      modules: [...modules],
      ...(observation.detail?.args ? { args: observation.detail.args } : {}),
      ...(observation.detail?.result
        ? { result: observation.detail.result }
        : {}),
    });
  }
  return out;
}
