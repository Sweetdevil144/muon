import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// REAL SQLite + REAL LadybugDB integration (no mocks), like memory-ledger.test.ts.
// R3 TTL is a governance policy over the durable ledger, so it is proven against
// the actual ledger rather than a mocked one: an expiry that only holds in a mock
// is not an expiry.

let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let settings: typeof import("../src/lib/operator-settings.js");
let graphLib: typeof import("../src/lib/graph.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const DAY_MS = 24 * 60 * 60 * 1_000;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-ttl-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  settings = await import("../src/lib/operator-settings.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
});

afterAll(async () => {
  await settle();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prisma.operatorSetting.deleteMany({
    where: { key: { in: ["memoryTtlDays", "memoryTtlTrustCeiling"] } },
  });
  // P0-2: TTL stamping is the STRICT-REVIEW path. With the default posture the
  // orchestrator vouches for agent memory at ingest and the note never expires
  // (see "orchestrator vouch" below), so every deadline assertion in this suite
  // is about the operator who turned that off — pin it explicitly.
  await settings.setAutoConfirmAgentMemory(false);
});

let seq = 0;
/** Distinct text + anchors per note so dedup never collapses two fixtures. */
function unique(label: string): { text: string; topics: string[] } {
  seq += 1;
  return { text: `${label} fixture #${seq}`, topics: [`ttl-topic-${seq}`] };
}

async function ingest(input: {
  label: string;
  createdBy: string;
  trust?: "low" | "medium" | "high";
}) {
  const { text, topics } = unique(input.label);
  const result = await ledger.ingestMemoryNote({
    kind: "decision",
    text,
    topics,
    createdBy: input.createdBy,
    ...(input.trust ? { trust: input.trust } : {}),
  });
  return result.note;
}

const rowOf = (id: string) =>
  db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });

describe("R3 TTL — the migration is additive", () => {
  it("applies 0037 and leaves a note written without an expiry NULL (no backfill)", async () => {
    const applied = await db.prisma.$queryRawUnsafe<{ version: string }[]>(
      `SELECT "version" FROM "_muon_migrations" WHERE "version" = '0037_memory_note_ttl'`
    );
    expect(applied).toHaveLength(1);

    // A row inserted the pre-TTL way (no expiry columns supplied at all) keeps
    // NULL in both, which reads everywhere as "this note never expires".
    await db.prisma.memoryNote.create({
      data: {
        id: "mem-ttl-legacy",
        kind: "decision",
        text: "a note written before the TTL policy existed",
        textHash: "ttl-legacy",
        createdBy: "codex",
        modules: [],
        topics: [],
        symbols: [],
      },
    });
    const row = await rowOf("mem-ttl-legacy");
    expect(row.expiresAt).toBeNull();
    expect(row.expiredAt).toBeNull();
    const visible = await ledger.applyMemoryExpiry([{ id: row.id }]);
    expect(visible.map((note) => note.id)).toEqual([row.id]);
    expect(visible[0]?.expired).toBe(false);
  });
});

