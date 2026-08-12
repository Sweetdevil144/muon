import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  TOOL_ACTIVITY_ARGS_CHARS,
  TOOL_ACTIVITY_RESULT_CHARS,
} from "@muon/protocol";

const prismaMock = vi.hoisted(() => ({
  streamChunk: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  orchestratorChat: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

/** The `data` array the route handed `createMany` for the last POST. */
function writtenChunks(): Array<Record<string, unknown>> {
  const call = prismaMock.streamChunk.createMany.mock.calls.at(-1);
  return (call?.[0] as { data: Array<Record<string, unknown>> }).data;
}

async function post(chunk: Record<string, unknown>) {
  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/streams",
    payload: { chunks: [{ taskId: "task-1", laneId: "lane-cx", ...chunk }] },
  });
  await app.close();
  return response;
}

describe("stream chunk tool detail (0036)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.streamChunk.createMany.mockResolvedValue({ count: 1 });
  });

  it("persists a bounded detail alongside the activity line", async () => {
    const response = await post({
      kind: "activity",
      content: "Bash completed",
      detail: { result: "PASS 12 tests", resultTruncated: false },
    });

    expect(response.statusCode).toBe(201);
    expect(writtenChunks()[0]!.detail).toEqual({
      result: "PASS 12 tests",
      resultTruncated: false,
    });
  });

  it("RE-SCRUBS a credential an agent-tier poster failed to redact", async () => {
    const response = await post({
      kind: "activity",
      content: "Bash completed",
      detail: {
        args: "env MUON_API_TOKEN=SECRET_ARG_VALUE",
        result: "Authorization: Bearer SECRET_BEARER_VALUE",
      },
    });

    expect(response.statusCode).toBe(201);
    const stored = JSON.stringify(writtenChunks()[0]!.detail);
    expect(stored).not.toContain("SECRET_ARG_VALUE");
    expect(stored).not.toContain("SECRET_BEARER_VALUE");
    expect(stored).toContain("[redacted]");
  });

  it("REFUSES an over-limit detail instead of storing it", async () => {
    const response = await post({
      kind: "activity",
      content: "Bash completed",
      detail: { result: "z".repeat(TOOL_ACTIVITY_RESULT_CHARS + 2) },
    });

    expect(response.statusCode).toBe(400);
    expect(prismaMock.streamChunk.createMany).not.toHaveBeenCalled();
  });

  it("accepts a detail exactly at the bound the adapter emits", async () => {
    const response = await post({
      kind: "activity",
      content: "Bash completed",
      detail: {
        args: "a".repeat(TOOL_ACTIVITY_ARGS_CHARS),
        result: "b".repeat(TOOL_ACTIVITY_RESULT_CHARS),
      },
    });

    expect(response.statusCode).toBe(201);
  });

  it("writes no detail key at all when the poster sends none", async () => {
    const response = await post({ kind: "activity", content: "Bash started" });

    expect(response.statusCode).toBe(201);
    expect(writtenChunks()[0]).not.toHaveProperty("detail");
  });

  it("serves detail on read, and a pre-0036 NULL row exactly as before", async () => {
    prismaMock.streamChunk.findMany.mockResolvedValue([
      {
        seq: 1,
        taskId: "task-1",
        laneId: "lane-cx",
        sessionId: null,
        runId: null,
        kind: "activity",
        content: "Bash completed",
        detail: { result: "PASS 12 tests" },
        timestamp: new Date("2026-07-25T00:00:00.000Z"),
      },
      {
        seq: 2,
        taskId: "task-1",
        laneId: "lane-cx",
        sessionId: null,
        runId: null,
        kind: "activity",
        content: "Read completed",
        detail: null,
        timestamp: new Date("2026-07-25T00:00:01.000Z"),
      },
    ]);
    const app = buildApp();

    const read = await app.inject({
      method: "GET",
      url: "/api/streams?taskId=task-1",
    });

    expect(read.statusCode).toBe(200);
    const chunks = read.json().chunks as Array<Record<string, unknown>>;
    expect(chunks[0]!.detail).toEqual({ result: "PASS 12 tests" });
    expect(chunks[1]!.detail).toBeNull();
    await app.close();
  });
});
