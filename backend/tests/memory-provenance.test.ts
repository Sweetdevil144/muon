import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// KG-5: bitemporal semantics + provenance, REAL SQLite + REAL LadybugDB (no
// mocks). Proves the net-new Principal model, AUTHORED_BY / CONFIRMED_BY / and
// first-class CONTRADICTS edges, bitemporal (as-of) retrieval, trust derivation +
// scope-aware recall, and, the load-bearing invariant, that ALL of it is a
// rebuildable projection: wipe the .lbug store → projectLedgerToGraph restores
// principals, provenance edges, and bitemporal state with zero loss.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-prov-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await settle();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("memory provenance + bitemporal (KG-5)", () => {
  it("upserts ONE Principal per author, AUTHORED_BY on both notes, trust derives from the principal", async () => {
    const a = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Alice picked cursor keybindings for the palette",
      modules: ["prov/alice-a.ts"],
      topics: ["prov-alice-a"],
      createdBy: "human:alice",
    });
    const b = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Alice prefers structured JSON logs in workers",
      modules: ["prov/alice-b.ts"],
      topics: ["prov-alice-b"],
      createdBy: "human:alice",
    });
    expect(a.action).toBe("inserted");
    expect(b.action).toBe("inserted");

    // Exactly ONE Principal row for the shared author (idempotent upsert).
    const principals = await db.prisma.principal.findMany({
      where: { id: "principal-human-alice" },
    });
    expect(principals).toHaveLength(1);
    expect(principals[0]?.kind).toBe("human");

    // Note trust DERIVES from the human principal → high (not the medium default).
    expect(a.note.trust).toBe("high");
    expect(b.note.trust).toBe("high");

    // Reproject for a deterministic graph, then AUTHORED_BY links BOTH notes.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect(await graph.authorsOf(a.note.id)).toContain("principal-human-alice");
    expect(await graph.authorsOf(b.note.id)).toContain("principal-human-alice");
    expect((await graph.getPrincipal("principal-human-alice"))?.trust).toBe("high");

    console.log(
      `[KG-5 principal-upsert] 2 notes by human:alice → 1 principal, AUTHORED_BY on both, note.trust=${a.note.trust}`
    );
  });

  it("note trust derives from an existing (human-adjusted) principal's trust, not the kind default", async () => {
    // A low-trust agent principal already exists (as KG-6 would set it).
    await db.prisma.principal.create({
      data: {
        id: "principal-agent-flaky",
        kind: "agent",
        displayName: "flaky",
        vendor: "flaky",
        trust: "low",
      },
    });
    const note = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Flaky agent retried the migration three times",
      modules: ["prov/flaky.ts"],
      topics: ["prov-flaky"],
      createdBy: "agent:flaky",
    });
    // Derived from the principal (low), NOT the agent kind default (medium).
    expect(note.note.trust).toBe("low");
    // Ingest never overwrites an existing principal's trust.
    const p = await db.prisma.principal.findUnique({
      where: { id: "principal-agent-flaky" },
    });
    expect(p?.trust).toBe("low");
  });

  it("a Confirmation projects a CONFIRMED_BY edge to the confirming human Principal", async () => {
    const created = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Codex proposed caching the compiled profiles",
      modules: ["prov/confirm.ts"],
      topics: ["prov-confirm"],
      createdBy: "agent:codex",
    });
    await ledger.updateMemoryNote(created.note.id, {
      confirmed: true,
      principal: "human", // KG-6 F1: the human operator confirms
    });
    await settle();

    // Durable append-only Confirmation row by the human principal. P0-2: the
    // orchestrator also vouches for an agent-authored note at ingest, so scope
    // to the HUMAN row — the point of this test is that a human confirm lands
    // attributed to the human, not that it is the only row on the note.
    const confirmation = await db.prisma.confirmation.findFirst({
      where: { noteId: created.note.id, decision: "confirm", principal: "human" },
    });
    expect(confirmation).not.toBeNull();
    expect(confirmation?.principal).toBe("human");
    // The human principal was upserted durably.
    const human = await db.prisma.principal.findUnique({
      where: { id: "principal-human-human" },
    });
    expect(human?.kind).toBe("human");

    // Reproject → CONFIRMED_BY restored to the confirming human principal.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect(await graph.confirmersOf(created.note.id)).toContain(
      "principal-human-human"
    );
    console.log(
      `[KG-5 confirmed-by] confirm → CONFIRMED_BY to principal-human-human`
    );
  });

  it("a contradiction persists a CONTRADICTS MemoryEdge; both notes stay active (governed, non-destructive)", async () => {
    const mod = "prov/contradict.ts";
    const base = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The cache layer must use Redis",
      modules: [mod],
      topics: ["prov-contradict"],
      createdBy: "human",
    });
    const clash = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The cache layer must not use Redis",
      modules: [mod],
      topics: ["prov-contradict"],
      createdBy: "agent:codex",
    });
    expect(clash.action).toBe("conflict");
    expect(clash.relatedNoteId).toBe(base.note.id);

    // Persisted, durable CONTRADICTS MemoryEdge (a first-class edge, KG-5).
    const edge = await db.prisma.memoryEdge.findFirst({
      where: { fromId: clash.note.id, toId: base.note.id, kind: "contradicts" },
    });
    expect(edge).not.toBeNull();

    // BOTH notes stay active, a human reconciles, nothing is silently dropped.
    const baseRow = await db.prisma.memoryNote.findUnique({
      where: { id: base.note.id },
    });
    const clashRow = await db.prisma.memoryNote.findUnique({
      where: { id: clash.note.id },
    });
    expect(baseRow?.status).toBe("active");
    expect(clashRow?.status).toBe("active");

    // Reproject → the CONTRADICTS graph edge is restored from the ledger.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect(await graph.contradictionsOf(clash.note.id)).toContain(base.note.id);
    console.log(
      `[KG-5 contradicts] opposite-polarity → CONTRADICTS edge, both active`
    );
  });

  it("bitemporal as-of: supersede a fact, then as-of=now = new fact only, as-of=(between) = old fact", async () => {
    const topic = "prov-asof";
    const mod = "prov/asof.ts";
    const factA = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Deploy target is the staging environment",
      modules: [mod],
      topics: [topic],
      createdBy: "human",
    });
    await tick();
    const between = new Date().toISOString();
    await tick();
    const factB = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Deploy target is the production environment",
      modules: [mod],
      topics: [topic],
      createdBy: "human",
    });
    expect(factB.action).toBe("superseded");
    expect(factB.relatedNoteId).toBe(factA.note.id);

    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // as-of NOW → only the superseding fact (the old one has been retired).
    const nowIds = (
      await graph.recallMemory({ topic, asOf: new Date().toISOString() })
    ).map((n) => n.id);
    expect(nowIds).toContain(factB.note.id);
    expect(nowIds).not.toContain(factA.note.id);

    // as-of BETWEEN (after A, before B) → the brain believed the OLD fact then.
    const betweenIds = (await graph.recallMemory({ topic, asOf: between })).map(
      (n) => n.id
    );
    expect(betweenIds).toContain(factA.note.id);
    expect(betweenIds).not.toContain(factB.note.id);

    // Default recall (no asOf) = current active set = the new fact only.
    const defaultIds = (await graph.recallMemory({ topic })).map((n) => n.id);
    expect(defaultIds).toEqual([factB.note.id]);

    console.log(
      `[KG-5 as-of] now→[${nowIds.join(",")}] between→[${betweenIds.join(",")}]`
    );
  });

  it("trust + scope: a high-trust confirmed note outranks a low-trust agent note; project-scope recall returns project notes", async () => {
    const topic = "prov-rank";
    // Human-authored (derives high) + confirmed.
    const good = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Prefer structured logging for request observability",
      modules: ["prov/rank-good.ts"],
      topics: [topic],
      createdBy: "human:carol",
    });
    await ledger.updateMemoryNote(good.note.id, {
      confirmed: true,
      principal: "human", // KG-6 F1: human blessing enables the confirmed bonus
    });
    // Low-trust agent note (explicit low).
    const weak = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Tried structured logging observability once but was unsure",
      modules: ["prov/rank-weak.ts"],
      topics: [topic],
      trust: "low",
      createdBy: "agent:weak",
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    const results = await graph.searchMemory("structured logging observability");
    const goodRank = results.findIndex((n) => n.id === good.note.id);
    const weakRank = results.findIndex((n) => n.id === weak.note.id);
    expect(goodRank).toBeGreaterThanOrEqual(0);
    expect(weakRank).toBeGreaterThan(goodRank); // high-trust confirmed surfaces first

    // Scope is a first-class dimension (D5): project-scope recall returns the
    // project notes; a lane scope returns none, wired, but not hard-gated.
    const projectIds = (
      await graph.recallMemory({ topic, scope: "project" })
    ).map((n) => n.id);
    expect(projectIds).toContain(good.note.id);
    expect(projectIds).toContain(weak.note.id);
    const laneScoped = await graph.recallMemory({ topic, scope: "lane:codex" });
    expect(laneScoped).toHaveLength(0);

    console.log(
      `[KG-5 trust+scope] confirmed high-trust rank=${goodRank} < low-trust agent rank=${weakRank}; project scope=${projectIds.length} notes, lane scope=0`
    );
  });

  it("F1 bitemporal correctness: second-precision / timezone-offset / date-only asOf all yield the RIGHT active set", async () => {
    // Pin a note's transaction + valid time to an EXACT sub-second instant.
    const pinned = new Date("2026-07-11T10:00:00.500Z");
    await db.prisma.memoryNote.create({
      data: {
        id: "f1-asof-note",
        kind: "decision",
        text: "F1 pinned note at ten oclock and a half second",
        textHash: "f1-asof-hash",
        createdBy: "human",
        scope: "project",
        trust: "high",
        status: "active",
        recordedAt: pinned,
        validFrom: pinned,
        updatedAt: pinned,
        modules: [],
        topics: ["f1-asof"],
      },
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    const recallIds = (asOf: string) =>
      graph
        .recallMemory({ topic: "f1-asof", asOf })
        .then((notes) => notes.map((n) => n.id));

    // Second-precision instant BEFORE .500 → the note did not exist yet → EXCLUDED.
    // (The raw-lexicographic bug wrongly INCLUDED it because '.'(0x2E) < 'Z'(0x5A).)
    expect(await recallIds("2026-07-11T10:00:00Z")).not.toContain("f1-asof-note");
    // One second later → active → INCLUDED.
    expect(await recallIds("2026-07-11T10:00:01Z")).toContain("f1-asof-note");
    // Timezone-offset 10:00:01+05:30 = 04:30:01Z (before the note) → EXCLUDED.
    expect(await recallIds("2026-07-11T10:00:01+05:30")).not.toContain(
      "f1-asof-note"
    );
    // Date-only next day = 2026-07-12T00:00:00Z (after) → INCLUDED; same day
    // 00:00:00Z (before 10:00) → EXCLUDED.
    expect(await recallIds("2026-07-12")).toContain("f1-asof-note");
    expect(await recallIds("2026-07-11")).not.toContain("f1-asof-note");
    console.log(
      `[KG-5 F1] second-precision / timezone-offset / date-only asOf normalized → correct active set`
    );
  });

  it("F1-sub: a supersede is contiguous, predecessor.validTo === successor.validFrom (no both-active window)", async () => {
    const mod = "prov/f1sub.ts";
    const first = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Batch size defaults to sixty four records",
      modules: [mod],
      topics: ["prov-f1sub"],
      createdBy: "human",
    });
    const second = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Batch size defaults to sixty four entries",
      modules: [mod],
      topics: ["prov-f1sub"],
      createdBy: "human",
    });
    expect(second.action).toBe("superseded");
    const pred = await db.prisma.memoryNote.findUnique({
      where: { id: first.note.id },
    });
    const succ = await db.prisma.memoryNote.findUnique({
      where: { id: second.note.id },
    });
    // Half-open [validFrom, validTo): predecessor.validTo === successor.validFrom
    // at the SAME instant, and === the retire instant → no as-of T sees both
    // active (nor a gap where neither is).
    expect(pred?.validTo?.toISOString()).toBe(succ?.validFrom.toISOString());
    expect(pred?.validTo?.toISOString()).toBe(pred?.retiredAt?.toISOString());
    console.log(
      `[KG-5 F1-sub] predecessor.validTo == successor.validFrom == ${succ?.validFrom.toISOString()}`
    );
  });

  it("F2 trust guard: an unconfirmed write cannot supersede a human-CONFIRMED note, downgraded to related, victim stays active", async () => {
    const mod = "prov/f2-guard.ts";
    // A human-authored, CONFIRMED constraint.
    const confirmed = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Rate limiter reads session token from config at startup",
      modules: [mod],
      topics: ["prov-f2"],
      createdBy: "human:carol",
    });
    await ledger.updateMemoryNote(confirmed.note.id, {
      confirmed: true,
      principal: "human", // KG-6 F1: human confirm protects the victim
    });
    // A low-trust agent proposes a same-kind, jaccard≥0.5 supersede of it.
    const weak = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Rate limiter reads session token from vault at boot",
      modules: [mod],
      topics: ["prov-f2"],
      createdBy: "agent:weak",
    });
    // The DESTRUCTIVE supersede is downgraded to the non-destructive `related`.
    expect(weak.action).toBe("related");
    expect(weak.relatedNoteId).toBe(confirmed.note.id);
    // The confirmed victim is UNTOUCHED, never rejected/retired.
    const victim = await db.prisma.memoryNote.findUnique({
      where: { id: confirmed.note.id },
    });
    expect(victim?.status).toBe("active");
    expect(victim?.retiredAt).toBeNull();
    // A related edge + a human reconcile were recorded (governed, non-destructive).
    const edge = await db.prisma.memoryEdge.findFirst({
      where: { fromId: weak.note.id, toId: confirmed.note.id, kind: "related" },
    });
    expect(edge).not.toBeNull();
    const reconcile = await db.prisma.confirmation.findFirst({
      where: { noteId: weak.note.id, decision: "reconcile" },
    });
    expect(reconcile).not.toBeNull();
    console.log(
      `[KG-5 F2] agent:weak vs confirmed human note → action=${weak.action}, victim status=${victim?.status} (not retired)`
    );
  });

  it("F2 no over-block: an unconfirmed victim still supersedes normally for a peer-or-higher writer (KG-3 governed dedup unaffected)", async () => {
    const mod = "prov/f2-refine.ts";
    // The victim is NOT confirmed → a legitimate refinement. KG-6 REFINED this
    // rule: a LOWER-trust writer against an unconfirmed higher-trust victim is now
    // gated (see the KG-6 hostile-write test), but a PEER-OR-HIGHER writer still
    // supersedes normally, no over-block. Here a human refines their own note.
    const base = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Worker pool size defaults to eight threads",
      modules: [mod],
      topics: ["prov-f2-refine"],
      createdBy: "human:carol",
    });
    const refined = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Worker pool size defaults to nine threads",
      modules: [mod],
      topics: ["prov-f2-refine"],
      createdBy: "human:carol", // peer (same high-trust author) → authorized
    });
    expect(refined.action).toBe("superseded");
    const victim = await db.prisma.memoryNote.findUnique({
      where: { id: base.note.id },
    });
    expect(victim?.status).toBe("rejected"); // unconfirmed + peer → supersede proceeds
    console.log(
      `[KG-5 F2 no-over-block] unconfirmed victim, peer writer → action=${refined.action} (normal refinement)`
    );
  });

  it("F3: a scope-only search keeps the full hybrid path (no as-of) and soft-filters by scope", async () => {
    const projectNote = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Telemetry spans flush every five seconds to the collector",
      modules: ["prov/f3-a.ts"],
      topics: ["prov-f3-project"],
      scope: "project",
      createdBy: "human",
    });
    const laneNote = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Telemetry spans flush every five seconds to the collector",
      modules: ["prov/f3-b.ts"],
      topics: ["prov-f3-lane"],
      scope: "lane:codex",
      createdBy: "human",
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    // scope-only (NO asOf) → full FTS+semantic+lexical hybrid, then a soft scope
    // post-filter (F3): the project note surfaces, the lane note is filtered out.
    const projectHits = await graph.searchMemory("telemetry spans flush", 20, {
      scope: "project",
    });
    const ids = projectHits.map((n) => n.id);
    expect(ids).toContain(projectNote.note.id);
    expect(ids).not.toContain(laneNote.note.id);
    console.log(
      `[KG-5 F3] scope-only hybrid search → project hit=${ids.includes(projectNote.note.id)}, lane excluded=${!ids.includes(laneNote.note.id)}`
    );
  });

  it("ACCEPTANCE: wipe the .lbug store → reproject → Principals, AUTHORED_BY/CONFIRMED_BY/CONTRADICTS + bitemporal all restored", async () => {
    // 1. Authored + confirmed note.
    const survivor = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Nightly backups write to cold object storage",
      modules: ["prov/wipe-a.ts"],
      topics: ["prov-wipe-a"],
      createdBy: "human:dave",
    });
    await ledger.updateMemoryNote(survivor.note.id, {
      confirmed: true,
      principal: "human", // KG-6 F1: human confirm (→ principal-human-human)
    });

    // 2. A contradiction (both active).
    const cmod = "prov/wipe-conflict.ts";
    const base = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Backups must run every night",
      modules: [cmod],
      topics: ["prov-wipe-c"],
      createdBy: "human:dave",
    });
    const clash = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Backups must not run every night",
      modules: [cmod],
      topics: ["prov-wipe-c"],
      createdBy: "agent:codex",
    });
    expect(clash.action).toBe("conflict");

    // 3. A supersede (bitemporal history).
    const smod = "prov/wipe-supersede.ts";
    const p = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Retention window is thirty days",
      modules: [smod],
      topics: ["prov-wipe-s"],
      createdBy: "human:dave",
    });
    await tick();
    const between = new Date().toISOString();
    await tick();
    const q = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Retention window is forty days",
      modules: [smod],
      topics: ["prov-wipe-s"],
      createdBy: "human:dave",
    });
    expect(q.action).toBe("superseded");
    await settle();

    // 4. WIPE the LadybugDB store, a STORE_VERSION bump / corrupt-store recovery.
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);

    // 5. Rebuild PURELY from the durable ledger.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // Principal node restored with its authoritative trust.
    const dave = await graph.getPrincipal("principal-human-dave");
    expect(dave?.kind).toBe("human");
    expect(dave?.trust).toBe("high");
    // AUTHORED_BY + CONFIRMED_BY restored.
    expect(await graph.authorsOf(survivor.note.id)).toContain(
      "principal-human-dave"
    );
    expect(await graph.confirmersOf(survivor.note.id)).toContain(
      "principal-human-human"
    );
    // CONTRADICTS restored; both notes still active.
    expect(await graph.contradictionsOf(clash.note.id)).toContain(base.note.id);
    expect((await graph.getMemoryNote(base.note.id))?.status).toBe("active");
    expect((await graph.getMemoryNote(clash.note.id))?.status).toBe("active");
    // Bitemporal state restored: as-of travel still works after the rebuild.
    const asBetween = (
      await graph.recallMemory({ topic: "prov-wipe-s", asOf: between })
    ).map((n) => n.id);
    expect(asBetween).toContain(p.note.id);
    expect(asBetween).not.toContain(q.note.id);
    const asNow = (
      await graph.recallMemory({
        topic: "prov-wipe-s",
        asOf: new Date().toISOString(),
      })
    ).map((n) => n.id);
    expect(asNow).toContain(q.note.id);
    expect(asNow).not.toContain(p.note.id);

    console.log(
      `[KG-5 wipe+reproject] principal(trust=${dave?.trust}), AUTHORED_BY, CONFIRMED_BY, CONTRADICTS, and bitemporal as-of ALL restored from the ledger`
    );
  }, 30_000);
});
