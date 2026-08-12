import type { DispatchJobRecord, MuonApiClient } from "@muon/client";
import { parseChatTerminalScope } from "./terminal-session-id.js";

type ChatReader = Pick<MuonApiClient, "getChat">;
type JobReader = Pick<MuonApiClient, "getChat" | "getDispatchJob">;
type TaskReader = Pick<MuonApiClient, "getChat" | "listDispatchJobs">;

/**
 * The shape a record id may have when it arrives from the RENDERER: the
 * charset the brain's own ids use (cuid) plus the separators MUON's synthetic
 * ids carry, bounded in length. Nothing here is a path or a URL, so `/`, `%`,
 * `?`, and whitespace have no business in one.
 */
const RENDERER_RECORD_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Bound a renderer-supplied record id AT THE IPC BOUNDARY, before it reaches a
 * client method that will interpolate it into a request path.
 *
 * The renderer is untrusted (prompt injection reaches it through repo files
 * the agents render), and "typed as string" is a compile-time claim about our
 * own code, not a run-time fact about what crossed the bridge. The client
 * escapes the id at the call site too — this is the other half of that pair,
 * and it is the half that keeps a malformed id from being *asked about* at
 * all.
 */
export function requireRendererRecordId(
  id: unknown,
  what: string
): string {
  if (typeof id !== "string" || !RENDERER_RECORD_ID.test(id)) {
    throw new Error(`That ${what} is not a shape MUON issues.`);
  }
  return id;
}

export function requireSelectedRendererChat(
  selectedChatId: string | null,
  requestedChatId: string
): string {
  if (!selectedChatId || requestedChatId !== selectedChatId) {
    throw new Error("That action is outside the selected chat.");
  }
  return selectedChatId;
}

/**
 * Resolve the attach coordinate at the untrusted renderer boundary. A
 * renderer may ask to reuse only the chat main has currently selected; it may
 * never supply a filesystem path. The workspace always comes from main's
 * bound state (or the host-owned fresh-install fallback).
 */
export function resolveRendererMcpAttachScope(
  selectedChatId: string | null,
  boundWorkspace: string | null,
  fallbackWorkspace: string,
  input: { chatId?: unknown }
): { chatId?: string; workspacePath: string } {
  const workspacePath = boundWorkspace || fallbackWorkspace;
  if (input.chatId !== undefined) {
    const requested = requireRendererRecordId(input.chatId, "chat");
    return {
      chatId: requireSelectedRendererChat(selectedChatId, requested),
      workspacePath,
    };
  }
  return selectedChatId
    ? { chatId: selectedChatId, workspacePath }
    : { workspacePath };
}

export async function requireActiveRendererChat(
  client: ChatReader,
  chatId: string | null
) {
  if (!chatId) {
    throw new Error("Select a chat before using this surface.");
  }
  const chat = await client.getChat(chatId);
  if (chat.status === "archived") {
    throw new Error("The selected chat is archived.");
  }
  return chat;
}

/**
 * Authorize the renderer's ARCHIVE of a chat — the one destructive chat-level
 * act that is NOT scoped to the selected chat, and why.
 *
 * `muon:archiveChat` sits among handlers that nearly all call
 * `requireSelectedRendererChat`, and it does not. That asymmetry was
 * undocumented, which made it read as an omission; it is not one that can
 * simply be corrected. Every row in the sidebar carries its own archive
 * control (`sidebar.tsx` renders `onArchive` per ChatRow, and app.tsx's
 * `onArchiveChat` explicitly handles `wasActive === false`), so requiring
 * selection would break archiving a chat you have not opened — a normal act on
 * a list. Rename, by contrast, IS selection-scoped because it is only reachable
 * from the selected chat's own header.
 *
 * So this states what CAN be required, positively:
 *  - the id is a shape MUON issues (it is interpolated into a request path
 *    downstream, and "typed as string" is a compile-time claim, not a run-time
 *    fact about what crossed the bridge), and
 *  - the chat is a real record in this operator's own local brain, resolved
 *    BEFORE the stop-everything path runs. An unknown id now fails on a read
 *    instead of on a cascade of writes.
 *
 * `alreadyArchived` is reported rather than thrown so the caller can answer an
 * archive of an already-archived chat with the record itself — idempotent, and
 * without replaying "stop every job in this chat" against it.
 *
 * THE RESIDUAL, NAMED: a renderer may still archive any LIVE chat in the local
 * brain, not only the selected one. That is the sidebar's own affordance, and
 * on a local-first single-operator app there is no cross-tenant boundary here —
 * but it is an authority, it is now stated, and closing it needs a UX decision
 * about the sidebar rather than a check in this file.
 */
