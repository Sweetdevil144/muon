import { createHash } from "node:crypto";
import { cosine, type Embedder, type PreEditDuplicateWork } from "@muon/graph";
import {
  coordinationPartitionReady,
  dispatchJobPartitionWhere,
  type CoordinationPartition,
} from "./coordination-partition.js";
import type { prisma as PrismaClient } from "./db.js";

/**
 * KG-10 (ADR-0014 §5 Embeddings / §6), the DUPLICATE-WORK reader (the ADR's
 * OPTIONAL dense enrichment). It flags, PRE-EDIT, that another currently-LIVE lane
 * is doing SEMANTICALLY THE SAME work: when a peer's declared `DispatchJob.brief`
 * is a paraphrase of the caller's brief (cosine of the two briefs' KG-3 embeddings
 * >= `DUP_WORK_THRESHOLD`), the caller learns to coordinate instead of duplicating
 * effort.
 *
 * COORDINATES, NEVER CONTENT, THE load-bearing invariant (the brain-gate
 * side-channel invariant + the KG-7/8 discipline). `brief` is CONTENT / free text.
 * It is read ONLY to compute an embedding; it NEVER surfaces. The only thing that
 * flows out is a `PreEditDuplicateWork` = { jobId, taskId, vendor, similarity, state
 * }, a similarity SCALAR + ids, no brief text, no embedding vector, no message,
 * ever. Deriving a scalar from content is fine; surfacing the content is not. A
 * side-channel audit test feeds a poison brief and asserts no substring of any
 * brief appears in the serialized output. Like activity, dup-work is agent-authored
 * ⇒ untrusted ⇒ a distinct channel that can NEVER become a `MemoryNote`, enter
 * `recallForGate`, or be confirmed.
 *
 * NO EGRESS, the embedder is the KG-3 loopback-only one (`127.0.0.1:11434`,
 * `redirect:"error"`, no DNS, no configurable host); it is injected verbatim, no
 * new network is introduced.
 *
 * OPT-IN + DEGRADE-TO-EMPTY, no embedder (MUON_EMBED_DISABLE / no Ollama) / <2
 * running jobs / any error / a slow embedder → `[]`. The default consumer (no
 * Ollama) does ZERO embed work: `isAvailable()` short-circuits before any embed,
 * exactly the KG-3 F5 discipline. There is deliberately NO lexical brief-comparison
 * fallback, that could be gamed and would surface textual signal; degrade means
 * degrade to nothing.
 */

/** Cosine >= this ⇒ the two briefs are the "same work". 0.86 sits in the KG-3
 *  paraphrase band (the corroborated-supersede cosine the dedup path uses), high
 *  enough that only genuine paraphrases fire, not merely same-domain briefs. A
 *  single named knob (ADR-0014 §7 / KG-11 can tune it on a labeled split). */
export const DUP_WORK_THRESHOLD = 0.86;

/** Bound the peer set the reader embeds, on the hero HOT PATH. The live set is
 *  already tiny (≤ fleet-cap × vendors running jobs), but a dispatch flood or a
 *  crash-stale `running` row must never amplify the embed fan-out. */
const MAX_RUNNING_BRIEFS = 32;

/** Tight overall budget so a slow/absent embedder can NEVER block or 500 the hero.
 *  The KG-3 per-embed timeout is 10s; on the hot path that is far too long, so the
 *  whole compute races this and resolves `[]` if it overruns (the in-flight fetch
 *  aborts on its own timeout in the background). Loopback embeds answer in ms, so
 *  this only ever fires on a genuinely wedged backend. */
const DUP_WORK_TIMEOUT_MS = 1500;

/** Same normalize+sha256 as the KG-3 EmbeddingCache key (memory-ledger `textHash`)
 *  so a brief's cached vector is REUSED across pre-edit calls (and shared with any
 *  note of identical text under the same model), a durable "embed a brief once". */
function briefHash(text: string): string {
  return createHash("sha256")
    .update(text.trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex");
}

/** Parse a JSON-encoded number[] from EmbeddingCache; undefined if malformed. */
function parseVector(json: string): number[] | undefined {
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) {
      return undefined;
    }
    const vec = arr.map(Number);
    return vec.every((n) => Number.isFinite(n)) ? vec : undefined;
  } catch {
    return undefined;
  }
}

