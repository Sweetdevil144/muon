import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// REAL SQLite (no mocks). These are the two library-read defects that are
// INVISIBLE on a small brain, which is exactly why they shipped:
//
//   F1 — the derived pre-pass ended in `where.id = { in: matchingIds }` next to
//        `take: limit`. Above 999 ids the SQLite connector chunks the `IN` list
//        and applies `take` PER CHUNK, so the read returned a MULTIPLE of the
//        requested page AND could miss the true newest rows entirely.
//   F5 — the same pre-pass capped its candidate scan at 5 000 rows ordered by
//        `updatedAt desc`, so `total` silently topped out and older matching
//        notes were unreachable from the library.
//
// Every corpus below therefore CROSSES the relevant boundary on purpose. A
// fixture under 1 000 notes proves nothing here.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Seed clock: notes are written oldest-first, so `updatedAt desc` returns the
 *  seed order REVERSED and "the true newest N" is unambiguous. */
const EPOCH = Date.UTC(2026, 0, 1);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-library-page-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prisma.confirmation.deleteMany();
  await db.prisma.memoryNote.deleteMany();
});

/** Bulk-seed straight into the ledger table: this suite is about how the read
 *  paginates a large corpus, not about ingest, and `ingestMemoryNote` on
 *  thousands of notes would be a dedup benchmark rather than a regression test. */
async function seed(
  count: number,
  shape: (index: number) => Partial<{
    trust: string;
    createdBy: string;
    kind: string;
    chatId: string | null;
    scope: string;
    expiresAt: Date | null;
  }> = () => ({})
): Promise<string[]> {
  const ids: string[] = [];
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const id = `mem-page-${String(index).padStart(5, "0")}`;
    ids.push(id);
    const at = new Date(EPOCH + index * MINUTE_MS);
    rows.push({
      id,
      kind: "decision",
      text: `paged fixture ${index}`,
      textHash: `paged-hash-${index}`,
      createdBy: "codex",
      trust: "medium",
      modules: [],
      topics: [],
      symbols: [],
      recordedAt: at,
      validFrom: at,
      updatedAt: at,
      ...shape(index),
    });
  }
  for (let offset = 0; offset < rows.length; offset += 500) {
    await db.prisma.memoryNote.createMany({
      data: rows.slice(offset, offset + 500),
    });
  }
  return ids;
}

/** Newest-first ids, i.e. what `orderBy updatedAt desc, id asc` must return. */
const newestFirst = (ids: string[]) => [...ids].reverse();

describe("F1 — /library honours its limit across the 999-id chunking boundary", () => {
  it("returns exactly `limit` rows at 1 000 notes (the first size that chunks)", async () => {
    const ids = await seed(1_000);
    const page = await ledger.listMemoryLibrary({ limit: 200 });
    // The pre-fix read returned 201 here: one chunk of 999 plus a chunk of 1.
    expect(page.notes).toHaveLength(200);
    expect(page.notes.map((note) => note.id)).toEqual(
      newestFirst(ids).slice(0, 200)
    );
    expect(page.total).toBe(1_000);
    expect(page.truncated).toBe(true);
  });

  it("returns exactly `limit` rows at 2 500 notes, and they are the true NEWEST", async () => {
    const ids = await seed(2_500);
    const page = await ledger.listMemoryLibrary({ limit: 200 });
    // Pre-fix: 600 rows (three chunks × take 200), missing 103 of the newest.
    expect(page.notes).toHaveLength(200);
    expect(page.notes.map((note) => note.id)).toEqual(
      newestFirst(ids).slice(0, 200)
    );
  });

  it("agrees with the showExpired read, which never took the broken path", async () => {
    await seed(2_500);
    const [byDefault, shown] = await Promise.all([
      ledger.listMemoryLibrary({ limit: 200 }),
      ledger.listMemoryLibrary({ limit: 200, showExpired: true }),
    ]);
    // `showExpired: true` skipped the derived pre-pass, so it was the one read
    // that stayed correct. The two must now be indistinguishable on a corpus
    // where nothing is actually expired.
    expect(byDefault.notes.map((note) => note.id)).toEqual(
      shown.notes.map((note) => note.id)
    );
    expect(byDefault.total).toBe(shown.total);
  });

  it("paginates AFTER the derived predicates, not before them", async () => {
    // The newest 300 notes are expired, so a correct read skips them and still
    // fills a full page from the next-newest live ones.
    const past = new Date(Date.now() - DAY_MS);
    const ids = await seed(2_500, (index) =>
      index >= 2_200 ? { expiresAt: past } : {}
    );
    const page = await ledger.listMemoryLibrary({ limit: 200 });
    expect(page.notes).toHaveLength(200);
    expect(page.total).toBe(2_200);
    expect(page.notes.map((note) => note.id)).toEqual(
      newestFirst(ids.slice(0, 2_200)).slice(0, 200)
    );
    expect(page.notes.every((note) => !note.expired)).toBe(true);
  });

  it("keeps the confirmed filter exact at scale (no id list, no per-chunk take)", async () => {
    const ids = await seed(1_500);
    // Confirm the oldest 1 200 — a set well past the chunking threshold.
    await db.prisma.confirmation.createMany({
      data: ids.slice(0, 1_200).map((noteId) => ({
        noteId,
        principal: "human:alice",
        decision: "confirm",
      })),
    });
    const confirmed = await ledger.listMemoryLibrary({
      limit: 200,
      confirmed: "confirmed",
    });
    expect(confirmed.notes).toHaveLength(200);
    expect(confirmed.total).toBe(1_200);
    expect(confirmed.notes.map((note) => note.id)).toEqual(
      newestFirst(ids.slice(0, 1_200)).slice(0, 200)
    );

    const unconfirmed = await ledger.listMemoryLibrary({
      limit: 200,
      confirmed: "unconfirmed",
    });
    expect(unconfirmed.notes).toHaveLength(200);
    expect(unconfirmed.total).toBe(300);
  });

  it("keeps the chat-scoped view exact at scale (global admission stays confirmed-only)", async () => {
    // 1 200 notes in another chat, promoted global but UNCONFIRMED, plus 400 in
    // the selected chat. Pre-fix the global admission rode an id list too.
    const ids = await seed(1_600, (index) =>
      index < 1_200
        ? { chatId: "chat-other", scope: "global" }
        : { chatId: "chat-mine" }
    );
    const scoped = await ledger.listMemoryLibrary({
      limit: 200,
      chatId: "chat-mine",
    });
    expect(scoped.total).toBe(400);
    expect(scoped.notes).toHaveLength(200);
    expect(
      scoped.notes.every((note) => note.chatId === "chat-mine")
    ).toBe(true);

    // Confirming a foreign-chat global note is what admits it, and only it.
    await db.prisma.confirmation.create({
      data: { noteId: ids[0]!, principal: "human:alice", decision: "confirm" },
    });
    const withGlobal = await ledger.listMemoryLibrary({
      limit: 200,
      chatId: "chat-mine",
    });
    expect(withGlobal.total).toBe(401);
  });
});

