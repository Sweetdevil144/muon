import { z } from "zod";
import type {
  ContextCondensationRecord,
  ContextFrameRecord,
  RecordedEvent,
  StreamChunk,
} from "./types.js";

export const TRAJECTORY_SCHEMA_VERSION = 2 as const;
export const TRAJECTORY_CONTEXT_GUARANTEE = "muon-recorded-only" as const;

const trajectoryScopeSchema = z.object({
  kind: z.literal("task"),
  taskId: z.string().min(1),
  title: z.string().optional(),
  status: z.string().optional(),
});

const trajectoryEventSchema = z.object({
  id: z.string().min(1),
  laneId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.string().min(1),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string().min(1),
  principalId: z.string().nullable().optional(),
  principalKind: z.string().nullable().optional(),
  accountablePrincipalId: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  payloadDiff: z.unknown().optional(),
});

const trajectoryChunkSchema = z.object({
  seq: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  laneId: z.string().min(1),
  agentId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  kind: z.string().min(1),
  content: z.string(),
  detail: z
    .object({
      args: z.string().optional(),
      argsTruncated: z.boolean().optional(),
      result: z.string().optional(),
      resultTruncated: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  timestamp: z.string().min(1),
});

const contextExposureSchema = z.object({
  id: z.string().min(1),
  frameId: z.string().min(1),
  artifactKind: z.string().min(1),
  artifactId: z.string().min(1),
  eligible: z.boolean(),
  included: z.boolean(),
  reason: z.string().min(1),
  ordinal: z.number().int().nullable().optional(),
  charCount: z.number().int().nullable().optional(),
  trustTier: z.string().nullable().optional(),
  createdAt: z.string().min(1),
});

const contextDeliverySchema = z.object({
  id: z.string().min(1),
  frameId: z.string().min(1),
  status: z.enum(["delivered", "failed"]),
  sessionId: z.string().nullable().optional(),
  vendorSessionId: z.string().nullable().optional(),
  failure: z.string().nullable().optional(),
  createdAt: z.string().min(1),
});

const trajectoryContextFrameSchema = z.object({
  id: z.string().min(1),
  clientRequestId: z.string().min(1),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  laneId: z.string().min(1),
  workspacePath: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  missionId: z.string().min(1),
  turnSeq: z.number().int().positive(),
  source: z.string().min(1),
  completeness: z.string().min(1),
  content: z.string(),
  contentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  charCount: z.number().int().nonnegative(),
  tokenEstimate: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  exposures: z.array(contextExposureSchema),
  delivery: contextDeliverySchema.nullable(),
});

const condensationMemberSchema = z.object({
  id: z.string().min(1),
  condensationId: z.string().min(1),
  artifactKind: z.string().min(1),
  artifactId: z.string().min(1),
  createdAt: z.string().min(1),
});

const trajectoryCondensationSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  taskId: z.string().min(1),
  inputFrameId: z.string().nullable().optional(),
  outputFrameId: z.string().nullable().optional(),
  origin: z.enum(["muon", "vendor_reported"]),
  sourceResponseId: z.string().min(1),
  summary: z.string().nullable().optional(),
  summaryOffset: z.number().int().nullable().optional(),
  createdAt: z.string().min(1),
  members: z.array(condensationMemberSchema),
});

const trajectoryPayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  scope: trajectoryScopeSchema,
  completeness: z.object({
    events: z.literal("complete"),
    streams: z.enum(["complete", "truncated"]),
    context: z.literal(TRAJECTORY_CONTEXT_GUARANTEE),
  }),
  events: z.array(trajectoryEventSchema),
  chunks: z.array(trajectoryChunkSchema),
});

export const trajectoryPayloadSchema = z.object({
  schemaVersion: z.literal(TRAJECTORY_SCHEMA_VERSION),
  scope: trajectoryScopeSchema,
  completeness: z.object({
    events: z.literal("complete"),
    streams: z.enum(["complete", "truncated"]),
    context: z.literal(TRAJECTORY_CONTEXT_GUARANTEE),
    contextEvidence: z.enum(["complete", "truncated"]),
  }),
  events: z.array(trajectoryEventSchema),
  chunks: z.array(trajectoryChunkSchema),
  contextFrames: z.array(trajectoryContextFrameSchema),
  contextCondensations: z.array(trajectoryCondensationSchema),
});

