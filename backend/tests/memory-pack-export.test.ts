import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// P1.4 Slice 1 — workspace memory pack EXPORT (backend/src/lib/memory-pack.ts).
//
// The pack is the file transport for the confirmed-memory moat, so these tests
// encode the acceptance clauses directly:
//   - only HUMAN-confirmed active notes are exported (no unconfirmed text ever
//     leaves the brain), every exclusion is a counted, honest omission;
//   - secrets are redacted before any byte is serialized (leak-scan);
//   - export is deterministic and content-addressed (byte-identical re-export,
//     recordHash/packDigest recomputable, confirmation⇔content hash binding);
//   - revocation/supersession ride as tombstones derived purely from the ledger;
//   - oversize text is OMITTED with a reason, never truncated;
//   - machine-local anchors (taskId/laneId) never appear in a record.
//
// ADR-0026 §7 (step 5) replaced the workspace boundary underneath this fixture: it
// is now an ALLOW-predicate on `MemoryNote.workspacePath` rather than a deny-list
// over `taskId → Task.workspacePath`. Every note here therefore carries an explicit
// partition, and two of them carry a taskId that DISAGREES with it — a pair that
// only passes if the note column decides and the task join no longer does. The new
// boundary's own directions, the residue policy and the pack routes live in
// `memory-pack-workspace.test.ts`.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));

type Db = typeof import("../src/lib/db.js");
type Ledger = typeof import("../src/lib/memory-ledger.js");
type PackLib = typeof import("../src/lib/memory-pack.js");

let prisma: Db["prisma"];
let ledger: Ledger;
let packLib: PackLib;
let dataDir: string;
let wsPath: string;
let otherWsPath: string;

const SENTINEL_KEY = "sk-sentinel-4f9d2c81deadbeef";
const SENTINEL_BEARER = "eyJsentinelJWTtoken12345678";
const OVERSIZE_MARKER = "oversize-note-marker";

const T0 = new Date("2026-07-01T10:00:00.000Z");
const T1 = new Date("2026-07-02T10:00:00.000Z");
const T2 = new Date("2026-07-03T10:00:00.000Z");

