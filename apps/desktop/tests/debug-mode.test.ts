import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createLineSplitter,
  formatBrainLine,
  formatDebugLine,
  installMainConsoleTee,
  installRendererConsoleTee,
  isDebugMode,
  safeLine,
} from "../src/lib/debug-mode.js";

const clock = () => new Date(Date.UTC(2026, 6, 25, 12, 0, 0));

describe("desktop debug mode", () => {
  it("is strictly opt-in", () => {
    expect(isDebugMode({})).toBe(false);
    expect(isDebugMode({ MUON_DEBUG: "0" })).toBe(false);
    expect(isDebugMode({ MUON_DEBUG: "1" })).toBe(true);
  });

  // Guardrail: nothing this surface writes may carry a credential. The redactor
  // is @muon/core's shared `redactedTail` — never a second local copy.
  it("redacts bearer tokens and KEY=value secrets out of every teed line", () => {
    expect(safeLine("GET /api/tasks Authorization: Bearer abcdef1234567890")).toBe(
      "GET /api/tasks Authorization: Bearer [redacted]"
    );
    expect(safeLine("spawning codex with ANTHROPIC_API_KEY=sk-live-123456")).toBe(
      "spawning codex with ANTHROPIC_API_KEY=[redacted]"
    );
  });

  it("formats a debug line as <ISO> [scope] text", () => {
    expect(formatDebugLine("main:log", "[brain] ready", clock)).toBe(
      "2026-07-25T12:00:00.000Z [main:log] [brain] ready"
    );
  });

  it("tees main-process console output while leaving the terminal output intact", () => {
    const written: string[] = [];
    const original = vi.fn();
    const target = {
      log: original,
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Console;

    const restore = installMainConsoleTee(
      { write: (chunk) => written.push(chunk) },
      target,
      clock
    );
    target.log("[runner] live", { host: "desktop-mac" });
    restore();
    target.log("after restore");

    expect(original).toHaveBeenCalledTimes(2);
    expect(written).toEqual([
      '2026-07-25T12:00:00.000Z [main:log] [runner] live {"host":"desktop-mac"}\n',
    ]);
  });

  it("forwards renderer console messages (Electron 37+ details shape)", () => {
    const contents = new EventEmitter();
    const lines: string[] = [];
    installRendererConsoleTee(contents, (line) => lines.push(line), clock);

    contents.emit("console-message", {
      message: "Uncaught TypeError: chat is undefined",
      level: "error",
      lineNumber: 42,
      sourceId: "file:///app/dist/renderer/app.js",
    });

    expect(lines).toEqual([
      "2026-07-25T12:00:00.000Z [renderer:error] Uncaught TypeError: chat is undefined (app.js:42)\n",
    ]);
  });

  it("still forwards renderer console messages in the legacy positional shape", () => {
    const contents = new EventEmitter();
    const lines: string[] = [];
    installRendererConsoleTee(contents, (line) => lines.push(line), clock);

    contents.emit("console-message", {}, 3, "legacy renderer error", 7, "app.js");

    expect(lines[0]).toContain("[renderer:error] legacy renderer error (app.js:7)");
  });

  it("pretty-prints the brain's pino JSON and passes plain output through", () => {
    expect(
      formatBrainLine(
        JSON.stringify({
          level: 50,
          time: Date.UTC(2026, 6, 25, 12, 0, 0),
          pid: 1,
          hostname: "mac",
          msg: "request",
          method: "POST",
          url: "/api/dispatch",
          status: 500,
        })
      )
    ).toBe(
      "2026-07-25T12:00:00.000Z [brain:ERROR] request method=POST url=/api/dispatch status=500"
    );
    expect(formatBrainLine("MUON brain ready on http://127.0.0.1:5555")).toBe(
      "[brain] MUON brain ready on http://127.0.0.1:5555"
    );
    expect(formatBrainLine("   ")).toBeNull();
  });

  it("reassembles chunked child output into whole lines", () => {
    const lines: string[] = [];
    const feed = createLineSplitter((line) => lines.push(line));
    feed("[runner] on");
    feed("line\n[runner] ▶ codex");
    feed("\n");
    expect(lines).toEqual(["[runner] online", "[runner] ▶ codex"]);
  });
});
