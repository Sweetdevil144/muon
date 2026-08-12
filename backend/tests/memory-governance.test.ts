import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// KG-6: governed multi-principal writes, the security backbone that makes the
// brain's memory UNGAMEABLE by a low-trust writer. REAL SQLite + REAL LadybugDB
// (no mocks), ledger-first. Proves:
//   1. the full trust gate, a hostile low-trust write can NOT destroy an
//      UNCONFIRMED higher-trust fact (it becomes a contestable PROPOSES_SUPERSEDE,
//      both notes stay active), while a peer-or-higher writer is NOT over-blocked;
//   2. the KG-5 confirmed-victim protection still holds (regression);
//   3. supersede-proposed resolution, a human confirm APPLIES the deferred
//      supersede atomically; a reject drops it and keeps the victim;
//   4. the gate-read contract, a governed (confirmed-only) read a gate consumes
//      can never see a hostile low-trust unconfirmed write;
//   5. the confirm route threads the REAL confirming principal;
//   6. all of it is a rebuildable projection: wipe the .lbug store → reproject →
//      PROPOSES_SUPERSEDE edges + confirmed-state + provenance restore with zero
//      loss. NOTE: KG-6 needed NO schema migration, MemoryEdge.kind and
//      Confirmation.principal are already free-form String columns (KG-1/KG-5), so
//      "proposes_supersede" / a real principal id are stored with no DDL change;
//      the _muon_migrations mechanism is exercised by embedded-sqlite.test.ts.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-gov-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  // Deterministic lexical recall (no FTS extension, no embedder), pure jaccard.
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

