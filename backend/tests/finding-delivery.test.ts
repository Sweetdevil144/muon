import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── Slice 3: DELIVERY — a sibling's finding reaches the edit boundary, and ──
// ── the delivery is an EVENT, not an inference. ─────────────────────────────
//
// Measured 2026-08-10 with a live two-agent crew: contender B published a
// finding (slice 2, atomic, note linked) and the losing contender's inbox was
// empty — pull-based delivery means a finding lands only if the peer happens
// to look, and nothing recorded whether it ever arrived. The research doc's
// stance test T3 ("A's finding reaches B at B's next work boundary") was
// unmeasurable BY CONSTRUCTION: delivery was not an event.
//
// The slice, end to end, against the REAL routes and a real SQLite ledger:
//   1. B `publish_finding`s on ground A is about to edit (the real /findings
//      route: note + announcement, refs.noteIds carrying the note id).
//   2. A runs `preflight_edit` on that ground (the real /preedit route). The
//      finding rides the crewFindings inform channel, and the `finding` kind
//      now joins the citation channel that labels it.
//   3. A `memory.injected` Event records the delivery — noteId, contentHash,
//      reason, recipientJobId — once per (job, note, content). An EDITED
//      finding re-fires; an unchanged one does not.

const OPERATOR = "operator-token-delivery";
const AGENT = "agent-token-delivery";

let dir: string;
let db: typeof import("../src/lib/db.js");
let app: FastifyInstance;

// A REAL directory: the ledger re-resolves a successor's anchors against the
// note's workspace on a text edit, and a nonexistent workspace strands them.
let WS: string;
const MOD = "src/pay/charge.ts";
const CHAT = "chat-delivery";

const JOBS = [
  // A crew is a root plus children (one active root per chat).
  { id: "job-editor", role: "implementer", parentJobId: null },
  { id: "job-finder", role: "reviewer", parentJobId: "job-editor" },
  { id: "job-witness", role: "qa", parentJobId: "job-editor" },
];

const token = (jobId: string) => `job-${jobId}-${"d".repeat(44)}`;
const auth = (jobId: string) => ({ authorization: `Bearer ${token(jobId)}` });

async function deliveryEvents(): Promise<Record<string, unknown>[]> {
  const rows = await db.prisma.event.findMany({
    where: { kind: "memory.injected", taskId: "job-editor" },
    orderBy: { timestamp: "asc" },
  });
  return rows
    .map((row) => row.metadata as Record<string, unknown>)
    .filter((meta) => meta.reason === "crew-finding-at-preedit");
}

