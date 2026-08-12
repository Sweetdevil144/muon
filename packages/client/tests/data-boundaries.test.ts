import { describe, expect, it } from "vitest";
import {
  buildDataBoundary,
  tablesForFileQuery,
  writersForTablesQuery,
  type DataBoundaryInput,
} from "../src/data-boundaries.js";

const input = (over: Partial<DataBoundaryInput> = {}): DataBoundaryInput => ({
  file: "backend/src/lib/memory-ledger.ts",
  queriedTables: ["memoryNote", "memoryEdge"],
  writerRows: [
    { table: "memoryNote", file: "backend/src/lib/memory-ledger.ts" },
    { table: "memoryNote", file: "backend/src/routes/memory.ts" },
    { table: "memoryNote", file: "backend/tests/memory-provenance.test.ts" },
    { table: "memoryEdge", file: "backend/src/lib/memory-ledger.ts" }, // sole writer
  ],
  ...over,
});

describe("buildDataBoundary", () => {
  it("maps the file's tables + who ELSE writes each, shared-first", () => {
    const b = buildDataBoundary(input());
    expect(b.hasDataBoundary).toBe(true);
    expect(b.tables.map((t) => t.table)).toEqual(["memoryNote", "memoryEdge"]); // 3 writers before 1
    const note = b.tables[0]!;
    expect(note.table).toBe("memoryNote");
    expect(note.writerCount).toBe(3);
    expect(note.shared).toBe(true);
    expect(note.otherWriters).toEqual([
      "backend/src/routes/memory.ts",
      "backend/tests/memory-provenance.test.ts",
    ]); // NOT the examined file itself
    const edge = b.tables[1]!;
    expect(edge.writerCount).toBe(1);
    expect(edge.shared).toBe(false);
    expect(edge.otherWriters).toEqual([]);
  });

  it("counts shared tables and surfaces the migration-risk note", () => {
    const b = buildDataBoundary(input());
    expect(b.sharedTables).toBe(1);
    expect(b.notes.join(" ")).toMatch(/migration|shared table/i);
    expect(b.notes.join(" ")).toContain("memoryNote (3 writers)");
  });

  it("a file that touches no table is a clean no-op", () => {
    const b = buildDataBoundary(input({ queriedTables: [], writerRows: [] }));
    expect(b.hasDataBoundary).toBe(false);
    expect(b.tables).toEqual([]);
    expect(b.sharedTables).toBe(0);
    expect(b.notes.join(" ")).toMatch(/no datastore table/i);
  });

  it("the examined file always counts as a writer even if absent from rows", () => {
    // graph returned the table but no writer rows mentioning our file
    const b = buildDataBoundary(
      input({ queriedTables: ["principal"], writerRows: [] })
    );
    expect(b.tables[0]).toMatchObject({ table: "principal", writerCount: 1, shared: false });
  });

  it("normalizes paths (backslashes, ./ prefix) before comparison", () => {
    const b = buildDataBoundary({
      file: "./backend/src/lib/memory-ledger.ts",
      queriedTables: ["memoryNote"],
      writerRows: [
        { table: "memoryNote", file: "backend\\src\\lib\\memory-ledger.ts" }, // same file, win-slashes
        { table: "memoryNote", file: "backend/src/routes/memory.ts" },
      ],
    });
    // the examined file is de-duped against its backslash twin → only 1 other writer
    expect(b.tables[0]!.writerCount).toBe(2);
    expect(b.tables[0]!.otherWriters).toEqual(["backend/src/routes/memory.ts"]);
  });
});

describe("data-boundary queries", () => {
  it("quote the file / table lists into the reads", () => {
    expect(tablesForFileQuery("'a/b.ts'")).toContain("f.filePath = 'a/b.ts'");
    expect(tablesForFileQuery("'a/b.ts'")).toContain("QUERIES");
    expect(writersForTablesQuery("'t1', 't2'")).toContain("t.name IN ['t1', 't2']");
  });
});