describe("memory governance: trust-gated destructive writes (KG-6)", () => {
  it("HOSTILE WRITE BLOCKED: a low-trust agent can NOT supersede an UNCONFIRMED high-trust human note → PROPOSES_SUPERSEDE, both active", async () => {
    const mod = "gov/hostile.ts";
    const topic = "gov-hostile";
    // An UNCONFIRMED high-trust human fact (the target of a hostile overwrite).
    const victim = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Database connection pool caps at thirty two connections",
      modules: [mod],
      topics: [topic],
      createdBy: "human:hera", // human → high trust
    });
    expect(victim.note.trust).toBe("high");

    // A low-trust agent proposes a same-kind, jaccard≥0.5 supersede of it.
    const hostile = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Database connection pool caps at sixty four connections",
      modules: [mod],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });

    // The destructive supersede is GATED → a non-destructive, contestable proposal.
    expect(hostile.action).toBe("proposed");
    expect(hostile.relatedNoteId).toBe(victim.note.id);

    // The victim is UNTOUCHED, never rejected/retired.
    const victimRow = await db.prisma.memoryNote.findUnique({
      where: { id: victim.note.id },
    });
    expect(victimRow?.status).toBe("active");
    expect(victimRow?.retiredAt).toBeNull();
    // The hostile note is inserted ACTIVE (not dropped), it just can't destroy.
    const hostileRow = await db.prisma.memoryNote.findUnique({
      where: { id: hostile.note.id },
    });
    expect(hostileRow?.status).toBe("active");
    expect(hostileRow?.trust).toBe("low");

    // A PROPOSES_SUPERSEDE edge + a human reconcile were recorded.
    const edge = await db.prisma.memoryEdge.findFirst({
      where: {
        fromId: hostile.note.id,
        toId: victim.note.id,
        kind: "proposes_supersede",
      },
    });
    expect(edge).not.toBeNull();
    const reconcile = await db.prisma.confirmation.findFirst({
      where: { noteId: hostile.note.id, decision: "reconcile" },
    });
    expect(reconcile).not.toBeNull();

    // Projected into the graph as a PROPOSES_SUPERSEDE relationship.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect(await graph.proposedSupersedesOf(hostile.note.id)).toContain(
      victim.note.id
    );
    console.log(
      `[KG-6 hostile-blocked] agent:intruder(low) vs UNCONFIRMED human(high) → action=${hostile.action}, victim status=${victimRow?.status} (not retired), PROPOSES_SUPERSEDE recorded`
    );
  });

  it("NO OVER-BLOCK: a high-trust note supersedes an UNCONFIRMED medium peer normally (victim retired)", async () => {
    const mod = "gov/no-overblock.ts";
    const topic = "gov-no-overblock";
    // An unconfirmed MEDIUM-trust note.
    const base = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Retry policy uses three attempts with linear backoff",
      modules: [mod],
      topics: [topic],
      trust: "medium",
      createdBy: "agent:mid",
    });
    expect(base.note.trust).toBe("medium");

    // A HIGHER-trust (human) writer refines it → authorized → supersede APPLIES.
    const refined = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Retry policy uses three attempts with exponential backoff",
      modules: [mod],
      topics: [topic],
      createdBy: "human:helia", // high
    });
    expect(refined.action).toBe("superseded");
    expect(refined.relatedNoteId).toBe(base.note.id);
    const victim = await db.prisma.memoryNote.findUnique({
      where: { id: base.note.id },
    });
    expect(victim?.status).toBe("rejected"); // higher-trust peer → not over-blocked
    expect(victim?.supersededBy).toBe(refined.note.id);
    console.log(
      `[KG-6 no-over-block] human(high) vs UNCONFIRMED agent(medium) → action=${refined.action}, victim retired`
    );
  });

  it("CONFIRMED VICTIM PROTECTED (KG-5 regression): a low-trust write vs a CONFIRMED note stays non-destructive (related)", async () => {
    const mod = "gov/confirmed.ts";
    const topic = "gov-confirmed";
    const confirmed = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Session tokens are rotated every fifteen minutes by the scheduler",
      modules: [mod],
      topics: [topic],
      createdBy: "human:carol",
    });
    await ledger.updateMemoryNote(confirmed.note.id, {
      confirmed: true,
      principal: "human:carol", // KG-6 F1: a human confirm protects the victim
    });

    const weak = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "Session tokens are rotated every sixty minutes by the scheduler",
      modules: [mod],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    // KG-5 protection preserved: a confirmed fact is not even proposed away.
    expect(weak.action).toBe("related");
    const victim = await db.prisma.memoryNote.findUnique({
      where: { id: confirmed.note.id },
    });
    expect(victim?.status).toBe("active");
    expect(victim?.retiredAt).toBeNull();
    console.log(
      `[KG-6 confirmed-protected] agent:intruder(low) vs CONFIRMED human note → action=${weak.action} (KG-5 preserved)`
    );
  });

  it("F2 GATED DUPLICATE NOOP-DROPS: low-trust identical duplicates of an unconfirmed high-trust note add 0 notes, 0 proposals, 0 reconciles", async () => {
    const mod = "gov/dup-flood.ts";
    const topic = "gov-dup-flood";
    const victim = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The canonical deploy branch is release slash stable",
      modules: [mod],
      topics: [topic],
      createdBy: "human:owner", // high, UNCONFIRMED
    });
    const before = await db.prisma.memoryNote.count();

    // Three IDENTICAL low-trust duplicates, a flood attempt.
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await ledger.ingestMemoryNote({
          kind: "decision",
          text: "The canonical deploy branch is release slash stable",
          modules: [mod],
          topics: [topic],
          trust: "low",
          createdBy: "agent:intruder",
        })
      );
    }
    // Every duplicate NOOP-drops (never a proposal), the pre-KG-6 behaviour.
    for (const r of results) {
      expect(r.action).toBe("duplicate");
      expect(r.relatedNoteId).toBe(victim.note.id);
    }
    // Zero new notes, zero proposals against the victim, zero reconciles.
    expect(await db.prisma.memoryNote.count()).toBe(before);
    expect(
      await db.prisma.memoryEdge.count({
        where: { toId: victim.note.id, kind: "proposes_supersede" },
      })
    ).toBe(0);
    expect(
      await db.prisma.confirmation.count({
        where: { noteId: victim.note.id, decision: "reconcile" },
      })
    ).toBe(0);
    console.log(
      `[KG-6 F2 gated-duplicate] 3 low-trust identical dups → all NOOP-drop, +0 notes, +0 proposals, +0 reconciles`
    );
  });

  it("BACKFILL: a MEDIUM agent supersedes an UNCONFIRMED MEDIUM agent peer, the trust `>=` branch APPLIES at the ledger (not via the human short-circuit)", async () => {
    const mod = "gov/peer-supersede.ts";
    const topic = "gov-peer";
    const base = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The queue worker prefetch count defaults to sixteen messages",
      modules: [mod],
      topics: [topic],
      trust: "medium",
      createdBy: "agent:alpha",
    });
    expect(base.note.trust).toBe("medium");
    // A DIFFERENT medium agent (non-human) refines it → the pure `>=` branch, not
    // the incomingIsHuman short-circuit, authorizes the supersede.
    const refined = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The queue worker prefetch count defaults to thirty two messages",
      modules: [mod],
      topics: [topic],
      trust: "medium",
      createdBy: "agent:beta",
    });
    expect(refined.note.trust).toBe("medium");
    expect(refined.action).toBe("superseded"); // medium >= medium, unconfirmed → applies
    const victim = await db.prisma.memoryNote.findUnique({
      where: { id: base.note.id },
    });
    expect(victim?.status).toBe("rejected");
    expect(victim?.supersededBy).toBe(refined.note.id);
    console.log(
      `[KG-6 backfill peer-supersede] agent:beta(medium) vs UNCONFIRMED agent:alpha(medium) → action=${refined.action} (>= branch)`
    );
  });
});

