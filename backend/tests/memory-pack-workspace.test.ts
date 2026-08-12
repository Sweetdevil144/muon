import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── ADR-0026 §7 (rollout step 5) — THE PACK PATH ─────────────────────────────
//
// The pack is the one place a workspace dimension crosses a MACHINE boundary,
// into a directory the user is told to commit to a team git repo. Step 5 replaced
// a fail-OPEN deny-list with an ALLOW-predicate, and this file exists because the
// deny-list was not merely loose — it was a confidentiality break with a verified
// four-step chain:
//
//   1. `importMemoryPack` stamped no `taskId` → every imported note landed NULL;
//   2. `inWorkspace(null)` returned true → the note was "in-workspace" for EVERY
//      workspace on the machine;
//   3. one local human confirm made it exportable, in an operator surface that
//      (§1) never said which repo the note came from;
//   4. `GET /pack/export?workspace=<anything>` then shipped it in every
//      workspace's pack.
//
// The first test walks exactly that chain and asserts the OPPOSITE at step 4. The
// rest hold the boundary in both directions, because a fence asserted in one
// direction only is indistinguishable from an export that returns nothing.
//
// Sibling files: `memory-pack-export.test.ts` owns the confirmed-only moat and the
// exact omission arithmetic; `memory-pack-import.test.ts` owns the hostile-pack
// verifier. This file owns the PARTITION.

// SPREAD THE ACTUAL MODULE, then override only the three the pack path must not
// really do. An ENUMERATING mock is a drift surface: it lists the exports the
// module had on the day it was written, so the next export added to `graph.js`
// fails these tests with "No X export is defined on the mock" — which is what
// happened when the confirm path started draining in-flight mirrors. Spreading
// keeps every function the mock does not care about real, and a no-op
// `mirrorToGraph` means nothing is ever enqueued, so the real drain is a no-op too.
vi.mock("../src/lib/graph.js", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/graph.js")>(
    "../src/lib/graph.js"
  )),
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));

type Db = typeof import("../src/lib/db.js");
type Ledger = typeof import("../src/lib/memory-ledger.js");
type PackLib = typeof import("../src/lib/memory-pack.js");
type ImportLib = typeof import("../src/lib/memory-pack-import.js");
type PackExport = Awaited<ReturnType<PackLib["collectMemoryPack"]>>;

let prisma: Db["prisma"];
let ledger: Ledger;
let packLib: PackLib;
let importLib: ImportLib;
let app: FastifyInstance;

let dir: string;
let repoA: string;
let repoB: string;
/** A governed worktree INSIDE repo A: `repoRootOf` must reduce it to repo A. */
let worktreeOfA: string;

const OPERATOR = "operator-token-pack-ws";
const AGENT = "agent-token-pack-ws";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// Path segments that must never ride a pack. Spelled into the workspace path
// itself so the leak-scan below is capable of FAILING: if any absolute local path
// ever reached a serialized record, these are the bytes that would show up.
const USER_SENTINEL = "username-sentinel-yankee";
const HOST_SENTINEL = "hostname-sentinel-zulu";

const T0 = new Date("2026-07-01T10:00:00.000Z");
const T1 = new Date("2026-07-02T10:00:00.000Z");
const T2 = new Date("2026-07-03T10:00:00.000Z");
const T_CONFIRM = "2026-07-02T10:00:00.000Z";

type SeedSpec = {
  id: string;
  text: string;
  workspacePath: string | null;
  status?: string;
  retiredAt?: Date | null;
  confirmations?: { principal: string; decision: string; at: Date }[];
};

/** A LOCAL note, written straight to the ledger so the partition is exact and the
 *  fixture does not depend on the write path this file is not about. */