export async function requireArchivableRendererChat(
  client: ChatReader,
  chatId: unknown
): Promise<{
  chatId: string;
  chat: Awaited<ReturnType<ChatReader["getChat"]>>;
  alreadyArchived: boolean;
}> {
  const requested = requireRendererRecordId(chatId, "chat");
  const chat = await client.getChat(requested);
  return {
    chatId: requested,
    chat,
    alreadyArchived: chat.status === "archived",
  };
}

export async function requireRendererDispatchJob(
  client: JobReader,
  chatId: string | null,
  jobId: string
): Promise<DispatchJobRecord> {
  const [chat, job] = await Promise.all([
    requireActiveRendererChat(client, chatId),
    client.getDispatchJob(jobId),
  ]);
  if (job.chatId !== chat.id) {
    throw new Error("That dispatch does not belong to the selected chat.");
  }
  return job;
}

export async function requireRendererTerminalSession(
  client: JobReader,
  chatId: string | null,
  sessionId: string
): Promise<void> {
  const standalonePrefix = "terminal-chat:";
  if (sessionId.startsWith(standalonePrefix)) {
    // Legacy single-shell ids and vendor-tab slots (`…:<kind>.<n>`,
    // terminal-session-id.ts) authorize identically: by the chat they name.
    const requestedChatId =
      parseChatTerminalScope(sessionId.slice(standalonePrefix.length))
        ?.chatId ?? "";
    requireSelectedRendererChat(chatId, requestedChatId);
    await requireActiveRendererChat(client, requestedChatId);
    return;
  }

  const jobPrefix = "terminal-";
  if (sessionId.startsWith(jobPrefix)) {
    const jobId = stripResumeSuffix(sessionId.slice(jobPrefix.length));
    if (jobId) {
      await requireRendererDispatchJob(client, chatId, jobId);
      return;
    }
  }

  throw new Error("That terminal does not belong to the selected chat.");
}

/**
 * A takeover terminal reuses its job's spawn coordinate with a `.resume` or
 * `.fork` suffix (see lib/terminal-host.ts) so it can coexist with the plain
 * new-session pty — and so a fork and a resume never share one. Authorization
 * is by the underlying JOB in every case.
 *
 * DELIBERATELY SPELLED OUT rather than imported: this module is reachable from
 * the preload/renderer boundary and must not pull in an Electron-main module.
 * The cost of that copy is drift, and drift here is not cosmetic — a suffix
 * this function does not know becomes a session id nothing in the app can
 * authorize a close for, which is a pty with no way to die.
 *
 * EXPORTED SO THE PAIR IS ACTUALLY PINNED. This comment used to claim
 * `terminal-host-ipc.test.ts` pinned the two lists while both constants were
 * module-private and no test imported either, so a third suffix added on one
 * side only would have shipped with every suite green — the exact failure the
 * claim promised was impossible. That test now imports BOTH lists and asserts
 * them against each other, and drives this module's close authorization from
 * the HOST's list, so adding a suffix in terminal-host.ts without adding it
 * here fails.
 */
export const TAKEOVER_SESSION_SUFFIXES = [".resume", ".fork"] as const;

function stripResumeSuffix(jobId: string): string {
  const suffix = TAKEOVER_SESSION_SUFFIXES.find((candidate) =>
    jobId.endsWith(candidate)
  );
  return suffix ? jobId.slice(0, -suffix.length) : jobId;
}

