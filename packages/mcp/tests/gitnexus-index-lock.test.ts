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
  GITNEXUS_INDEX_LOCK_MAX_HOLD_MS,
} from "@muon/client/gitnexus-index-lock";
import {
  __ownRebuildStartedAt,
  createGitNexusToolDefinitions,
  defaultReconRunner,
  releaseWhenWriterExits,
} from "../src/gitnexus-tools.js";

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

  it("does not hang when THIS process owns the lock and the rebuild is slow", async () => {
    // The gap the two tests above leave open. They cover contention — another
    // process holding the lock. Live, nobody else held it: this process took
    // the lock and ran the full re-index inline, with a ten-minute timeout, so
    // a stale index (the state of every repo right after a commit) turned
    // code_impact into a multi-minute silence. Measured at 20s from the tool
    // sweep and 300s from a live MCP call.
    const root = await workspace();
    const analyzed: string[][] = [];
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(root, STALE), stderr: "" };
      if (args[0] === "analyze") {
        analyzed.push(args);
        // A rebuild that outlives the caller's patience, which is the whole
        // point: the tool must stop waiting, not the rebuild. Unref'd so the
        // pending timer cannot hold the test runner open after the bounded
        // call has already returned.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          timer.unref?.();
        });
        return { stdout: "Repository indexed successfully", stderr: "" };
      }
      return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
    });
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    const started = Date.now();
    const result = await tool.handler({ target: "changeMe" });
    const elapsed = Date.now() - started;

    // Bounded, and retryably refused rather than answered from a stale graph.
    expect(elapsed).toBeLessThan(40_000);
    expect(result.isError).toBe(true);
    const payload = JSON.stringify(result.structuredContent);
    expect(payload).toMatch(/being rebuilt/i);
    // And it must NOT tell the agent to start a competing indexer: `--force`
    // deletes the store before rebuilding, so a second run against a store
    // this process is already rebuilding destroys the graph.
    expect(payload).not.toMatch(/Run `gitnexus analyze/);
    expect(payload).toMatch(/do not start another|Do NOT run/i);
    // The rebuild was still started — it is the waiting that is bounded.
    expect(analyzed.length).toBeGreaterThan(0);
  }, 60_000);

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

  it("a rebuild that FAILS reports its real cause, not the rebuild wording", async () => {
    // The bounded wait CARRIES the rejection instead of erasing it, so a broken
    // binary or a corrupt store is named. Without it the answer was the generic
    // staleness refusal, and the agent went looking for a rebuild to wait on.
    //
    // Scope, stated honestly: this pins the fast-failure path (the refresh
    // settles before the 8s budget). The narrow case where the rejection lands
    // AFTER the timer has already won is a real-time race that cannot be forced
    // deterministically here; what saves that call is the NEXT one, which finds
    // no live rebuild, retries, and fails fast into this same path.
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(root, STALE), stderr: "" };
      if (args[0] === "analyze") throw new Error("gitnexus: no such file");
      return { stdout: "{}", stderr: "" };
    });
    const impact = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    const result = await impact.handler({ target: "changeMe" });
    const payload = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatch(/no such file/);
    // Not the "we are still rebuilding, come back" answer, which is advice for
    // a rebuild that is over.
    expect(payload).not.toMatch(/did not finish in time|is being rebuilt/i);
  });

  it("an unfinished rebuild of ONE store does not speak for another", async () => {
    // The flag is process-wide on purpose (two tool instances share one lock),
    // but "a rebuild is running" is only ever true of ONE store. Held as a
    // single global, workspace A's background rebuild — which by design outlives
    // the 8s wait — made every unrelated workspace answer "MUON is rebuilding
    // this repository's index" for the next ten minutes.
    const busy = await workspace();
    const other = await workspace();
    const slowRun = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(busy, STALE), stderr: "" };
      if (args[0] === "analyze") {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          timer.unref?.();
        });
        return { stdout: "ok", stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    });
    const slow = createGitNexusToolDefinitions({
      workspacePath: busy,
      binary: "gitnexus",
      run: slowRun,
    }).find((candidate) => candidate.name === "code_impact")!;
    // Leaves a live rebuild behind, which is the whole point.
    await slow.handler({ target: "changeMe" });

    // A DIFFERENT workspace, with nothing indexed for it at all.
    const otherRun = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: "", stderr: "" };
      return { stdout: "{}", stderr: "" };
    });
    const elsewhere = createGitNexusToolDefinitions({
      workspacePath: other,
      binary: "gitnexus",
      run: otherRun,
    }).find((candidate) => candidate.name === "code_impact")!;

    const payload = JSON.stringify(await elsewhere.handler({ target: "x" }));

    expect(payload).toMatch(/No indexed GitNexus repository/i);
    expect(
      payload,
      "the other workspace's rebuild says nothing about this one"
    ).not.toMatch(/being rebuilt/i);
  }, 60_000);

  it("a stale-graph SUCCESS during our rebuild does not advise the competing indexer", async () => {
    // `code_query` degrades to the stale graph and normally advises "run
    // `gitnexus analyze`". During this process's own background rebuild that
    // advice starts the overlapping indexer whose `--force` retry deletes the
    // store — the error path already refuses to say it, and the success path
    // carries the same obligation.
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(root, STALE), stderr: "" };
      if (args[0] === "analyze") {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          timer.unref?.();
        });
        return { stdout: "ok", stderr: "" };
      }
      return { stdout: JSON.stringify({ processes: [] }), stderr: "" };
    });
    const tools = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    });
    // Leaves this process's own rebuild of `root` in flight.
    await tools
      .find((candidate) => candidate.name === "code_impact")!
      .handler({ target: "changeMe" });

    const result = await tools
      .find((candidate) => candidate.name === "code_query")!
      .handler({ query: "anything" });
    const payload = JSON.stringify(result);

    expect(result.isError).not.toBe(true);
    expect(result.ui?.degradation).toMatchObject({ active: true });
    expect(payload).toMatch(/already rebuilding/i);
    expect(payload).not.toMatch(/Run `gitnexus analyze/);
  }, 60_000);

  it("an unrelated failure DURING our rebuild is not promised away", async () => {
    // While this process's own rebuild is in flight, every error still routes
    // through `unavailable()` — and a query broken on its own merits fails
    // identically after the wait. The in-flight fact licenses exactly one
    // instruction ("do not start a competing indexer"); it must not upgrade to
    // "waiting fixes this", and it must not claim the contention wording.
    const root = await workspace();
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") return { stdout: listOutput(root, STALE), stderr: "" };
      if (args[0] === "analyze") {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60_000);
          timer.unref?.();
        });
        return { stdout: "ok", stderr: "" };
      }
      if (args[0] === "query") throw new Error("query exploded on its own");
      return { stdout: "{}", stderr: "" };
    });
    const tools = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    });
    // Leaves this process's own rebuild of `root` in flight.
    await tools
      .find((candidate) => candidate.name === "code_impact")!
      .handler({ target: "changeMe" });

    const result = await tools
      .find((candidate) => candidate.name === "code_query")!
      .handler({ query: "anything" });
    const payload = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatch(/query exploded on its own/);
    // The one licensed instruction survives…
    expect(payload).toMatch(/Do NOT run `gitnexus analyze`/);
    // …without promising the wait fixes it, and without the contention claim.
    expect(payload).toMatch(/fails identically after the rebuild/i);
    expect(payload).not.toMatch(/Wait for the in-flight index rebuild, then retry/i);
  }, 60_000);

  it("stops claiming a finished rebuild as its own", async () => {
    // `ownRebuildStartedAt` selects the "MUON is rebuilding" wording. Left set
    // after the rebuild ended, the NEXT genuinely-contended call — another
    // process, another tool, minutes later — inherits it and blames a rebuild
    // that is over.
    const root = await workspace();
    let refreshed = false;
    const run = vi.fn(async (binary: string, args: string[]) => {
      if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "list") {
        return { stdout: listOutput(root, refreshed ? HEAD : STALE), stderr: "" };
      }
      if (args[0] === "analyze") {
        refreshed = true;
        return { stdout: "ok", stderr: "" };
      }
      return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
    });
    const tools = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    });
    const impact = tools.find((candidate) => candidate.name === "code_impact")!;

    // One full rebuild, start to finish, by this process.
    expect((await impact.handler({ target: "changeMe" })).isError).not.toBe(true);

    // Now the store goes stale again and SOMEONE ELSE holds the lock.
    refreshed = false;
    await otherProcessHoldsLock(root);
    const contended = await impact.handler({ target: "changeMe" });
    const payload = JSON.stringify(contended);

    expect(contended.isError).toBe(true);
    expect(payload).toMatch(/another MUON process|indexing this repository/i);
    expect(
      payload,
      "our rebuild finished; this one is not ours"
    ).not.toMatch(/being rebuilt/i);
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