/** The one coordinate select every brief read uses. `brief` is present because it
 *  is read ONLY to embed, it is NEVER placed on an output `PreEditDuplicateWork`. */
const BRIEF_SELECT = {
  id: true,
  taskId: true,
  vendor: true,
  brief: true,
} as const;

type BriefRow = { id: string; taskId: string; vendor: string; brief: string };

/** The narrowed EmbeddingCache surface the reader reaches for, reuse the KG-3
 *  durable cache (keyed by (textHash, model)) so a brief is embedded once. Optional
 *  so a unit-test fake prisma may omit it (then the reader embeds via the fake). */
type EmbeddingCacheClient = {
  findUnique(args: {
    where: { textHash_model: { textHash: string; model: string } };
  }): Promise<{ vector: string; dims: number } | null>;
  upsert(args: {
    where: { textHash_model: { textHash: string; model: string } };
    create: { textHash: string; model: string; vector: string; dims: number };
    update: { vector: string; dims: number };
  }): Promise<unknown>;
};

/**
 * Vectors for a set of briefs, keyed by brief-hash. Cache-FIRST over the durable
 * KG-3 EmbeddingCache (best-effort, a fake prisma may omit it, or a read/write may
 * fail; either way we fall back to embedding), then a SINGLE batch `embed` of the
 * misses (so a brief is embedded at most once per call). Reuses the KG-3
 * EmbeddingCache table verbatim so a brief embedded on one pre-edit is free on the
 * next. Never throws, an embed failure yields a partial map and the pair goes
 * uncompared (→ not flagged), never surfaced.
 */
async function embedBriefsCached(
  prisma: typeof PrismaClient,
  embedder: Embedder,
  texts: string[]
): Promise<Map<string, number[]>> {
  const model = embedder.id;
  const byHash = new Map<string, number[]>();
  const cache = (prisma as unknown as { embeddingCache?: EmbeddingCacheClient })
    .embeddingCache;

  // Dedup by hash + cache-first lookup (durable EmbeddingCache reuse, best-effort).
  const misses: { hash: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const hash = briefHash(text);
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    let vec: number[] | undefined;
    if (cache) {
      try {
        const row = await cache.findUnique({
          where: { textHash_model: { textHash: hash, model } },
        });
        if (row) {
          const parsed = parseVector(row.vector);
          if (parsed && parsed.length === row.dims) {
            vec = parsed;
          }
        }
      } catch {
        // best-effort, a cache miss/failure just means we embed below.
      }
    }
    if (vec) {
      byHash.set(hash, vec);
    } else {
      misses.push({ hash, text });
    }
  }

  if (misses.length === 0) {
    return byHash;
  }

  // Batch-embed the misses ONCE (the loopback KG-3 embedder, no egress).
  let vectors: number[][] = [];
  try {
    vectors = await embedder.embed(misses.map((m) => m.text));
  } catch {
    vectors = [];
  }
  for (let i = 0; i < misses.length; i += 1) {
    const vec = vectors[i];
    if (!vec || vec.length === 0) {
      continue;
    }
    byHash.set(misses[i].hash, vec);
    // Persist to the durable, model-keyed cache (best-effort, never fails).
    if (cache) {
      void Promise.resolve(
        cache.upsert({
          where: { textHash_model: { textHash: misses[i].hash, model } },
          create: {
            textHash: misses[i].hash,
            model,
            vector: JSON.stringify(vec),
            dims: vec.length,
          },
          update: { vector: JSON.stringify(vec), dims: vec.length },
        })
      ).catch(() => undefined);
    }
  }
  return byHash;
}

/** The embed-heavy core: resolve the caller's brief, fetch OTHER running briefs,
 *  embed, cosine, threshold. Returns coordinates only. Any absence → []. */
