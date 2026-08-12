/**
 * ROADMAP T4 — OSC-8 hyperlink allowlist for every terminal pane (human tabs,
 * takeover panes, and the read-only job-console viewer).
 *
 * A terminal's OSC-8 hyperlinks are painted by whatever is running inside it
 * — a build tool, a vendor CLI, or (through the read-only job attach) a
 * DISPATCHED AGENT. That makes clicking one an AGENT-CONTROLLED CHANNEL INTO
 * THE UI, the same class `navigation-security.ts` closes for the renderer's
 * own document by denying every navigation and popup outright. A terminal
 * cannot take that same blanket "deny everything" stance — a build log's own
 * `https://` links and a ripgrep-style in-workspace path are the entire point
 * of the feature — so this is a narrow, explicit ALLOWLIST instead, fail
 * closed on everything else: `javascript:`, `data:`, `vscode:`, a bare custom
 * scheme, credentials embedded in a URL, or a path that resolves outside the
 * bound workspace are all refused.
 *
 * Pure and dependency-free (no xterm, no Electron, no node built-ins — the
 * renderer bundle is a browser target) so it is exhaustively unit-testable.
 */
import type { TerminalLinkTarget } from "../../shared/terminal-link-protocol.js";

export type { TerminalLinkTarget };

const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

function isAllowedUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) {
    return null;
  }
  // Credentials embedded in the link text (`https://user:pass@host/`) are
  // never honoured — the same posture `isAllowedGitHubExternalUrl` takes.
  if (url.username || url.password) {
    return null;
  }
  return url.toString();
}

/** POSIX-only split (the desktop packages macOS-only — electron-builder's
 *  `--mac` target — so this never needs to reason about `\`). */
function segments(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

/**
 * Resolve `candidate` against `workspaceRoot` and return the absolute,
 * `..`-collapsed path IF (and only if) it lands inside the root — string-level
 * boundary math, no filesystem access (so it cannot see a symlink that
 * escapes the root; that is a real limitation, stated rather than hidden).
 */
function resolveWithinWorkspace(
  candidate: string,
  workspaceRoot: string
): string | null {
  if (!workspaceRoot.startsWith("/")) {
    return null; // an unresolved/relative root cannot bound anything
  }
  const rootParts = segments(workspaceRoot);
  const combined = candidate.startsWith("/")
    ? segments(candidate)
    : [...rootParts, ...segments(candidate)];
  const resolved: string[] = [];
  for (const part of combined) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      if (resolved.length === 0) {
        return null; // walked above the filesystem root — never inside workspace
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  if (resolved.length < rootParts.length) {
    return null;
  }
  for (let i = 0; i < rootParts.length; i += 1) {
    if (resolved[i] !== rootParts[i]) {
      return null; // outside the workspace root entirely
    }
  }
  return `/${resolved.join("/")}`;
}

/** `file://` (localhost-only) → a bare filesystem path; anything else through unchanged. */
function stripFileScheme(uri: string): string | null {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  try {
    const url = new URL(uri);
    if (url.hostname && url.hostname !== "localhost") {
      return null; // a remote file:// authority is not a local workspace path
    }
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

/**
 * Classify one OSC-8 target against the allowlist. Returns `null` for
 * anything not on it: `javascript:`, `data:`, `vscode://`, a bare custom
 * scheme, or a path (via `file://` or plain text) that resolves outside the
 * bound workspace.
 *
 * `workspaceRoot` absent (no bound chat/workspace) denies every path-shaped
 * link outright — http(s) needs no workspace context and is allowed either
 * way.
 */
export function classifyTerminalLink(
  uri: string,
  workspaceRoot: string | null
): TerminalLinkTarget | null {
  const trimmed = uri.trim();
  if (!trimmed) {
    return null;
  }
  const allowedUrl = isAllowedUrl(trimmed);
  if (allowedUrl) {
    return { kind: "url", url: allowedUrl };
  }
  if (!workspaceRoot) {
    return null;
  }
  const pathCandidate = stripFileScheme(trimmed);
  if (pathCandidate === null) {
    return null;
  }
  // A second scheme (mailto:, ssh:, a custom vendor URI) masquerading as a
  // path — refuse rather than guess at what it means.
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathCandidate) &&
    !pathCandidate.startsWith("/")
  ) {
    return null;
  }
  const resolved = resolveWithinWorkspace(pathCandidate, workspaceRoot);
  return resolved ? { kind: "path", absolutePath: resolved } : null;
}

/**
 * ⌘-click on macOS, Ctrl-click elsewhere — the ONE activation gesture this
 * channel honours. Every other click on a link (a bare click, a right-click)
 * is inert: xterm still underlines/highlights it, but nothing opens.
 */
export function isTerminalLinkActivationClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.metaKey || event.ctrlKey;
}