async function seedNote(spec: SeedSpec): Promise<void> {
  await prisma.memoryNote.create({
    data: {
      id: spec.id,
      kind: "constraint",
      text: spec.text,
      textHash: ledger.computeMemoryTextHash(spec.text),
      scope: "project",
      trust: "high",
      status: spec.status ?? "active",
      createdBy: "human:carol",
      workspacePath: spec.workspacePath,
      retiredAt: spec.retiredAt ?? null,
      recordedAt: T0,
      validFrom: T0,
      modules: ["src/pay/charge.ts"],
      topics: [],
      symbols: [],
    },
  });
  for (const confirmation of spec.confirmations ?? []) {
    await prisma.confirmation.create({
      data: {
        noteId: spec.id,
        principal: confirmation.principal,
        decision: confirmation.decision,
        at: confirmation.at,
      },
    });
  }
}

type PackRecord = {
  hash: string;
  record: ReturnType<typeof makeRecord>["record"];
};
type Tombstone = {
  originNoteId: string;
  textHash: string;
  reason: "superseded" | "revoked";
  supersededByNoteId: string | null;
  retiredAt: string;
};

/** One INCOMING pack record from a teammate's brain. `extra` is the hostile knob:
 *  keys a pack must not be able to set locally (`recordHashOf` canonicalizes
 *  field-by-field, so they neither change the content address nor survive the
 *  verifier's schema). */
function makeRecord(spec: {
  originFingerprint: string;
  originNoteId: string;
  text: string;
  modules?: string[];
  extra?: Record<string, unknown>;
}) {
  const textHash = ledger.computeMemoryTextHash(spec.text);
  const record = {
    version: 1 as const,
    origin: {
      fingerprint: spec.originFingerprint,
      noteId: spec.originNoteId,
      label: "teammate-repo",
    },
    note: {
      kind: "constraint",
      text: spec.text,
      textHash,
      scope: "project",
      trust: "high",
      modules: [...(spec.modules ?? [])].sort(),
      topics: [],
      symbols: [],
      validFrom: "2026-07-01T10:00:00.000Z",
      recordedAt: "2026-07-01T10:00:00.000Z",
    },
    author: { principal: "human:carol", kind: "human" as const },
    confirmation: {
      principal: "human:carol",
      decision: "confirm" as const,
      at: T_CONFIRM,
      textHash,
    },
    supersededTextHashes: [],
    ...(spec.extra ?? {}),
  };
  return { hash: packLib.recordHashOf(record), record };
}

function makePack(
  originFingerprint: string,
  records: PackRecord[],
  tombstones: Tombstone[] = []
) {
  const sorted = [...records].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const sortedTombs = [...tombstones].sort((a, b) =>
    a.originNoteId < b.originNoteId ? -1 : 1
  );
  const core = {
    version: 1 as const,
    origin: { fingerprint: originFingerprint, label: "teammate-repo" },
    records: sorted.map(({ hash, record }) => ({
      hash,
      file: `records/${hash}.json`,
      originNoteId: record.origin.noteId,
      textHash: record.note.textHash,
    })),
    tombstones: sortedTombs,
  };
  return {
    manifest: {
      ...core,
      counts: { records: sorted.length, tombstones: sortedTombs.length, omitted: 0 },
      omissions: [],
      invariants: {
        confirmedOnly: true,
        unconfirmedTextExcluded: true,
        secretsRedactedBeforeWrite: true,
        noCredentialMaterial: true,
      },
      packDigest: packLib.packDigestOf(core),
    },
    records: sorted,
  };
}

