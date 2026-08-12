import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { failCommand } from "../lib/refusal.js";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import {
  VENDOR_REGISTRY,
  vendorLabel,
  type VendorId,
} from "@muon/protocol";
import type { MuonApiClient } from "../lib/api-client.js";

const execFileAsync = promisify(execFile);

type NativeVendor = VendorId;

type NativeProxyClient = Pick<
  MuonApiClient,
  "listDispatchJobs" | "createTask" | "updateTaskStatus" | "recordEvent"
>;

type NativeProxyDependencies = {
  spawn?: typeof spawn;
  resolveCommand?: (vendor: NativeVendor) => string | undefined;
  changedFiles?: (workspacePath: string) => Promise<string[]>;
};

/**
 * WAVE D: labels and spawn candidates come from the registry.
 *
 * `commandName` stays hand-written and is NOT `commandCandidates[0]`: it is the
 * subcommand a human types (`muon native cursor`), which for Cursor is the
 * product name while the binary MUON spawns is `cursor-agent`. Collapsing the
 * two would be the ADR-0022 §6.7 mistake in reverse — the display name is not
 * the spawnable, and the spawnable is not the display name.
 */
const NATIVE_COMMAND_NAMES: Record<VendorId, string | null> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  // No native proxy subcommand: the lane is read-only recon, and the dev/test
  // double has no binary at all. `null` is a statement.
  opencode: null,
  fake: null,
};

const VENDORS: Record<
  string,
  { commandName: string; label: string; candidates: string[] }
> = Object.fromEntries(
  (Object.entries(NATIVE_COMMAND_NAMES) as [VendorId, string | null][])
    .filter((entry): entry is [VendorId, string] => entry[1] !== null)
    .map(([vendor, commandName]) => [
      vendor,
      {
        commandName,
        label: vendorLabel(vendor),
        candidates: [...VENDOR_REGISTRY[vendor].execution.commandCandidates],
      },
    ])
);

function availableCommand(vendor: NativeVendor): string | undefined {
  const lookup = process.platform === "win32" ? "where" : "which";
  return VENDORS[vendor]?.candidates.find(
    (candidate) =>
      spawnSync(lookup, [candidate], { stdio: "ignore", shell: false }).status ===
      0
  );
}

async function workspaceChangedFiles(workspacePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd: workspacePath,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1_048_576,
        shell: false,
      }
    );
    const entries = stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (path) files.push(path);
      if ((status.startsWith("R") || status.startsWith("C")) && entries[index + 1]) {
        files.push(entries[index + 1]!);
        index += 1;
      }
    }
    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}

function waitForChild(child: ChildProcess): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveChild, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolveChild({ exitCode: code ?? 1, signal });
      }
    });
  });
}