/**
 * THE CHATS THIS WINDOW HAS ACTUALLY BOUND.
 *
 * `authorizeRendererTerminalClose` deliberately does not require a chat to
 * still be SELECTED (archive/switch races flip the selection before the close
 * IPC lands — see below). The bug was that dropping the selection requirement
 * also dropped the ownership requirement: the job branch looked the job up and
 * then asserted nothing about it, so the check answered "this jobId exists",
 * which every jobId in the brain does. That is an authority the comment never
 * claimed, and this repo's rule is that a comment and its code must agree.
 *
 * Ownership is therefore stated positively and separately from selection: a
 * chat this window has bound at some point during its life. That is exactly the
 * set whose terminals this window can be holding — a session is only ever
 * created under an authorized open, and every authorized open runs against a
 * bound chat — so it can never refuse a close for a pty that actually exists,
 * which matters: a refusal here would leak a live vendor child, the thing the
 * close path exists to prevent.
 *
 * NEVER EVICTS, on purpose. An LRU would make a long-lived window unable to
 * close a terminal it still owns, i.e. it would manufacture the leak. Growth is
 * bounded by the operator's own chat records rather than by a counter: an entry
 * is added only after a chat has been successfully bound, which requires the
 * chat to exist in the local brain, so a renderer loop cannot mint entries.
 */
export type RendererChatOwnership = {
  /** Record a chat this window has bound. Null/empty records nothing. */
  note(chatId: string | null | undefined): void;
  /** Has this window ever bound that chat? */
  owns(chatId: string | null | undefined): boolean;
};

export function createRendererChatOwnership(): RendererChatOwnership {
  const owned = new Set<string>();
  return {
    note: (chatId) => {
      if (chatId) {
        owned.add(chatId);
      }
    },
    owns: (chatId) => Boolean(chatId) && owned.has(chatId as string),
  };
}

/**
 * Authorize tearing down a terminal session by its encoded identity.
 *
 * Unlike `requireRendererTerminalSession`, this does NOT require the chat to
 * still be SELECTED — archive/switch races change selection before close IPC
 * lands, and closing a pty is safe teardown (never a data-exfil path).
 *
 * It DOES require ownership: the chat named by a standalone id, or the chat
 * owning the job named by a `terminal-<jobId>` id, must be one this window has
 * bound (see RendererChatOwnership). `ownership` is a REQUIRED parameter and
 * not an optional one, because an optional authority argument is an authority
 * a call site can drop by forgetting it — which is how this check went missing
 * in the first place.
 */
export async function authorizeRendererTerminalClose(
  client: JobReader,
  sessionId: string,
  ownership: RendererChatOwnership
): Promise<void> {
  const standalonePrefix = "terminal-chat:";
  if (sessionId.startsWith(standalonePrefix)) {
    // A vendor-tab slot (`…:<kind>.<n>`) closes under the same chat identity
    // as the legacy single shell — the slot is presentation, not authority.
    const requestedChatId = parseChatTerminalScope(
      sessionId.slice(standalonePrefix.length)
    )?.chatId;
    if (!requestedChatId) {
      throw new Error("That terminal does not belong to a known chat.");
    }
    requireOwnedRendererChat(ownership, requestedChatId);
    // Archived chats are fine — we are closing after archive.
    await client.getChat(requestedChatId);
    return;
  }

  const jobPrefix = "terminal-";
  if (sessionId.startsWith(jobPrefix)) {
    const jobId = stripResumeSuffix(sessionId.slice(jobPrefix.length));
    if (!jobId) {
      throw new Error("That terminal does not belong to a known chat.");
    }
    const job = await client.getDispatchJob(jobId);
    requireOwnedRendererChat(ownership, job.chatId);
    return;
  }

  throw new Error("That terminal does not belong to a known chat.");
}

function requireOwnedRendererChat(
  ownership: RendererChatOwnership,
  chatId: string | null | undefined
): void {
  if (!ownership.owns(chatId)) {
    throw new Error(
      "That terminal belongs to a mission this window has not opened."
    );
  }
}

export async function requireRendererTask(
  client: TaskReader,
  chatId: string | null,
  taskId: string
): Promise<void> {
  const chat = await requireActiveRendererChat(client, chatId);
  if (chat.taskId === taskId) {
    return;
  }
  const jobs = await client.listDispatchJobs({ chatId: chat.id, limit: 200 });
  if (!jobs.some((job) => job.taskId === taskId)) {
    throw new Error("That task does not belong to the selected chat.");
  }
}
