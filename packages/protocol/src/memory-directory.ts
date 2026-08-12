import { z } from "zod";

/** TODO 4.14 — one immutable, job-scoped projection of the human gate. */
export const MEMORY_DIRECTORY_SCHEMA_VERSION = 1 as const;
/** Mirrors `recallForGate`'s unanchored ceiling. */
export const MEMORY_DIRECTORY_MAX_NOTES = 200;
/** Refuse an oversized projection instead of silently dropping governed facts. */
export const MEMORY_DIRECTORY_MAX_BYTES = 4 * 1024 * 1024;

const notePathSchema = z
  .string()
  .regex(/^notes\/mem-[0-9a-f-]{36}\.txt$/i);

export const memoryDirectoryFileSchema = z
  .object({
    path: z.union([
      z.literal("README.md"),
      z.literal("index.tsv"),
      notePathSchema,
    ]),
    /** Note files contain the ledger text byte-for-byte, with no wrapper. */
    content: z.string(),
    mode: z.literal("0444"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const memoryDirectorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_DIRECTORY_SCHEMA_VERSION),
    source: z.literal("human_confirmed_gate"),
    noteCount: z.number().int().min(0).max(MEMORY_DIRECTORY_MAX_NOTES),
    /** Conservative: true whenever the gate returned its full 200-row ceiling. */
    truncated: z.boolean(),
    files: z
      .array(memoryDirectoryFileSchema)
      .min(2)
      .max(MEMORY_DIRECTORY_MAX_NOTES + 2),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const encoder = new TextEncoder();
    const bytes = value.files.reduce(
      (total, file) => total + encoder.encode(file.content).byteLength,
      0
    );
    if (bytes > MEMORY_DIRECTORY_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `memory directory exceeds ${MEMORY_DIRECTORY_MAX_BYTES} bytes`,
        path: ["files"],
      });
    }
    const noteFiles = value.files.filter((file) => file.path.startsWith("notes/"));
    if (noteFiles.length !== value.noteCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noteCount must equal the number of note files",
        path: ["noteCount"],
      });
    }
    const paths = new Set(value.files.map((file) => file.path));
    if (paths.size !== value.files.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "memory directory file paths must be unique",
        path: ["files"],
      });
    }
  });

export type MemoryDirectoryFile = z.infer<typeof memoryDirectoryFileSchema>;
export type MemoryDirectorySnapshot = z.infer<
  typeof memoryDirectorySnapshotSchema
>;

/**
 * Canonical, cross-runtime input for the snapshot digest. Hashing remains at
 * the Node trust boundaries, while this keeps producer and consumer framing
 * byte-for-byte identical without importing Node crypto into protocol bundles.
 */
export function memoryDirectoryDigestPayload(
  files: readonly MemoryDirectoryFile[]
): string {
  return [
    `muon-memory-directory-v${MEMORY_DIRECTORY_SCHEMA_VERSION}\0`,
    ...files.map((file) => `${file.path}\0${file.mode}\0${file.sha256}\0`),
  ].join("");
}