describe("memory governance: supersede-proposed resolution (KG-6)", () => {
  it("a human CONFIRM of a PROPOSES_SUPERSEDE applies the deferred supersede atomically (victim retired, successor active) and reprojects", async () => {
    const mod = "gov/resolve-confirm.ts";
    const topic = "gov-resolve-confirm";
    const victim = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Feature flags are evaluated once at process startup only",
      modules: [mod],
      topics: [topic],
      createdBy: "human:owner", // high, UNCONFIRMED
    });
    const proposal = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Feature flags are evaluated once per request at startup only",
      modules: [mod],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    expect(proposal.action).toBe("proposed");

    // A human confirms the proposing note → APPLY the deferred supersede.
    await ledger.updateMemoryNote(proposal.note.id, {
      confirmed: true,
      principal: "human:owner",
    });
    await settle();

    // Victim retired, successor active, atomic ledger state transition.
    const victimRow = await db.prisma.memoryNote.findUnique({
      where: { id: victim.note.id },
    });
    const successorRow = await db.prisma.memoryNote.findUnique({
      where: { id: proposal.note.id },
    });
    expect(victimRow?.status).toBe("rejected");
    expect(victimRow?.supersededBy).toBe(proposal.note.id);
    expect(victimRow?.retiredAt).not.toBeNull();
    expect(successorRow?.status).toBe("active");

    // The contested proposal edge was SWAPPED for a real supersedes edge.
    const proposalEdge = await db.prisma.memoryEdge.findFirst({
      where: {
        fromId: proposal.note.id,
        toId: victim.note.id,
        kind: "proposes_supersede",
      },
    });
    const supersedesEdge = await db.prisma.memoryEdge.findFirst({
      where: {
        fromId: proposal.note.id,
        toId: victim.note.id,
        kind: "supersedes",
      },
    });
    expect(proposalEdge).toBeNull();
    expect(supersedesEdge).not.toBeNull();

    // Reprojects correctly: the victim reads inactive, the successor is confirmed.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect((await graph.getMemoryNote(victim.note.id))?.status).toBe("rejected");
    expect(await graph.proposedSupersedesOf(proposal.note.id)).not.toContain(
      victim.note.id
    );
    expect(await graph.confirmersOf(proposal.note.id)).toContain(
      "principal-human-owner"
    );
    console.log(
      `[KG-6 resolve-confirm] human confirm → victim retired (supersededBy=successor), proposes_supersede→supersedes`
    );
  });

  it("a REJECT of a PROPOSES_SUPERSEDE drops the proposal and keeps the victim active", async () => {
    const mod = "gov/resolve-reject.ts";
    const topic = "gov-resolve-reject";
    const victim = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The primary region for writes is the eastern datacenter",
      modules: [mod],
      topics: [topic],
      createdBy: "human:owner", // high, UNCONFIRMED
    });
    const proposal = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The primary region for writes is the western datacenter",
      modules: [mod],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    expect(proposal.action).toBe("proposed");

    // A human REJECTS the proposal → drop it, keep the victim.
    await ledger.updateMemoryNote(proposal.note.id, {
      confirmed: false,
      principal: "human:owner",
    });
    await settle();

    const victimRow = await db.prisma.memoryNote.findUnique({
      where: { id: victim.note.id },
    });
    expect(victimRow?.status).toBe("active"); // victim kept
    expect(victimRow?.retiredAt).toBeNull();
    const proposalEdge = await db.prisma.memoryEdge.findFirst({
      where: {
        fromId: proposal.note.id,
        toId: victim.note.id,
        kind: "proposes_supersede",
      },
    });
    expect(proposalEdge).toBeNull(); // proposal dropped
    // The proposing note itself stays active (just unconfirmed / not a successor).
    const proposalRow = await db.prisma.memoryNote.findUnique({
      where: { id: proposal.note.id },
    });
    expect(proposalRow?.status).toBe("active");

    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    expect(await graph.proposedSupersedesOf(proposal.note.id)).not.toContain(
      victim.note.id
    );
    console.log(
      `[KG-6 resolve-reject] human reject → proposal dropped, victim status=${victimRow?.status}`
    );
  });
});