const bundleEnvelopeSchema = {
  exportedAt: z.string().min(1),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const trajectoryBundleV1Schema = trajectoryPayloadV1Schema.extend(
  bundleEnvelopeSchema
);
export const trajectoryBundleSchema = trajectoryPayloadSchema.extend(
  bundleEnvelopeSchema
);
const anyTrajectoryPayloadSchema = z.discriminatedUnion("schemaVersion", [
  trajectoryPayloadV1Schema,
  trajectoryPayloadSchema,
]);
const anyTrajectoryBundleSchema = z.discriminatedUnion("schemaVersion", [
  trajectoryBundleV1Schema,
  trajectoryBundleSchema,
]);

export type TrajectoryPayload = z.infer<typeof trajectoryPayloadSchema>;
export type TrajectoryBundle = z.infer<typeof anyTrajectoryBundleSchema>;
type TrajectoryContextFrame = z.infer<typeof trajectoryContextFrameSchema>;
type TrajectoryCondensation = z.infer<typeof trajectoryCondensationSchema>;

export type TrajectoryReplayStep =
  | {
      recordClass: "system-recorded";
      stableId: string;
      timestamp: string;
      kind: string;
      event: TrajectoryBundle["events"][number];
    }
  | {
      recordClass: "context-window-recorded";
      stableId: string;
      timestamp: string;
      kind: string;
      chunk: TrajectoryBundle["chunks"][number];
    }
  | {
      recordClass: "context-delivery";
      stableId: string;
      timestamp: string;
      kind: string;
      frame: TrajectoryContextFrame;
    }
  | {
      recordClass: "context-condensation";
      stableId: string;
      timestamp: string;
      kind: string;
      condensation: TrajectoryCondensation;
    };

export type TrajectoryReplay = {
  scope: TrajectoryBundle["scope"];
  completeness: TrajectoryBundle["completeness"];
  timeline: TrajectoryReplayStep[];
  systemEvents: number;
  contextWindowChunks: number;
  contextFrames: number;
  deliveredFrames: number;
  failedFrames: number;
  queuedFrames: number;
  contextCondensations: number;
  vendorKnowledgeGaps: number;
  muonCondensations: number;
  principalStampedEvents: number;
  payloadDiffEvents: number;
  firstRecordedAt?: string;
  lastRecordedAt?: string;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function utf8ContainsAt(content: string, expected: string, offset: number) {
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content);
  const expectedBytes = encoder.encode(expected);
  if (offset + expectedBytes.length > contentBytes.length) return false;
  return expectedBytes.every(
    (byte, index) => contentBytes[offset + index] === byte
  );
}

/** Recursively sort object keys while preserving array order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function createTrajectoryPayload(input: {
  taskId: string;
  title?: string;
  status?: string;
  events: readonly RecordedEvent[];
  chunks: readonly StreamChunk[];
  contextFrames?: readonly ContextFrameRecord[];
  contextCondensations?: readonly ContextCondensationRecord[];
  streamsComplete?: boolean;
  contextComplete?: boolean;
}): TrajectoryPayload {
  const events = [...input.events].sort(
    (a, b) => compareText(a.timestamp, b.timestamp) || compareText(a.id, b.id)
  );
  const chunks = [...input.chunks].sort(
    (a, b) => a.seq - b.seq || compareText(a.timestamp, b.timestamp)
  );
  const contextFrames = [...(input.contextFrames ?? [])].sort(
    (a, b) =>
      compareText(a.createdAt, b.createdAt) ||
      compareText(a.jobId, b.jobId) ||
      a.turnSeq - b.turnSeq ||
      compareText(a.id, b.id)
  );
  const contextCondensations = [...(input.contextCondensations ?? [])].sort(
    (a, b) =>
      compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id)
  );
  return trajectoryPayloadSchema.parse({
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    scope: {
      kind: "task",
      taskId: input.taskId,
      ...(input.title ? { title: input.title } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    completeness: {
      events: "complete",
      streams: input.streamsComplete === false ? "truncated" : "complete",
      context: TRAJECTORY_CONTEXT_GUARANTEE,
      contextEvidence:
        input.contextComplete === false ? "truncated" : "complete",
    },
    events,
    chunks,
    contextFrames,
    contextCondensations,
  });
}

/** Export timestamp and digest are envelopes, not part of the content hash. */
export function trajectoryDigestInput(
  input: TrajectoryPayload | TrajectoryBundle
): string {
  return canonicalJson(anyTrajectoryPayloadSchema.parse(input));
}

export function parseTrajectoryBundle(input: unknown): TrajectoryBundle {
  const bundle = anyTrajectoryBundleSchema.parse(input);
  const foreignEvent = bundle.events.find(
    (event) => event.taskId !== bundle.scope.taskId
  );
  const foreignChunk = bundle.chunks.find(
    (chunk) => chunk.taskId !== bundle.scope.taskId
  );
  if (foreignEvent || foreignChunk) {
    throw new Error("Trajectory contains a record outside its declared task scope.");
  }
  if (new Set(bundle.events.map((event) => event.id)).size !== bundle.events.length) {
    throw new Error("Trajectory contains duplicate event identifiers.");
  }
  if (new Set(bundle.chunks.map((chunk) => chunk.seq)).size !== bundle.chunks.length) {
    throw new Error("Trajectory contains duplicate stream sequence numbers.");
  }
  if (bundle.schemaVersion === 2) {
    if (
      bundle.contextFrames.some((frame) => frame.taskId !== bundle.scope.taskId) ||
      bundle.contextCondensations.some(
        (condensation) => condensation.taskId !== bundle.scope.taskId
      )
    ) {
      throw new Error("Trajectory contains context evidence outside its declared task scope.");
    }
    if (
      new Set(bundle.contextFrames.map((frame) => frame.id)).size !==
      bundle.contextFrames.length
    ) {
      throw new Error("Trajectory contains duplicate context frame identifiers.");
    }
    if (
      new Set(bundle.contextCondensations.map((row) => row.id)).size !==
      bundle.contextCondensations.length
    ) {
      throw new Error("Trajectory contains duplicate condensation identifiers.");
    }
    for (const frame of bundle.contextFrames) {
      if (
        frame.exposures.some((row) => row.frameId !== frame.id) ||
        (frame.delivery !== null && frame.delivery.frameId !== frame.id)
      ) {
        throw new Error("Trajectory context child evidence does not match its frame.");
      }
    }
    for (const condensation of bundle.contextCondensations) {
      if (
        condensation.members.some(
          (member) => member.condensationId !== condensation.id
        )
      ) {
        throw new Error("Trajectory condensation members do not match their parent.");
      }
      if (condensation.origin === "vendor_reported") {
        if (condensation.summary != null || condensation.members.length > 0) {
          throw new Error(
            "Trajectory invents undisclosed vendor condensation content."
          );
        }
        continue;
      }
      const inputFrame = bundle.contextFrames.find(
        (frame) => frame.id === condensation.inputFrameId
      );
      const outputFrame = bundle.contextFrames.find(
        (frame) => frame.id === condensation.outputFrameId
      );
      if (
        !inputFrame ||
        !outputFrame ||
        inputFrame.id === outputFrame.id ||
        inputFrame.jobId !== condensation.jobId ||
        outputFrame.jobId !== condensation.jobId ||
        condensation.summary == null ||
        condensation.summaryOffset == null ||
        condensation.members.length === 0 ||
        !utf8ContainsAt(
          outputFrame.content,
          condensation.summary,
          condensation.summaryOffset
        )
      ) {
        throw new Error(
          "Trajectory contains a MUON condensation that cannot replay its exact output summary."
        );
      }
    }
  }
  return bundle;
}

/** Deterministically fold immutable ledgers; never reconstruct vendor-hidden context. */
export function replayTrajectory(
  input: TrajectoryBundle,
  onStep?: (step: TrajectoryReplayStep) => void
): TrajectoryReplay {
  const bundle = parseTrajectoryBundle(input);
  const contextFrames =
    bundle.schemaVersion === 2 ? bundle.contextFrames : [];
  const condensations =
    bundle.schemaVersion === 2 ? bundle.contextCondensations : [];
  const timeline: TrajectoryReplayStep[] = [
    ...bundle.events.map(
      (event): TrajectoryReplayStep => ({
        recordClass: "system-recorded",
        stableId: `event:${event.id}`,
        timestamp: event.timestamp,
        kind: event.kind,
        event,
      })
    ),
    ...bundle.chunks.map(
      (chunk): TrajectoryReplayStep => ({
        recordClass: "context-window-recorded",
        stableId: `chunk:${String(chunk.seq).padStart(12, "0")}`,
        timestamp: chunk.timestamp,
        kind: chunk.kind,
        chunk,
      })
    ),
    ...contextFrames.map(
      (frame): TrajectoryReplayStep => ({
        recordClass: "context-delivery",
        stableId: `context-frame:${frame.id}`,
        timestamp: frame.delivery?.createdAt ?? frame.createdAt,
        kind: `context.${frame.source}.${frame.delivery?.status ?? "queued"}`,
        frame,
      })
    ),
    ...condensations.map(
      (condensation): TrajectoryReplayStep => ({
        recordClass: "context-condensation",
        stableId: `context-condensation:${condensation.id}`,
        timestamp: condensation.createdAt,
        kind: `context.condensation.${condensation.origin}`,
        condensation,
      })
    ),
  ].sort(
    (a, b) =>
      compareText(a.timestamp, b.timestamp) || compareText(a.stableId, b.stableId)
  );
  for (const step of timeline) onStep?.(step);
  return {
    scope: bundle.scope,
    completeness: bundle.completeness,
    timeline,
    systemEvents: bundle.events.length,
    contextWindowChunks: bundle.chunks.length,
    contextFrames: contextFrames.length,
    deliveredFrames: contextFrames.filter(
      (frame) => frame.delivery?.status === "delivered"
    ).length,
    failedFrames: contextFrames.filter(
      (frame) => frame.delivery?.status === "failed"
    ).length,
    queuedFrames: contextFrames.filter((frame) => frame.delivery === null).length,
    contextCondensations: condensations.length,
    vendorKnowledgeGaps: condensations.filter(
      (row) => row.origin === "vendor_reported"
    ).length,
    muonCondensations: condensations.filter((row) => row.origin === "muon").length,
    principalStampedEvents: bundle.events.filter(
      (event) => event.principalId != null
    ).length,
    payloadDiffEvents: bundle.events.filter(
      (event) => event.payloadDiff != null
    ).length,
    ...(timeline[0] ? { firstRecordedAt: timeline[0].timestamp } : {}),
    ...(timeline.at(-1)
      ? { lastRecordedAt: timeline.at(-1)!.timestamp }
      : {}),
  };
}
