import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireGitNexusIndexLock,
  gitnexusIndexLockPath,
  readGitNexusIndexLock,
} from "@muon/client/gitnexus-index-lock";
import { createGitNexusToolDefinitions } from "../src/gitnexus-tools.js";

// MUON spawns `gitnexus analyze` from TWO of its own processes against ONE
// `.gitnexus/` store — this MCP server's freshness refresh and the desktop's
// index supervisor. `analyze --force` deletes the store's DB files before
// rebuilding them, so an overlap is a destroyed graph, not a slow one.
//
// These run REAL processes: the guard exists precisely because an in-process
// flag cannot see another OS process, so mocking that away would prove nothing.

const require = createRequire(import.meta.url);
const LOCK_MODULE = pathToFileURL(
  require.resolve("@muon/client/gitnexus-index-lock")
).href;

const HEAD = "53aca6ff35be1c1b225feb3e60eccf05e220cc2b";
const STALE = "d148ccc";
const workspaces: string[] = [];
const holders: Array<{ kill: () => void }> = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "muon-gnx-xlock-"));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  for (const holder of holders.splice(0)) holder.kill();
  await Promise.all(
    workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function listOutput(root: string, commit: string): string {
  return [
    "",
    "  Indexed Repositories (1)",
    "",
    "  muon",
    `    Path:    ${root}`,
    "    Indexed: 7/27/2026, 3:01:12 PM",
    `    Commit:  ${commit}`,
    "    Stats:   913 files, 17396 symbols, 28352 edges",
    "",
  ].join("\n");
}

/**
 * A REAL second MUON process that takes the index lock and holds it until it is
 * killed — the desktop supervisor's analyze, from this test's point of view.
 * Resolves once the lock is actually published.
 */
async function otherProcessHoldsLock(
  repo: string
): Promise<{ kill: () => void }> {
  const script = join(repo, "hold-lock.mjs");
  writeFileSync(
    script,
    `import { acquireGitNexusIndexLock } from ${JSON.stringify(LOCK_MODULE)};
     const attempt = acquireGitNexusIndexLock(process.argv[2], { owner: "desktop" });
     process.stdout.write(attempt.acquired ? "HELD\\n" : "REFUSED\\n");
     if (!attempt.acquired) process.exit(1);
     setInterval(() => {}, 1000);`
  );
  const child = spawn(process.execPath, [script, repo], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const handle = {
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
  };
  holders.push(handle);
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) =>
      String(chunk).includes("HELD")
        ? resolve()
        : reject(new Error("the holder process failed to take the lock"))
    );
    child.on("error", reject);
  });
  return handle;
}

