import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

// P1.4 Slice 2 — HOSTILE pack hardening. The import surface assumes an
// attacker-built pack: every field is re-verified server-side, pack-level
// defects refuse the WHOLE pack with a reason, record-level defects refuse
// THAT record with a reason while honest siblings still import, and an origin
// "confirmed" status can never mint local trust.

vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  getEmbedder: () => null,
  mirrorToGraph: () => undefined,
}));

type Db = typeof import("../src/lib/db.js");
type Ledger = typeof import("../src/lib/memory-ledger.js");
type PackLib = typeof import("../src/lib/memory-pack.js");
type ImportLib = typeof import("../src/lib/memory-pack-import.js");

let prisma: Db["prisma"];
let ledger: Ledger;
let packLib: PackLib;
let importLib: ImportLib;
let dataDir: string;

const ORIGIN_FP = "ws-00000000000000bb";
const SENTINEL = "sk-hostile-sentinel-1f2e3d4c";

function makeRecord(spec: {
  noteId: string;
  text: string;
  textHashOverride?: string;
  confirmation?: Partial<{
    principal: string;
    decision: string;
    at: string;
    textHash: string;
  }> | null;
  version?: number;
}) {
  const textHash =
    spec.textHashOverride ?? ledger.computeMemoryTextHash(spec.text);
  const confirmation =
    spec.confirmation === null
      ? undefined
      : {
          principal: "human:carol",
          decision: "confirm",
          at: "2026-07-02T10:00:00.000Z",
          textHash,
          ...(spec.confirmation ?? {}),
        };
  const record = {
    version: (spec.version ?? 1) as 1,
    origin: { fingerprint: ORIGIN_FP, noteId: spec.noteId, label: "evil" },
    note: {
      kind: "constraint",
      text: spec.text,
      textHash,
      scope: "project",
      trust: "high",
      modules: [],
      topics: [],
      symbols: [],
      validFrom: "2026-07-01T10:00:00.000Z",
      recordedAt: "2026-07-01T10:00:00.000Z",
    },
    author: { principal: "human:carol", kind: "human" as const },
    ...(confirmation ? { confirmation } : {}),
    supersededTextHashes: [],
  };
  // The attacker signs whatever they built — the hash is honest over the bytes
  // unless a test tampers AFTER hashing. A structurally broken record (missing
  // confirmation) cannot be canonicalized, so it just claims a plausible hash.
  return {
    hash: confirmation
      ? packLib.recordHashOf(record as never)
      : "a".repeat(64),
    record: record as Record<string, unknown>,
  };
}

function makePack(
  records: { hash: string; record: Record<string, unknown> }[],
  overrides: { version?: number; packDigest?: string } = {}
) {
  const sorted = [...records].sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const manifestCore = {
    version: 1 as const,
    origin: { fingerprint: ORIGIN_FP, label: "evil" },
    records: sorted.map(({ hash, record }) => ({
      hash,
      file: `records/${hash}.json`,
      originNoteId: String(
        (record.origin as { noteId?: unknown })?.noteId ?? "mem-x"
      ),
      textHash: String(
        (record.note as { textHash?: unknown })?.textHash ?? "0".repeat(64)
      ),
    })),
    tombstones: [] as never[],
  };
  return {
    manifest: {
      version: overrides.version ?? 1,
      origin: manifestCore.origin,
      counts: { records: sorted.length, tombstones: 0, omitted: 0 },
      records: manifestCore.records,
      tombstones: [],
      omissions: [],
      invariants: {
        confirmedOnly: true,
        unconfirmedTextExcluded: true,
        secretsRedactedBeforeWrite: true,
        noCredentialMaterial: true,
      },
      packDigest: overrides.packDigest ?? packLib.packDigestOf(manifestCore),
    },
    records: sorted,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "muon-pack-hostile-"));
  process.env.DATABASE_URL = `file:${path.join(dataDir, "muon.db")}`;
  process.env.MUON_DATA_DIR = dataDir;
  vi.resetModules();
  const db = await import("../src/lib/db.js");
  prisma = db.prisma;
  await db.ensureSchema();
  ledger = await import("../src/lib/memory-ledger.js");
  packLib = await import("../src/lib/memory-pack.js");
  importLib = await import("../src/lib/memory-pack-import.js");
});

