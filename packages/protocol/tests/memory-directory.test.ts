import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MEMORY_DIRECTORY_MAX_BYTES,
  memoryDirectorySnapshotSchema,
} from "../src/memory-directory.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const valid = () => ({
  schemaVersion: 1 as const,
  source: "human_confirmed_gate" as const,
  noteCount: 1,
  truncated: false,
  files: [
    { path: "README.md" as const, content: "read", mode: "0444" as const, sha256: hash("read") },
    { path: "index.tsv" as const, content: "id\n", mode: "0444" as const, sha256: hash("id\n") },
    {
      path: "notes/mem-12345678-1234-4123-8123-123456789abc.txt",
      content: "fact",
      mode: "0444" as const,
      sha256: hash("fact"),
    },
  ],
  digest: "a".repeat(64),
});

describe("memoryDirectorySnapshotSchema", () => {
  it("accepts a bounded immutable projection", () => {
    expect(memoryDirectorySnapshotSchema.parse(valid()).noteCount).toBe(1);
  });

  it("rejects traversal paths and a dishonest note count", () => {
    const traversal = valid();
    traversal.files[2]!.path = "notes/../../secret.txt";
    expect(() => memoryDirectorySnapshotSchema.parse(traversal)).toThrow();
    expect(() =>
      memoryDirectorySnapshotSchema.parse({ ...valid(), noteCount: 0 })
    ).toThrow(/noteCount/);
  });

  it("rejects an oversized projection instead of truncating content", () => {
    const oversized = valid();
    oversized.files[2]!.content = "x".repeat(MEMORY_DIRECTORY_MAX_BYTES + 1);
    expect(() => memoryDirectorySnapshotSchema.parse(oversized)).toThrow(
      /exceeds/
    );
  });
});
