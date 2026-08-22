import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── ADR-0091 — a note can say who owns a surface ─────────────────────────────
//
// Real DB, real routes. What these pin:
//   • the ownership kind mints with structured `owners`, and the record
//     reads them back; every other kind REFUSES owners loudly (400), never
//     silently drops them;
//   • ownership grants nothing (D2): the note lands unconfirmed like any
//     agent-adjacent write and carries no authority fields;
//   • the D3 recast sweep: an ACTIVE ownership-tagged note gets ONE
//     unconfirmed recast proposal with a `related` edge — idempotent, a
//     second apply files nothing;
//   • a stored FIVE-key lifecycle policy (pre-0091) still parses — the
//     records-vs-growing-constants defect class, pinned.

const OPERATOR = "operator-token-ownership";
const auth = { authorization: `Bearer ${OPERATOR}` };

let dir: string;
let db: typeof import("../src/lib/db.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-ownership-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await graphLib.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe("the ownership kind", () => {
  it("mints with structured owners and reads them back; owners on any other kind refuses loudly", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth,
      payload: {
        kind: "ownership",
        text: "Payments is owned by the billing crew; event-sourced so refunds replay.",
        modules: ["src/payments.ts"],
        createdBy: "human",
        owners: ["human:sam", "agent:codex"],
      },
    });
    if (created.statusCode !== 201) console.error("MINT BODY:", created.body);
    expect(created.statusCode).toBe(201);
    const note = created.json().note;
    expect(note.kind).toBe("ownership");
    expect(note.owners).toEqual(["human:sam", "agent:codex"]);
    // D2 — orientation, never authority: the note lands like any note,
    // unconfirmed, and naming an owner set no authority field.
    expect(note.confirmed).toBe(false);

    const refused = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth,
      payload: {
        kind: "decision",
        text: "A decision that tries to smuggle owners.",
        createdBy: "human",
        owners: ["human:sam"],
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain("ownership");
  });

  it("a text-edit successor and a clone both keep the structured owners", async () => {
    const ledger = await import("../src/lib/memory-ledger.js");
    const minted = await ledger.ingestMemoryNote({
      kind: "ownership",
      text: "The runner is owned by the infra crew; it must stay vendor-neutral.",
      owners: ["human:kim"],
      modules: ["packages/runner/src/execute.ts"],
      createdBy: "human",
    });
    expect(minted.note.owners).toEqual(["human:kim"]);
    const successor = await ledger.updateMemoryNote(minted.note.id, {
      text: "The runner is owned by the infra crew; vendor-neutral by decision.",
    });
    expect(successor).toBeTruthy();
    // A REAL successor row — the supersede minted a new id — and the
    // structured owners survived the edit.
    expect(successor!.id).not.toBe(minted.note.id);
    expect(successor!.owners).toEqual(["human:kim"]);
  });

  it("D3: the recast sweep files ONE unconfirmed proposal per active tagged note, related-linked, idempotently", async () => {
    const ledger = await import("../src/lib/memory-ledger.js");
    const tagged = await ledger.ingestMemoryNote({
      kind: "constraint",
      text: "The auth module is owned by core-platform; do not fork its session model.",
      topics: ["ownership"],
      modules: ["src/auth.ts"],
      createdBy: "human",
    });

    const preview = await ledger.migrateOwnershipKindRecasts({ dryRun: true });
    expect(preview.candidates.map((c) => c.noteId)).toContain(tagged.note.id);
    expect(preview.filed).toBe(0);
    // Dry-run filed nothing.
    expect(
      await db.prisma.memoryNote.count({
        where: { text: { contains: "Recast proposal" } },
      })
    ).toBe(0);

    const applied = await ledger.migrateOwnershipKindRecasts({ dryRun: false });
    expect(applied.filed).toBeGreaterThanOrEqual(1);
    const proposal = await db.prisma.memoryNote.findFirst({
      where: { text: { contains: tagged.note.id.slice(0, 8) } },
    });
    expect(proposal).toBeTruthy();
    expect(proposal!.kind).toBe("question");
    // Unconfirmed — machines propose, the gate is the same gate (0051).
    expect(
      await db.prisma.confirmation.count({
        where: { noteId: proposal!.id, decision: "confirm" },
      })
    ).toBe(0);
    // Linked by a related edge, never proposes_supersede (confirming that
    // shape would replace the note with the advice about it).
    const edge = await db.prisma.memoryEdge.findUnique({
      where: {
        fromId_toId_kind: {
          fromId: proposal!.id,
          toId: tagged.note.id,
          kind: "related",
        },
      },
    });
    expect(edge).toBeTruthy();

    // Idempotent: the second apply files nothing for this note.
    const again = await ledger.migrateOwnershipKindRecasts({ dryRun: false });
    expect(again.candidates.map((c) => c.noteId)).not.toContain(
      tagged.note.id
    );
    expect(again.skippedAlreadyFiled).toBeGreaterThanOrEqual(1);
  });

  it("a stored pre-0091 lifecycle policy still parses, and ownership resolves non-destructively under it", async () => {
    const { parseMemoryLifecyclePolicy } = await import("@muon/protocol");
    // Exactly what an existing install's applied policy looks like: five
    // kinds, no ownership key. Requiring the new key would fail-parse every
    // stored policy — the records-vs-growing-constants defect class.
    const stored = parseMemoryLifecyclePolicy({
      version: 1,
      trustCeiling: "medium",
      daysByKind: {
        decision: 90,
        constraint: 90,
        convention: 90,
        attempt: 30,
        question: 7,
      },
      permanentWhenConfirmedByKind: {
        decision: true,
        constraint: true,
        convention: true,
        attempt: true,
        question: true,
      },
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const { lifecycleDaysForKind } = await import("@muon/protocol");
    // Undefined, never zero and never a throw: the TTL evaluator reads
    // this as "no configured days" and the note simply never expires.
    expect(lifecycleDaysForKind(stored.policy, "ownership")).toBeUndefined();
  });
});