afterAll(async () => {
  await prisma?.$disconnect();
  delete process.env.MUON_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("memory pack import — hostile pack hardening", () => {
  it("tampered packDigest → whole pack refused; the reason names the digest", async () => {
    const rec = makeRecord({ noteId: "mem-h1", text: "an honest looking fact" });
    const pack = makePack([rec], { packDigest: "f".repeat(64) });
    const result = await importLib.importMemoryPack(pack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/packDigest/);
    }
    expect(await prisma.memoryNote.count()).toBe(0);
  });

  it("tampered record text (content-address mismatch) → that record refused; honest sibling still imports", async () => {
    const honest = makeRecord({
      noteId: "mem-h2-honest",
      text: "an honest sibling fact that must still import",
    });
    const tampered = makeRecord({
      noteId: "mem-h2-tampered",
      text: "the original text the hash was computed over",
    });
    // Tamper AFTER hashing: swap the text, keep hash + textHash claims.
    (tampered.record.note as { text: string }).text =
      "the attacker's replacement text";
    const result = await importLib.importMemoryPack(makePack([honest, tampered]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.proposed).toHaveLength(1);
      expect(result.report.proposed[0].recordHash).toBe(honest.hash);
      expect(result.report.refused).toHaveLength(1);
      expect(result.report.refused[0].recordHash).toBe(tampered.hash);
      expect(result.report.refused[0].reason).toMatch(/hash/i);
    }
    const rows = await prisma.memoryNote.findMany();
    expect(rows.some((r) => r.text.includes("replacement text"))).toBe(false);
  });

  it("fake confirmation (agent principal / reject decision / missing) → record refused; origin 'confirmed' never mints local trust", async () => {
    const agentConfirmed = makeRecord({
      noteId: "mem-h3-agent",
      text: "an agent claims to have confirmed this at the origin",
      confirmation: { principal: "agent:codex" },
    });
    const rejectDecision = makeRecord({
      noteId: "mem-h3-reject",
      text: "the origin decision was actually a reject",
      confirmation: { decision: "reject" },
    });
    const missing = makeRecord({
      noteId: "mem-h3-missing",
      text: "no confirmation at all rode this record",
      confirmation: null,
    });
    const result = await importLib.importMemoryPack(
      makePack([agentConfirmed, rejectDecision, missing])
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.proposed).toHaveLength(0);
      expect(result.report.refused).toHaveLength(3);
      for (const refusal of result.report.refused) {
        expect(refusal.reason.length).toBeGreaterThan(0);
      }
    }
    // Nothing landed, and certainly nothing confirmed.
    const texts = (await prisma.memoryNote.findMany()).map((r) => r.text);
    expect(texts.join("\n")).not.toMatch(/mem-h3|origin decision|claims to have/);
  });

  it("oversized text → record refused with a reason", async () => {
    const oversize = makeRecord({
      noteId: "mem-h4-oversize",
      text: `oversize ${"y".repeat(10_100)}`,
    });
    const result = await importLib.importMemoryPack(makePack([oversize]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.refused).toHaveLength(1);
      expect(result.report.refused[0].reason).toMatch(/10000|exceeds/);
    }
  });

  it("a secret that survived into an attacker-built record → refused via redaction re-run hash mismatch; secret never lands", async () => {
    const rec = makeRecord({
      noteId: "mem-h5-secret",
      text: `use API_KEY=${SENTINEL} for the internal service`,
    });
    const result = await importLib.importMemoryPack(makePack([rec]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.proposed).toHaveLength(0);
      expect(result.report.refused).toHaveLength(1);
      expect(result.report.refused[0].reason).toMatch(/hash/i);
    }
    const rows = await prisma.memoryNote.findMany();
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
  });

  it("wrong pack version → whole pack refused; message says to re-export", async () => {
    const rec = makeRecord({ noteId: "mem-h6", text: "a future format record" });
    const result = await importLib.importMemoryPack(
      makePack([rec], { version: 2 })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/version/i);
      expect(result.reason).toMatch(/re-export/i);
    }
  });

  it("more than 500 records → whole pack refused with a reason", async () => {
    const base = makeRecord({ noteId: "mem-h7", text: "cap check record" });
    const records = Array.from({ length: 501 }, (_, i) => ({
      hash: i.toString(16).padStart(64, "0"),
      record: base.record,
    }));
    const pack = makePack([base]);
    const oversizedPack = {
      manifest: {
        ...pack.manifest,
        records: records.map(({ hash }) => ({
          hash,
          file: `records/${hash}.json`,
          originNoteId: "mem-h7",
          textHash: "0".repeat(64),
        })),
        counts: { records: 501, tombstones: 0, omitted: 0 },
      },
      records,
    };
    const result = await importLib.importMemoryPack(oversizedPack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/500/);
    }
  });
});