describe("two MUON processes must never index one store at once", () => {
  /**
   * A `run` seam over a stale index. `analyze` is recorded (and asserted
   * against) rather than executed — the point of these tests is WHETHER MUON
   * spawns a second indexer, not what the indexer does.
   */
  function toolsOver(root: string, onAnalyze?: () => void) {
    const analyzed: string[][] = [];
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") {
        return { stdout: listOutput(root, STALE), stderr: "" };
      }
      if (args[0] === "analyze") {
        analyzed.push(args);
        onAnalyze?.();
        return { stdout: "Repository indexed successfully", stderr: "" };
      }
      return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
    });
    return {
      analyzed,
      run,
      tool: (name: string) =>
        createGitNexusToolDefinitions({
          workspacePath: root,
          binary: "gitnexus",
          run,
        }).find((candidate) => candidate.name === name)!,
    };
  }

  it("code_impact does NOT index behind another process — it fails closed", async () => {
    const root = await workspace();
    await otherProcessHoldsLock(root);
    const { analyzed, tool } = toolsOver(root);

    const result = await tool("code_impact").handler({ target: "changeMe" });

    // Never a second analyze against a store MUON is already rebuilding.
    expect(analyzed).toHaveLength(0);
    // And never a confidently-wrong answer from the stale graph: fail closed,
    // naming the contention so the agent knows this one is worth retrying.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toMatch(
      /Another MUON process is indexing/
    );
  });

  it("does not BLOCK the governed child either — it answers immediately", async () => {
    const root = await workspace();
    await otherProcessHoldsLock(root);
    const { tool } = toolsOver(root);
    const started = Date.now();
    await tool("code_impact").handler({ target: "changeMe" });
    // A real rebuild takes minutes. Queueing behind it would hang the child's
    // tool call for that long, which is the other way to lose a mission.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("code_query still answers from the stale graph, disclosed, never spawning", async () => {
    const root = await workspace();
    await otherProcessHoldsLock(root);
    const { analyzed, tool } = toolsOver(root);

    const result = await tool("code_query").handler({ query: "approvals" });

    expect(result.isError).not.toBe(true);
    expect(analyzed).toHaveLength(0);
    expect(result.ui?.degradation).toMatchObject({ active: true });
  });

  it("refreshes normally once the other process lets go", async () => {
    const root = await workspace();
    const holder = await otherProcessHoldsLock(root);
    const { analyzed, tool } = toolsOver(root);
    await tool("code_impact").handler({ target: "changeMe" });
    expect(analyzed).toHaveLength(0);

    holder.kill();
    await waitForFreeLock(root);

    // Fresh tools over a store that now comes current when analyzed.
    let refreshed = false;
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") {
        return { stdout: listOutput(root, refreshed ? HEAD : STALE), stderr: "" };
      }
      if (args[0] === "analyze") {
        refreshed = true;
        // The lock must be HELD by us for the whole life of the analyze.
        expect(readGitNexusIndexLock(root)?.owner).toBe("mcp");
        return { stdout: "ok", stderr: "" };
      }
      return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
    });
    const impact = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    const result = await impact.handler({ target: "changeMe" });
    expect(result.isError).not.toBe(true);
    expect(refreshed).toBe(true);
    // Released on the way out — a stale lock here would wedge the desktop's
    // Re-index button until the pid check reclaimed it.
    expect(existsSync(gitnexusIndexLockPath(root))).toBe(false);
  });

  it("releases the lock even when BOTH the incremental and the force fail", async () => {
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") {
        return { stdout: listOutput(root, STALE), stderr: "" };
      }
      if (args[0] === "analyze") throw new Error("analyze exploded");
      return { stdout: "{}", stderr: "" };
    });
    const impact = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    const result = await impact.handler({ target: "changeMe" });
    expect(result.isError).toBe(true);
    expect(existsSync(gitnexusIndexLockPath(root))).toBe(false);
  });

  it("exactly one of six REAL processes takes one store's lock", async () => {
    const root = await workspace();
    const script = join(root, "racer.mjs");
    writeFileSync(
      script,
      `import { acquireGitNexusIndexLock } from ${JSON.stringify(LOCK_MODULE)};
       const attempt = acquireGitNexusIndexLock(process.argv[2], { owner: "mcp" });
       if (!attempt.acquired) process.exit(20);
       // Hold long enough that every sibling meets a LIVE holder.
       setTimeout(() => { attempt.lock.release(); process.exit(10); }, 500);`
    );
    const codes = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawn(process.execPath, [script, root], {
            stdio: "ignore",
          });
          child.on("error", reject);
          child.on("exit", (code) => resolve(code));
        })
      )
    );
    expect(codes.filter((code) => code === 10)).toHaveLength(1);
    expect(codes.filter((code) => code === 20)).toHaveLength(5);
    // The winner released on its way out; the store is free again.
    expect(existsSync(gitnexusIndexLockPath(root))).toBe(false);
  });
});

/** Wait until the store's lock is free (the killed holder's pid is reaped). */
async function waitForFreeLock(root: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const attempt = acquireGitNexusIndexLock(root, { owner: "mcp" });
    if (attempt.acquired) {
      attempt.lock.release();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the index lock never came free");
}