describe("R3 TTL — who gets a deadline", () => {
  it("stamps the default 30-day TTL on an unconfirmed medium-trust agent note", async () => {
    const before = Date.now();
    const note = await ingest({ label: "agent decision", createdBy: "codex" });
    const row = await rowOf(note.id);
    expect(row.expiresAt).not.toBeNull();
    // Default policy (no OperatorSetting row) is 30 days / medium ceiling.
    const elapsed = row.expiresAt!.getTime() - before;
    expect(elapsed).toBeGreaterThan(29 * DAY_MS);
    expect(elapsed).toBeLessThanOrEqual(30 * DAY_MS + 5_000);
    expect(row.expiredAt).toBeNull();
    expect(note.expired).toBe(false);
  });

  it("NEVER expires a human-authored note, even at low trust", async () => {
    const note = await ingest({
      label: "human decision",
      createdBy: "human:alice",
      trust: "low",
    });
    expect((await rowOf(note.id)).expiresAt).toBeNull();
  });

  it("NEVER expires a high-trust note", async () => {
    const note = await ingest({
      label: "trusted agent decision",
      createdBy: "codex",
      trust: "high",
    });
    expect((await rowOf(note.id)).expiresAt).toBeNull();
  });

  it("honours a low-only ceiling and the days=0 off switch", async () => {
    await settings.setMemoryTtlPolicy({ days: 7, trustCeiling: "low" });
    const medium = await ingest({ label: "medium agent", createdBy: "codex" });
    const low = await ingest({
      label: "low agent",
      createdBy: "codex",
      trust: "low",
    });
    expect((await rowOf(medium.id)).expiresAt).toBeNull();
    expect((await rowOf(low.id)).expiresAt).not.toBeNull();

    await settings.setMemoryTtlPolicy({ days: 0, trustCeiling: "medium" });
    const off = await ingest({ label: "policy off", createdBy: "codex" });
    expect((await rowOf(off.id)).expiresAt).toBeNull();
  });

  it("treats the ceiling as a WRITE-time dial: narrowing it never un-expires a stamped note", async () => {
    const note = await ingest({ label: "stamped at medium", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    // The operator narrows the policy AFTER the note was stamped.
    await settings.setMemoryTtlPolicy({ days: 30, trustCeiling: "low" });
    // The read path and the sweeper agree: the stamp still stands, because only
    // the three never-expire invariants can redeem a note, never a settings edit.
    expect(await ledger.applyMemoryExpiry([{ id: note.id }])).toEqual([]);
    const sweep = await ledger.sweepExpiredMemory();
    expect(sweep.noteIds).toContain(note.id);
    expect((await rowOf(note.id)).expiredAt).not.toBeNull();
  });

  it("gives an agent CLONE its own fresh deadline, never the source's", async () => {
    const source = await ingest({ label: "clone source", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: source.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const clone = await ledger.cloneMemoryNote(source.id, {
      tier: "operator",
      principal: "agent:codex",
    });
    expect(clone.status).toBe("cloned");
    if (clone.status !== "cloned") return;
    const row = await rowOf(clone.note.id);
    // A stale source must not launder into a clone that is born expired.
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("R3 TTL — confirming is the redemption path", () => {
  it("clears the expiry (and any sweep marker) on a HUMAN confirm", async () => {
    const note = await ingest({ label: "to confirm", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS), expiredAt: new Date() },
    });
    const confirmed = await ledger.updateMemoryNote(note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    expect(confirmed?.confirmed).toBe(true);
    expect(confirmed?.expiresAt).toBeNull();
    expect(confirmed?.expired).toBe(false);
    const row = await rowOf(note.id);
    expect(row.expiresAt).toBeNull();
    expect(row.expiredAt).toBeNull();
  });

  it("does NOT let an agent or system 'confirm' clear an expiry", async () => {
    const note = await ingest({ label: "self confirm", createdBy: "codex" });
    const deadline = new Date(Date.now() + DAY_MS);
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: deadline },
    });
    for (const principal of ["agent:codex", "system"]) {
      await ledger.updateMemoryNote(note.id, { confirmed: true, principal });
      const row = await rowOf(note.id);
      expect(row.expiresAt?.toISOString()).toBe(deadline.toISOString());
    }
  });

  it("clears the expiry when an operator raises the note to high trust", async () => {
    const note = await ingest({ label: "to promote", createdBy: "codex" });
    expect((await rowOf(note.id)).expiresAt).not.toBeNull();
    await ledger.updateMemoryNote(note.id, { trust: "high" });
    expect((await rowOf(note.id)).expiresAt).toBeNull();
  });

  it("keeps a text-edit successor un-expiring when the same edit confirms it", async () => {
    const note = await ingest({ label: "to edit", createdBy: "codex" });
    const plain = await ledger.updateMemoryNote(note.id, {
      text: "edited without a confirm, still an unreviewed agent note",
    });
    expect(plain?.expiresAt).not.toBeNull();

    const second = await ingest({ label: "to edit and confirm", createdBy: "codex" });
    const blessed = await ledger.updateMemoryNote(second.id, {
      text: "edited and confirmed by a human in one act",
      confirmed: true,
      principal: "human:alice",
    });
    expect(blessed?.expiresAt).toBeNull();
  });

  it("F4: editing the TEXT of an already-confirmed note does not re-arm a TTL", async () => {
    // agent writes (+30d) → human confirms (permanent) → operator fixes a typo.
    // The successor carries the agent author and is unconfirmed by construction,
    // so the old code stamped it with a fresh deadline and the human-adjudicated
    // fact vanished from recall 30 days after a proofread.
    const note = await ingest({ label: "confirmed then typo-fixed", createdBy: "codex" });
    expect((await rowOf(note.id)).expiresAt).not.toBeNull();
    await ledger.updateMemoryNote(note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    expect((await rowOf(note.id)).expiresAt).toBeNull();

    const successor = await ledger.updateMemoryNote(note.id, {
      text: "confirmed then typo-fixed fixture, with the typo fixed",
    });
    expect(successor?.expiresAt).toBeNull();
    expect((await rowOf(successor!.id)).expiresAt).toBeNull();
    // The successor is NOT auto-confirmed: only a human blessing makes THIS text
    // confirmed, so the confirmed-only gate is untouched by the fix.
    expect(successor?.confirmed).toBe(false);
    // ...and it stays visible: nothing expires it, now or after any sweep.
    const sweep = await ledger.sweepExpiredMemory();
    expect(sweep.noteIds).not.toContain(successor!.id);
    expect(
      (await ledger.applyMemoryExpiry([{ id: successor!.id }])).map((row) => row.id)
    ).toEqual([successor!.id]);
  });

  it("still stamps the successor when the predecessor was never confirmed", async () => {
    const note = await ingest({ label: "never confirmed", createdBy: "codex" });
    const successor = await ledger.updateMemoryNote(note.id, {
      text: "never confirmed fixture, edited while still an unreviewed guess",
    });
    expect(successor?.expiresAt).not.toBeNull();
  });
});

describe("R3 TTL — hidden by default, visible on opt-in", () => {
  async function expiredNote(label: string) {
    const note = await ingest({ label, createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    return note;
  }

  it("drops an expired note from a note set and returns it under showExpired", async () => {
    const note = await expiredNote("hidden");
    const live = await ingest({ label: "live", createdBy: "codex" });
    const input = [{ id: note.id }, { id: live.id }];

    const hidden = await ledger.applyMemoryExpiry(input);
    expect(hidden.map((row) => row.id)).toEqual([live.id]);

    const shown = await ledger.applyMemoryExpiry(input, { showExpired: true });
    expect(shown.map((row) => row.id).sort()).toEqual([note.id, live.id].sort());
    expect(shown.find((row) => row.id === note.id)?.expired).toBe(true);
    expect(shown.find((row) => row.id === live.id)?.expired).toBe(false);
  });

  it("never hides a note that has since been confirmed, even if still stamped", async () => {
    const note = await expiredNote("stamped then confirmed");
    // Confirm through the ledger, then re-stamp the column directly. This is the
    // "some other write path set expiresAt" case: read-side hidden-ness must
    // still refuse to hide a human-confirmed note.
    await ledger.updateMemoryNote(note.id, {
      confirmed: true,
      principal: "human:alice",
    });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const visible = await ledger.applyMemoryExpiry([{ id: note.id }]);
    expect(visible.map((row) => row.id)).toEqual([note.id]);
  });

  it("hides expired notes from the operator library and reveals them on request", async () => {
    const note = await expiredNote("library");
    const hidden = await ledger.listMemoryLibrary({ q: note.text });
    expect(hidden.notes.map((row) => row.id)).not.toContain(note.id);
    expect(hidden.total).toBe(0);

    const shown = await ledger.listMemoryLibrary({
      q: note.text,
      showExpired: true,
    });
    expect(shown.notes.map((row) => row.id)).toContain(note.id);
    expect(shown.notes.find((row) => row.id === note.id)?.expired).toBe(true);
    expect(shown.total).toBe(1);
  });

  it("applies the R5 filter grammar inside the library read", async () => {
    const note = await ingest({ label: "filterable", createdBy: "codex" });
    const hit = await ledger.listMemoryLibrary({
      q: note.text,
      filter: { field: "kind", op: "eq", value: "decision" },
    });
    expect(hit.notes.map((row) => row.id)).toContain(note.id);
    const miss = await ledger.listMemoryLibrary({
      q: note.text,
      filter: { field: "kind", op: "eq", value: "attempt" },
    });
    expect(miss.notes).toHaveLength(0);
    expect(miss.total).toBe(0);
  });
});

describe("R3 TTL — the sweeper", () => {
  beforeAll(async () => {
    // Drain candidates left by the fixtures above so the bounded-batch counts
    // below describe only this suite's notes.
    for (let i = 0; i < 20; i += 1) {
      const drain = await ledger.sweepExpiredMemory(new Date(), { limit: 500 });
      if (drain.scanned === 0) {
        break;
      }
    }
  });

  async function stampExpired(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const note = await ingest({ label: `sweep ${i}`, createdBy: "codex" });
      ids.push(note.id);
    }
    await db.prisma.memoryNote.updateMany({
      where: { id: { in: ids } },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    return ids;
  }

  it("is bounded per run and makes forward progress across runs", async () => {
    const ids = await stampExpired(5);
    const first = await ledger.sweepExpiredMemory(new Date(), { limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.expired).toBe(2);
    const second = await ledger.sweepExpiredMemory(new Date(), { limit: 2 });
    expect(second.expired).toBe(2);
    // No id is ever swept twice: `expiredAt IS NULL` is the cursor.
    expect(
      first.noteIds.some((id) => second.noteIds.includes(id))
    ).toBe(false);
    const third = await ledger.sweepExpiredMemory(new Date(), { limit: 10 });
    expect(third.expired).toBe(1);
    const fourth = await ledger.sweepExpiredMemory(new Date(), { limit: 10 });
    expect(fourth.expired).toBe(0);
    const rows = await db.prisma.memoryNote.findMany({
      where: { id: { in: ids } },
    });
    expect(rows.every((row) => row.expiredAt !== null)).toBe(true);
    // Non-destructive: nothing was retired and no text was cleared.
    expect(rows.every((row) => row.status === "active" && row.text !== "")).toBe(
      true
    );
  });

  it("records the eviction as append-only, non-elevating provenance", async () => {
    const [id] = await stampExpired(1);
    await ledger.sweepExpiredMemory();
    const rows = await db.prisma.confirmation.findMany({
      where: { noteId: id },
    });
    const expire = rows.find((row) => row.decision === "expire");
    expect(expire?.principal).toBe("system:ttl");
    // An "expire" marker is not a confirm: the note stays unconfirmed.
    const note = await ledger.getMemoryNote(id!);
    expect(note?.confirmed).toBe(false);
  });

  it("skips a confirmed / human-authored / high-trust note and clears its deadline", async () => {
    const confirmed = await ingest({ label: "swept confirmed", createdBy: "codex" });
    await ledger.updateMemoryNote(confirmed.id, {
      confirmed: true,
      principal: "human:alice",
    });
    const human = await ingest({ label: "swept human", createdBy: "human:alice" });
    const trusted = await ingest({
      label: "swept trusted",
      createdBy: "codex",
      trust: "high",
    });
    const past = new Date(Date.now() - DAY_MS);
    await db.prisma.memoryNote.updateMany({
      where: { id: { in: [confirmed.id, human.id, trusted.id] } },
      data: { expiresAt: past },
    });

    const sweep = await ledger.sweepExpiredMemory();
    expect(sweep.noteIds).not.toContain(confirmed.id);
    expect(sweep.noteIds).not.toContain(human.id);
    expect(sweep.noteIds).not.toContain(trusted.id);
    for (const id of [confirmed.id, human.id, trusted.id]) {
      const row = await rowOf(id);
      expect(row.expiredAt).toBeNull();
      // The stale deadline is dropped for good, so they never re-enter the scan.
      expect(row.expiresAt).toBeNull();
    }
  });

  it("fails closed to no eviction when the TTL policy is unreadable", async () => {
    const [id] = await stampExpired(1);
    await db.prisma.operatorSetting.upsert({
      where: { key: "memoryTtlDays" },
      create: { key: "memoryTtlDays", value: "not-a-number" },
      update: { value: "not-a-number" },
    });
    expect(await settings.getMemoryTtlPolicy()).toBeNull();
    const sweep = await ledger.sweepExpiredMemory();
    expect(sweep).toMatchObject({ skipped: true, expired: 0, ttlDays: null });
    expect((await rowOf(id!)).expiredAt).toBeNull();
  });

  it("does not make an expired note eligible for hard compaction", async () => {
    const [id] = await stampExpired(1);
    await ledger.sweepExpiredMemory();
    // Backdate so the note is inside any retention window compaction would use.
    await db.prisma.memoryNote.update({
      where: { id },
      data: { retiredAt: new Date(Date.now() - 400 * DAY_MS) },
    });
    const compaction = await ledger.compactMemory(1, new Date(), {
      mirrorGraph: false,
    });
    expect(compaction.noteIds).not.toContain(id);
    expect((await rowOf(id!)).text).not.toBe("");
  });

  it("dryRun reports the expire count without writing", async () => {
    const ids = await stampExpired(3);
    const dry = await ledger.sweepExpiredMemory(new Date(), { dryRun: true });
    expect(dry).toMatchObject({
      dryRun: true,
      scanned: 3,
      expired: 3,
      batchId: null,
    });
    for (const id of ids) {
      expect((await rowOf(id)).expiredAt).toBeNull();
    }
    const applied = await ledger.sweepExpiredMemory(new Date(), {
      batchId: "batch-dry-run-test",
      reason: "operator preview follow-up",
    });
    expect(applied.dryRun).toBe(false);
    expect(applied.batchId).toBe("batch-dry-run-test");
    expect(applied.reason).toBe("operator preview follow-up");
    expect(applied.expired).toBe(3);
    const rows = await db.prisma.confirmation.findMany({
      where: { batchId: "batch-dry-run-test", decision: "expire" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.reason === "operator preview follow-up")).toBe(
      true
    );
  });

  it("maxForget caps how many notes one sweep may expire", async () => {
    const ids = await stampExpired(4);
    const before = await db.prisma.memoryNote.count({
      where: { expiredAt: { not: null } },
    });
    const sweep = await ledger.sweepExpiredMemory(new Date(), { maxForget: 2 });
    expect(sweep.expired).toBe(2);
    expect(sweep.noteIds.every((id) => ids.includes(id))).toBe(true);
    const after = await db.prisma.memoryNote.count({
      where: { expiredAt: { not: null } },
    });
    expect(after - before).toBe(2);
  });

  it("revertExpiredMemoryBatch clears expiredAt for a batch as a unit", async () => {
    const ids = await stampExpired(2);
    const sweep = await ledger.sweepExpiredMemory(new Date(), {
      batchId: "batch-revert-test",
      maxForget: 500,
    });
    expect(sweep.noteIds).toEqual(expect.arrayContaining(ids));
    for (const id of ids) {
      expect((await rowOf(id)).expiredAt).not.toBeNull();
    }
    const reverted = await ledger.revertExpiredMemoryBatch("batch-revert-test");
    expect(reverted.noteIds).toEqual(expect.arrayContaining(ids));
    for (const id of ids) {
      expect((await rowOf(id)).expiredAt).toBeNull();
    }
  });
});

describe("an apply is bound to the preview that justified it", () => {
  /**
   * Cubic P1, 2026-08-11. Both bulk paths recompute eligibility from the LIVE
   * policy, so a lifetime changed between a dry run and its apply — from the
   * CLI, from a second desk window — silently moved the candidate set out from
   * under the counts an operator approved. Survivable for a sweep (reversible);
   * not for a compaction, whose text is cleared.
   *
   * The binding is OPTIONAL by design: `muon memory sweep-expired` has no
   * preview to be bound to, and omitting the digest is exactly the old
   * behaviour.
   */
  it("a dry run reports a digest, and the same policy applies with it", async () => {
    await settings.setMemoryTtlPolicy({ days: 30, trustCeiling: "medium" });
    const note = await ingest({ label: "bound apply", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });

    const preview = await ledger.sweepExpiredMemory(new Date(), {
      dryRun: true,
    });
    expect(preview.previewDigest, "a preview names what it depended on").toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(preview.noteIds).toContain(note.id);

    const applied = await ledger.sweepExpiredMemory(new Date(), {
      dryRun: false,
      previewDigest: preview.previewDigest!,
    });
    expect(applied.noteIds).toContain(note.id);
  });

  it("REFUSES an apply whose policy moved since the preview", async () => {
    await settings.setMemoryTtlPolicy({ days: 30, trustCeiling: "medium" });
    const note = await ingest({ label: "moved policy", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const preview = await ledger.sweepExpiredMemory(new Date(), {
      dryRun: true,
    });

    // Somebody else changes the policy — the CLI, another window.
    await settings.setMemoryTtlPolicy({ days: 7, trustCeiling: "low" });

    await expect(
      ledger.sweepExpiredMemory(new Date(), {
        dryRun: false,
        previewDigest: preview.previewDigest!,
      })
    ).rejects.toThrow(/Preview again/);
    // And it wrote NOTHING: the note is still live.
    expect((await rowOf(note.id)).expiredAt).toBeNull();
  });

  it("still applies with no digest at all — the CLI has no preview to bind", async () => {
    await settings.setMemoryTtlPolicy({ days: 30, trustCeiling: "medium" });
    const note = await ingest({ label: "unbound apply", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: note.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const applied = await ledger.sweepExpiredMemory(new Date(), {
      dryRun: false,
    });
    expect(applied.noteIds).toContain(note.id);
  });

  /**
   * A REAL candidate, because the binding is only tested by something there is
   * something to lose. Compaction requires a rejected note, retired before the
   * cutoff, that has been superseded — with none of that, `compactMemory`
   * returns `tombstoned: 0` down the empty-set path and every assertion below
   * passes without the destructive path ever running.
   */
  async function compactable(label: string, retiredDaysAgo: number) {
    const doomed = await ingest({ label, createdBy: "codex" });
    const successor = await ingest({ label: `${label} successor`, createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: doomed.id },
      data: {
        status: "rejected",
        retiredAt: new Date(Date.now() - retiredDaysAgo * DAY_MS),
        supersededBy: successor.id,
      },
    });
    // The EDGE as well as the column: eligibility reads `supersededBy` but
    // resolves the successor's status through the edge table, so a note with
    // the column alone is never compactable and the test would be vacuous in
    // the other direction.
    await db.prisma.memoryEdge.create({
      data: { fromId: successor.id, toId: doomed.id, kind: "supersedes" },
    });
    return doomed.id;
  }

  it("binds a COMPACTION to the notes it will clear, which is what it cannot undo", async () => {
    const doomedId = await compactable("bound compaction", 120);
    const preview = await ledger.compactMemory(90, new Date(), { dryRun: true });
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.noteIds).toContain(doomedId);
    // Nothing was destroyed by the preview.
    expect((await rowOf(doomedId)).text).not.toBe("");

    // A different window is a different candidate set, and compaction clears
    // text — so this is refused rather than applied to whatever is current.
    await expect(
      ledger.compactMemory(30, new Date(), {
        dryRun: false,
        previewDigest: preview.previewDigest!,
      })
    ).rejects.toThrow(/Preview again/);

    const applied = await ledger.compactMemory(90, new Date(), {
      dryRun: false,
      previewDigest: preview.previewDigest!,
    });
    expect(applied.dryRun).toBe(false);
    // The APPLY PATH RAN: the reviewed note is tombstoned and its text gone.
    expect(applied.noteIds).toContain(doomedId);
    expect(applied.tombstoned).toBeGreaterThan(0);
    expect((await rowOf(doomedId)).text).toBe("");
  });

  it("refuses an apply when a note joined the set the operator never saw", async () => {
    // The drift the old digest could not see: same retention window, same
    // bounds, same everything the caller passes — and one more note now
    // eligible. Binding the window alone let this through and cleared text
    // nobody had reviewed.
    await compactable("reviewed", 120);
    const preview = await ledger.compactMemory(90, new Date(), { dryRun: true });
    const latecomer = await compactable("never reviewed", 200);

    await expect(
      ledger.compactMemory(90, new Date(), {
        dryRun: false,
        previewDigest: preview.previewDigest!,
      })
    ).rejects.toThrow(/Preview again/);
    // And it is refused BEFORE anything is destroyed.
    expect((await rowOf(latecomer)).text).not.toBe("");
  });

  it("refuses a SWEEP when a note lapsed after the preview", async () => {
    // Same shape on the reversible side: the candidate query filters
    // `expiresAt <= now` and the route passes a fresh Date per request, so
    // time alone moves the set. The sweep is revertible by batch, which is why
    // this is the smaller of the two — but the preview still promised a count.
    await settings.setMemoryTtlPolicy({ days: 30, trustCeiling: "medium" });
    const first = await ingest({ label: "lapsed before", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: first.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });
    const preview = await ledger.sweepExpiredMemory(new Date(), { dryRun: true });
    expect(preview.noteIds).toContain(first.id);

    const late = await ingest({ label: "lapsed after", createdBy: "codex" });
    await db.prisma.memoryNote.update({
      where: { id: late.id },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    });

    await expect(
      ledger.sweepExpiredMemory(new Date(), {
        dryRun: false,
        previewDigest: preview.previewDigest!,
      })
    ).rejects.toThrow(/Preview again/);
    expect((await rowOf(late.id)).expiredAt).toBeNull();
  });
});

describe("a text edit never stalls the memory write-actor", () => {
  /**
   * The awaited mirror closes the window where an edit leaves the gate seeing
   * NEITHER note (ADR-0049) — but it sits inside `runExclusive`, the single
   * queue every memory write passes through. Unbounded, one hung graph would
   * stall every write on the machine instead of degrading one best-effort
   * projection.
   */
  it("returns while the graph is still busy, rather than holding the lock", async () => {
    const note = await ingest({ label: "bounded mirror", createdBy: "codex" });
    // A graph that never answers. `projectMemoryNote` is the first call the
    // text-edit mirror makes.
    const graph = graphLib.getGraph() as unknown as {
      projectMemoryNote: (...args: unknown[]) => Promise<void>;
    };
    const original = graph.projectMemoryNote.bind(graph);
    // EVERY resolver, not the latest. The subsequent ingest starts its own
    // fire-and-forget mirror and calls this stub a second time; storing one
    // resolver dropped the first, so the edit's own projection stayed pending
    // forever and leaked into whatever ran next.
    const wedged: Array<() => void> = [];
    graph.projectMemoryNote = () =>
      new Promise<void>((resolve) => {
        wedged.push(resolve);
      });
    try {
      const started = Date.now();
      const updated = await ledger.updateMemoryNote(note.id, {
        text: "edited while the graph is wedged",
        principal: "human:tester",
      });
      const elapsed = Date.now() - started;
      expect(updated?.id, "the edit still lands in the ledger").toBeTruthy();
      // The budget is 2s; without the bound this never returns at all.
      expect(elapsed).toBeLessThan(10_000);

      // AND THE LOCK IS FREE: another write completes while the graph is
      // still wedged. This is the property that matters — the ledger is not
      // hostage to the projection.
      const next = await ingest({ label: "after wedge", createdBy: "codex" });
      expect(next.id).toBeTruthy();
    } finally {
      wedged.forEach((resolve) => resolve());
      graph.projectMemoryNote = original;
      // Drain what we unwedged, so nothing crosses into the next test.
      await graphLib.awaitGraphMirrors();
    }
  }, 30_000);
});
