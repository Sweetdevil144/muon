import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  boundStreamChunkContent,
  STREAM_MESSAGE_CONTENT_CHARS,
} from "@muon/protocol";

// ── THE WRITE SIDE OF A REPORT-SIZED CHUNK ───────────────────────────────────
//
// The founder's coordinator summary (5 431 characters) and a child's final
// report (4 910) were both stored as exactly 4 000 characters, cut mid-word by
// the recorder. The recorder now bounds by class; this file pins that the ROUTE
// accepts what the recorder legitimately produces, and refuses — loudly, not by
// trimming — anything past the bound it publishes.

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

function writtenChunks(): Array<Record<string, unknown>> {
  const call = prismaMock.streamChunk.createMany.mock.calls.at(-1);
  return (call?.[0] as { data: Array<Record<string, unknown>> }).data;
}

async function post(chunk: Record<string, unknown>) {
  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/streams",
    payload: { chunks: [{ taskId: "task-1", laneId: "codex", ...chunk }] },
  });
  await app.close();
  return response;
}

describe("stream chunk content bound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.streamChunk.createMany.mockResolvedValue({ count: 1 });
  });

  it("stores a 50 KB final report byte-for-byte", async () => {
    const report = `${"x".repeat(50_000)}\n\nNEXT ACTION: land the change`;

    const response = await post({ kind: "output.message", content: report });

    expect(response.statusCode).toBe(201);
    expect(writtenChunks()[0]!.content).toBe(report);
  });

  it("stores what the recorder produces for an absurd message, marker and all", async () => {
    const { content } = boundStreamChunkContent(
      "z".repeat(5_000_000),
      STREAM_MESSAGE_CONTENT_CHARS
    );

    const response = await post({ kind: "output.message", content });

    expect(response.statusCode).toBe(201);
    expect(writtenChunks()[0]!.content).toBe(content);
    expect(writtenChunks()[0]!.content).toContain("[muon:truncated]");
  });

  it("REJECTS an over-bound poster instead of silently trimming it", async () => {
    // Rejection, not truncation: a writer that is over the limit learns it is
    // over the limit. Storing a quietly shortened copy is how a durable record
    // starts lying about what an agent said.
    const response = await post({
      kind: "output.message",
      content: "y".repeat(STREAM_MESSAGE_CONTENT_CHARS + 1),
    });

    expect(response.statusCode).toBe(400);
    expect(prismaMock.streamChunk.createMany).not.toHaveBeenCalled();
  });
});
