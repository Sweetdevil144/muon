import { z } from "zod";
import {
  type MemoryFilter,
  type MemoryLibraryOrderBy,
  type NoteDerivation,
  type NoteReviewStatus,
  noteDerivationSchema,
  noteReviewStatusSchema,
} from "@muon/protocol";

const noteSchema = z.object({
  id: z.string(),
  kind: z.enum(["decision", "constraint", "convention", "attempt", "question"]),
  text: z.string(),
  taskId: z.string().nullable().optional(),
  laneId: z.string().nullable().optional(),
  modules: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  trust: z.enum(["low", "medium", "high"]),
  confirmed: z.boolean(),
  stale: z.boolean(),
  status: z.enum(["active", "paused", "rejected"]),
  scope: z.string().default("project"),
  // ADR-0026 §8: which workspace this note belongs to, or null for the unassigned
  // residue. The library is the human's review queue, so this is the field that
  // stops one page of 200 rows spanning two repos with nothing distinguishing them
  // (§1's measurement). zod strips unknown keys — omit it and there is no label.
  workspacePath: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  validFrom: z.string().optional(),
  validTo: z.string().nullable().optional(),
  invalidatedAt: z.string().nullable().optional(),
  invalidatedBy: z.string().nullable().optional(),
  staleSince: z.string().nullable().optional(),
  supersededBy: z.string().nullable().optional(),
  accessCount: z.number().int().nonnegative().default(0),
  lastAccessedAt: z.string().nullable().optional(),
  conflictsWith: z.string().nullable().optional(),
  // R3 TTL (additive): absent on a pre-TTL backend → the note never expires,
  // which is exactly the pre-TTL behaviour.
  expiresAt: z.string().nullable().optional(),
  expired: z.boolean().default(false),
  pinned: z.boolean().default(false),
  provenance: z
    .object({
      sourceType: z.string(),
      rawRef: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable()
    .default(null),
  // P0-2 (additive): WHO vouched for this note. "human" is the strictly
  // stronger tier and is exactly what `confirmed` reports; "orchestrator" means
  // the crew's coordinator vouched so the operator owes no review — settled,
  // durable crew knowledge, but never a claim that a person read it. Absent on
  // an older backend → null, i.e. today's "nobody has vouched" reading.
  confirmedBy: z.enum(["human", "orchestrator"]).nullable().default(null),
  // TODO 4.8 (additive): provenance tier; absent → authored (legacy rows).
  derivation: noteDerivationSchema.default("authored"),
  reviewStatus: noteReviewStatusSchema.nullable().optional(),
  // TODO 4.8: corroboration count for the review queue (same textHash, active).
  supportCount: z.number().int().nonnegative().default(1),
});

const edgeSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number().nullable(),
  at: z.string(),
});

const confirmationSchema = z.object({
  id: z.string(),
  noteId: z.string(),
  principal: z.string(),
  // Deliberately WIDE: the ledger's Confirmation.decision is overloaded — besides
  // human "confirm"/"reject" it carries system "reconcile" markers (KG-6 conflict
  // convention; P1.4 pack tombstones write more of them). A closed enum here made
  // any brain with a conflict fail the whole snapshot parse. Consumers must treat
  // unknown decisions as neutral provenance, never as a confirm or reject.
  decision: z.string(),
  at: z.string(),
});

// P1.4 memory packs: import PROVENANCE for a note (origin workspace, origin
// author, origin confirmation, content address, local disposition). This is
// origin EVIDENCE rendered to the reviewing human — it never implies local
// trust; only a local human confirm admits the note to the gate.
const importSchema = z.object({
  id: z.string(),
  noteId: z.string().nullable(),
  originWorkspace: z.string(),
  originLabel: z.string(),
  originNoteId: z.string(),
  recordHash: z.string(),
  textHash: z.string(),
  disposition: z.string(),
  originAuthor: z.string(),
  originConfirmedBy: z.string(),
  originConfirmedAt: z.string(),
  importedAt: z.string(),
});

const analyticsSchema = z.object({
  noteScores: z
    .array(
      z.object({
        noteId: z.string().max(512),
        score: z.number().min(0).max(1),
        degree: z.number().int().nonnegative(),
        communityId: z.string().max(64),
      })
    )
    .max(5_000)
    .default([]),
  hotModules: z
    .array(
      z.object({
        module: z.string().max(1_024),
        score: z.number().min(0).max(1),
        noteCount: z.number().int().nonnegative(),
        communityId: z.string().max(64),
      })
    )
    .max(100)
    .default([]),
  communities: z
    .array(
      z.object({
        id: z.string().max(64),
        noteCount: z.number().int().nonnegative(),
        moduleCount: z.number().int().nonnegative(),
      })
    )
    .max(5_000)
    .default([]),
  source: z
    .object({
      notes: z.number().int().nonnegative().max(5_000),
      modules: z.number().int().nonnegative().max(25_000),
      edges: z.number().int().nonnegative().max(20_000),
      truncated: z.boolean(),
    })
    .default({ notes: 0, modules: 0, edges: 0, truncated: false }),
});

