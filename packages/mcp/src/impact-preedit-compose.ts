/**
 * Shared `code_impact` → blast-radius composition. `memory_preedit` documents
 * "fuse governed memory over the code-graph blast radius" as the pattern; two
 * tools now actually PLUMB a `code_impact` result into it — `preflight_edit`
 * (which additionally requires runner scope and records signed job-scoped
 * coverage) and `impact_memory` (which needs neither). Extracted here so the
 * mapping from a raw GitNexus `impact` result to MUON's module/symbol blast
 * radius, and the fail-closed risk/freshness gate, have exactly ONE
 * implementation instead of two that can drift.
 */
import { gitnexusUidToLocalSymbolId, toSymbolId } from "@muon/graph";

export type ImpactRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ImpactGateFailure = {
  reason: string;
  humanDecisionRequired?: boolean;
  degradation?: { active: true; reason: string; action: string };
  nextActions?: string[];
};

export type ImpactGateResult =
  | { ok: true; risk: "LOW" | "MEDIUM"; graphCommit: string; headCommit: string }
  | { ok: false; failure: ImpactGateFailure };

/**
 * Fail-closed on HIGH/CRITICAL/unusable risk or a stale/unverifiable index —
 * byte-for-byte the gate `preflight_edit` has always enforced. A caller that
 * receives `ok: false` must stop; nothing here ever widens or retries.
 */
export function gateImpactResult(
  impactResult: Record<string, unknown>,
  repo: Record<string, unknown>,
  gitCommitsMatch: (a: string, b: string) => boolean
): ImpactGateResult {
  const risk =
    typeof impactResult.risk === "string"
      ? impactResult.risk.toUpperCase()
      : "";
  if (risk === "HIGH" || risk === "CRITICAL") {
    return {
      ok: false,
      failure: {
        reason: `GitNexus reported ${risk} upstream impact; stop and review the blast radius before editing.`,
        humanDecisionRequired: true,
        degradation: {
          active: true,
          reason: `${risk} impact is not eligible for automatic edit coverage`,
          action:
            "Report direct callers and affected processes/modules to the human before proceeding.",
        },
        nextActions: [
          "Report the HIGH/CRITICAL blast radius and wait for direction.",
        ],
      },
    };
  }
  if (risk !== "LOW" && risk !== "MEDIUM") {
    return {
      ok: false,
      failure: { reason: "GitNexus did not return a usable impact risk" },
    };
  }
  const graphCommit =
    typeof repo.graphCommit === "string" ? repo.graphCommit : undefined;
  const headCommit =
    typeof repo.headCommit === "string" ? repo.headCommit : undefined;
  if (
    !graphCommit ||
    !headCommit ||
    !gitCommitsMatch(graphCommit, headCommit) ||
    repo.stale !== false
  ) {
    return {
      ok: false,
      failure: {
        reason:
          "GitNexus impact is stale or its indexed commit could not be verified",
      },
    };
  }
  return { ok: true, risk: risk as "LOW" | "MEDIUM", graphCommit, headCommit };
}

export type ImpactBlastRadius = {
  targetName?: string;
  targetFile?: string;
  /** Canonical local symbol id, absent when the module cannot safely form one. */
  targetSymbol?: string;
  /** Undefined unless GitNexus's own `target.id` uid parses onto the SAME
   *  local id independently derived from `target.filePath`/`target.name`. */
  targetUid?: string;
  modules: string[];
  symbols: string[];
  /**
   * local symbol id -> GitNexus uid, harvested from the target plus every
   * `byDepth` row that carried an `id`. Feeds the D2 option B `symbolUid`
   * cache; empty when GitNexus omitted ids or none mapped onto the SAME local
   * id independently built from that row's own `filePath`/`name` (the
   * cross-check that keeps a cached uid from ever pointing at the wrong
   * symbol).
   */
  symbolUidByLocalId: ReadonlyMap<string, string>;
};

/**
 * Extract the blast-radius module/symbol sets (plus, best-effort, the
 * GitNexus uid for every symbol resolved) from a raw `code_impact` result.
 * `declaredFiles` seeds the module set so a caller's own extra edit-target
 * files (`preflight_edit`'s `files` argument) survive the fold.
 *
 * `sanitize` is the caller's own coordinate scrubber (bounded length + no
 * control chars) — injected rather than imported, so this module stays free
 * of a dependency back onto `handlers.ts` and there remains exactly ONE
 * coordinate-sanitization rule in the tree.
 */
export function extractImpactBlastRadius(
  impactResult: Record<string, unknown>,
  declaredFiles: readonly string[],
  sanitize: (value: unknown) => string | undefined
): ImpactBlastRadius {
  const blastRadiusFiles = new Set<string>(declaredFiles);
  const coveredSymbols = new Set<string>();
  const symbolUidByLocalId = new Map<string, string>();
  let targetName: string | undefined;
  let targetFile: string | undefined;
  let targetSymbol: string | undefined;
  let targetUid: string | undefined;

  const addImpactNode = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const filePath =
      typeof node.filePath === "string" ? sanitize(node.filePath) : undefined;
    const name =
      typeof node.name === "string" ? sanitize(node.name) : undefined;
    const uid = typeof node.id === "string" ? node.id : undefined;
    if (filePath) blastRadiusFiles.add(filePath);
    if (!filePath || !name) return;
    const localId = toSymbolId(filePath, name);
    if (!localId) return;
    coveredSymbols.add(localId);
    if (uid && gitnexusUidToLocalSymbolId(uid) === localId) {
      symbolUidByLocalId.set(localId, uid);
    }
  };

  if (impactResult.target && typeof impactResult.target === "object") {
    const target = impactResult.target as Record<string, unknown>;
    targetName =
      typeof target.name === "string" ? sanitize(target.name) : undefined;
    targetFile =
      typeof target.filePath === "string"
        ? sanitize(target.filePath)
        : undefined;
    addImpactNode(target);
    if (targetFile && targetName) {
      targetSymbol = toSymbolId(targetFile, targetName) ?? undefined;
      targetUid = targetSymbol
        ? symbolUidByLocalId.get(targetSymbol)
        : undefined;
    }
  }
  if (impactResult.byDepth && typeof impactResult.byDepth === "object") {
    for (const rows of Object.values(
      impactResult.byDepth as Record<string, unknown>
    )) {
      if (Array.isArray(rows)) rows.forEach(addImpactNode);
    }
  }

  return {
    targetName,
    targetFile,
    targetSymbol,
    targetUid,
    modules: [...blastRadiusFiles].sort().slice(0, 128),
    symbols: [...coveredSymbols].sort().slice(0, 512),
    symbolUidByLocalId,
  };
}
