import type { Embedder } from "@muon/graph";

// ── Local, opt-in, auto-detected dense embedder (KG-3) ──────────────────────
//
// MUON is local-first with NO data egress by default (ADR-0009). The dense tier
// is therefore:
//   • LOCAL-ONLY , the host is a hard-coded loopback literal IP. There is NO
//                   env knob to point it at a remote address (no DNS name, so no
//                   rebind), and both fetches use `redirect: "error"` so a
//                   hostile/misconfigured process on :11434 can NOT 307/308 the
//                   POST body (the note text) off-box (KG-3 F3). Never a cloud
//                   embedding API.
//   • OPT-IN     , it only activates if a local Ollama is actually running
//                   (a deliberate user action); nothing is required to be up on
//                   first run, and MUON_EMBED_DISABLE=1 is a hard off.
//   • AUTO-DETECT, a single, cached, ASYNC probe (`isAvailable`). Never
//                   spawnSync / never sync HTTP on the event loop (the P2a bug);
//                   on ANY failure or timeout it silently stays lexical, and
//                   once "unreachable" is known the ingest path goes inert
//                   (no per-ingest cache lookup or awaited embed, KG-3 F5).

/** Loopback literal IP ONLY, deliberately not configurable, no DNS. */
const OLLAMA_HOST = "http://127.0.0.1:11434";

/** Small local embedding model; overridable, but the HOST is not. */
const DEFAULT_MODEL = "nomic-embed-text";

// Short probe budget (a running Ollama answers instantly on loopback); a longer
// budget per-embed. Both via AbortSignal.timeout so nothing blocks the loop.
const PROBE_TIMEOUT_MS = 800;
const EMBED_TIMEOUT_MS = 10_000;

function envModel(): string {
  return process.env.MUON_EMBED_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Build the local Ollama-backed embedder. `fetchImpl` is injectable so tests
 * never touch the network (and neither does construction, detection is lazy,
 * on first `isAvailable`/`embed`, and cached). The embedder's `id` is the model
 * name, which becomes part of the EmbeddingCache key (KG-3 F2) so a model switch
 * is a natural cache miss rather than a cross-embedding-space comparison.
 */
export function createLocalOllamaEmbedder(opts?: {
  model?: string;
  fetchImpl?: typeof fetch;
}): Embedder {
  const model = opts?.model ?? envModel();
  const doFetch = opts?.fetchImpl ?? fetch;

  // Tri-state detection cache: null = not yet probed. The probe promise is
  // memoized so concurrent first-embeds share ONE probe, and the result sticks.
  let available: boolean | null = null;
  let probing: Promise<boolean> | null = null;

  async function detect(): Promise<boolean> {
    if (available !== null) {
      return available;
    }
    probing ??= (async () => {
      try {
        const res = await doFetch(`${OLLAMA_HOST}/api/tags`, {
          method: "GET",
          redirect: "error", // never follow a redirect off loopback (F3)
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        available = res.ok;
      } catch {
        // Ollama not installed / not running / slow / redirecting → lexical.
        available = false;
      }
      return available;
    })();
    return probing;
  }

  return {
    id: model,
    async isAvailable(): Promise<boolean> {
      return detect();
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      // No local Ollama → empty result; callers treat that as "no dense vector"
      // and fall back to lexical. Never throws for the unavailable case.
      if (!(await detect())) {
        return [];
      }
      const vectors: number[][] = [];
      for (const text of texts) {
        const res = await doFetch(`${OLLAMA_HOST}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: text }),
          redirect: "error", // never re-send the note text off loopback (F3)
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
        if (!res.ok) {
          throw new Error(`ollama embeddings ${res.status}`);
        }
        const body = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
          throw new Error("ollama embeddings: empty vector");
        }
        vectors.push(body.embedding);
      }
      return vectors;
    },
  };
}