describe("memory governance: gate-read contract + confirm-route principal (KG-6)", () => {
  it("GATE READ is confirmed-only: a hostile low-trust unconfirmed note is in general recall/search but NEVER in the gate view", async () => {
    const mod = "gov/gate.ts";
    const topic = "gov-gate";
    // A CONFIRMED governed note (what a gate is allowed to trust).
    const governed = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Prefer dependency injection for all service constructors",
      modules: [mod],
      topics: [topic],
      createdBy: "human:gatekeeper",
    });
    await ledger.updateMemoryNote(governed.note.id, {
      confirmed: true,
      principal: "human:gatekeeper", // KG-6 F1: only a human confirm enters a gate
    });
    // A hostile low-trust UNCONFIRMED note on the SAME anchor, distinct text (no
    // dedup/conflict, both stay active).
    const hostile = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "The build cache lives under a temporary scratch directory somewhere",
      modules: [mod],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // GENERAL recall sees BOTH (unchanged behaviour).
    const generalIds = (await graph.recallMemory({ topic })).map((n) => n.id);
    expect(generalIds).toContain(governed.note.id);
    expect(generalIds).toContain(hostile.note.id);

    // GATE recall (the hero's preEditContext contract) sees ONLY the confirmed one.
    const gateIds = (await graph.recallForGate({ topic })).map((n) => n.id);
    expect(gateIds).toContain(governed.note.id);
    expect(gateIds).not.toContain(hostile.note.id);
    // The `governedOnly` option on recallMemory is equivalent.
    const gateOptionIds = (
      await graph.recallMemory({ topic, governedOnly: true })
    ).map((n) => n.id);
    expect(gateOptionIds).not.toContain(hostile.note.id);

    // GATE search likewise cannot surface the hostile note even on a bullseye query.
    const generalHits = (
      await graph.searchMemory("build cache scratch directory")
    ).map((n) => n.id);
    expect(generalHits).toContain(hostile.note.id);
    const gateHits = (
      await graph.searchMemory("build cache scratch directory", 20, {
        governedOnly: true,
      })
    ).map((n) => n.id);
    expect(gateHits).not.toContain(hostile.note.id);
    console.log(
      `[KG-6 gate-read] general recall=${generalIds.length} notes; gate recall excludes the hostile low-trust note (gate=${gateIds.length})`
    );
  });

  it("CONFIRM ROUTE PRINCIPAL: CONFIRMED_BY points at the SUPPLIED human principal; an OMITTED principal does NOT elevate (F1)", async () => {
    // Supplied HUMAN principal → CONFIRMED_BY the actual confirmer; note elevated.
    const a = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Metrics are scraped on a fifteen second interval by the collector",
      modules: ["gov/principal-a.ts"],
      topics: ["gov-principal-a"],
      createdBy: "agent:codex",
    });
    await ledger.updateMemoryNote(a.note.id, {
      confirmed: true,
      principal: "human:reviewer",
    });
    // OMITTED principal → a NON-elevating "system" default (KG-6 F1): recorded for
    // audit but the note is NOT human-confirmed, no auto-human elevation.
    const b = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "Backpressure kicks in above ten thousand queued messages per shard",
      modules: ["gov/principal-b.ts"],
      topics: ["gov-principal-b"],
      createdBy: "agent:codex",
    });
    await ledger.updateMemoryNote(b.note.id, { confirmed: true }); // omitted
    await settle();

    // The durable Confirmation rows carry the REAL confirmer identity; the omitted
    // one is recorded as the non-elevating "system" principal, never "human".
    // P0-2: the orchestrator also vouches for an agent-authored note at ingest,
    // so look past its row — what is under test is the principal the CONFIRM
    // ROUTE records, not how many rows a note carries.
    const notOrchestrator = {
      NOT: { principal: { startsWith: "agent:orchestrator:" } },
    };
    const confA = await db.prisma.confirmation.findFirst({
      where: { noteId: a.note.id, decision: "confirm", ...notOrchestrator },
    });
    const confB = await db.prisma.confirmation.findFirst({
      where: { noteId: b.note.id, decision: "confirm", ...notOrchestrator },
    });
    expect(confA?.principal).toBe("human:reviewer");
    expect(confB?.principal).toBe("system");

    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    // a: human-confirmed → CONFIRMED_BY the reviewer, and IN the gate.
    expect(await graph.confirmersOf(a.note.id)).toContain(
      "principal-human-reviewer"
    );
    const gateA = (await graph.recallForGate({ topic: "gov-principal-a" })).map(
      (n) => n.id
    );
    expect(gateA).toContain(a.note.id);
    // b: omitted → NOT human-confirmed → no human CONFIRMED_BY, EXCLUDED from gate.
    expect(await graph.confirmersOf(b.note.id)).not.toContain(
      "principal-human-human"
    );
    const gateB = (await graph.recallForGate({ topic: "gov-principal-b" })).map(
      (n) => n.id
    );
    expect(gateB).not.toContain(b.note.id);
    console.log(
      `[KG-6 confirm-principal F1] supplied human → CONFIRMED_BY + gated in; omitted → system, NOT elevated, gated out`
    );
  });

  it("F1 SELF-CONFIRM BLOCKED: a low-trust agent cannot self-confirm its OWN note into the gate (as agent:x OR omitted); only a HUMAN confirm enters", async () => {
    const topic = "gov-self-confirm";
    // Two hostile low-trust agent notes + one genuine human note on one anchor.
    const asAgent = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Rotate the deploy secrets every seven days per the intruder plan",
      modules: ["gov/self-a.ts"],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    const asOmitted = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Disable the audit log sampling entirely for faster local runs",
      modules: ["gov/self-b.ts"],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    const human = await ledger.ingestMemoryNote({
      kind: "convention",
      text: "Prefer explicit return types on every exported function",
      modules: ["gov/self-c.ts"],
      topics: [topic],
      createdBy: "human:op",
    });

    // The agent tries to self-confirm, once as ITSELF, once with principal OMITTED.
    await ledger.updateMemoryNote(asAgent.note.id, {
      confirmed: true,
      principal: "agent:intruder", // honest agent identity → INERT
    });
    await ledger.updateMemoryNote(asOmitted.note.id, { confirmed: true }); // omitted → system
    // The human confirms theirs.
    await ledger.updateMemoryNote(human.note.id, {
      confirmed: true,
      principal: "human:op",
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // Neither self-confirm elevated the note; only the human confirm did.
    expect((await graph.getMemoryNote(asAgent.note.id))?.confirmed).toBe(false);
    expect((await graph.getMemoryNote(asOmitted.note.id))?.confirmed).toBe(false);
    expect((await graph.getMemoryNote(human.note.id))?.confirmed).toBe(true);

    // The gate admits ONLY the human-confirmed note, no self-confirm escape.
    const gate = (await graph.recallForGate({ topic })).map((n) => n.id);
    expect(gate).not.toContain(asAgent.note.id);
    expect(gate).not.toContain(asOmitted.note.id);
    expect(gate).toContain(human.note.id);
    console.log(
      `[KG-6 F1 self-confirm] agent:x confirm + omitted confirm → NOT in gate; human:op confirm → in gate`
    );
  });

  it("F4 GATE COMPLETENESS: an OLD governed note is not dropped by LIMIT in favour of a NEWER ungoverned one", async () => {
    const topic = "gov-f4";
    // OLDER note, then human-confirmed → governed.
    const oldGoverned = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The service mesh enforces mTLS between all internal services",
      modules: ["gov/f4-a.ts"],
      topics: [topic],
      createdBy: "human:op",
    });
    await ledger.updateMemoryNote(oldGoverned.note.id, {
      confirmed: true,
      principal: "human:op",
    });
    // A strictly NEWER, ungoverned low-trust note on the same topic.
    const newerUngoverned = await ledger.ingestMemoryNote({
      kind: "attempt",
      text: "Skip mTLS locally to speed up the inner development loop",
      modules: ["gov/f4-b.ts"],
      topics: [topic],
      trust: "low",
      createdBy: "agent:intruder",
    });
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // Even at LIMIT 1 (newest-first ordering), the GATE returns the OLD governed
    // note, the gate is enforced IN the query, so LIMIT applies to governed rows
    // (completeness), not the newest rows then filtered to empty.
    const gated = await graph.recallMemory({ topic, governedOnly: true }, 1);
    expect(gated.map((n) => n.id)).toEqual([oldGoverned.note.id]);
    // General recall at LIMIT 1 returns the NEWER note, proving the ordering and
    // that the difference is the gate, not luck.
    const general = await graph.recallMemory({ topic }, 1);
    expect(general.map((n) => n.id)).toEqual([newerUngoverned.note.id]);
    console.log(
      `[KG-6 F4 gate-completeness] LIMIT 1 gated → old governed note; LIMIT 1 general → newer ungoverned note`
    );
  });
});

