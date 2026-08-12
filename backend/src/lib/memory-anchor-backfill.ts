import { Prisma } from "@prisma/client";
import { promoteResolvedPathEntities } from "./anchor-promotion.js";
import { coordinateResolverFor } from "./anchor-resolution.js";
import { prisma } from "./db.js";
import { repoRootOf } from "./workspace-identity.js";

// ── D15's one-shot retro-anchor backfill, DRY-RUN BY DEFAULT ──────────────────
//
// `docs/design/memory-index-decisions.md` §D15. Promotion at ingest
// (`anchor-promotion.ts`, wired into `noteCreateOps`) only ever helps the NEXT note.
// The measured debt is already written: **62 active notes name a tracked repo file
// in their prose and carry no module anchor at all** (`npm run health:memory`
// row 22, 2026-07-30; the design note estimated 63), against 33 notes that carry
// one. Draining that debt is what takes the coordinate layer from 33 to ~96
// anchored notes "with no agent behaving any differently".
//
// DRY-RUN BY DEFAULT, and for the same reason `backfillMemoryNoteWorkspace` is: this
// writes into the layer the pre-edit gate trusts, so an operator sees what it would
// write before it writes anything. `apply: true` is the only thing that writes.
//
// FOUR BOUNDING RULES, each of which is a decision:
//
//   1. ORPHANS ONLY — an active note with NO `module` anchor row. This can therefore
//      only ADD a coordinate to a note that had none; it can never edit, reorder or
//      contradict a coordinate set a caller supplied. The wider variant (promote into
//      every note, including ones that already carry anchors) was REJECTED for a
//      one-shot retro-write: it is what the ingest path now does going forward, where
//      a human can see the result per note, and it is not what the measured number
//      describes.
//   2. RESOLVED AGAINST THE NOTE'S OWN WORKSPACE, never a caller-named one. One
//      ledger holds notes from six distinct workspaces (measured), and `src/index.ts`
//      is not the same file in two of them. There is deliberately no `--repo`
//      override: resolving repo A's prose against repo B's tracked set is exactly the
//      mis-identification §D3 names, and it would land as `resolved`.
//   3. NO GRAPH WRITE. The ledger is the source of truth and the mirror is a
//      REBUILDABLE projection: `projectLedgerToGraph` replays the whole ledger at
//      every boot, so a restart is what publishes these anchors to the READ path
//      (`recallForGate` → `preEditContext` read the mirror, not the ledger).
//      Opening the `.lbug` here instead would mean a second writer against a store
//      the running desktop holds.
//      Until that restart the two stores genuinely disagree, and MEASURED on a copy
//      of the founder's brain, this is how the gap presents: §1.2 row 4 (ledger
//      anchors) went 37 → 141 and row 5 (the ledger's gate query) 0 → 25 while row
//      15 (mirror `Module` / `ANCHORED_TO`) stayed at 9 / 37 and the MIRROR's own
//      gate query stayed at 0. Row 23's divergence check does NOT catch it — both of
//      its queries are mirror-internal, so it reported 0 / 0 throughout. That is why
//      the CLI prints the restart line, and why it names row 4 against row 15.
//   4. IT ONLY EVER ADDS. The note's `modules` scalar is UNIONED, never replaced, and
//      the anchor row is an `upsert` on `(noteId, kind, value)` — so a re-run is
//      idempotent and a partial run is safe to resume.

/** Hard ceiling on notes ONE run inspects, so even a huge brain cannot turn this
 *  into an unbounded scan. Mirrors `MAX_MEMORY_LIBRARY_SCAN`'s posture in
 *  `memory-ledger.ts`: a run that hits it reports `truncated` rather than silently
 *  describing part of the brain as all of it. */
const MAX_BACKFILL_SCAN = 20_000;

export type MemoryAnchorBackfillResult = {
  /** Active notes with no `module` anchor when the scan started. */
  scanned: number;
  /** Notes that would gain (or gained) at least one module anchor. */
  notes: number;
  /** Module anchor rows that would be written (or were). */
  anchors: number;
  /** Skipped: no `workspacePath`, so there is nothing to resolve against — the §8
   *  residue, and every note on a ledger still at migration 0040. */
  noWorkspace: number;
  /** Skipped: a workspace, but no tracked set (not a git repo, `git` missing, gone).
   *  NEVER treated as "no coordinates": we held no set, so we assert nothing. */
  noTrackedSet: number;
  /** Scanned, resolvable set in hand, and the prose named no tracked file. This is
   *  the honest floor on row 22 — 37 of the 60 live path-shaped entity keys are
   *  another repository's paths. */
  noResolvablePath: number;
  /** Coordinates REFUSED because two tracked paths differ only by case. */
  ambiguous: number;
  /** Whether the scan ceiling was hit. */
  truncated: boolean;
  /** Whether anything was actually written. */
  applied: boolean;
  /** Per workspace, for the operator's review. */
  byWorkspace: { workspacePath: string; notes: number; anchors: number }[];
  /** COORDINATES ONLY — the note id and the tracked paths it names. Never a
   *  fragment of note text, matching `scripts/memory-index-health.mjs` row 22. */
  examples: { noteId: string; modules: string[] }[];
};

/** Examples carried for a human to go look at. Counts are the answer; this is not
 *  an enumeration of the corpus. */
const MAX_EXAMPLES = 10;

/** `MemoryNote.modules` is a SQLite Json column, so a row read back is
 *  `Prisma.JsonValue`. Same two-line coercion `memory-ledger.ts` applies; kept local
 *  because this module deliberately does not import the ledger (which would pull the
 *  graph store and the embedder into a one-shot CLI). */
function toStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

export async function backfillPromotedModuleAnchors(
  options: { apply?: boolean } = {}
): Promise<MemoryAnchorBackfillResult> {
  const apply = options.apply === true;
  // The orphan predicate, matching §1.2 row 22's candidate set: ACTIVE, and no
  // `module` anchor row. Two queries rather than one raw `NOT EXISTS`, so the
  // Prisma client's own column mapping is the only place that knows the schema.
  const anchored = new Set(
    (
      await prisma.memoryAnchor.findMany({
        where: { kind: "module" },
        select: { noteId: true },
      })
    ).map((row) => row.noteId)
  );
  const rows = await prisma.memoryNote.findMany({
    where: { status: "active" },
    select: { id: true, text: true, modules: true, workspacePath: true },
    orderBy: { recordedAt: "asc" },
    take: MAX_BACKFILL_SCAN + 1,
  });
  const truncated = rows.length > MAX_BACKFILL_SCAN;
  const orphans = rows
    .slice(0, MAX_BACKFILL_SCAN)
    .filter((row) => !anchored.has(row.id));

  // ONE resolver per DISTINCT canonical workspace: the `git ls-files` probe is the
  // expensive part, and a 200-note residue in one repo must not spawn 200 of them.
  // `repoRootOf` first, because `0041_memory_note_workspace` was raw SQL and could
  // not apply it — a note whose stored workspace is still a `.muon/worktrees/<id>`
  // tail has no git index of its own, and every coordinate on it would resolve to
  // nothing.
  const resolverByWorkspace = new Map<
    string,
    Awaited<ReturnType<typeof coordinateResolverFor>>
  >();
  const canonicalByRaw = new Map<string, string>();
  const resolverFor = async (raw: string) => {
    let canonical = canonicalByRaw.get(raw);
    if (canonical === undefined) {
      canonical = await repoRootOf(raw);
      canonicalByRaw.set(raw, canonical);
    }
    let resolver = resolverByWorkspace.get(canonical);
    if (!resolver) {
      // No `plannedCoordinates`: a declaration is a CALLER's claim about a write it
      // is making, and a retro-write makes no claims. Nothing here can produce
      // `planned`, and nothing here promotes an unresolved path either.
      resolver = await coordinateResolverFor({ workspacePath: canonical });
      resolverByWorkspace.set(canonical, resolver);
    }
    return { canonical, resolver };
  };

  const plan: {
    noteId: string;
    workspacePath: string;
    modules: string[];
    existing: string[];
  }[] = [];
  let noWorkspace = 0;
  let noTrackedSet = 0;
  let noResolvablePath = 0;
  let ambiguous = 0;

  for (const row of orphans) {
    if (!row.workspacePath) {
      noWorkspace += 1;
      continue;
    }
    const { canonical, resolver } = await resolverFor(row.workspacePath);
    if (!resolver.tracked) {
      noTrackedSet += 1;
      continue;
    }
    const promoted = promoteResolvedPathEntities(row.text, resolver);
    ambiguous += promoted.ambiguous.length;
    if (promoted.modules.length === 0) {
      noResolvablePath += 1;
      continue;
    }
    plan.push({
      noteId: row.id,
      workspacePath: canonical,
      modules: promoted.modules,
      existing: toStringArray(row.modules),
    });
  }

  if (apply) {
    for (const entry of plan) {
      // UNION, never replace. A note can carry a `modules` scalar entry with no
      // anchor row (that asymmetry is §1.2 row 23's whole subject), and overwriting
      // the scalar here would DELETE a coordinate to add one.
      const modules = [...new Set([...entry.existing, ...entry.modules])];
      await prisma.$transaction([
        prisma.memoryNote.update({
          where: { id: entry.noteId },
          data: { modules },
        }),
        // `resolution: "resolved"` is not an assumption: promotion's gate IS the
        // tracked-set membership test, so a promoted coordinate is resolved by
        // construction. `upsert` on the unique triple rather than `create`, so a
        // re-run (or a resumed partial run) writes nothing new — SQLite has no
        // `createMany({ skipDuplicates })`.
        ...entry.modules.map((value) =>
          prisma.memoryAnchor.upsert({
            where: {
              noteId_kind_value: { noteId: entry.noteId, kind: "module", value },
            },
            create: {
              noteId: entry.noteId,
              kind: "module",
              value,
              resolution: "resolved",
            },
            // An existing row keeps its own label. Nothing here may relabel a
            // coordinate a caller supplied.
            update: {},
          })
        ),
      ]);
    }
  }

  const byWorkspace = new Map<string, { notes: number; anchors: number }>();
  for (const entry of plan) {
    const row = byWorkspace.get(entry.workspacePath) ?? { notes: 0, anchors: 0 };
    row.notes += 1;
    row.anchors += entry.modules.length;
    byWorkspace.set(entry.workspacePath, row);
  }
  return {
    scanned: orphans.length,
    notes: plan.length,
    anchors: plan.reduce((total, entry) => total + entry.modules.length, 0),
    noWorkspace,
    noTrackedSet,
    noResolvablePath,
    ambiguous,
    truncated,
    applied: apply,
    byWorkspace: [...byWorkspace.entries()]
      .map(([workspacePath, counts]) => ({ workspacePath, ...counts }))
      .sort(
        (a, b) =>
          b.notes - a.notes || (a.workspacePath < b.workspacePath ? -1 : 1)
      ),
    examples: plan
      .slice(0, MAX_EXAMPLES)
      .map((entry) => ({ noteId: entry.noteId, modules: entry.modules })),
  };
}
