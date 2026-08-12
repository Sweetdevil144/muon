import { mkdirSync } from "node:fs";
import path from "node:path";
import { redactedTail } from "@muon/core";
import {
  createLogSink,
  logMaxBytesFromEnv,
  type RotatingLogSink,
} from "./log-sink.js";

// Debug mode (`npm run dev:desktop:debug` → MUON_DEBUG=1) is the one switch a
// developer flips to make the app explain itself:
//
//   * Electron MAIN console output is TEE'd to <dataDir>/logs/desktop.log
//     (it still prints to the terminal exactly as before).
//   * RENDERER console output — invisible today unless DevTools is open — is
//     forwarded into the same file and terminal.
//   * the embedded brain's pino JSON is pretty-printed to the terminal instead
//     of disappearing into brain.log.
//   * the detached runner's stdout/stderr is mirrored to the terminal.
//
// It is strictly OPT-IN: with MUON_DEBUG unset, `isDebugMode` is false and none
// of this is installed, so `npm run dev:desktop` behaves exactly as it did.
//
// Everything teed here can carry agent/vendor-authored text (a renderer log of a
// chat message, a brain error containing a tool result), so every line goes
// through @muon/core's `redactedTail` — THE shared redaction control — before it
// reaches a terminal or a file.

/** Per-line cap for teed output (bounded so one huge line can't flood a log). */
export const DEBUG_LINE_MAX_CHARS = 4000;

export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUON_DEBUG === "1";
}

/** Redact + bound a single log line. Never returns multi-KB agent text raw. */
export function safeLine(text: string): string {
  return redactedTail(text, DEBUG_LINE_MAX_CHARS);
}

export function formatDebugLine(
  scope: string,
  text: string,
  now: () => Date = () => new Date()
): string {
  return `${now().toISOString()} [${scope}] ${safeLine(text)}`;
}

/** The debug log file every teed line lands in. */
export function desktopLogPath(dataDir: string): string {
  return path.join(dataDir, "logs", "desktop.log");
}

/**
 * Open the debug log. Returns null (rather than throwing) if the log dir cannot
 * be created — losing debug output must never stop the app from starting.
 */
export function createDesktopDebugSink(
  dataDir: string
): RotatingLogSink | null {
  try {
    const file = desktopLogPath(dataDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const sink = createLogSink({ file, maxBytes: logMaxBytesFromEnv() });
    // Stream errors arrive as events, not throws; swallow them for the same
    // reason (a broken log must not take the app down).
    sink.on("error", () => undefined);
    return sink;
  } catch {
    return null;
  }
}

type ConsoleLike = Pick<Console, "log" | "warn" | "error" | "info" | "debug">;

/**
 * Mirror the main process's console into `sink`, keeping the original terminal
 * output untouched. Returns a restore function (used by tests; the app keeps it
 * installed for its whole life).
 */
export function installMainConsoleTee(
  sink: { write: (chunk: string) => void },
  target: ConsoleLike = console,
  now: () => Date = () => new Date()
): () => void {
  const levels = ["log", "warn", "error", "info", "debug"] as const;
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const level of levels) {
    const original = target[level].bind(target) as (...args: unknown[]) => void;
    originals.set(level, original);
    target[level] = ((...args: unknown[]) => {
      original(...args);
      try {
        sink.write(
          `${formatDebugLine(`main:${level}`, args.map(stringify).join(" "), now)}\n`
        );
      } catch {
        // Diagnostics loss is never worth breaking a console call over.
      }
    }) as ConsoleLike[typeof level];
  }
  return () => {
    for (const level of levels) {
      const original = originals.get(level);
      if (original) {
        target[level] = original as ConsoleLike[typeof level];
      }
    }
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

type RendererConsoleDetails = {
  message?: string;
  level?: string;
  lineNumber?: number;
  sourceId?: string;
};

type ConsoleMessageEmitter = {
  on(
    event: "console-message",
    listener: (details: RendererConsoleDetails, ...legacy: unknown[]) => void
  ): unknown;
};

/**
 * Forward renderer console output to `write`. Electron 37+ passes a details
 * object; the pre-37 positional signature (level, message, line, sourceId) is
 * still accepted so this keeps working across an Electron bump.
 */
export function installRendererConsoleTee(
  contents: ConsoleMessageEmitter,
  write: (line: string) => void,
  now: () => Date = () => new Date()
): void {
  contents.on("console-message", (details, ...legacy) => {
    const fromDetails =
      details && typeof details === "object" && typeof details.message === "string"
        ? details
        : null;
    const message =
      fromDetails?.message ??
      (typeof legacy[1] === "string" ? (legacy[1] as string) : "");
    if (!message) {
      return;
    }
    const level = fromDetails?.level ?? levelName(legacy[0]);
    const source = fromDetails?.sourceId ?? (legacy[3] as string | undefined);
    const lineNumber = fromDetails?.lineNumber ?? (legacy[2] as number | undefined);
    const where = source
      ? ` (${path.basename(String(source))}${lineNumber ? `:${lineNumber}` : ""})`
      : "";
    write(`${formatDebugLine(`renderer:${level}`, `${message}${where}`, now)}\n`);
  });
}

function levelName(level: unknown): string {
  switch (level) {
    case 0:
      return "debug";
    case 2:
      return "warning";
    case 3:
      return "error";
    default:
      return "info";
  }
}

const PINO_LEVELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

/**
 * Pretty-print one line of the brain's pino JSON for a human terminal. Anything
 * that is not pino JSON (a bare console.error from boot, a stack trace) is
 * passed through untouched.
 */
export function formatBrainLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!trimmed.startsWith("{")) {
    return `[brain] ${safeLine(trimmed)}`;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return `[brain] ${safeLine(trimmed)}`;
  }
  const level =
    typeof parsed.level === "number"
      ? (PINO_LEVELS[parsed.level] ?? String(parsed.level))
      : "INFO";
  const time =
    typeof parsed.time === "number"
      ? new Date(parsed.time).toISOString()
      : new Date().toISOString();
  const message = typeof parsed.msg === "string" ? parsed.msg : "";
  const extras = Object.entries(parsed)
    .filter(
      ([key]) =>
        !["level", "time", "msg", "pid", "hostname", "v"].includes(key)
    )
    .map(([key, value]) => `${key}=${compact(value)}`)
    .join(" ");
  return `${time} [brain:${level}] ${safeLine(
    `${message}${extras ? ` ${extras}` : ""}`
  )}`;
}

function compact(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/**
 * Buffer partial chunks into whole lines. A child's stdout arrives in arbitrary
 * chunks, so anything that formats per line has to reassemble them first.
 */
export function createLineSplitter(
  onLine: (line: string) => void
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        onLine(line);
      }
      index = buffer.indexOf("\n");
    }
    // Never let a pathological no-newline stream grow without bound.
    if (buffer.length > 64 * 1024) {
      onLine(buffer);
      buffer = "";
    }
  };
}