describe("TODO 4.22 — cold-start decision projection stays LIMIT-complete", () => {
  it("finds an older curated decision behind newer unpinned decisions", async () => {
    const ids = await seed(300, () => ({ scope: "global" }));
    await db.prisma.confirmation.createMany({
      data: [
        {
          noteId: ids[0]!,
          principal: "human:operator",
          decision: "confirm",
        },
        {
          noteId: ids[0]!,
          principal: "human:operator",
          decision: "pin",
        },
      ],
    });

    const canon = await ledger.listStandingDecisionLog({ limit: 1 });
    expect(canon.map((note) => note.id)).toEqual([ids[0]]);
    expect(canon[0]).toMatchObject({
      kind: "decision",
      scope: "global",
      confirmed: true,
      pinned: true,
      stale: false,
    });
  });
});

describe("F5 — /library reports an honest total past the old 5 000 candidate cap", () => {
  it(
    "counts the whole matching set at 6 000 notes and marks it exact",
    async () => {
      await seed(6_000);
      const page = await ledger.listMemoryLibrary({ limit: 200 });
      // Pre-fix: total === 5 000 on the default read while showExpired said 6 000.
      expect(page.total).toBe(6_000);
      expect(page.totalExact).toBe(true);
      expect(page.notes).toHaveLength(200);
    },
    // The 6,000-row fixture is the assertion boundary. On a contended laptop
    // the real SQLite seed plus exact-count scan crosses Vitest's 5 s default;
    // this is not a latency SLO test, so give the deliberate scale fixture room.
    30_000
  );

  it("gives the default and showExpired reads the SAME total (the desktop empty state subtracts them)", async () => {
    await seed(6_000);
    const [byDefault, shown] = await Promise.all([
      ledger.listMemoryLibrary({ limit: 1 }),
      ledger.listMemoryLibrary({ limit: 1, showExpired: true }),
    ]);
    expect(byDefault.total).toBe(shown.total);
    expect(shown.total - byDefault.total).toBe(0);
  });

  it("says so when the scan ceiling is reached instead of reporting a wrong count", async () => {
    // Past MAX_MEMORY_LIBRARY_SCAN the count becomes a FLOOR, and the read
    // declares that rather than shipping a number the consumer would render as
    // a total. The PAGE is unaffected — the scan runs newest-first, so it is
    // filled long before the ceiling.
    const ids = await seed(20_001);
    const page = await ledger.listMemoryLibrary({ limit: 200 });
    expect(page.totalExact).toBe(false);
    expect(page.total).toBe(20_000);
    expect(page.notes).toHaveLength(200);
    expect(page.notes.map((note) => note.id)).toEqual(
      newestFirst(ids).slice(0, 200)
    );
  }, 60_000);

  it("reaches a note outside the 5 000 most-recently-updated rows", async () => {
    const ids = await seed(6_000);
    // The very oldest note: unreachable from the library before this fix.
    const oldest = ids[0]!;
    const found = await ledger.listMemoryLibrary({
      limit: 200,
      q: "paged fixture 0",
    });
    expect(found.notes.map((note) => note.id)).toContain(oldest);
  });
});