describe("memory governance: wipe + reproject (KG-6 durability)", () => {
  it("ACCEPTANCE: wipe the .lbug store → reproject → PROPOSES_SUPERSEDE edges + confirmed-state + provenance all restore with zero loss", async () => {
    // 1. A pending governed proposal (both notes active).
    const pmod = "gov/wipe-proposal.ts";
    const victim = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The default page size for list endpoints is fifty items",
      modules: [pmod],
      topics: ["gov-wipe-proposal"],
      createdBy: "human:dana", // high, UNCONFIRMED
    });
    const proposal = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "The default page size for list endpoints is one hundred items",
      modules: [pmod],
      topics: ["gov-wipe-proposal"],
      trust: "low",
      createdBy: "agent:intruder",
    });
    expect(proposal.action).toBe("proposed");

    // 2. A confirmed note (confirmed-state + real confirmer provenance).
    const confirmed = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "All outbound webhooks must be signed with the shared secret",
      modules: ["gov/wipe-confirmed.ts"],
      topics: ["gov-wipe-confirmed"],
      createdBy: "human:dana",
    });
    await ledger.updateMemoryNote(confirmed.note.id, {
      confirmed: true,
      principal: "human:dana",
    });
    await settle();

    // 3. WIPE the LadybugDB store (STORE_VERSION bump / corrupt-store recovery).
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);

    // 4. Rebuild PURELY from the durable ledger.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();

    // PROPOSES_SUPERSEDE edge restored; both notes still active.
    expect(await graph.proposedSupersedesOf(proposal.note.id)).toContain(
      victim.note.id
    );
    expect((await graph.getMemoryNote(victim.note.id))?.status).toBe("active");
    expect((await graph.getMemoryNote(proposal.note.id))?.status).toBe("active");
    // Confirmed-state + real confirmer provenance restored.
    expect((await graph.getMemoryNote(confirmed.note.id))?.confirmed).toBe(true);
    expect(await graph.confirmersOf(confirmed.note.id)).toContain(
      "principal-human-dana"
    );
    // The gate still excludes the hostile proposal after a rebuild.
    const gateIds = (
      await graph.recallForGate({ topic: "gov-wipe-proposal" })
    ).map((n) => n.id);
    expect(gateIds).not.toContain(proposal.note.id);
    expect(gateIds).not.toContain(victim.note.id); // unconfirmed → excluded too

    console.log(
      `[KG-6 wipe+reproject] PROPOSES_SUPERSEDE edge, confirmed-state, and real-confirmer provenance ALL restored from the ledger`
    );
  }, 30_000);
});

