/**
 * The session-id scheme for HUMAN terminal sessions bound to a chat's
 * workspace (the vendor tab bar + plain shell tabs).
 *
 * One id shape, three consumers, so it lives in one pure module:
 *  - the renderer BUILDS ids when the human clicks a vendor in the strip
 *    (`chatTerminalSessionId`),
 *  - the terminal cwd resolver (terminal-workspace-resolver.ts) PARSES the
 *    chat back out to authorize + resolve the workspace HOST-side,
 *  - the close authorizer (renderer-chat-scope.ts) PARSES the chat back out
 *    so tearing down "Claude 2" is authorized by the same chat record as the
 *    legacy single shell tab.
 *
 * Shape: `terminal-chat:<chatId>` is the pre-existing single-shell id and
 * stays valid (kind/ordinal null). A vendor/shell TAB appends one slot:
 * `terminal-chat:<chatId>:<kind>.<ordinal>` — e.g.
 * `terminal-chat:cm123:claude-code.2` is the human's second Claude session in
 * that chat's workspace. The slot only NAMES a kind; the host still resolves
 * the actual command from its own allowlist (terminal-spawn.ts), so a forged
 * slot can select nothing outside it.
 *
 * Parsing is fail-closed by construction: a tail that does not match the
 * strict slot pattern is treated as part of the chat id, and an unknown chat
 * id refuses downstream (getChat 404 / bound-chat mismatch). No parse result
 * ever widens what the host will spawn or where.
 */

export const CHAT_TERMINAL_SESSION_PREFIX = "terminal-chat:";

/** `<kind>.<ordinal>` — kind is a host-allowlisted terminal kind ("shell" or
 *  a vendor id), ordinal a small 1-based int ("Claude" / "Claude 2"). */
const CHAT_TERMINAL_SLOT = /^([a-z][a-z0-9-]{0,63})\.([1-9][0-9]{0,3})$/;

export type ChatTerminalScope = {
  chatId: string;
  /** null on the legacy single-shell id (`terminal-chat:<chatId>`). */
  kind: string | null;
  ordinal: number | null;
};

/**
 * Parse the part AFTER the `chat:` marker (the cwd resolver's view: it
 * receives ids already stripped of the `terminal-` prefix). Returns null only
 * for an empty rest — everything else yields at least a chatId to authorize.
 */
export function parseChatTerminalScope(rest: string): ChatTerminalScope | null {
  if (!rest) {
    return null;
  }
  const cut = rest.lastIndexOf(":");
  if (cut > 0) {
    const slot = CHAT_TERMINAL_SLOT.exec(rest.slice(cut + 1));
    if (slot) {
      return {
        chatId: rest.slice(0, cut),
        kind: slot[1]!,
        ordinal: Number(slot[2]!),
      };
    }
  }
  return { chatId: rest, kind: null, ordinal: null };
}

/** The full session id for one human terminal tab in a chat's workspace. */
export function chatTerminalSessionId(
  chatId: string,
  kind: string,
  ordinal: number
): string {
  if (!chatId) {
    throw new Error("a chat terminal session needs a chat id");
  }
  if (!CHAT_TERMINAL_SLOT.test(`${kind}.${ordinal}`)) {
    throw new Error(
      `'${kind}.${ordinal}' is not a valid terminal tab slot (kind + small ordinal)`
    );
  }
  return `${CHAT_TERMINAL_SESSION_PREFIX}${chatId}:${kind}.${ordinal}`;
}

export function isChatTerminalSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CHAT_TERMINAL_SESSION_PREFIX);
}

/** Parse a FULL session id (`terminal-chat:...`); null when it is not one. */
export function parseChatTerminalSessionId(
  sessionId: string
): ChatTerminalScope | null {
  return isChatTerminalSessionId(sessionId)
    ? parseChatTerminalScope(
        sessionId.slice(CHAT_TERMINAL_SESSION_PREFIX.length)
      )
    : null;
}