/**
 * `analyze` must ask for SIGTERM (cubic pass-5, hardened pass-6). `--force`
 * DELETES `lbug`/`lbug.wal` before rebuilding, so a SIGKILL inside that window
 * leaves a half-written store — the corruption this whole lock exists to
 * prevent. The signal rides on a positional parameter and was ALREADY lost
 * once when the spawn paths were unified, so it is pinned rather than trusted.
 *
 * This lives here because this is the file with a fixture that actually
 * reaches the refresh path. A version written against a fixture that never
 * spawns `analyze` passes while asserting nothing — which is exactly what the
 * first attempt did.
 */
describe("the analyze spawn's kill signal", () => {
  it("requests SIGTERM for analyze, and leaves reads on the default", async () => {
    const root = await workspace();
    const calls: { args: string[]; killSignal?: string }[] = [];
    const run = vi.fn(
      async (binary: string, args: string[], options: { killSignal?: string }) => {
        calls.push({ args, killSignal: options?.killSignal });
        if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
        if (args[0] === "list") return { stdout: listOutput(root, STALE), stderr: "" };
        if (args[0] === "analyze") {
          return { stdout: "Repository indexed successfully", stderr: "" };
        }
        return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
      }
    );
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    await tool.handler({ target: "changeMe" }).catch(() => undefined);

    const analyzeCalls = calls.filter((call) => call.args[0] === "analyze");
    // NOT VACUOUS: if the fixture stops reaching the refresh path this fails
    // loudly instead of asserting over an empty list.
    expect(
      analyzeCalls.length,
      "fixture must actually spawn analyze, or this test proves nothing"
    ).toBeGreaterThan(0);
    for (const call of analyzeCalls) {
      expect(call.killSignal, "analyze must request SIGTERM").toBe("SIGTERM");
    }
    for (const call of calls.filter((c) => c.args[0] !== "analyze")) {
      expect(
        call.killSignal,
        `read spawn '${call.args[0]}' must stay on the default signal`
      ).toBeUndefined();
    }
  });
});