// KG-8 (ADR-0014), the REBUILDABLE recent-activity projection is durable exactly
// like memory: a .lbug wipe → reproject restores the ACTED_ON edges from the
// append-only Event log (+ the trusted DispatchJob claim-state) with ZERO loss, and
// the surfaced coordinate row NEVER carries Event.message / DispatchJob.brief text.
describe("activity projection: wipe + reproject (KG-8 durability + side-channel)", () => {
  const SINCE = "2026-07-01T00:00:00.000Z"; // a floor well before the touch
  const AT = "2026-07-12T00:00:00.000Z";
  const SYM = "kg8/wipe.ts#handler";
  const MOD = "kg8/wipe.ts";

  it("ACCEPTANCE: wipe the .lbug store → reproject → ACTED_ON edges restore from the ledger with zero loss; coordinates only (no message/brief leak)", async () => {
    // 1. The trusted claim-state: a DispatchJob for the task (a POISON brief that
    //    must never ride out as a coordinate).
    const job = await db.prisma.dispatchJob.create({
      data: {
        vendor: "codex",
        taskId: "kg8-task",
        brief: "SECRET_BRIEF_KG8_POISON",
        status: "running",
      },
    });
    // 2. Append-only Event log: a symbol touch + declared module intent, each carrying a
    //    POISON `message` and a POISON extra `metadata` field the projection must
    //    ignore (it reads ONLY coordinate arrays).
    await db.prisma.event.create({
      data: {
        laneId: "codex",
        taskId: "kg8-task",
        kind: "task.progress",
        message: "SECRET_MESSAGE_KG8_POISON",
        metadata: { symbols: [SYM], secret: "SECRET_META_KG8_POISON" },
        timestamp: new Date(AT),
      },
    });
    await db.prisma.event.create({
      data: {
        laneId: "codex",
        taskId: "kg8-task",
        kind: "task.progress",
        message: "SECRET_MESSAGE_KG8_POISON_2",
        metadata: { intentModules: [MOD] },
        timestamp: new Date(AT),
      },
    });

    // 3. Project → the recent read surfaces the symbol collision with the TRUSTED
    //    DispatchJob coordinates (jobId/vendor), and NO poison text.
    await ledger.projectLedgerToGraph();
    const graph = graphLib.getGraph();
    const before = await graph.recentActivityOn(
      { symbols: [SYM], modules: [MOD] },
      SINCE
    );
    const rowBefore = before.find((r) => r.taskId === "kg8-task");
    expect(rowBefore).toBeDefined();
    expect(rowBefore).toMatchObject({
      taskId: "kg8-task",
      laneId: "codex",
      vendor: "codex", // enriched from the trusted DispatchJob claim-state
      jobId: job.id,
      anchor: SYM,
      anchorKind: "symbol",
      kind: "editing",
      state: "recent",
    });
    expect(JSON.stringify(before)).not.toContain("SECRET_");

    // 4. WIPE the LadybugDB store.
    await graphLib.closeGraph();
    const storePath = graphLib.currentGraphStorePath();
    for (const file of [storePath, `${storePath}.wal`, `${storePath}.shm`]) {
      rmSync(file, { force: true });
    }
    expect(existsSync(storePath)).toBe(false);

    // 5. Rebuild PURELY from the durable ledger → ACTED_ON restored, zero loss.
    await ledger.projectLedgerToGraph();
    const rebuilt = graphLib.getGraph();
    const after = await rebuilt.recentActivityOn(
      { symbols: [SYM], modules: [MOD] },
      SINCE
    );
    const rowAfter = after.find((r) => r.taskId === "kg8-task");
    expect(rowAfter).toEqual(rowBefore); // byte-identical coordinate row
    expect(JSON.stringify(after)).not.toContain("SECRET_");

    console.log(
      `[KG-8 wipe+reproject] ACTED_ON symbol/module edges restored from the append-only Event log (+ DispatchJob claim-state); coordinates only, no message/brief leak`
    );
  }, 30_000);
});
