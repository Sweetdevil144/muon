import type { MuonApiClient } from "@muon/client";
import { requireActiveRendererChat } from "./renderer-chat-scope.js";

type RendererWorkflowClient = Pick<
  MuonApiClient,
  "getChat" | "getWorkflowRun"
>;

/**
 * Resolve a workflow run for a renderer mutation only when it belongs to the
 * selected chat. Operator CLI/API callers remain able to address runs directly;
 * this is the desktop renderer boundary.
 */
export async function requireRendererWorkflowRun(
  client: RendererWorkflowClient,
  chatId: string | null,
  runId: string
) {
  await requireActiveRendererChat(client, chatId);
  const detail = await client.getWorkflowRun(runId);
  if (detail.run.chatId !== chatId) {
    throw new Error("That workflow does not belong to the selected chat.");
  }
  return detail.run;
}