async function computeDuplicateWork(
  prisma: typeof PrismaClient,
  embedder: Embedder,
  exclude?: { taskId?: string; jobId?: string },
  partition?: CoordinationPartition | null
): Promise<PreEditDuplicateWork[]> {
  if (!coordinationPartitionReady(partition)) {
    return [];
  }
  // Resolve the CALLER's brief, targeted by its running job id or its running
  // task. Read `brief` ONLY to embed it (never surfaced). Absent a self anchor
  // there is nothing to compare against → [].
  const callerWhere = exclude?.jobId
    ? { id: exclude.jobId, ...dispatchJobPartitionWhere(partition) }
    : exclude?.taskId
      ? {
          taskId: exclude.taskId,
          status: "running",
          ...dispatchJobPartitionWhere(partition),
        }
      : null;
  if (!callerWhere) {
    return [];
  }
  const caller = (await prisma.dispatchJob.findFirst({
    where: callerWhere,
    select: BRIEF_SELECT,
  })) as BriefRow | null;
  if (!caller?.brief) {
    return [];
  }

  // OTHER currently-running jobs (self-excluded by job AND the caller's OWN task,
  // #5), bounded. Excluding `caller.taskId` (loaded above, regardless of whether
  // the caller was resolved by jobId or taskId) means a SIBLING job on the caller's
  // own task, the same work by definition, is never compared. Coordinate select +
  // `brief` (read ONLY to embed). Never `title`/`description`.
  // Substrate §3.1: peers must share the caller's workspace/chat partition.
  const peers = (await prisma.dispatchJob.findMany({
    where: {
      status: "running",
      id: { not: caller.id },
      taskId: { not: caller.taskId },
      ...dispatchJobPartitionWhere(partition),
    },
    take: MAX_RUNNING_BRIEFS,
    select: BRIEF_SELECT,
  })) as BriefRow[];
  const peerBriefs = peers.filter((p) => p.brief);
  // <2 running jobs (the caller + no peers) → nothing to duplicate → [].
  if (peerBriefs.length === 0) {
    return [];
  }

  const vectors = await embedBriefsCached(prisma, embedder, [
    caller.brief,
    ...peerBriefs.map((p) => p.brief),
  ]);
  const callerVec = vectors.get(briefHash(caller.brief));
  if (!callerVec) {
    return [];
  }

  const out: PreEditDuplicateWork[] = [];
  const seen = new Set<string>();
  for (const peer of peerBriefs) {
    if (seen.has(peer.id)) {
      continue;
    }
    const peerVec = vectors.get(briefHash(peer.brief));
    if (!peerVec) {
      continue;
    }
    const sim = cosine(callerVec, peerVec);
    if (sim >= DUP_WORK_THRESHOLD) {
      seen.add(peer.id);
      out.push({
        jobId: peer.id,
        taskId: peer.taskId,
        vendor: peer.vendor,
        // A COORDINATE: the scalar rounded to 2 dp, derived from the brief text
        // but carrying none of it.
        similarity: Math.round(sim * 100) / 100,
        state: "live",
      });
    }
  }
  // Most-duplicate first (the strongest collision signal).
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

/**
 * Build the pre-edit DUPLICATE-WORK reader the hero calls
 * (`PreEditOptions.duplicateWorkReader`). Given only the caller's own ids (to
 * resolve + self-exclude the caller), it returns coordinate-only
 * `PreEditDuplicateWork` for every OTHER live lane doing semantically the same
 * work. Wraps the compute in an availability short-circuit (ZERO embed work when
 * dense is off) AND a tight timeout race, so a slow/absent embedder NEVER blocks
 * or 500s the hero, it degrades to `[]`.
 */
export function readDuplicateWork(
  prisma: typeof PrismaClient,
  embedder: Embedder | undefined,
  partition?: CoordinationPartition | null
) {
  return async (exclude?: {
    taskId?: string;
    jobId?: string;
  }): Promise<PreEditDuplicateWork[]> => {
    // OPT-IN: no embedder (MUON_EMBED_DISABLE / dense off) → [] with ZERO work.
    if (!embedder) {
      return [];
    }
    if (!coordinationPartitionReady(partition)) {
      return [];
    }
    // KG-3 F5: once detection concludes the loopback backend is unreachable, go
    // inert, no cache lookup, no awaited embed. The realistic no-Ollama default
    // costs nothing here after the first (cached) probe.
    try {
      if (embedder.isAvailable && !(await embedder.isAvailable())) {
        return [];
      }
    } catch {
      return [];
    }

    // The embed-heavy path, bounded by a tight timeout so it can never wedge the
    // hero. The timer is unref'd so it holds nothing open, and cleared on settle.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PreEditDuplicateWork[]>((resolve) => {
      timer = setTimeout(() => resolve([]), DUP_WORK_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        computeDuplicateWork(prisma, embedder, exclude, partition),
        timeout,
      ]);
    } catch {
      return [];
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}