function expectOk(
  result: Awaited<ReturnType<ImportLib["importMemoryPack"]>>
): Extract<Awaited<ReturnType<ImportLib["importMemoryPack"]>>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok import, refused: ${result.reason}`);
  }
  return result;
}

/** The manifest's omission lines, parsed back into reason → count. The counts are
 *  the operator-visible half of this change: a withheld note must be COUNTED under
 *  a reason that says WHY, never silently dropped. */
function omissions(pack: PackExport): Map<string, number> {
  const parsed = new Map<string, number>();
  for (const line of pack.manifest.omissions) {
    const match = /^(\d+) notes? excluded: (.+)$/.exec(line);
    if (match) {
      parsed.set(match[2]!, Number(match[1]));
    }
  }
  return parsed;
}

const exportedNoteIds = (pack: PackExport): string[] =>
  pack.manifest.records.map((entry) => entry.originNoteId).sort();
const tombstonedNoteIds = (pack: PackExport): string[] =>
  pack.manifest.tombstones.map((entry) => entry.originNoteId).sort();

beforeAll(async () => {
  // realpath FIRST: `repoRootOf` symlink-resolves, and on macOS `/var/folders/…`
  // is a symlink to `/private/var/folders/…`. Without this the route-reduced path
  // and the seeded partition would be two spellings of one directory — which is
  // precisely the defect this slice fixes, and it must not be the thing under test.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-pack-ws-")));
  repoA = path.join(dir, USER_SENTINEL, HOST_SENTINEL, "repo-a");
  repoB = path.join(dir, USER_SENTINEL, HOST_SENTINEL, "repo-b");
  worktreeOfA = path.join(repoA, ".muon", "worktrees", "task-wt-1");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  mkdirSync(worktreeOfA, { recursive: true });

  process.env.DATABASE_URL = `file:${path.join(dir, "muon.db")}`;
  process.env.MUON_DATA_DIR = dir;
  process.env.MUON_WORKSPACE_ROOTS = dir;
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  ledger = await import("../src/lib/memory-ledger.js");
  packLib = await import("../src/lib/memory-pack.js");
  importLib = await import("../src/lib/memory-pack-import.js");

  // The LOCAL corpus: four confirmed facts whose only meaningful difference is the
  // partition, plus one retired-but-once-confirmed note (the tombstone axis).
  await seedNote({
    id: "mem-local-a",
    text: "Charges are idempotent by request key (repo A local fact).",
    workspacePath: repoA,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  await seedNote({
    id: "mem-local-b",
    text: "Charges are idempotent by request key (repo B local fact).",
    workspacePath: repoB,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  await seedNote({
    id: "mem-local-unassigned",
    text: "A confirmed fact that was never assigned to a workspace at all.",
    workspacePath: null,
    confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
  });
  await seedNote({
    id: "mem-local-b-retired",
    text: "A repo B fact that was confirmed and then revoked.",
    workspacePath: repoB,
    status: "rejected",
    retiredAt: T2,
    confirmations: [
      { principal: "human:carol", decision: "confirm", at: T1 },
      { principal: "human:carol", decision: "reject", at: T2 },
    ],
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  delete process.env.MUON_DATA_DIR;
  delete process.env.MUON_WORKSPACE_ROOTS;
  rmSync(dir, { recursive: true, force: true });
});

describe("ADR-0026 §7 — the break, walked as a chain", () => {
  it("an imported note confirmed locally in repo A does NOT leave in repo B's pack", async () => {
    const ORIGIN = "ws-00000000000000aa";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-1",
      text: "Teammate fact: the ledger is the source of truth, the graph is a projection.",
      modules: ["src/ledger.ts"],
    });

    // 1. Import into repo A. The note no longer lands NULL — it lands IN repo A.
    const imported = expectOk(
      await importLib.importMemoryPack(makePack(ORIGIN, [record]), {
        workspace: repoA,
      })
    );
    const noteId = imported.report.proposed[0]!.noteId;
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.workspacePath).toBe(repoA);

    // 2. One local human confirm — the whole cost of making it exportable.
    await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:dana",
    });

    // 3. THE ASSERTION THAT USED TO FAIL. Export repo B: the note is withheld, and
    //    withheld VISIBLY — an operator can read why, under a reason that says the
    //    note belongs to another repo rather than "nothing to export".
    const packB = await packLib.collectMemoryPack(repoB);
    expect(exportedNoteIds(packB)).not.toContain(noteId);
    expect(JSON.stringify(packB)).not.toContain(record.record.note.text);
    expect(omissions(packB).get("belongs to another workspace") ?? 0).toBeGreaterThan(0);

    // 4. The other direction, which is what stops this being "export nothing":
    //    repo A — the workspace whose human confirmed it — still ships it.
    const packA = await packLib.collectMemoryPack(repoA);
    expect(exportedNoteIds(packA)).toContain(noteId);
    expect(JSON.stringify(packA)).toContain(record.record.note.text);
  });
});

describe("ADR-0026 §7 — the allow-predicate, both directions", () => {
  it("a local note is exportable from its OWN workspace and from no other", async () => {
    const packA = await packLib.collectMemoryPack(repoA);
    const packB = await packLib.collectMemoryPack(repoB);

    expect(exportedNoteIds(packA)).toContain("mem-local-a");
    expect(exportedNoteIds(packA)).not.toContain("mem-local-b");
    // The mirror image. Two one-directional assertions in opposite directions are
    // what make this a partition rather than a filter that happens to favour A.
    expect(exportedNoteIds(packB)).toContain("mem-local-b");
    expect(exportedNoteIds(packB)).not.toContain("mem-local-a");
  });

  it("the predicate is EQUALITY: a nested repository's note does not leave in the parent's pack", async () => {
    // Containment would look tidier and is a widener. A repository checked out
    // INSIDE another (a vendored tree, or §4's `$HOME`-dotfiles shape) is its own
    // partition, and both the write path and `repoRootOf` treat it that way — so a
    // parent whose predicate was `isWithin` would ship a repo nobody asked it to.
    const nested = path.join(repoA, "vendor", "nested-repo");
    mkdirSync(nested, { recursive: true });
    await seedNote({
      id: "mem-nested-repo",
      text: "A fact belonging to a repository checked out inside repo A.",
      workspacePath: nested,
      confirmations: [{ principal: "human:carol", decision: "confirm", at: T1 }],
    });
    const packA = await packLib.collectMemoryPack(repoA);
    expect(exportedNoteIds(packA)).not.toContain("mem-nested-repo");
    const packNested = await packLib.collectMemoryPack(nested);
    expect(exportedNoteIds(packNested)).toEqual(["mem-nested-repo"]);
  });

  it("§8: the unassigned residue leaves in NO workspace's pack, under its own reason", async () => {
    for (const workspace of [repoA, repoB]) {
      const pack = await packLib.collectMemoryPack(workspace);
      expect(exportedNoteIds(pack)).not.toContain("mem-local-unassigned");
      // A DISTINCT reason from the foreign-partition one: "unassigned" is a review
      // debt an operator can settle; "another repo's" is a partition answer.
      const reasons = omissions(pack);
      expect(
        reasons.get("not assigned to a workspace (unscoped residue)") ?? 0
      ).toBeGreaterThan(0);
      expect(reasons.get("belongs to another workspace") ?? 0).toBeGreaterThan(0);
    }
  });

  it("a workspace with no notes of its own exports an EMPTY pack that still says why", async () => {
    const empty = path.join(dir, USER_SENTINEL, HOST_SENTINEL, "repo-empty");
    mkdirSync(empty, { recursive: true });
    const pack = await packLib.collectMemoryPack(empty);
    expect(pack.manifest.counts.records).toBe(0);
    expect(pack.manifest.counts.tombstones).toBe(0);
    // Silence here would read as "this brain knows nothing", which is false.
    expect(pack.manifest.counts.omitted).toBeGreaterThan(0);
    expect(omissions(pack).get("belongs to another workspace") ?? 0).toBeGreaterThan(0);
  });

  it("a foreign retired note is not even a TOMBSTONE (the ordering property)", async () => {
    const packA = await packLib.collectMemoryPack(repoA);
    expect(tombstonedNoteIds(packA)).not.toContain("mem-local-b-retired");
    // A tombstone carries the foreign note's id AND its textHash, so leaking one is
    // leaking the existence + content address of another repo's memory. The
    // workspace check therefore runs BEFORE the rejected/tombstone branch.
    const retired = await prisma.memoryNote.findUnique({
      where: { id: "mem-local-b-retired" },
    });
    expect(JSON.stringify(packA)).not.toContain(retired!.textHash);

    // Present in its own workspace's pack, so the exclusion above is the partition
    // and not the tombstone derivation having broken.
    const packB = await packLib.collectMemoryPack(repoB);
    expect(tombstonedNoteIds(packB)).toContain("mem-local-b-retired");
  });
});

describe("ADR-0026 §7 — provenance is data, the partition is authority", () => {
  it("no absolute path, hostname or username rides a pack — only the salted fingerprint", async () => {
    const pack = await packLib.collectMemoryPack(repoA);
    const serialized = JSON.stringify(pack);

    // The scan can fail: these bytes ARE the note's stored partition.
    const stored = await prisma.memoryNote.findUnique({
      where: { id: "mem-local-a" },
    });
    expect(stored?.workspacePath).toBe(repoA);
    expect(serialized).not.toContain(repoA);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain(USER_SENTINEL);
    expect(serialized).not.toContain(HOST_SENTINEL);
    // The real machine identifiers, too. Guarded on length only because a
    // pathologically short username would make the assertion meaningless rather
    // than meaningful.
    for (const identifier of [userInfo().username, hostname()]) {
      if (identifier.length >= 4) {
        expect(serialized).not.toContain(identifier);
      }
    }
    // No record field is named for the partition either — `canonicalRecordJson`
    // rebuilds a record field-by-field, so the column cannot be added by accident.
    for (const { record } of pack.records) {
      expect(packLib.canonicalRecordJson(record)).not.toContain("workspacePath");
    }
    // What DOES identify the origin: the opaque salted fingerprint, plus a
    // basename-only label. Both deliberate, both path-free.
    expect(pack.manifest.origin.fingerprint).toMatch(/^ws-[0-9a-f]{16}$/);
    expect(pack.manifest.origin.label).toBe("repo-a");
    // Non-empty, so the scan above ran against real bytes.
    expect(pack.manifest.counts.records).toBeGreaterThan(0);
  });

  it("the local partition is NOT settable by a pack's contents", async () => {
    const ORIGIN = "ws-00000000000000bb";
    const EVIL = "/evil/absolute/path-the-pack-chose";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-hostile-partition",
      text: "A teammate record that tries to name its own local partition.",
      extra: {
        workspacePath: EVIL,
        receivingWorkspace: `${EVIL}/receiving`,
      },
    });
    // The hostile keys do not even perturb the content address (the canonical
    // projection is rebuilt field-by-field), so the pack verifies as honest.
    const imported = expectOk(
      await importLib.importMemoryPack(makePack(ORIGIN, [record]), {
        workspace: repoB,
      })
    );
    const noteId = imported.report.proposed[0]!.noteId;
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    expect(row?.workspacePath).toBe(repoB);
    expect(row?.text).not.toContain(EVIL);
    const anchors = await prisma.memoryAnchor.findMany({ where: { noteId } });
    expect(anchors.some((anchor) => anchor.value === EVIL)).toBe(false);
    expect(
      anchors.find((anchor) => anchor.kind === "workspace")?.value
    ).toBe(repoB);
    const claim = await prisma.memoryImport.findFirst({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
    });
    expect(claim?.receivingWorkspace).toBe(repoB);
  });
});

describe("ADR-0026 §7 — a pack is per-(origin workspace, receiving workspace)", () => {
  it("the same pack imported into a SECOND workspace proposes again, and the copies do not cross", async () => {
    const ORIGIN = "ws-00000000000000cc";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-two-workspaces",
      text: "A teammate fact that two of this machine's repositories both want.",
      modules: ["src/shared/rule.ts"],
    });
    const pack = makePack(ORIGIN, [record]);

    const intoA = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoA })
    );
    const intoB = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoB })
    );

    // The widened key permits the second import. `importMemoryPack` claims the row
    // BEFORE ingesting and reads P2002 as "already imported", so a mis-stamped
    // receiving workspace would swallow this silently rather than fail loudly.
    expect(intoA.report.proposed).toHaveLength(1);
    expect(intoB.report.proposed).toHaveLength(1);
    expect(intoB.report.alreadyImported).toEqual([]);
    const noteInA = intoA.report.proposed[0]!.noteId;
    const noteInB = intoB.report.proposed[0]!.noteId;
    expect(noteInA).not.toBe(noteInB);

    const rows = await prisma.memoryNote.findMany({
      where: { id: { in: [noteInA, noteInB] } },
      select: { id: true, workspacePath: true },
    });
    expect(new Map(rows.map((row) => [row.id, row.workspacePath]))).toEqual(
      new Map([
        [noteInA, repoA],
        [noteInB, repoB],
      ])
    );
    const claims = await prisma.memoryImport.findMany({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
      select: { receivingWorkspace: true, noteId: true },
    });
    expect(
      claims.map((claim) => claim.receivingWorkspace).sort()
    ).toEqual([repoA, repoB].sort());

    // Idempotence still holds WITHIN a partition: a third import into repo A is
    // `alreadyImported`, not a third proposal.
    const againIntoA = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoA })
    );
    expect(againIntoA.report.proposed).toEqual([]);
    expect(againIntoA.report.alreadyImported).toEqual([record.hash]);

    // And the two local copies stay in their own packs after a local confirm each.
    for (const noteId of [noteInA, noteInB]) {
      await ledger.updateMemoryNote(noteId, {
        confirmed: true,
        principal: "human:dana",
      });
    }
    const packA = await packLib.collectMemoryPack(repoA);
    const packB = await packLib.collectMemoryPack(repoB);
    expect(exportedNoteIds(packA)).toContain(noteInA);
    expect(exportedNoteIds(packA)).not.toContain(noteInB);
    expect(exportedNoteIds(packB)).toContain(noteInB);
    expect(exportedNoteIds(packB)).not.toContain(noteInA);
  });

  it("a fact already confirmed in repo A is still PROPOSED to repo B (dedup is partitioned)", async () => {
    // The third copy of the visibility rule, and the one §9 did not list because it
    // lives on the pack path: the `duplicate-confirmed` short-circuit reads local
    // notes by textHash. Unpartitioned, repo A having confirmed the sentence would
    // make repo B's import a no-op pointing at repo A's note — repo B's agents would
    // never see the fact, and no review item would exist to notice. §9's own words
    // about the ledger's two dedup functions: losing the other repo's copy outright
    // is worse than the leak.
    const ORIGIN = "ws-0000000000000202";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-cross-partition-dedup",
      text: "A teammate fact that repo A confirms before repo B ever imports it.",
    });
    const pack = makePack(ORIGIN, [record]);

    const intoA = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoA })
    );
    const noteInA = intoA.report.proposed[0]!.noteId;
    await ledger.updateMemoryNote(noteInA, {
      confirmed: true,
      principal: "human:dana",
    });

    const intoB = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoB })
    );
    expect(intoB.report.duplicatesOfConfirmed).toEqual([]);
    expect(intoB.report.proposed).toHaveLength(1);
    const noteInB = intoB.report.proposed[0]!.noteId;
    expect(noteInB).not.toBe(noteInA);
    const rowB = await prisma.memoryNote.findUnique({ where: { id: noteInB } });
    expect(rowB?.workspacePath).toBe(repoB);
    // Repo B's copy is its OWN review debt: unconfirmed here, whatever repo A did.
    expect(await prisma.confirmation.count({ where: { noteId: noteInB } })).toBe(0);
  });

  it("CODE-P: a failed import into a second workspace does not release the FIRST workspace's claim", async () => {
    const ORIGIN = "ws-0000000000000101";
    const SENTINEL = "INJECTED-FAILURE-SENTINEL";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-code-p",
      text: `A teammate fact whose ingest can be made to fail: ${SENTINEL}.`,
    });
    const pack = makePack(ORIGIN, [record]);

    // Repo A imports it cleanly: claim row + proposal note.
    const intoA = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoA })
    );
    const noteInA = intoA.report.proposed[0]!.noteId;

    // Now make the NEXT ingest of this exact text fail inside its transaction. A
    // SQLite trigger rather than a mocked client: the failure has to happen where
    // CODE-P's release path actually catches it, and `prisma` is an extended client
    // whose delegates cannot be spied without destroying them.
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER muon_test_fail_note_insert BEFORE INSERT ON "MemoryNote"
         WHEN NEW."text" LIKE '%${SENTINEL}%'
         BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`
    );
    let intoB: Awaited<ReturnType<ImportLib["importMemoryPack"]>>;
    try {
      intoB = await importLib.importMemoryPack(pack, { workspace: repoB });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER muon_test_fail_note_insert`);
    }
    const failed = expectOk(intoB);
    expect(failed.report.refused).toHaveLength(1);
    expect(failed.report.refused[0]!.reason).toMatch(/storage error while ingesting/);

    // THE PARTITION PROPERTY: repo B's claim was released, repo A's was NOT. A
    // release keyed on (origin, recordHash) alone would have deleted A's row and
    // left A's proposal an orphan with no provenance — and a later re-import into A
    // would then propose the same fact a second time.
    const claims = await prisma.memoryImport.findMany({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
      select: { receivingWorkspace: true, noteId: true, disposition: true },
    });
    expect(claims).toEqual([
      { receivingWorkspace: repoA, noteId: noteInA, disposition: "proposed" },
    ]);
    expect(
      await prisma.memoryNote.findUnique({ where: { id: noteInA } })
    ).not.toBeNull();

    // And the release was real: with the trigger gone, repo B can import it.
    const retry = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoB })
    );
    expect(retry.report.proposed).toHaveLength(1);
    expect(retry.report.alreadyImported).toEqual([]);
  });

  it("a tombstone stales only the receiving workspace's own proposal", async () => {
    const ORIGIN = "ws-00000000000000dd";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-revoked-per-partition",
      text: "A teammate fact that the origin later revokes, imported by two repos.",
    });
    const pack = makePack(ORIGIN, [record]);
    const intoA = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoA })
    );
    const intoB = expectOk(
      await importLib.importMemoryPack(pack, { workspace: repoB })
    );
    const noteInA = intoA.report.proposed[0]!.noteId;
    const noteInB = intoB.report.proposed[0]!.noteId;

    // The origin revokes it. Repo B re-syncs; repo A has not.
    const revoke = makePack(
      ORIGIN,
      [],
      [
        {
          originNoteId: "mem-teammate-revoked-per-partition",
          textHash: record.record.note.textHash,
          reason: "revoked",
          supersededByNoteId: null,
          retiredAt: T2.toISOString(),
        },
      ]
    );
    const revoked = expectOk(
      await importLib.importMemoryPack(revoke, { workspace: repoB })
    );
    expect(revoked.report.revocations.map((entry) => entry.noteId)).toEqual([
      noteInB,
    ]);

    const [rowA, rowB] = await Promise.all([
      prisma.memoryNote.findUnique({ where: { id: noteInA } }),
      prisma.memoryNote.findUnique({ where: { id: noteInB } }),
    ]);
    expect(rowB?.staleSince?.toISOString()).toBe(T2.toISOString());
    // Repo A's copy is untouched: revocation is an act on ONE partition's review
    // queue, and repo A's human has not been shown the tombstone yet.
    expect(rowA?.staleSince).toBeNull();
    // Its provenance marker is untouched too. The disposition FLIP is the second
    // half of the tombstone pass, and a flip that crossed the partition would mark
    // repo A's live proposal `revoked-at-origin` — the SEC-2 residual shape, one
    // partition over.
    const dispositions = await prisma.memoryImport.findMany({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
      select: { receivingWorkspace: true, disposition: true },
    });
    expect(
      new Map(dispositions.map((row) => [row.receivingWorkspace, row.disposition]))
    ).toEqual(
      new Map([
        [repoA, "proposed"],
        [repoB, "revoked-at-origin"],
      ])
    );
  });
});

describe("ADR-0026 §7 — both pack routes reduce through repoRootOf", () => {
  it("export from a WORKTREE path exports the parent repository's partition", async () => {
    const fromRepo = await app.inject({
      method: "GET",
      url: `/api/memory/pack/export?workspace=${encodeURIComponent(repoA)}`,
      headers: auth(OPERATOR),
    });
    const fromWorktree = await app.inject({
      method: "GET",
      url: `/api/memory/pack/export?workspace=${encodeURIComponent(worktreeOfA)}`,
      headers: auth(OPERATOR),
    });
    expect(fromRepo.statusCode).toBe(200);
    expect(fromWorktree.statusCode).toBe(200);

    const repoPack = fromRepo.json() as PackExport;
    const worktreePack = fromWorktree.json() as PackExport;
    // Unreduced, `<repoA>/.muon/worktrees/task-wt-1` matches no stored partition and
    // the allow-predicate withholds EVERYTHING — fail-closed, and wrong. Reduced, a
    // worktree is the repository, so the two exports are the same pack byte-for-byte
    // (same fingerprint: the origin identity is derived from the reduced path too).
    expect(worktreePack.manifest.counts.records).toBeGreaterThan(0);
    expect(worktreePack.manifest.origin.fingerprint).toBe(
      repoPack.manifest.origin.fingerprint
    );
    expect(worktreePack.manifest.packDigest).toBe(repoPack.manifest.packDigest);
    expect(exportedNoteIds(worktreePack)).toContain("mem-local-a");
  });

  it("import from a WORKTREE path stamps the parent repository, not the worktree", async () => {
    const ORIGIN = "ws-00000000000000ee";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-worktree-import",
      text: "A teammate fact imported while the operator sat in a governed worktree.",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/memory/pack/import?workspace=${encodeURIComponent(worktreeOfA)}`,
      headers: { ...auth(OPERATOR), "content-type": "application/json" },
      payload: makePack(ORIGIN, [record]),
    });
    expect(response.statusCode).toBe(200);
    const report = response.json() as { proposed: { noteId: string }[] };
    const row = await prisma.memoryNote.findUnique({
      where: { id: report.proposed[0]!.noteId },
    });
    // The whole point of reducing on the WRITE side of the route: an unreduced
    // stamp would mint a memory island per worktree that no read coordinate ever
    // names again (every read reduces), so the proposal would be unreachable.
    expect(row?.workspacePath).toBe(repoA);
    expect(row?.workspacePath).not.toBe(worktreeOfA);
    const claim = await prisma.memoryImport.findFirst({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
    });
    expect(claim?.receivingWorkspace).toBe(repoA);
  });

  it("an import with NO workspace lands in the residue rather than a guessed cwd", async () => {
    const ORIGIN = "ws-00000000000000ff";
    const record = makeRecord({
      originFingerprint: ORIGIN,
      originNoteId: "mem-teammate-no-workspace",
      text: "A teammate fact imported by a caller that named no receiving workspace.",
    });
    const imported = expectOk(
      await importLib.importMemoryPack(makePack(ORIGIN, [record]))
    );
    const noteId = imported.report.proposed[0]!.noteId;
    const row = await prisma.memoryNote.findUnique({ where: { id: noteId } });
    // NULL, never `process.cwd()`: the partition is authority, and a guessed
    // authority is worse than an admitted absence (§8 keeps it operator-visible).
    expect(row?.workspacePath).toBeNull();
    const claim = await prisma.memoryImport.findFirst({
      where: { originWorkspace: ORIGIN, recordHash: record.hash },
    });
    expect(claim?.receivingWorkspace).toBe("");

    // Fail-CLOSED at the export: a residue note leaves in nobody's pack, so the
    // §7 chain cannot be re-armed by simply omitting the parameter.
    await ledger.updateMemoryNote(noteId, {
      confirmed: true,
      principal: "human:dana",
    });
    for (const workspace of [repoA, repoB]) {
      const pack = await packLib.collectMemoryPack(workspace);
      expect(exportedNoteIds(pack)).not.toContain(noteId);
      expect(JSON.stringify(pack)).not.toContain(record.record.note.text);
    }
  });
});
