import { createHash } from "node:crypto";
import { failCommand } from "../lib/refusal.js";
import { readFile, writeFile } from "node:fs/promises";
import {
  createTrajectoryPayload,
  parseTrajectoryBundle,
  replayTrajectory,
  trajectoryDigestInput,
  type TrajectoryBundle,
  type TrajectoryReplay,
} from "@muon/client";
import type { Command } from "commander";
import { MuonApiClient } from "../lib/api-client.js";
import { printJson } from "../lib/output.js";

const TRAJECTORY_PAGE = 1_000;
const DEFAULT_MAX_CHUNKS = 50_000;
const MAX_MAX_CHUNKS = 250_000;
const CONTEXT_PAGE = 500;
const DISPATCH_JOB_EXPORT_LIMIT = 200;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function parseMaxChunks(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_CHUNKS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_MAX_CHUNKS
  ) {
    throw new Error(
      `--max-chunks must be an integer from 1 to ${MAX_MAX_CHUNKS}.`
    );
  }
  return value;
}

async function collectTaskChunks(
  client: MuonApiClient,
  taskId: string,
  maxChunks: number
) {
  const chunks = [];
  let afterSeq = 0;
  let complete = false;
  while (chunks.length < maxChunks) {
    const limit = Math.min(TRAJECTORY_PAGE, maxChunks - chunks.length);
    const page = await client.listStreamChunks({ taskId, afterSeq, limit });
    if (page.length === 0) {
      complete = true;
      break;
    }
    const fresh = page.filter((chunk) => chunk.seq > afterSeq);
    if (fresh.length === 0) {
      throw new Error(
        "Stream pagination did not advance; trajectory save refused an ambiguous replay."
      );
    }
    chunks.push(...fresh);
    afterSeq = fresh.at(-1)!.seq;
    if (page.length < limit) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    const probe = await client.listStreamChunks({
      taskId,
      afterSeq,
      limit: 1,
    });
    complete = probe.length === 0;
  }
  return { chunks, complete };
}

async function collectTaskContext(client: MuonApiClient, taskId: string) {
  const jobs = await client.listDispatchJobs({
    taskId,
    limit: DISPATCH_JOB_EXPORT_LIMIT,
  });
  const complete = jobs.length < DISPATCH_JOB_EXPORT_LIMIT;
  const frames = [];
  const condensations = new Map<string, Awaited<ReturnType<MuonApiClient["listJobContext"]>>["condensations"][number]>();
  for (const job of jobs) {
    let afterTurn = 0;
    let afterCondensation: string | undefined;
    while (true) {
      const page = await client.listJobContext(job.id, {
        afterTurn,
        limit: CONTEXT_PAGE,
        condensationLimit: CONTEXT_PAGE,
        ...(afterCondensation ? { afterCondensation } : {}),
      });
      frames.push(...page.frames);
      for (const condensation of page.condensations) {
        condensations.set(condensation.id, condensation);
      }
      const framesComplete = page.frames.length < CONTEXT_PAGE;
      if (page.frames.length > 0) {
        const nextTurn = page.frames.at(-1)!.turnSeq;
        if (nextTurn <= afterTurn) {
          throw new Error(
            "Context pagination did not advance; trajectory save refused an ambiguous replay."
          );
        }
        afterTurn = nextTurn;
      }
      if (page.condensations.length > 0) {
        afterCondensation = page.condensations.at(-1)!.id;
      }
      if (framesComplete && !page.condensationsTruncated) break;
    }
  }
  return {
    frames,
    condensations: [...condensations.values()],
    complete,
  };
}

export async function collectTaskTrajectory(input: {
  client: MuonApiClient;
  taskId: string;
  maxChunks?: number;
  exportedAt?: string;
}): Promise<Extract<TrajectoryBundle, { schemaVersion: 2 }>> {
  const [task, events, stream, context] = await Promise.all([
    input.client.getTaskDetail(input.taskId),
    input.client.listTaskEvents(input.taskId),
    collectTaskChunks(
      input.client,
      input.taskId,
      input.maxChunks ?? DEFAULT_MAX_CHUNKS
    ),
    collectTaskContext(input.client, input.taskId),
  ]);
  const payload = createTrajectoryPayload({
    taskId: input.taskId,
    title: task.title,
    status: task.status,
    events,
    chunks: stream.chunks,
    contextFrames: context.frames,
    contextCondensations: context.condensations,
    streamsComplete: stream.complete,
    contextComplete: context.complete,
  });
  return {
    ...payload,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    contentSha256: sha256(trajectoryDigestInput(payload)),
  };
}

