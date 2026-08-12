// Data-boundary evidence — the pure projection over GitNexus QUERIES edges.
//
// GitNexus resolves which FILE touches which datastore model/table (a QUERIES
// edge, File → CodeElement, e.g. memory-ledger.ts → memoryNote). MUON's blast
// radius today is code-structural (callers, modules, symbols); it is blind to
// the DATA boundary — an edit near a table that N other files also write is a
// migration-safety risk the pre-edit gate should see. This projects those edges
// into "the tables this file touches + who ELSE writes each" so the answer can
// ride the pre-edit gate and become a durable, human-confirmable memory note
// ("editing X touches memoryNote; 5 other writers exist"). Pure + browser-safe
// (no CLI): the tool feeds it graph rows; this file only aggregates + judges.

/** One writer of a table, from a QUERIES edge. */
export type WriterRow = { table: string; file: string };

export type DataBoundaryInput = {
  /** The file being examined/edited (already repo-relative, forward-slashed). */
  file: string;
  /** Distinct tables/models this file QUERIES. */
  queriedTables: string[];
  /** All (table → writer-file) rows for those tables (this file included). */
  writerRows: WriterRow[];
};

export type TableBoundary = {
  table: string;
  /** Files OTHER than the examined file that also query this table. */
  otherWriters: string[];
  /** Total distinct writers of this table, including the examined file. */
  writerCount: number;
  /** More than one writer → a shared table; a migration touches many sites. */
  shared: boolean;
};

export type DataBoundary = {
  file: string;
  tables: TableBoundary[];
  /** The file touches at least one datastore table. */
  hasDataBoundary: boolean;
  /** How many of the touched tables are shared (>1 writer). */
  sharedTables: number;
  /** Honesty rail: what this means for a migration / an edit. */
  notes: string[];
};

const MAX_TABLES = 40;
const MAX_OTHER_WRITERS = 25;

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Project a file's datastore footprint. Deterministic. For each table the file
 * queries, list the OTHER files that write it (co-writers) and flag shared
 * tables. A file that touches no table is a clean no-op (hasDataBoundary=false).
 */
export function buildDataBoundary(input: DataBoundaryInput): DataBoundary {
  const file = norm(input.file);
  // table → all writer files (normalized, deduped)
  const writersByTable = new Map<string, Set<string>>();
  for (const row of input.writerRows) {
    if (!row.table) continue;
    const set = writersByTable.get(row.table) ?? new Set<string>();
    if (row.file) set.add(norm(row.file));
    writersByTable.set(row.table, set);
  }

  const tables: TableBoundary[] = dedupeSorted(input.queriedTables)
    .slice(0, MAX_TABLES)
    .map((table) => {
      const writers = writersByTable.get(table) ?? new Set<string>([file]);
      writers.add(file); // the examined file writes it by definition
      const otherWriters = [...writers].filter((w) => w !== file).sort();
      return {
        table,
        otherWriters: otherWriters.slice(0, MAX_OTHER_WRITERS),
        writerCount: writers.size,
        shared: writers.size > 1,
      };
    })
    // Most-shared tables first — they carry the most migration risk.
    .sort(
      (a, b) => b.writerCount - a.writerCount || a.table.localeCompare(b.table)
    );

  const sharedTables = tables.filter((t) => t.shared).length;
  const notes: string[] = [];
  if (tables.length === 0) {
    notes.push("This file touches no datastore table (no QUERIES edge).");
  } else {
    notes.push(
      `Edits here touch ${tables.length} table(s): ${tables.map((t) => t.table).join(", ")}.`
    );
    if (sharedTables > 0) {
      const shared = tables.filter((t) => t.shared);
      notes.push(
        `${sharedTables} shared table(s) have other writers — a schema/shape change is a migration that touches them all: ${shared
          .map((t) => `${t.table} (${t.writerCount} writers)`)
          .join(", ")}.`
      );
    }
  }

  return {
    file,
    tables,
    hasDataBoundary: tables.length > 0,
    sharedTables,
    notes,
  };
}

// ── Cypher the tool runs (parameterized by the file / table list) ─────────────

// `table` is a reserved word in the graph's Cypher dialect (Kùzu) — alias as
// `tbl`; the caller reads the `tbl` column.
/** Tables a single file QUERIES. `quotedFile` is a Cypher-quoted path literal. */
export function tablesForFileQuery(quotedFile: string): string {
  return `MATCH (f:File)-[r:CodeRelation]->(t:CodeElement) WHERE r.type = 'QUERIES' AND f.filePath = ${quotedFile} RETURN DISTINCT t.name AS tbl`;
}

/** All (table → writer file) rows for a set of tables. `quotedTables` is a
 *  Cypher-quoted comma list. */
export function writersForTablesQuery(quotedTables: string): string {
  return `MATCH (f:File)-[r:CodeRelation]->(t:CodeElement) WHERE r.type = 'QUERIES' AND t.name IN [${quotedTables}] RETURN t.name AS tbl, f.filePath AS file`;
}