/**
 * The wait for a dead child is BOUNDED (cubic pass-7).
 *
 * `close` fires only after the process exits AND every stdio stream closes, so
 * a grandchild that inherited stderr keeps it pending after the child itself is
 * gone. Waiting on `close` alone therefore had a state where the promise never
 * settled at all — and an unsettled run never releases the cross-process index
 * lock, blocking every later refresh until the 30-minute max-hold ages it out.
 *
 * This is a REAL spawn with a REAL orphaned grandchild, because the hazard is a
 * property of pipes and process trees that a fake runner cannot reproduce.
 */
describe("the recon runner's wait for a dead child", () => {
  it("settles when the child exits even though a grandchild holds stderr open", async () => {
    const dir = await workspace();
    const started = Date.now();
    // `sh` exits immediately; `sleep` inherits stderr and lives on. `close`
    // cannot arrive for ~6s, so anything that settles sooner settled on `exit`.
    const result = await defaultReconRunner(
      "/bin/sh",
      ["-c", "sleep 6 & exit 0"],
      { cwd: dir, timeout: 30_000, label: "grandchild probe" }
    );
    const elapsed = Date.now() - started;

    expect(result.stdout).toBe("");
    // NOT VACUOUS, both directions. Under ~1.5s would mean `close` fired
    // promptly and the fixture never reproduced the hazard; over ~5s would
    // mean we waited for the grandchild after all, which is the bug.
    expect(
      elapsed,
      "must settle on the exit+drain path, not on close"
    ).toBeGreaterThan(1_500);
    expect(
      elapsed,
      "must not wait for the grandchild to release stderr"
    ).toBeLessThan(5_000);
  }, 30_000);
});

