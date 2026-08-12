import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
  type MemoryLifecycleKind,
} from "@muon/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Real SQLite + real LadybugDB. This proves both the authoritative deadline
// migration and the mirror read path; no mocked graph can establish that an
// extended deadline becomes visible before restart.
let dir: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let settings: typeof import("../src/lib/operator-settings.js");
let graphLib: typeof import("../src/lib/graph.js");

const DAY_MS = 24 * 60 * 60 * 1_000;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-lifecycle-policy-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  settings = await import("../src/lib/operator-settings.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();
  await settings.setAutoConfirmAgentMemory(false);
});

afterAll(async () => {
  await graphLib.awaitGraphMirrors();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let sequence = 0;
async function ingest(kind: MemoryLifecycleKind, label: string) {
  sequence += 1;
  return (
    await ledger.ingestMemoryNote({
      kind,
      text: `${label} lifecycle sentinel ${sequence}`,
      topics: [`lifecycle-${sequence}`],
      modules: [`src/lifecycle-${sequence}.ts`],
      createdBy: "agent:codex",
    })
  ).note;
}

describe("TODO 4.11 kind-dependent lifecycle migration", () => {
  it("requires an exact preview, migrates every kind deadline, and updates the live graph", async () => {
    const legacy = await settings.getMemoryLifecyclePolicy();
    expect(legacy).toEqual({
      source: "legacy_global",
      legacyFallbackDays: 30,
      policy: {
        version: 1,
        trustCeiling: "medium",
        daysByKind: {
          decision: 30,
          constraint: 30,
          convention: 30,
          attempt: 30,
          question: 30,
        },
        permanentWhenConfirmedByKind: {
          decision: true,
          constraint: true,
          convention: true,
          attempt: true,
          question: true,
        },
      },
    });

    const question = await ingest("question", "short lived question");
    const decision = await ingest("decision", "long lived decision");
    const convention = await ingest("convention", "confirmed convention");
    await ledger.updateMemoryNote(convention.id, {
      confirmed: true,
      principal: "human:operator",
    });

    const now = new Date();
    const recordedAt = new Date(now.getTime() - 20 * DAY_MS);
    const oldFuture = new Date(now.getTime() + 10 * DAY_MS);
    await db.prisma.memoryNote.updateMany({
      where: { id: { in: [question.id, decision.id] } },
      data: { recordedAt, validFrom: recordedAt, expiresAt: oldFuture },
    });
    // Deliberately inject the old side-effect bug: a confirmed convention with
    // a stale deadline. The explicit lifecycle fold must make it permanent.
    await db.prisma.memoryNote.update({
      where: { id: convention.id },
      data: {
        recordedAt,
        validFrom: recordedAt,
        expiresAt: new Date(now.getTime() - DAY_MS),
      },
    });
    await ledger.projectLedgerToGraph();

    expect(
      (
        await graphLib
          .getGraph()
          .searchMemory("short lived question lifecycle sentinel", 20)
      ).map((note) => note.id)
    ).toContain(question.id);

    const preview = await ledger.migrateMemoryLifecyclePolicy(
      RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
      { dryRun: true },
      now
    );
    expect(preview).toMatchObject({
      previousSource: "legacy_global",
      dryRun: true,
      applied: false,
      scanned: 3,
      changed: 3,
      wouldHideNow: 1,
      wouldRestoreNow: 0,
      wouldBecomePermanent: 1,
    });
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    // Dry-run is genuinely read-only.
    expect((await settings.getMemoryLifecyclePolicy())?.source).toBe(
      "legacy_global"
    );
    expect(
      (await db.prisma.memoryNote.findUniqueOrThrow({ where: { id: question.id } }))
        .expiresAt?.toISOString()
    ).toBe(oldFuture.toISOString());

    await expect(
      ledger.migrateMemoryLifecyclePolicy(
        RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
        { dryRun: false, previewDigest: "0".repeat(64) },
        now
      )
    ).rejects.toBeInstanceOf(ledger.MemoryLifecyclePreviewMismatchError);
    expect((await settings.getMemoryLifecyclePolicy())?.source).toBe(
      "legacy_global"
    );

    // The same rows and deadlines can have a different immediate consequence
    // after wall time crosses a boundary. That consequence is part of the
    // preview contract, so the old digest must not authorize the later state.
    await expect(
      ledger.migrateMemoryLifecyclePolicy(
        RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
        { dryRun: false, previewDigest: preview.previewDigest },
        new Date(now.getTime() + 100 * DAY_MS)
      )
    ).rejects.toBeInstanceOf(ledger.MemoryLifecyclePreviewMismatchError);
    expect((await settings.getMemoryLifecyclePolicy())?.source).toBe(
      "legacy_global"
    );

    const applied = await ledger.migrateMemoryLifecyclePolicy(
      RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
      { dryRun: false, previewDigest: preview.previewDigest },
      now
    );
    expect(applied).toMatchObject({ applied: true, dryRun: false, changed: 3 });
    expect(await settings.getMemoryLifecyclePolicy()).toEqual({
      source: "kind_table",
      legacyFallbackDays: null,
      policy: RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
    });

    const [questionRow, decisionRow, conventionRow] = await Promise.all(
      [question.id, decision.id, convention.id].map((id) =>
        db.prisma.memoryNote.findUniqueOrThrow({ where: { id } })
      )
    );
    expect(questionRow.expiresAt?.toISOString()).toBe(
      new Date(recordedAt.getTime() + 7 * DAY_MS).toISOString()
    );
    expect(decisionRow.expiresAt?.toISOString()).toBe(
      new Date(recordedAt.getTime() + 90 * DAY_MS).toISOString()
    );
    expect(conventionRow.expiresAt).toBeNull();

    expect(
      (await ledger.applyMemoryExpiry([{ id: question.id }])).map((row) => row.id)
    ).toEqual([]);
    expect(
      (
        await graphLib
          .getGraph()
          .searchMemory("short lived question lifecycle sentinel", 20)
      ).map((note) => note.id)
    ).not.toContain(question.id);
    expect(
      (
        await graphLib
          .getGraph()
          .searchMemory("long lived decision lifecycle sentinel", 20)
      ).map((note) => note.id)
    ).toContain(decision.id);

    // The same digest is single-snapshot evidence: activation itself changes
    // the source posture, so replaying it must force another preview.
    await expect(
      ledger.migrateMemoryLifecyclePolicy(
        RECOMMENDED_MEMORY_LIFECYCLE_POLICY,
        { dryRun: false, previewDigest: preview.previewDigest },
        now
      )
    ).rejects.toBeInstanceOf(ledger.MemoryLifecyclePreviewMismatchError);
  }, 30_000);
});
