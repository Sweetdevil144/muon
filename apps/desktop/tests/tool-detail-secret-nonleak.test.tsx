// @vitest-environment jsdom

/**
 * THE control this whole feature rests on.
 *
 * MUON deliberately stopped being coordinates-only about tool calls: the cards
 * now show what a tool was called with and what it returned. That payload is
 * agent/vendor-authored and routinely contains credentials, so this walks a
 * credential-shaped tool result down the REAL path — adapter-bounded event →
 * @muon/core stream recorder → persisted chunk shape → chat history →
 * transcript projection → tool cards → rendered DOM — and asserts the secret is
 * gone at the end of it, while the KEY that names it survives so a human can
 * still diagnose what was scrubbed.
 *
 * A failing call is used deliberately: a failure card opens itself, so the
 * untrusted body is actually in the rendered markup this test inspects.
 *
 * If someone adds a hop that bypasses `redactedTail`, this is the test that
 * fails.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createStreamRecorder, type StreamChunkRecord } from "@muon/core";
import { ToolCardList } from "../src/renderer/chat-activity.js";
import { buildToolCards } from "../src/renderer/lib/tool-cards.js";
import { emptyHistory, reduceChunks } from "../src/lib/chat-history.js";
import { buildChatTranscript } from "../src/lib/chat-transcript.js";

const SECRETS = [
  "SECRET_ENV_VALUE",
  "SECRET_BEARER_VALUE",
  "SECRET_ARG_VALUE",
] as const;

/** What the vendor tool actually printed, credentials and all. */
const HOSTILE_TOOL_OUTPUT = [
  "$ printenv",
  `MUON_API_TOKEN=${SECRETS[0]}`,
  `Authorization: Bearer ${SECRETS[1]}`,
  "exit 1",
].join("\n");

/**
 * The lane event a session driver emits, already bounded at its source.
 * `@muon/protocol` is deliberately NOT a desktop dependency (see ipc.ts), so the
 * event shape is restated here and the bounded values are written out literally
 * — the adapter-side bounding has its own tests in packages/adapters.
 */
function toolEvent(
  message: string,
  phase: string,
  detail: Record<string, unknown>
) {
  return {
    id: `event-${phase}`,
    laneId: "muon-chat",
    taskId: "chat-1",
    kind: (phase === "failed" ? "task.blocked" : "task.progress") as const,
    message,
    timestamp: "2026-07-25T00:00:00.000Z",
    metadata: {
      controlPlane: true,
      toolActivity: { provider: "claude-code", phase, tool: "Bash", detail },
    },
  };
}

async function recordThroughCore(): Promise<StreamChunkRecord[]> {
  const recorded: StreamChunkRecord[] = [];
  const recorder = createStreamRecorder({
    sink: {
      recordStreamChunks: async (chunks) => {
        recorded.push(...chunks);
        return { recorded: chunks.length };
      },
    },
  });

  recorder.handle(
    toolEvent("Bash started", "started", {
      args: `command: printenv MUON_API_TOKEN=${SECRETS[2]}`,
      argsTruncated: false,
    })
  );
  recorder.handle(
    toolEvent("Bash failed", "failed", {
      result: HOSTILE_TOOL_OUTPUT,
      resultTruncated: false,
    })
  );
  await recorder.flush();
  return recorded;
}

describe("captured tool detail never carries a credential to the renderer", () => {
  it("scrubs the secret at the ledger boundary and all the way into the DOM", async () => {
    const chunks = await recordThroughCore();

    // 1) The recorder is THE redaction boundary: nothing durable holds it.
    const durable = JSON.stringify(chunks);
    for (const secret of SECRETS) {
      expect(durable).not.toContain(secret);
    }

    // 2) Read back exactly as the stream route serves persisted chunks.
    const history = reduceChunks(
      emptyHistory(),
      chunks.map((chunk, index) => ({
        seq: index + 1,
        kind: chunk.kind,
        content: chunk.content,
        laneId: chunk.laneId,
        timestamp: chunk.timestamp,
        ...(chunk.detail ? { detail: chunk.detail } : {}),
      }))
    );

    // 3) Transcript projection → tool cards → rendered DOM.
    const transcript = buildChatTranscript({
      history: [
        { role: "user", text: "print the env", seq: 0 },
        ...history.messages,
      ],
      live: [],
      running: false,
    });
    const work = transcript.find((item) => item.kind === "work");
    if (work?.kind !== "work") throw new Error("no work turn projected");
    const cards = buildToolCards(work.activities);
    const html = renderToStaticMarkup(<ToolCardList cards={cards} />);

    for (const secret of SECRETS) {
      expect(html).not.toContain(secret);
    }

    // The card DID capture the call — this is not passing by capturing nothing.
    expect(cards).toHaveLength(1);
    expect(cards[0]?.status).toBe("failed");
    expect(cards[0]?.args).toContain("MUON_API_TOKEN");
    expect(cards[0]?.output).toContain("[redacted]");
    // …and the untrusted body really is rendered (a failure opens itself),
    // with the key that names the secret intact so it stays diagnosable.
    expect(html).toContain("Tool activity · untrusted");
    expect(html).toContain("MUON_API_TOKEN");
    expect(html).toContain("[redacted]");
  });
});
