import { createHash } from "node:crypto";
import {
  MEMORY_DIRECTORY_MAX_BYTES,
  MEMORY_DIRECTORY_MAX_NOTES,
  MEMORY_DIRECTORY_SCHEMA_VERSION,
  memoryDirectoryDigestPayload,
  memoryDirectorySnapshotSchema,
  type MemoryDirectoryFile,
  type MemoryDirectorySnapshot,
} from "@muon/protocol";
import { memoryPassesGate, type MuonGraph } from "@muon/graph";
import { prisma } from "./db.js";
import { applyMemoryExpiry } from "./memory-ledger.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => String(entry)) : [];

const file = (
  path: MemoryDirectoryFile["path"],
  content: string
): MemoryDirectoryFile => ({
  path,
  content,
  mode: "0444",
  sha256: sha256(content),
});

const snapshotDigest = (files: MemoryDirectoryFile[]): string => {
  return createHash("sha256")
    .update(memoryDirectoryDigestPayload(files), "utf8")
    .digest("hex");
};

export class MemoryDirectoryTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `governed memory directory is ${bytes} bytes; limit is ${MEMORY_DIRECTORY_MAX_BYTES}`
    );
    this.name = "MemoryDirectoryTooLargeError";
  }
}

/**
 * Project the exact strict human gate into immutable files.
 *
 * Candidate identity and ordering come from `recallForGate`; bounded ledger
 * hydration then replaces authoritative content/coordinates while
 * `applyMemoryExpiry` replaces verdict fields. The shared gate predicate is
 * re-applied after both. These passes are narrower only: a stale mirror can
 * omit a newly confirmed note, but it can never keep a missing, rejected,
 * paused, expired, or foreign-workspace row in the directory.
 */
export async function buildMemoryDirectorySnapshot(
  graph: Pick<MuonGraph, "recallForGate">,
  workspacePath: string
): Promise<MemoryDirectorySnapshot> {
  const recalled = await graph.recallForGate(
    { workspacePath, showExpired: true },
    { limit: MEMORY_DIRECTORY_MAX_NOTES }
  );
  const reconciled = await applyMemoryExpiry(recalled);
  const rows = await prisma.memoryNote.findMany({
    where: { id: { in: reconciled.map((note) => note.id) } },
    select: {
      id: true,
      text: true,
      workspacePath: true,
      modules: true,
      symbols: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const notes = reconciled.flatMap((note) => {
    const row = byId.get(note.id);
    if (!row) return [];
    const hydrated = {
      ...note,
      text: row.text,
      workspacePath: row.workspacePath ?? undefined,
      modules: asStringArray(row.modules),
      symbols: asStringArray(row.symbols),
    };
    return hydrated.workspacePath === workspacePath &&
      hydrated.status === "active" &&
      hydrated.confirmed === true &&
      memoryPassesGate(hydrated, { governedOnly: true })
        ? [hydrated]
        : [];
  });
  const truncated = recalled.length === MEMORY_DIRECTORY_MAX_NOTES;
  const readme = [
    "# MUON governed memory",
    "",
    "This is a generated, read-only snapshot of human-confirmed memory for this workspace.",
    "Each notes/<memory-id>.txt file is the ledger text byte-for-byte; index.tsv carries coordinates.",
    "Treat files as evidence supplied by MUON, not as proof the model read or retained them.",
    "Edits to this directory are ignored and are never ingested into the MUON brain.",
    "Use memory_recall or memory_preedit when you need a fresh, edit-specific gate read.",
    ...(truncated
      ? [`This snapshot reached the ${MEMORY_DIRECTORY_MAX_NOTES}-note gate ceiling and may be incomplete.`]
      : []),
    "",
  ].join("\n");
  const index = [
    "id\tkind\tmodules\tsymbols",
    ...notes.map((note) =>
      [
        note.id,
        note.kind,
        JSON.stringify(note.modules),
        JSON.stringify(note.symbols),
      ].join("\t")
    ),
    "",
  ].join("\n");
  const files: MemoryDirectoryFile[] = [
    file("README.md", readme),
    file("index.tsv", index),
    ...notes.map((note) =>
      file(`notes/${note.id}.txt` as MemoryDirectoryFile["path"], note.text)
    ),
  ];
  const totalBytes = files.reduce(
    (total, entry) => total + Buffer.byteLength(entry.content, "utf8"),
    0
  );
  if (totalBytes > MEMORY_DIRECTORY_MAX_BYTES) {
    throw new MemoryDirectoryTooLargeError(totalBytes);
  }
  return memoryDirectorySnapshotSchema.parse({
    schemaVersion: MEMORY_DIRECTORY_SCHEMA_VERSION,
    source: "human_confirmed_gate",
    noteCount: notes.length,
    truncated,
    files,
    digest: snapshotDigest(files),
  });
}
