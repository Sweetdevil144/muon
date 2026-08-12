import fs from "node:fs";
import { dbFilePath, resolveDataDir } from "@muon/client/paths";
import dotenv from "dotenv";
import { z } from "zod";

// Tests control process.env explicitly; loading .env there would leak local
// secrets (e.g. MUON_API_TOKEN) into the suite and 401 every request.
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  dotenv.config();
}

// Local-first embedded brain: with no DATABASE_URL provided (the default for a
// downloaded app/CLI), the database is a SQLite file in the per-user data dir.
// A hosted "Team/Cloud" build supplies its own DATABASE_URL (Postgres) and this
// is skipped. See docs/adr/0008-embedded-brain-sqlite.md.
if (!process.env.DATABASE_URL) {
  const dataDir = resolveDataDir();
  // 0700: the data dir holds the db, graph, logs and the local token, no other
  // user on a shared host may traverse into it (review finding F8). chmod too,
  // in case a prior run (or another surface) already created it at 0755.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // best-effort (e.g. a dir we don't own), the 0600 db/lockfile still protect.
  }
  process.env.DATABASE_URL = `file:${dbFilePath(dataDir)}`;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Reserved for future queueing; the backend runs fine without a Redis instance.
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  // Two-tier local API credentials (P3-A). The OPERATOR token carries human /
  // govern authority (approve, confirm, harness command writes); the AGENT token
  // is the agent tier (reads + agent-writes, NEVER govern) injected into
  // dispatched sub-agents. Embedded boot mints both (index.ts); a hosted deploy
  // must supply both or it refuses a non-loopback bind (fail-closed, H3).
  MUON_OPERATOR_TOKEN: z.string().min(8).optional(),
  MUON_AGENT_TOKEN: z.string().min(8).optional(),
  // Legacy single-token name. Still accepted as the OPERATOR token for
  // back-compat when the two-tier pair is not set; never an agent credential.
  MUON_API_TOKEN: z.string().min(8).optional(),
  // P3-B (audit M2): comma-separated extra roots a submitted workspacePath may
  // resolve under, on top of the always-allowed process CWD + home subtree.
  // Widen this for CI / power users who keep repos outside home. Read at request
  // time by backend/src/lib/workspace.ts (kept here for discoverability).
  MUON_WORKSPACE_ROOTS: z.string().optional(),
  // CG-1 (ADR-0011 → ALWAYS-ON per ADR-0012 Decision 6): the LOCAL, in-process,
  // no-egress code-graph provider for the pre-edit hero is now always active,
  // there is NO enable flag and NO off-switch. The only "off" is the provider's
  // intrinsic degrade-to-null (unsupported language / unresolvable target /
  // over-budget scan → today's `target-only`). See backend/src/lib/codegraph.ts.
  // Pino level for the brain's own log (fatal|error|warn|info|debug|trace|silent).
  // Default `info`; `npm run dev:desktop:debug` sets `debug`, which additionally
  // un-hides the per-request poll traffic demoted in lib/request-log.ts. Read at
  // build time by app.ts via resolveLogLevel(); declared here for discoverability.
  MUON_LOG_LEVEL: z.string().optional(),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3050"),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * The EMBEDDED (local) brain's port.
   *
   * DEFAULTS TO A CONSTANT (`DEFAULT_EMBEDDED_BRAIN_PORT`), not to an
   * OS-assigned ephemeral one. Churn was the original choice — it meant tests,
   * a second checkout and the desktop could never collide — and it cost more
   * than it saved:
   *
   *   - an attached-coordinator capability file PINS `apiBase` at attach time,
   *     so every brain restart silently invalidated every attached seat on the
   *     machine (measured 2026-08-11: a file pinned :55666 while the live
   *     brain answered on :50598);
   *   - a long-lived MCP server built at :55036 was still calling :55036 two
   *     days later;
   *   - and none of it is legible to a user, who sees only tools that stopped
   *     working.
   *
   * Both of those now self-heal (the client re-resolves a moved brain), but a
   * stable address is what makes the failure not happen in the first place —
   * and it is what the hosted deploy already does with `PORT`.
   *
   * CONTENTION IS HANDLED RATHER THAN TRADED FOR. If the constant is taken,
   * the DEFAULT falls back to an ephemeral port and says so, because a user
   * whose 47100 is held by something unrelated must not have a dead product.
   * An EXPLICIT pin still fails loudly — someone who chose a number deserves
   * to learn it was unavailable rather than silently get another.
   *
   * `MUON_BRAIN_PORT=0` opts back into the old ephemeral behaviour outright.
   */
  MUON_BRAIN_PORT: z
    // An EMPTY assignment (`MUON_BRAIN_PORT=` in a .env) is UNSET, not zero.
    // `z.coerce.number()` turns "" into 0, and 0 is an explicit request for an
    // OS-assigned port — so an empty line would have silently produced exactly
    // the churning port the stable default exists to eliminate, with no
    // message. It used to be a loud validation error; it must not become a
    // quiet behaviour change.
    .preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.coerce.number().int().min(0).max(65535).optional()
    ),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export const env = envSchema.parse(process.env);
