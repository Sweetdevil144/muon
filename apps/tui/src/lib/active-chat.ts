import type { MuonApiClient } from "@muon/client";

/**
 * THE workspace-chat resolution, shared (review finding: the shell entry
 * re-derived the classic desk's inline rule, and two independently
 * maintained selections drift). One active chat per workspace path,
 * exactly the rule the classic desk always applied; null = this workspace
 * has never had a chat, which callers state rather than treat as an error.
 */
export async function resolveActiveChat(
  client: Pick<MuonApiClient, "listChats">,
  workspacePath: string
): Promise<{ id: string } | null> {
  const chats = await client.listChats({ status: "active" });
  return chats.find((chat) => chat.workspacePath === workspacePath) ?? null;
}