async function seedNote(input: {
  id: string;
  text: string;
  scope?: string;
  status?: string;
  /** ADR-0026: the note's partition. Explicit on every row — `undefined` would be
   *  the §8 residue, which is a distinct, separately-tested outcome. */
  workspacePath: string | null;
  taskId?: string | null;
  laneId?: string | null;
  supersededBy?: string | null;
  retiredAt?: Date | null;
  createdBy?: string;
  modules?: string[];
  topics?: string[];
  symbols?: string[];
  confirmations?: { principal: string; decision: string; at: Date }[];
}) {
  await prisma.memoryNote.create({
    data: {
      id: input.id,
      kind: "constraint",
      text: input.text,
      textHash: ledger.computeMemoryTextHash(input.text),
      scope: input.scope ?? "project",
      trust: "high",
      status: input.status ?? "active",
      createdBy: input.createdBy ?? "human:carol",
      workspacePath: input.workspacePath,
      taskId: input.taskId ?? null,
      laneId: input.laneId ?? null,
      supersededBy: input.supersededBy ?? null,
      retiredAt: input.retiredAt ?? null,
      recordedAt: T0,
      validFrom: T0,
      modules: input.modules ?? [],
      topics: input.topics ?? [],
      symbols: input.symbols ?? [],
    },
  });
  for (const c of input.confirmations ?? []) {
    await prisma.confirmation.create({
      data: {
        noteId: input.id,
        principal: c.principal,
        decision: c.decision,
        at: c.at,
      },
    });
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-memory-pack-"));
  wsPath = path.join(dataDir, "repo");
  otherWsPath = path.join(dataDir, "other-repo");
  mkdirSync(wsPath, { recursive: true });
  mkdirSync(otherWsPath, { recursive: true });
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_DATA_DIR = dataDir;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  ledger = await import("../src/lib/memory-ledger.js");
  packLib = await import("../src/lib/memory-pack.js");

  const taskInWs = await prisma.task.create({
    data: { title: "in-ws", description: "task in this workspace", workspacePath: wsPath },
  });
  const taskOther = await prisma.task.create({
    data: { title: "other-ws", description: "task elsewhere", workspacePath: otherWsPath },
  });

  // Exported: plain human-confirmed active note carrying sentinel secrets.
  await seedNote({
    id: "mem-confirmed",
    text: `Never log credentials. API_KEY=${SENTINEL_KEY} and Authorization: Bearer ${SENTINEL_BEARER} must stay out of logs.`,
    workspacePath: wsPath,
    modules: ["backend/src/lib/auth.ts"],
    topics: ["auth"],
    symbols: ["backend/src/lib/auth.ts#requireOperator"],
    confirmations: [
      { principal: "human:carol", decision: "confirm", at: T1 },
      {
        principal: "human:carol",
        decision: "pin",
        at: new Date(T1.getTime() + 1_000),
      },
    ],
  });
  // Excluded: active but never confirmed.
  await seedNote({
    id: "mem-unconfirmed",
    text: "an unconfirmed observation",
    workspacePath: wsPath,
  });
  // Excluded with its own reason: a pause is local "not now", neither a
  // portable confirmation nor a revocation tombstone.
  await seedNote({
    id: "mem-paused",
    text: "confirmed locally but paused before export",
    workspacePath: wsPath,
    status: "paused",
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Excluded: only an AGENT "confirm" row — never crosses the gate.
  await seedNote({
    id: "mem-agent-confirmed",
    text: "agent tried to self-confirm this",
    workspacePath: wsPath,
    createdBy: "agent:codex",
    confirmations: [{ principal: "agent:codex", decision: "confirm", at: T1 }],
  });
  // Excluded, NO tombstone: rejected without any prior human confirm.
  await seedNote({
    id: "mem-rejected-neverconfirmed",
    text: "rejected before any human confirm",
    workspacePath: wsPath,
    status: "rejected",
    retiredAt: T2,
  });
  // Excluded: private / lane scopes never leave the machine.
  await seedNote({
    id: "mem-private",
    text: "a private-scope confirmed note",
    workspacePath: wsPath,
    scope: "private:alice",
    confirmations: [{ principal: "human:alice", decision: "confirm", at: T1 }],
  });
  await seedNote({
    id: "mem-lane",
    text: "a lane-scope confirmed note",
    workspacePath: wsPath,
    scope: "lane:k1",
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Excluded: PARTITIONED to another workspace — and its task points at THIS one.
  // Under the deny-list this note was exportable from here; under ADR-0026 §7's
  // allow-predicate the note's own column decides and the task join is inert.
  await seedNote({
    id: "mem-other-ws",
    text: "confirmed but belongs to another workspace",
    workspacePath: otherWsPath,
    taskId: taskInWs.id,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Exported: partitioned to THIS workspace while its task points ELSEWHERE (the
  // mirror image of the note above), and its taskId must be dropped from the record.
  await seedNote({
    id: "mem-task-ws",
    text: "confirmed and anchored to a task in this workspace",
    workspacePath: wsPath,
    taskId: taskOther.id,
    laneId: "lane-cuid-1",
    modules: ["src/parser.ts"],
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Excluded (§8 residue): confirmed, in-scope, and assigned to NO workspace. It
  // leaves in nobody's pack and is counted under its own distinct reason.
  await seedNote({
    id: "mem-unassigned",
    text: "a confirmed note that was never assigned to a workspace",
    workspacePath: null,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Excluded with reason, never truncated: oversize confirmed note.
  await seedNote({
    id: "mem-oversize",
    text: `${OVERSIZE_MARKER} ${"x".repeat(10_050)}`,
    workspacePath: wsPath,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Tombstone (superseded): retired, previously human-confirmed, has successor.
  await seedNote({
    id: "mem-superseded-old",
    text: "the old form of the constraint",
    workspacePath: wsPath,
    status: "rejected",
    supersededBy: "mem-successor",
    retiredAt: T2,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  // Exported successor: carries the predecessor's textHash as chain evidence.
  await seedNote({
    id: "mem-successor",
    text: "the refined form of the constraint",
    workspacePath: wsPath,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T2 }],
  });
  // Tombstone (revoked): retired, previously human-confirmed, no successor.
  await seedNote({
    id: "mem-revoked",
    text: "a confirmed fact later revoked",
    workspacePath: wsPath,
    status: "rejected",
    retiredAt: T2,
    confirmations: [
      { principal: "human:carol", decision: "confirm", at: T1 },
      { principal: "human:carol", decision: "reject", at: T2 },
    ],
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  delete process.env.MUON_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("memory pack export (P1.4 slice 1)", () => {
  it("exports ONLY human-confirmed active notes; every exclusion is a counted omission", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    const exportedIds = pack.manifest.records.map((r) => r.originNoteId).sort();
    expect(exportedIds).toEqual(["mem-confirmed", "mem-successor", "mem-task-ws"]);
    expect(pack.manifest.counts.records).toBe(3);
    expect(pack.manifest.counts.tombstones).toBe(2);
    expect(pack.manifest.counts.omitted).toBe(9);
    const omissions = pack.manifest.omissions.join("\n");
    expect(omissions).toMatch(/2 notes excluded: not human-confirmed/);
    expect(omissions).toMatch(/1 note excluded: paused by the local operator/);
    expect(omissions).toMatch(/1 note excluded: rejected without a prior human confirmation/);
    expect(omissions).toMatch(/1 note excluded: scope private:\*/);
    expect(omissions).toMatch(/1 note excluded: scope lane:\*/);
    // ADR-0026 §7 — the two workspace withholdings, each under its OWN reason.
    expect(omissions).toMatch(/1 note excluded: belongs to another workspace/);
    expect(omissions).toMatch(
      /1 note excluded: not assigned to a workspace \(unscoped residue\)/
    );
    expect(omissions).toMatch(/1 note excluded: text exceeds 10000 chars/);
    // origin identity: opaque salted fingerprint + human-readable basename label.
    expect(pack.manifest.origin.fingerprint).toMatch(/^ws-[0-9a-f]{16}$/);
    expect(pack.manifest.origin.label).toBe("repo");
    // pack invariants block travels with the manifest.
    expect(pack.manifest.invariants).toEqual({
      confirmedOnly: true,
      unconfirmedTextExcluded: true,
      secretsRedactedBeforeWrite: true,
      noCredentialMaterial: true,
    });
  });

  it("leak-scan: sentinel secrets never survive into any serialized byte of the pack", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    const everything = JSON.stringify(pack);
    expect(everything).not.toContain(SENTINEL_KEY);
    expect(everything).not.toContain(SENTINEL_BEARER);
    // the redacted note is still exported (redaction, not omission)
    expect(pack.manifest.records.some((r) => r.originNoteId === "mem-confirmed")).toBe(true);
    const record = pack.records.find((r) => r.record.origin.noteId === "mem-confirmed");
    expect(record?.record.note.text).toContain("[redacted]");
  });

  it("determinism: two exports over the same ledger are deep-equal and byte-identical", async () => {
    const a = await packLib.collectMemoryPack(wsPath);
    const b = await packLib.collectMemoryPack(wsPath);
    expect(a).toEqual(b);
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
    for (let i = 0; i < a.records.length; i += 1) {
      expect(packLib.canonicalRecordJson(a.records[i].record)).toBe(
        packLib.canonicalRecordJson(b.records[i].record)
      );
    }
    // stable ordering everywhere: records by hash asc, tombstones by originNoteId
    const hashes = a.manifest.records.map((r) => r.hash);
    expect(hashes).toEqual([...hashes].sort());
    const tombIds = a.manifest.tombstones.map((t) => t.originNoteId);
    expect(tombIds).toEqual([...tombIds].sort());
    for (const { record } of a.records) {
      expect(record.note.modules).toEqual([...record.note.modules].sort());
      expect(record.note.topics).toEqual([...record.note.topics].sort());
      expect(record.note.symbols).toEqual([...record.note.symbols].sort());
      expect(record.supersededTextHashes).toEqual([...record.supersededTextHashes].sort());
    }
  });

  it("content addressing: recordHash + packDigest recompute; confirmation⇔text hash binding holds", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    for (const { hash, record } of pack.records) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(packLib.recordHashOf(record)).toBe(hash);
      const manifestEntry = pack.manifest.records.find((r) => r.hash === hash);
      expect(manifestEntry?.file).toBe(`records/${hash}.json`);
      expect(manifestEntry?.originNoteId).toBe(record.origin.noteId);
      // the confirmed text IS the exported text: binding is a fresh recompute
      expect(record.confirmation.textHash).toBe(record.note.textHash);
      expect(record.note.textHash).toBe(ledger.computeMemoryTextHash(record.note.text));
      expect(manifestEntry?.textHash).toBe(record.note.textHash);
      // only a human confirm row is ever exported as the confirmation
      expect(record.confirmation.decision).toBe("confirm");
      expect(record.confirmation.principal.startsWith("human")).toBe(true);
    }
    expect(packLib.packDigestOf(pack.manifest)).toBe(pack.manifest.packDigest);
  });

  it("tombstones: retired previously-confirmed notes only; superseded carries its successor", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    const byId = new Map(pack.manifest.tombstones.map((t) => [t.originNoteId, t]));
    const superseded = byId.get("mem-superseded-old");
    expect(superseded).toBeDefined();
    expect(superseded?.reason).toBe("superseded");
    expect(superseded?.supersededByNoteId).toBe("mem-successor");
    expect(superseded?.retiredAt).toBe(T2.toISOString());
    const revoked = byId.get("mem-revoked");
    expect(revoked).toBeDefined();
    expect(revoked?.reason).toBe("revoked");
    expect(revoked?.supersededByNoteId).toBeNull();
    // never-confirmed rejected note emits NOTHING (no tombstone, no record)
    expect(byId.has("mem-rejected-neverconfirmed")).toBe(false);
    // successor carries the retired predecessor's textHash as chain evidence
    const successor = pack.records.find((r) => r.record.origin.noteId === "mem-successor");
    expect(successor?.record.supersededTextHashes).toContain(
      ledger.computeMemoryTextHash("the old form of the constraint")
    );
  });

  it("oversize confirmed text is OMITTED with a reason, never truncated", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    expect(pack.manifest.records.some((r) => r.originNoteId === "mem-oversize")).toBe(false);
    expect(JSON.stringify(pack)).not.toContain(OVERSIZE_MARKER);
    expect(pack.manifest.omissions.join("\n")).toMatch(/text exceeds 10000 chars/);
  });

  it("machine-local anchors (taskId/laneId) never appear in a record", async () => {
    const pack = await packLib.collectMemoryPack(wsPath);
    const taskAnchored = pack.records.find((r) => r.record.origin.noteId === "mem-task-ws");
    expect(taskAnchored).toBeDefined();
    const serialized = packLib.canonicalRecordJson(taskAnchored!.record);
    expect(serialized).not.toContain("taskId");
    expect(serialized).not.toContain("laneId");
    expect(serialized).not.toContain("lane-cuid-1");
    // module anchors DO survive (workspace-relative, portable)
    expect(taskAnchored!.record.note.modules).toContain("src/parser.ts");
  });

  it("mints a stable 0600 pack salt and a stable fingerprint across exports", async () => {
    const a = await packLib.collectMemoryPack(wsPath);
    const b = await packLib.collectMemoryPack(wsPath);
    expect(a.manifest.origin.fingerprint).toBe(b.manifest.origin.fingerprint);
    const salt = readFileSync(path.join(dataDir, "pack-salt"), "utf8").trim();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // a different workspace under the same salt gets a DIFFERENT fingerprint
    const other = await packLib.collectMemoryPack(otherWsPath);
    expect(other.manifest.origin.fingerprint).not.toBe(a.manifest.origin.fingerprint);
  });
});

// CODE-E — a large workspace must still export IMPORTABLY. Export was uncapped
// while import hard-refuses >500 records, so a 501+-note brain dead-ended team
// sync. Export now splits deterministically into pages that each honor the
// shared record + redaction-char caps; every page is a standalone importable
// pack with its own recomputable digest, ordering preserved across the split.
type PackSource = Parameters<PackLib["buildMemoryPackPages"]>[0];

function synthSource(
  notes: { id: string; text: string }[],
  origin = { fingerprint: "ws-000000000000abcd", label: "big" }
): PackSource {
  const rows = notes.map(
    (n) =>
      ({
        id: n.id,
        kind: "constraint",
        text: n.text,
        textHash: ledger.computeMemoryTextHash(n.text),
        scope: "project",
        trust: "high",
        status: "active",
        createdBy: "human:carol",
        taskId: null,
        laneId: null,
        supersededBy: null,
        retiredAt: null,
        recordedAt: T0,
        validFrom: T0,
        updatedAt: T0,
        // ADR-0026 §7: the paging fixture has to be IN the exporting partition, or
        // the allow-predicate withholds all 1201 rows and every page assertion below
        // measures an empty pack.
        workspacePath: wsPath,
        modules: [],
        topics: [],
        symbols: [],
      }) as unknown as PackSource["notes"][number]
  );
  const confirmations = notes.map((n) => ({
    noteId: n.id,
    principal: "human:carol",
    decision: "confirm",
    at: T1,
  }));
  return {
    workspacePath: wsPath,
    origin,
    notes: rows,
    confirmations,
  } as PackSource;
}

describe("memory pack export paging (CODE-E)", () => {
  it("splits a 501+ record workspace into importable pages at the record cap, order preserved + deterministic", () => {
    const N = 1201;
    const source = synthSource(
      Array.from({ length: N }, (_, i) => ({
        id: `mem-page-${String(i).padStart(4, "0")}`,
        text: `page fact ${i} — a short confirmed memory ${"z".repeat(30)}`,
      }))
    );
    const pages = packLib.buildMemoryPackPages(source);
    expect(pages.length).toBe(Math.ceil(N / 500)); // 3
    for (const page of pages) {
      expect(page.manifest.records.length).toBeLessThanOrEqual(500);
      // each page is a standalone importable pack: its digest recomputes.
      expect(packLib.packDigestOf(page.manifest)).toBe(page.manifest.packDigest);
      expect(page.manifest.counts.pageCount).toBe(pages.length);
      expect(page.manifest.counts.totalRecords).toBe(N);
    }
    // every record appears exactly once across all pages; hashes globally sorted.
    const allHashes = pages.flatMap((p) => p.manifest.records.map((r) => r.hash));
    expect(new Set(allHashes).size).toBe(N);
    expect(allHashes).toEqual([...allHashes].sort());
    // deterministic rebuild + page selection via buildMemoryPack(opts.page).
    expect(JSON.stringify(packLib.buildMemoryPackPages(source))).toBe(
      JSON.stringify(pages)
    );
    expect(packLib.buildMemoryPack(source, { page: 1 })).toEqual(pages[1]);
    expect(packLib.buildMemoryPack(source, { page: 0 })).toEqual(pages[0]);
  });

  it("splits by the aggregate redaction-char budget even below the record cap, so no page exceeds what import accepts", () => {
    const CHARS = 9_900;
    const N = 60; // 60 * 9.9k ≈ 594k > the 500k char budget, but < 500 records
    const source = synthSource(
      Array.from({ length: N }, (_, i) => ({
        id: `mem-big-${String(i).padStart(4, "0")}`,
        text: `big ${i} ${"y".repeat(CHARS)}`,
      }))
    );
    const pages = packLib.buildMemoryPackPages(source);
    expect(pages.length).toBeGreaterThan(1); // char budget forced a split
    for (const page of pages) {
      expect(page.manifest.records.length).toBeLessThanOrEqual(500);
      const pageChars = page.records.reduce(
        (sum, r) => sum + r.record.note.text.length,
        0
      );
      expect(pageChars).toBeLessThanOrEqual(500_000);
    }
    // still lossless: all N records land across the pages.
    const total = pages.reduce((sum, p) => sum + p.manifest.records.length, 0);
    expect(total).toBe(N);
  }, 60_000);
});