/**
 * …and the deadline does not fire against a process that has already exited
 * (cubic pass-8). The early-settle path above waits 2s for the pipes to drain,
 * and the timeout timer used to stay armed through that window — so a child
 * that exited CLEANLY could be reported as timed out. `refreshWorkspaceRepo`
 * answers a failed `analyze(false)` with `analyze(true)`, and `--force` DELETES
 * `lbug`/`lbug.wal`, so the misreport would have cost a destructive rebuild of
 * a store that had just indexed successfully.
 */
describe("the recon runner's deadline after a clean exit", () => {
  it("does not report a timeout for a child that exited 0 inside the drain window", async () => {
    const dir = await workspace();
    // The deadline (500ms) lands INSIDE the 2s drain, and the child is already
    // gone by then — so an armed timer would reject here.
    const result = await defaultReconRunner(
      "/bin/sh",
      ["-c", "sleep 6 & exit 0"],
      { cwd: dir, timeout: 500, label: "clean exit probe" }
    );
    expect(result.stdout).toBe("");
  }, 30_000);
});

/**
 * A rejection that leaves the child ALIVE must not trigger the destructive
 * retry (cubic pass-13).
 *
 * `refreshWorkspaceRepo` answers a failed `analyze(false)` with `analyze(true)`
 * — `gitnexus analyze --force`, which DELETES `lbug`/`lbug.wal`. That is safe
 * only because every other failure here means the process is gone. The terminal
 * deadline broke that assumption: it fires precisely when the child could not
 * be killed, so the retry would point a store-deleting run at a store a live
 * writer still holds. The cross-process lock does not help — this process is
 * the one holding it.
 */
describe("the force retry after a live-child timeout", () => {
  it("does NOT run `analyze --force` when the first analyze left a live child", async () => {
    const root = await workspace();
    const analyzeArgs: string[][] = [];
    const run = vi.fn(
      async (binary: string, args: readonly string[]) => {
        if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
        if (args[0] === "list")
          return { stdout: listOutput(root, STALE), stderr: "" };
        if (args[0] === "analyze") {
          analyzeArgs.push([...args]);
          const error: Error & { childStillLive?: true } = new Error(
            "analyze timed out, and the process did not exit after SIGKILL"
          );
          error.childStillLive = true;
          throw error;
        }
        return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
      }
    );
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    await tool.handler({ target: "changeMe" }).catch(() => undefined);

    // NOT VACUOUS: the fixture must really reach the refresh path, or this
    // asserts over an empty list and proves nothing.
    expect(
      analyzeArgs.length,
      "fixture must actually spawn analyze, or this test proves nothing"
    ).toBeGreaterThan(0);
    // …and every spawn must be the NON-destructive one.
    for (const args of analyzeArgs) {
      expect(args, "a live child must never be answered with --force").not.toContain(
        "--force"
      );
    }
  });

  it("STILL runs the force retry for an ordinary failure (the control)", async () => {
    // Without this, a change that suppressed the retry unconditionally would
    // pass the test above while silently retiring the recovery it guards.
    const root = await workspace();
    const analyzeArgs: string[][] = [];
    const run = vi.fn(
      async (binary: string, args: readonly string[]) => {
        if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
        if (args[0] === "list")
          return { stdout: listOutput(root, STALE), stderr: "" };
        if (args[0] === "analyze") {
          analyzeArgs.push([...args]);
          if (!args.includes("--force")) throw new Error("analyze failed");
          return { stdout: "Repository indexed successfully", stderr: "" };
        }
        return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
      }
    );
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    await tool.handler({ target: "changeMe" }).catch(() => undefined);

    expect(analyzeArgs.some((args) => args.includes("--force"))).toBe(true);
  });
});