/** The recorder is fire-and-forget; poll for it like the product behaves. */
async function deliveriesAtLeast(
  n: number,
  timeoutMs = 5_000
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await deliveryEvents();
  while (rows.length < n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    rows = await deliveryEvents();
  }
  return rows;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-finding-delivery-"));
  WS = path.join(dir, "ws");
  mkdirSync(path.join(WS, "src", "pay"), { recursive: true });
  writeFileSync(path.join(WS, "src", "pay", "charge.ts"), "export {};\n");
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();

  const { createHash } = await import("node:crypto");
  for (const job of JOBS) {
    await db.prisma.task.create({
      data: {
        id: `task-${job.id}`,
        title: job.id,
        description: job.id,
        status: "in_progress",
      },
    });
    await db.prisma.orchestratorChat
      .create({ data: { id: CHAT, taskId: `task-${job.id}`, title: CHAT } })
      .catch(() => undefined);
    await db.prisma.dispatchJob.create({
      data: {
        id: job.id,
        taskId: `task-${job.id}`,
        chatId: CHAT,
        vendor: "codex",
        brief: "work",
        status: "running",
        startedAt: new Date(),
        workspacePath: WS,
        role: job.role,
        capabilityMode: "worker",
        ...(job.parentJobId
          ? { parentJobId: job.parentJobId, rootJobId: job.parentJobId }
          : {}),
      },
    });
    await db.prisma.delegationGrant.create({
      data: {
        jobId: job.id,
        tokenHash: createHash("sha256").update(token(job.id)).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("T3 — a published finding reaches the sibling's edit boundary", () => {
  let noteId: string;
  /**
   * WHICH note actually rode the channel. The corroborating publish below
   * files a SECOND note with identical text, so "the finding" is not a single
   * id: either may surface (and the ledger may corroborate them into one).
   * Asserting deliveries against `noteId` specifically was the flake — the
   * recorder had faithfully recorded the OTHER id. Delivery is a property of
   * the note that surfaced, so the tests follow that note.
   */
  let deliveredNoteId: string;
  /** The text-edit successor, set by the edit test and read by the re-fire. */
  let successorId: string;

  /**
   * The ledger→graph mirror is FIRE-AND-FORGET (by design: a mirror write
   * must never block an ingest), so a preflight issued immediately after a
   * publish can race it. The sync point is the gate's own telemetry: each
   * preedit files a memory.gate_read event whose metadata says how many
   * candidates it CONSIDERED and how many rode the inform channel — poll
   * the real surface until the graph has caught up, then assert on that
   * same response. No sleeps, no vacuous absence checks.
   */
  async function probeUntil(
    predicate: (meta: Record<string, unknown>) => boolean,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: { body: Record<string, unknown>; meta: Record<string, unknown> } = {
      body: {},
      meta: {},
    };
    for (;;) {
      const response = await app.inject({
        method: "POST",
        url: "/api/memory/preedit",
        headers: auth("job-editor"),
        payload: { module: MOD },
      });
      expect(response.statusCode).toBe(200);
      const reads = await db.prisma.event.findMany({
        where: { kind: "memory.gate_read" },
        orderBy: { timestamp: "desc" },
        take: 1,
      });
      last = {
        body: response.json(),
        meta: (reads[0]?.metadata ?? {}) as Record<string, unknown>,
      };
      if (predicate(last.meta) || Date.now() > deadline) {
        return last.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("B publishes on the ground A is about to edit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/a2a/findings",
      headers: auth("job-finder"),
      payload: {
        text: "charge() retries are NOT idempotent below the gateway timeout",
        kind: "constraint",
        subject: "retry idempotency hole",
        coordinates: [MOD],
        to: { kind: "crew" },
      },
    });
    expect(response.statusCode).toBe(201);
    noteId = response.json().noteId ?? response.json().note?.id;
    expect(noteId).toBeTruthy();
  });

  it("A's preflight on that ground surfaces it — ONE author suffices for INFORM", async () => {
    // A diagnostic detour worth its comment: this test transiently read as
    // "withheld" and was rewritten to demand corroboration — but the withheld
    // reads were the FIRE-AND-FORGET mirror race, not a gate rule. Settled
    // truth (probe-synced on the gate's own telemetry): a single author's
    // finding rides the crew INFORM channel; corroboration promotes trust,
    // it is not the admission bar for inform.
    const body = await probeUntil(
      (meta) => Number(meta.informFindings ?? 0) >= 1
    );
    const delivered = ((body.crewFindings ?? []) as {
      id: string;
      tier?: string;
      authority?: string;
    }[]).find((note) => note.id === noteId);
    expect(delivered, "the finding rides the crew channel").toBeTruthy();
    expect(delivered!.tier).toBe("crew_vouched");
    expect(delivered!.authority).toBe("inform");
    deliveredNoteId = delivered!.id;
  }, 30_000);

  it("a SECOND distinct principal corroborates, and it still reaches A", async () => {
    const witness = await app.inject({
      method: "POST",
      url: "/api/a2a/findings",
      headers: auth("job-witness"),
      payload: {
        text: "charge() retries are NOT idempotent below the gateway timeout",
        kind: "constraint",
        subject: "confirmed: retry idempotency hole",
        coordinates: [MOD],
        to: { kind: "crew" },
      },
    });
    expect(witness.statusCode).toBe(201);

    const body = await probeUntil(
      (meta) => Number(meta.informFindings ?? 0) >= 1
    );
    // The corroborating note carries the SAME text, so either id may be the
    // one that surfaced — assert the CHANNEL carried a finding on this
    // ground, not which of two duplicate notes won the race.
    expect(
      ((body.crewFindings ?? []) as { id: string }[]).length,
      "the crew channel still carries a finding after corroboration"
    ).toBeGreaterThan(0);
  }, 30_000);

  it("the delivery is a durable EVENT with hash, reason and recipient", async () => {
    // DETERMINISTIC since task #99: the pre-edit gate's path-triggered
    // STANDING injection writes to this same Event kind for the same
    // (job, note) pair with no reason and no contentHash, and the old
    // (job, note, content) dedup key let it silently suppress this record.
    // Whichever landed first decided whether delivery telemetry existed —
    // a 3-in-8 flake that was under-reporting deliveries in production, not
    // a slow test. The reason is part of the key now.
    const rows = await deliveriesAtLeast(1);
    const delivery = rows.find((meta) => meta.noteId === deliveredNoteId);
    expect(delivery, "delivery was recorded").toBeTruthy();
    expect(delivery!.recipientJobId).toBe("job-editor");
    expect(typeof delivery!.contentHash).toBe("string");
    expect((delivery!.contentHash as string).length).toBe(64);
    // Coordinates and hashes only — never the finding's text.
    expect(JSON.stringify(delivery)).not.toContain("idempotent");
  }, 30_000);

  it("a STANDING injection of the same note does not stand in for it", async () => {
    // The bug, pinned from the other side: a path-triggered row (no reason,
    // no hash) must not satisfy the crew-finding dedup, or the delivery is
    // suppressed and T3 becomes unmeasurable exactly when the gate is busy.
    const telemetry = await import("../src/lib/injection-telemetry.js");
    telemetry.recordMemoryInjected({
      noteId: "note-standing-probe",
      jobId: "job-editor",
      anchor: MOD,
      gateTier: "human_confirmed",
      tier: "agent",
    });
    const deadline = Date.now() + 5_000;
    while (
      !(await telemetry.hasDeliveredContent(
        "job-editor",
        "note-standing-probe",
        "x".repeat(64)
      )) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Reason-less probe: the standing row IS that delivery.
    expect(
      await telemetry.hasDeliveredContent(
        "job-editor",
        "note-standing-probe",
        "x".repeat(64)
      )
    ).toBe(true);
    // Crew-finding probe on the SAME note: a different delivery, not yet made.
    expect(
      await telemetry.hasDeliveredContent(
        "job-editor",
        "note-standing-probe",
        "x".repeat(64),
        "crew-finding-at-preedit"
      )
    ).toBe(false);
  }, 30_000);

  it("an UNCHANGED finding does not re-record once its delivery has landed", async () => {
    const before = (await deliveryEvents()).filter(
      (meta) => meta.noteId === deliveredNoteId
    ).length;
    expect(before).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/memory/preedit",
        headers: auth("job-editor"),
        payload: { module: MOD },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = (await deliveryEvents()).filter(
      (meta) => meta.noteId === deliveredNoteId
    ).length;
    expect(after).toBe(before);
  }, 30_000);

  it("a text edit never blanks the ground it was about", async () => {
    // WAS PINNED AS A KNOWN GAP, and the diagnosis was wrong. A text edit is a
    // supersede: the predecessor retires INSIDE the transaction (instant, in
    // the ledger) while the successor's anchors reach the graph only when the
    // fire-and-forget mirror lands. Measured 2026-08-11: at ~47ms after the
    // edit an edit-boundary gate on that ground returned NEITHER note, and the
    // successor appeared at ~90ms — deterministic across runs. The anchors
    // were never stranded; the two halves of one change were simply visible at
    // different speeds.
    //
    // An operator fixing a typo must not take the finding off its ground, even
    // for 50ms, so the edit now awaits its own projection. NO POLLING HERE on
    // purpose: the assertion is that the FIRST read after the write already
    // sees it.
    const ledger = await import("../src/lib/memory-ledger.js");
    const updated = await ledger.updateMemoryNote(deliveredNoteId, {
      text: "charge() retries ARE idempotent since the gateway fix",
      principal: "human:tester",
    });
    successorId = updated!.id;
    expect(successorId).not.toBe(deliveredNoteId);
    const successorRow = await db.prisma.memoryNote.findUnique({
      where: { id: successorId },
    });
    expect(successorRow?.status).toBe("active");
    expect(successorRow?.chatId).toBe(CHAT);

    const probe = await app.inject({
      method: "POST",
      url: "/api/memory/preedit",
      headers: auth("job-editor"),
      payload: { module: MOD },
    });
    const body = probe.json();
    const surfaced = [
      ...(body.memories ?? []),
      ...(body.crewFindings ?? []),
    ] as { id: string; text?: string }[];
    const hit = surfaced.find((note) => note.id === successorId);
    expect(hit, "the corrected finding is on its ground immediately").toBeTruthy();
    expect(hit!.text).toContain("ARE idempotent");
  }, 30_000);

  it("the corrected finding re-fires as its own delivery", async () => {
    // Content-hash dedup means a CHANGED finding is a new delivery: the
    // recipient was told something that is no longer true, so the correction
    // has to reach them rather than being suppressed as "already delivered".
    // Poll for THIS note's row, not for "at least one": the predecessor's
    // delivery already satisfies a bare count, and a poll that returns on
    // someone else's row is how an absent record reads as a present one.
    const deadline = Date.now() + 10_000;
    let delivered = await deliveryEvents();
    while (
      !delivered.some((meta) => meta.noteId === successorId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      delivered = await deliveryEvents();
    }
    const forSuccessor = delivered.filter(
      (meta) => meta.noteId === successorId
    );
    expect(
      forSuccessor.length,
      "the successor records a delivery of its own"
    ).toBeGreaterThanOrEqual(1);
    // And it is a DIFFERENT delivery from the predecessor's, not a re-count of
    // the same row.
    const forPredecessor = delivered.filter(
      (meta) => meta.noteId === deliveredNoteId
    );
    expect(forPredecessor.length).toBeGreaterThanOrEqual(1);
    expect(forSuccessor[0]!.contentHash).not.toBe(
      forPredecessor[0]!.contentHash
    );
  }, 30_000);

  it("hasDeliveredContent: a hash mismatch re-fires, a legacy row does not", async () => {
    // The defensive branch a supersede-shaped ledger never exercises: if any
    // path ever mutates a note's text IN PLACE (a mirror repair, an import),
    // dedup must compare CONTENT, not just ids. Driven directly against the
    // real Event table.
    const telemetry = await import("../src/lib/injection-telemetry.js");
    telemetry.recordMemoryInjected({
      noteId: "note-hash-probe",
      jobId: "job-editor",
      anchor: MOD,
      gateTier: "crew_vouched",
      tier: "agent",
      reason: "crew-finding-at-preedit",
      contentHash: "a".repeat(64),
      recipientJobId: "job-editor",
    });
    // The recorder is fire-and-forget; wait for the row.
    const deadline = Date.now() + 5_000;
    while (
      !(await telemetry.hasDeliveredContent(
        "job-editor",
        "note-hash-probe",
        "a".repeat(64),
        "crew-finding-at-preedit"
      )) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await telemetry.hasDeliveredContent(
        "job-editor",
        "note-hash-probe",
        "a".repeat(64),
        "crew-finding-at-preedit"
      ),
      "same content: already delivered"
    ).toBe(true);
    expect(
      await telemetry.hasDeliveredContent(
        "job-editor",
        "note-hash-probe",
        "b".repeat(64),
        "crew-finding-at-preedit"
      ),
      "changed content: re-fires"
    ).toBe(false);
    // A row recorded BEFORE contentHash existed cannot say what it carried —
    // it matches on the note id alone rather than re-firing forever.
    telemetry.recordMemoryInjected({
      noteId: "note-legacy-probe",
      jobId: "job-editor",
      anchor: MOD,
      gateTier: "crew_vouched",
      tier: "agent",
    });
    const legacyDeadline = Date.now() + 5_000;
    while (
      !(await telemetry.hasDeliveredContent(
        "job-editor",
        "note-legacy-probe",
        "c".repeat(64)
      )) &&
      Date.now() < legacyDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      await telemetry.hasDeliveredContent(
        "job-editor",
        "note-legacy-probe",
        "c".repeat(64)
      )
    ).toBe(true);
  });
});