export async function runNativeVendorProxy(
  input: {
    vendor: NativeVendor;
    args: string[];
    workspacePath: string;
  },
  client: NativeProxyClient,
  dependencies: NativeProxyDependencies = {}
): Promise<number> {
  const workspacePath = await realpath(input.workspacePath);
  const active = await client.listDispatchJobs({
    activeOnly: true,
    limit: 100,
  });
  const activeWorkspaces = await Promise.all(
    active.map(async (job) => ({
      job,
      workspacePath: job.workspacePath
        ? await realpath(job.workspacePath).catch(() =>
            resolve(job.workspacePath!)
          )
        : undefined,
    }))
  );
  const conflicting = activeWorkspaces.find(
    (entry) =>
      entry.workspacePath &&
      resolve(entry.workspacePath) === resolve(workspacePath)
  )?.job;
  if (conflicting) {
    throw new Error(
      `A MUON-managed dispatch is active in this workspace (${conflicting.id}). Stop it or wait before starting a human-owned native session.`
    );
  }

  const command =
    dependencies.resolveCommand?.(input.vendor) ??
    (dependencies.resolveCommand ? undefined : availableCommand(input.vendor));
  const vendor = VENDORS[input.vendor];
  if (!vendor) {
    // A registered vendor with no native proxy subcommand (`null` above), or an
    // id MUON has never heard of. Fail closed rather than reaching for another
    // vendor's binary.
    throw new Error(
      `${vendorLabel(input.vendor)} has no native CLI proxy in MUON; choose one of: ${Object.keys(
        VENDORS
      ).join(", ")}.`
    );
  }
  if (!command) {
    throw new Error(
      `${vendor.label} native CLI is not installed. Expected one of: ${vendor.candidates.join(", ")}.`
    );
  }

  const changedFiles = dependencies.changedFiles ?? workspaceChangedFiles;
  const before = await changedFiles(workspacePath);
  const task = await client.createTask({
    title: `Native ${vendor.label} session`,
    description:
      "Human-owned native terminal takeover. MUON records lifecycle and workspace change coordinates, but does not interpret raw terminal output or grant automation authority.",
    priority: "medium",
    workspacePath,
  });
  await client.updateTaskStatus(task.id, "in_progress");
  await client.recordEvent({
    laneId: `native:${input.vendor}`,
    taskId: task.id,
    kind: "task.started",
    message: `human opened native ${vendor.label}`,
    metadata: {
      vendor: input.vendor,
      authority: "human-owned-native",
      structuredAutomation: false,
      rawTerminalCaptured: false,
      workspacePath,
      argvCount: input.args.length,
    },
  });

  process.stderr.write(
    `MUON native takeover · ${vendor.label} · human authority\n` +
      `workspace: ${workspacePath}\n` +
      "Raw terminal output stays in the terminal and is not treated as trusted agent evidence.\n"
  );

  let exitCode = 1;
  let signal: NodeJS.Signals | null = null;
  try {
    const child = (dependencies.spawn ?? spawn)(command, input.args, {
      cwd: workspacePath,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        MUON_NATIVE_TAKEOVER: "1",
        MUON_TASK_ID: task.id,
        MUON_WORKSPACE: workspacePath,
      },
    });
    ({ exitCode, signal } = await waitForChild(child));
  } catch (error) {
    await client.updateTaskStatus(task.id, "blocked");
    await client.recordEvent({
      laneId: `native:${input.vendor}`,
      taskId: task.id,
      kind: "task.blocked",
      message: `native ${vendor.label} failed to launch`,
      metadata: {
        vendor: input.vendor,
        authority: "human-owned-native",
        error:
          error instanceof Error ? error.message.slice(0, 300) : "launch failed",
      },
    });
    throw error;
  }

  const after = await changedFiles(workspacePath);
  const beforeSet = new Set(before);
  const newlyChangedFiles = after.filter((file) => !beforeSet.has(file));
  const succeeded = exitCode === 0 && signal === null;
  // P6: a native takeover is a HUMAN session — MUON records its lifecycle but
  // never interprets its work — so it settles to "review", NOT "done". "done" is
  // gated behind an approved ship/merge review (which a native session never
  // files), so a success used to 409 and STRAND the task in_progress forever
  // while a task.completed event fired (row/ledger disagreement). "review" is
  // ungated and honest: the human's unverified changes are captured and routed
  // into the NORMAL ship-review flow (they run `muon ship` to reach "done") —
  // governance is respected, not bypassed. A failed session still → "blocked".
  const terminalStatus = succeeded ? "review" : "blocked";
  await client.updateTaskStatus(task.id, terminalStatus).catch((error) => {
    // Defensive only: "review"/"blocked" are ungated, so this is a backend
    // hiccup, never the ship gate. The session outcome is still recorded below.
    process.stderr.write(
      `note: tracking task status not updated (${
        error instanceof Error ? error.message : "rejected"
      }); the native session outcome is still recorded.\n`
    );
  });
  await client.recordEvent({
    laneId: `native:${input.vendor}`,
    taskId: task.id,
    kind: succeeded ? "task.completed" : "task.blocked",
    message: succeeded
      ? newlyChangedFiles.length > 0
        ? `human closed native ${vendor.label}; ${newlyChangedFiles.length} file(s) changed — in review`
        : `human closed native ${vendor.label} (no changes)`
      : `native ${vendor.label} exited without completion`,
    metadata: {
      vendor: input.vendor,
      authority: "human-owned-native",
      exitCode,
      signal,
      changedFiles: after,
      newlyChangedFiles,
      preexistingChangedFiles: before,
      rawTerminalCaptured: false,
      reconciliationRequired: after.length > 0,
    },
  });
  return exitCode;
}

export function registerNativeProxyCommands(
  program: Command,
  createClient: () => MuonApiClient,
  dependencies: NativeProxyDependencies = {}
) {
  for (const vendorKey of Object.keys(VENDORS) as NativeVendor[]) {
    const vendor = VENDORS[vendorKey];
    program
      .command(`${vendor.commandName} [vendorArgs...]`)
      .description(
        `Open the native ${vendor.label} CLI under explicit human takeover with MUON lifecycle audit`
      )
      .allowUnknownOption(true)
      .action(async (vendorArgs: string[] = []) => {
        try {
          const exitCode = await runNativeVendorProxy(
            {
              vendor: vendorKey,
              args: vendorArgs,
              workspacePath: process.cwd(),
            },
            createClient(),
            dependencies
          );
          // DELIBERATE passthrough, the one exception to MUON's own exit
          // contract: `muon claude|codex|cursor` IS the vendor session — a
          // thin native takeover, like ssh returning the remote status — and
          // scripts wrapping it want the vendor's real code, ambiguity with
          // MUON's exit 2 included. Every governed MUON verb maps to
          // 0/1/2/3/130 instead.
          process.exitCode = exitCode;
        } catch (error) {
          failCommand(error, `Native ${vendor.label} session failed.`);
        }
      });
  }
}