/**
 * …and the lock is NOT handed back while that child is still writing
 * (cubic pass-13, second half).
 *
 * Refusing the `--force` retry protects the call that hit the timeout. It does
 * nothing for the NEXT one: releasing the lock in `finally` hands the store to
 * the next `code_impact`, which spawns its own `analyze(false)` beside the live
 * child — and THAT spawn's ordinary failure re-enables the retry this call just
 * refused. The guard has to outlive the call that set it.
 */
describe("the index lock after a live-child timeout", () => {
  it("stays held, so the next refresh cannot start a competing indexer", async () => {
    const root = await workspace();
    const analyzeArgs: string[][] = [];
    const run = vi.fn(
      async (binary: string, args: readonly string[]) => {
        if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
        if (args[0] === "list")
          return { stdout: listOutput(root, STALE), stderr: "" };
        if (args[0] === "analyze") {
          analyzeArgs.push([...args]);
          const error: Error & { childStillLive?: true } = new Error(
            "analyze timed out, and the process did not exit after SIGKILL"
          );
          error.childStillLive = true;
          throw error;
        }
        return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
      }
    );
    const tool = () =>
      createGitNexusToolDefinitions({
        workspacePath: root,
        binary: "gitnexus",
        run,
      }).find((candidate) => candidate.name === "code_impact")!;

    await tool().handler({ target: "changeMe" }).catch(() => undefined);
    const afterFirst = analyzeArgs.length;
    expect(
      afterFirst,
      "fixture must actually spawn analyze, or this test proves nothing"
    ).toBeGreaterThan(0);

    // The lock file is still there, still ours, still claiming a live rebuild.
    expect(existsSync(gitnexusIndexLockPath(root))).toBe(true);
    expect(readGitNexusIndexLock(root)?.pid).toBe(process.pid);

    // And the second call adds no analyze of its own.
    await tool().handler({ target: "changeMe" }).catch(() => undefined);
    expect(
      analyzeArgs.length,
      "a second refresh must not spawn analyze beside the live child"
    ).toBe(afterFirst);
  });
});

/**
 * …and it is released the moment that child is gone (cubic pass-15).
 *
 * Holding the lock is right only while a writer is actually writing. Held
 * indefinitely it is not the safer failure — the lock's staleness rule is
 * holder-pid liveness and the holder is this long-lived server, so every
 * indexing surface in MUON would be refused until a restart. This pins the
 * self-healing half against a REAL process that really does exit.
 */
describe("the wedged-writer watcher", () => {
  it("releases the lock once the live child actually exits", async () => {
    const root = await workspace();
    // A real child with a real pid, alive for ~1.5s and then genuinely gone.
    const child = spawn("/bin/sh", ["-c", "sleep 1.5"], { stdio: "ignore" });
    const run = vi.fn(
      async (binary: string, args: readonly string[]) => {
        if (binary === "git") return { stdout: `${HEAD}\n`, stderr: "" };
        if (args[0] === "list")
          return { stdout: listOutput(root, STALE), stderr: "" };
        if (args[0] === "analyze") {
          const error: Error & {
            childStillLive?: true;
            childPid?: number;
          } = new Error("analyze timed out, and the process did not exit after SIGKILL");
          error.childStillLive = true;
          error.childPid = child.pid;
          throw error;
        }
        return { stdout: JSON.stringify({ risk: "LOW", byDepth: {} }), stderr: "" };
      }
    );
    const tool = createGitNexusToolDefinitions({
      workspacePath: root,
      binary: "gitnexus",
      run,
    }).find((candidate) => candidate.name === "code_impact")!;

    await tool.handler({ target: "changeMe" }).catch(() => undefined);

    // Held while the writer lives — the non-vacuity guard for the wait below.
    expect(
      existsSync(gitnexusIndexLockPath(root)),
      "the lock must be held while the writer is alive"
    ).toBe(true);
    // …and the CHILD is on the on-disk record. This is what protects the store
    // if this server dies mid-hold: without it the next acquirer sees only a
    // dead server pid, judges the lock a corpse, and reclaims it into
    // `--force` under the live writer. `onSpawn` adoption lives inside the
    // default runner, which every test here replaces — this assertion goes
    // through the flagged-error path, the one the injected seam CAN observe.
    expect(
      readGitNexusIndexLock(root)?.childPid,
      "the live child must be adopted into the lock record"
    ).toBe(child.pid);

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        if (!existsSync(gitnexusIndexLockPath(root))) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          reject(new Error("the lock was never released after the writer exited"));
        }
      }, 100);
    });
  }, 30_000);
});

