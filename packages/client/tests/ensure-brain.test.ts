import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBrain, resolveBrainEntry } from "../src/ensure-brain.js";
import { lockfilePath, writeLockfile, type BrainLock } from "../src/paths.js";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-ensure-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const lock = (pid: number): BrainLock => ({
  port: 4123,
  token: "t",
  pid,
  dbPath: "/x",
  startedAt: "t",
});

describe("ensureBrain (moved into @muon/client)", () => {
  it("no-ops when an existing lockfile's brain answers /health", async () => {
    writeLockfile(lock(process.pid), dir);
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);

    const result = await ensureBrain({ dataDir: dir, fetcher });

    expect(result).toMatchObject({
      live: true,
      started: false,
      base: "http://127.0.0.1:4123",
      dataDir: dir,
    });
    // It went through the SHARED probe (paths.ts), never spawned anything.
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4123/health",
      expect.anything()
    );
  });

  it("reports an honest note (names the lockfile) when a spawned brain never turns healthy", async () => {
    // A dummy entrypoint that exits immediately: it never writes a lockfile, so
    // the confirm loop times out — the spawn path without a real backend.
    const dummy = path.join(dir, "dummy-entry.mjs");
    writeFileSync(dummy, "process.exit(0);\n");
    process.env.MUON_BRAIN_ENTRY = dummy;
    const fetcher = vi.fn(async () => ({ ok: false }) as Response);

    const result = await ensureBrain({
      dataDir: dir,
      confirmMs: 200,
      fetcher,
    });

    expect(result.live).toBe(false);
    expect(result.started).toBe(true);
    expect(result.note).toContain("lockfile:");
    expect(result.note).toContain(lockfilePath(dir));
  });

  it("resolveBrainEntry honors the MUON_BRAIN_ENTRY override", () => {
    const override = path.join(dir, "override-entry.js");
    writeFileSync(override, "// entry\n");
    process.env.MUON_BRAIN_ENTRY = override;

    expect(resolveBrainEntry()).toBe(override);
  });

  it("resolveBrainEntry's dev-search still reaches backend/dist from the new location", () => {
    delete process.env.MUON_BRAIN_ENTRY;
    // In the monorepo the upward walk from packages/client/dist must reach the
    // repo-root backend/dist/index.js (identical outcome to the old apps/cli
    // location). Guard so this stays meaningful only when the backend is built.
    const entry = resolveBrainEntry();
    if (entry && existsSync(entry)) {
      expect(entry.endsWith(path.join("backend", "dist", "index.js"))).toBe(
        true
      );
    }
  });
});
