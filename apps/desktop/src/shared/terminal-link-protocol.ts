// ROADMAP T4 — the wire shape for one ALREADY-ALLOWLISTED OSC-8 terminal
// hyperlink target, crossing from the renderer (which classified it —
// `renderer/lib/terminal-link-security.ts`) to trusted main (which
// re-validates independently before touching the filesystem or the OS's own
// URL opener — `openTerminalLink` in main.ts). Shared so both sides of the
// bridge, and this file, describe the exact same union.
export type TerminalLinkTarget =
  | { kind: "url"; url: string }
  | { kind: "path"; absolutePath: string };