/**
 * The null-pid CEILING branch of the watcher — the only release path that can
 * give the store away without proof the writer is gone (cubic passes 16-18).
 * A probeable pid has NO ceiling: its life is the bound, because every
 * wall-clock bound eventually released the lock under a provably-live writer
 * and flipped the advice to "run gitnexus analyze" — measured across three
 * review passes. Three properties pinned here:
 * released at the bound; the marker survives, back-stamped by (bound - grace)
 * so it expires on the grace rather than a second full bound; and an EPERM
 * probe never releases, on any host, root included.
 */
describe("the wedged-writer watcher's release paths", () => {
  it("null pid: releases at the bound, marker back-stamped to the grace", async () => {
    let released = false;
    const repoPath = `/definitely/not/a/real/repo-${process.pid}`;
    __ownRebuildStartedAt.set(repoPath, 1);
    releaseWhenWriterExits(null, repoPath, {
      release: () => {
        released = true;
      },
    }, { maxHoldMs: 3_000, pollMs: 25, graceMs: 1_000 });

    // Poll for the release rather than sleeping a fixed time, so the age
    // measurement below starts right at the release instead of a scheduler
    // delay later.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        if (released) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          reject(new Error("the null-pid ceiling never ended the hold"));
        }
      }, 25);
    });
    // The back-stamp is (bound - grace) into the past — BOTH directions. Too
    // recent (left at "just now") reads live for a second full bound and
    // misattributes the next holder's rebuild; too old (stamped a full bound
    // back) kills the marker instantly and flips the advice to "run gitnexus
    // analyze" the moment the lock comes free.
    const stamped = __ownRebuildStartedAt.get(repoPath);
    expect(stamped).toBeDefined();
    // The back-stamp is computed against the READER's bound
    // (OWN_REBUILD_LIVE_BOUND_MS = the lock max-hold), not the overridable
    // test deadline — the marker's lifetime is defined by what
    // `ownRebuildIsLive` will accept, and two independently-shortenable
    // expressions is how a back-stamped marker arrives already dead. So the
    // assertion is in reader terms: the marker must still read LIVE now, and
    // must expire within the grace (1s here), not a second full bound later.
    const age = Date.now() - (stamped ?? 0);
    expect(
      age,
      "back-stamp too deep — marker would already be dead to the reader"
    ).toBeLessThan(GITNEXUS_INDEX_LOCK_MAX_HOLD_MS);
    expect(
      age,
      "back-stamp too shallow — marker would live a full reader bound"
    ).toBeGreaterThan(GITNEXUS_INDEX_LOCK_MAX_HOLD_MS - 1_000 - 2_000);
    __ownRebuildStartedAt.delete(repoPath);
  });

  it("EPERM probe: never releases — an unsignalable pid is not a dead one", async () => {
    // Injected probe, so the ESRCH-vs-EPERM rule is exercised on every host
    // (pid-1 tricks go vacuous under root). EPERM means the pid EXISTS and is
    // not signalable; releasing on it hands the store to a competing indexer
    // while a writer provably lives. The watch ends only when the probe says
    // ESRCH — which this test flips to, both to prove the release path and to
    // clean up its own interval.
    let released = false;
    let code: "EPERM" | "ESRCH" = "EPERM";
    releaseWhenWriterExits(12345, undefined, {
      release: () => {
        released = true;
      },
    }, {
      pollMs: 25,
      probe: () => {
        const error: NodeJS.ErrnoException = new Error(code);
        error.code = code;
        throw error;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(released, "EPERM must keep the hold").toBe(false);
    code = "ESRCH";
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = setInterval(() => {
        if (released) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          reject(new Error("ESRCH never released the hold"));
        }
      }, 25);
    });
  });
});