export function verifyAndReplayTrajectory(
  raw: unknown,
  expectedEventKinds: readonly string[] = []
): { bundle: TrajectoryBundle; replay: TrajectoryReplay } {
  const bundle = parseTrajectoryBundle(raw);
  const actual = sha256(trajectoryDigestInput(bundle));
  if (actual !== bundle.contentSha256) {
    throw new Error(
      `Trajectory digest mismatch: expected ${bundle.contentSha256}, measured ${actual}.`
    );
  }
  const replay = replayTrajectory(bundle);
  const kinds = new Set(bundle.events.map((event) => event.kind));
  const missing = expectedEventKinds.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    throw new Error(
      `Trajectory replay is missing expected system event kind(s): ${missing.join(", ")}.`
    );
  }
  return { bundle, replay };
}

export function registerTrajectoryCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const trajectory = program
    .command("trajectory")
    .description("Save and deterministically replay MUON-recorded governance evidence");

  trajectory
    .command("save")
    .description("Save one task's complete event ledger and bounded stream history")
    .requiredOption("--task-id <id>", "Task identifier")
    .requiredOption(
      "--output <path>",
      "New JSON file to create, or - for stdout (existing files are refused)"
    )
    .option(
      "--max-chunks <n>",
      `Maximum stream chunks to include (default ${DEFAULT_MAX_CHUNKS})`
    )
    .action(
      async (options: {
        taskId: string;
        output: string;
        maxChunks?: string;
      }) => {
        try {
          const bundle = await collectTaskTrajectory({
            client: createClient(),
            taskId: options.taskId,
            maxChunks: parseMaxChunks(options.maxChunks),
          });
          const body = `${JSON.stringify(bundle, null, 2)}\n`;
          if (options.output === "-") {
            process.stdout.write(body);
            return;
          }
          await writeFile(options.output, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
          process.stdout.write(
            `saved ${bundle.events.length} events, ${bundle.chunks.length} stream chunks, and ${bundle.contextFrames.length} context frames to ${options.output} (${bundle.completeness.streams} streams, ${bundle.completeness.contextEvidence} context evidence)\n`
          );
        } catch (error) {
          failCommand(error, "Trajectory save failed.");
        }
      }
    );

  trajectory
    .command("replay")
    .description("Verify a trajectory digest and fold its immutable ledgers")
    .requiredOption("--file <path>", "Trajectory JSON file")
    .option(
      "--expect-event <kind...>",
      "Fail unless every named system event kind was recorded"
    )
    .option("--json", "Print the replay summary as JSON")
    .action(
      async (options: {
        file: string;
        expectEvent?: string[];
        json?: boolean;
      }) => {
        try {
          const raw = JSON.parse(await readFile(options.file, "utf8")) as unknown;
          const { bundle, replay } = verifyAndReplayTrajectory(
            raw,
            options.expectEvent ?? []
          );
          if (options.json) {
            printJson({
              verified: true,
              contentSha256: bundle.contentSha256,
              replay,
            });
            return;
          }
          process.stdout.write(
            `trajectory verified ${bundle.contentSha256}\n` +
              `${replay.systemEvents} system events · ${replay.contextWindowChunks} recorded context-window chunks · ${replay.principalStampedEvents} principal-stamped · ${replay.payloadDiffEvents} with payload diffs\n` +
              `${replay.contextFrames} MUON-supplied context frames (${replay.deliveredFrames} delivered, ${replay.failedFrames} failed, ${replay.queuedFrames} outcome unknown) · ${replay.contextCondensations} condensations (${replay.vendorKnowledgeGaps} vendor knowledge gaps)\n` +
              `context guarantee: ${replay.completeness.context}; vendor-hidden context is not reconstructed\n`
          );
        } catch (error) {
          failCommand(error, "Trajectory replay failed.");
        }
      }
    );
}