const snapshotSchema = z.object({
  notes: z.array(noteSchema),
  edges: z.array(edgeSchema),
  confirmations: z.array(confirmationSchema),
  // Additive (P1.4): absent on pre-pack backends/snapshots → [].
  imports: z.array(importSchema).default([]),
  // Additive (B4): old backends degrade to an empty coordinate-only summary.
  analytics: analyticsSchema.default({
    noteScores: [],
    hotModules: [],
    communities: [],
    source: { notes: 0, modules: 0, edges: 0, truncated: false },
  }),
  total: z.number().int().nonnegative(),
  // Additive (F5): false when the ledger's derived scan hit MAX_MEMORY_LIBRARY_SCAN
  // before exhausting the matches, so `total` is a floor rather than a count. The
  // page itself is always correct — only the tally is capped. Defaults true so an
  // older backend (which always counted exactly) reads as exact.
  totalExact: z.boolean().default(true),
  truncated: z.boolean(),
});

export type MemoryLibraryNote = z.infer<typeof noteSchema>;
export type MemoryLibraryEdge = z.infer<typeof edgeSchema>;
export type MemoryLibraryConfirmation = z.infer<typeof confirmationSchema>;
export type MemoryLibraryImport = z.infer<typeof importSchema>;
export type MemoryAnalyticsSnapshot = z.infer<typeof analyticsSchema>;
export type MemoryLibrarySnapshot = z.infer<typeof snapshotSchema>;
export type MemoryLibraryQuery = {
  q?: string;
  /** Selected desktop/operator chat. The server adds confirmed global memory. */
  chatId?: string;
  /**
   * ADR-0026 §5 — which workspace this library page is FOR. Send the raw path; the
   * server validates it against the workspace allowlist, then canonicalizes and
   * reduces it to the repo root, so a worktree / symlink / case-variant spelling all
   * land on the partition the write path stored.
   *
   * ANDed OUTSIDE the `chatId` admission server-side, which is what closes §6: a
   * `scope:"global"` note is global across CHATS within ONE workspace, never across
   * repos. Absent → today's unscoped view.
   */
  workspace?: string;
  /** ADR-0026 §8 residue view: ONLY the notes with no workspace, so the operator can
   *  adjudicate them in the queue they already confirm in. Every returned row carries
   *  `workspacePath: null` as its label. Mutually exclusive with `workspace`. */
  unscoped?: boolean;
  status?: "all" | "active" | "paused" | "rejected";
  /**
   * P0-2. `confirmed`/`unconfirmed` are the literal HUMAN tier. `unvouched` is
   * the review queue: nobody has vouched, neither a human nor the orchestrator.
   * A surface that counts "what still needs me" must ask for `unvouched` — an
   * `unconfirmed` bucket includes settled, MUON-approved crew memory and turns
   * it back into homework.
   */
  confirmed?: "all" | "confirmed" | "unconfirmed" | "unvouched";
  kind?: MemoryLibraryNote["kind"];
  trust?: MemoryLibraryNote["trust"];
  limit?: number;
  /** R3, mem0's `show_expired`: include notes past their TTL. Default false. */
  showExpired?: boolean;
  /** R5 bounded filter grammar. Validated server-side by the SAME @muon/protocol
   *  validator this type comes from, so the client cannot express a filter the
   *  backend would accept on looser bounds (or vice versa). */
  filter?: MemoryFilter;
  /** TODO 4.8: review-queue ordering (`supportCount` ranks corroboration first). */
  orderBy?: MemoryLibraryOrderBy;
  derivation?: NoteDerivation;
  reviewStatus?: NoteReviewStatus;
};

export async function loadMemoryLibrary(input: {
  apiBase: string;
  apiToken?: string;
  query?: MemoryLibraryQuery;
  fetcher?: typeof fetch;
}): Promise<MemoryLibrarySnapshot> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value === undefined || value === "") {
      continue;
    }
    // The filter is structured, so it rides as JSON; everything else in this
    // query is a scalar and `String()` is the right serialization.
    params.set(key, key === "filter" ? JSON.stringify(value) : String(value));
  }
  const url = `${input.apiBase.replace(/\/$/, "")}/api/memory/library${
    params.size > 0 ? `?${params.toString()}` : ""
  }`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
  const response = await (input.fetcher ?? fetch)(url, { headers });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Memory library request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return snapshotSchema.parse(await response.json());
}

/** B4 coordinate-only analytics loader. Agent callers must supply the trusted
 * chat scope; operator callers omit it for the whole local brain. */
export async function loadMemoryAnalytics(input: {
  apiBase: string;
  apiToken?: string;
  chatId?: string;
  /** ADR-0026: the workspace this analysis is ABOUT. Hot-module paths are
   *  workspace-relative, so an unfenced answer merges two repos' `src/index.ts`. */
  workspace?: string;
  unscoped?: boolean;
  limit?: number;
  fetcher?: typeof fetch;
}): Promise<MemoryAnalyticsSnapshot> {
  const params = new URLSearchParams();
  if (input.chatId) params.set("chatId", input.chatId);
  if (input.workspace) params.set("workspace", input.workspace);
  if (input.unscoped) params.set("unscoped", "true");
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
  const response = await (input.fetcher ?? fetch)(
    `${input.apiBase.replace(/\/$/, "")}/api/memory/analytics${query}`,
    { headers }
  );
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Memory analytics request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return analyticsSchema.parse(await response.json());
}
