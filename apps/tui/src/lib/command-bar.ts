/**
 * Command bar parsing (prompt-first TUI): plain text is an instruction for
 * the super-orchestrator (proposal → human apply → crew works); `/commands`
 * jump straight to a cockpit action, Claude-Code style; and, ADR-0013 #52,
 * `/<action> [vendor]` invokes a vendor's own feature through MUON
 * (e.g. `/ultrareview [claude]`, `/plan codex`), badged and gated.
 */
import {
  isVendorActionCommand,
  normalizeVendorAlias,
  type VendorKey,
} from "@muon/core";

export type CommandBarAction =
  | { type: "instruct"; request: string }
  | { type: "palette"; commandId: string; args?: string[] }
  | {
      type: "vendorAction";
      actionId: string;
      vendor?: VendorKey;
      args: string[];
    }
  | { type: "error"; message: string };

export const SLASH_COMMANDS: Record<string, string> = {
  "/plan": "plan",
  "/run": "run",
  "/session": "session-start",
  "/ship": "ship",
  "/specialist": "specialist",
  "/workflows": "workflows",
  "/crew": "crew",
  "/mcp": "mcp",
  "/mcp-attach": "mcp-attach",
  "/mcp-detach": "mcp-detach",
  "/memory": "memory-search",
  "/task": "task-new",
  "/assign": "assign",
  "/answer": "answer",
  "/revoke-grants": "revoke-grants",
  "/archive-chat": "archive-chat",
};

export const COMMAND_BAR_PLACEHOLDER =
  "type what the crew should do (plain text proposes a workflow) · /run /session /ship · /ultrareview [claude] …";

/**
 * Recognise a `[vendor]` / bare-vendor selector token. Returns the canonical
 * lane key when the token is a known vendor, else undefined (so it is treated
 * as a positional argument instead).
 */
function readVendorSelector(token: string | undefined): VendorKey | undefined {
  return normalizeVendorAlias(token);
}

export function parseCommandBarInput(raw: string): CommandBarAction {
  const input = raw.trim();
  if (!input) {
    return { type: "error", message: "type an instruction or a /command" };
  }
  if (input.startsWith("/")) {
    const tokens = input.split(/\s+/);
    const head = tokens[0]!.toLowerCase();
    const actionToken = head.slice(1); // strip the leading slash
    const cockpitId = SLASH_COMMANDS[head];
    const isVendorAction = isVendorActionCommand(actionToken);

    // Peek at the next token to see whether the user named a vendor.
    const selector = readVendorSelector(tokens[1]);

    // A vendor-action token WITH an explicit vendor selector always resolves as
    // a vendor action (this is how `/plan codex` reaches the vendor while `/plan`
    // alone stays the MUON cockpit planner).
    if (isVendorAction && selector) {
      return {
        type: "vendorAction",
        actionId: actionToken,
        vendor: selector,
        args: tokens.slice(2),
      };
    }

    // Cockpit slash-commands win when there is no vendor selector.
    // ADR-0028: only `/mcp-attach` / `/mcp-detach` carry trailing tokens as
    // palette args (vendor name). Other cockpit commands ignore trailing
    // words so `/SHIP now` stays a bare palette action.
    if (cockpitId) {
      if (
        (cockpitId === "mcp-attach" || cockpitId === "mcp-detach") &&
        tokens.length > 1
      ) {
        return {
          type: "palette",
          commandId: cockpitId,
          args: tokens.slice(1),
        };
      }
      return { type: "palette", commandId: cockpitId };
    }

    // A bare vendor-action token (no vendor), MUON picks/asks for the vendor.
    if (isVendorAction) {
      return {
        type: "vendorAction",
        actionId: actionToken,
        vendor: undefined,
        args: tokens.slice(1),
      };
    }

    return {
      type: "error",
      message: `unknown command '${head}', try ${Object.keys(SLASH_COMMANDS).join(" ")} or /ultrareview [claude]`,
    };
  }
  return { type: "instruct", request: input };
}
