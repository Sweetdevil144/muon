import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CheckCommandError,
  parseCheckCommand,
  resolveCheckArgv,
} from "@muon/protocol";
import { runShellCheck } from "../src/loop-runner.js";

// Wrap the real spawn so we can assert HOW it was invoked (no shell) while
// still really running valid commands.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const spawnMock = vi.mocked(spawn);

afterEach(() => {
  spawnMock.mockClear();
});

describe("parseCheckCommand (P3-B safe tokenizer)", () => {
  it("splits a normal command into an argv array", () => {
    expect(parseCheckCommand("npm test")).toEqual(["npm", "test"]);
    expect(parseCheckCommand("npm run build")).toEqual(["npm", "run", "build"]);
    expect(parseCheckCommand("  pnpm   lint  ")).toEqual(["pnpm", "lint"]);
  });

  it("is quote-aware: grouped args keep spaces, quotes are stripped", () => {
    expect(parseCheckCommand("prettier --check 'src/a b.ts'")).toEqual([
      "prettier",
      "--check",
      "src/a b.ts",
    ]);
    expect(parseCheckCommand('node -e "let x = 1"')).toEqual([
      "node",
      "-e",
      "let x = 1",
    ]);
  });

  it.each([
    ["pipe |", "echo hi | sh"],
    ["chain &&", "echo hi && curl evil"],
    ["chain ||", "false || rm -rf /"],
    ["background &", "sleep 1 &"],
    ["semicolon ;", "a; b"],
    ["redirect >", "npm test > out"],
    ["redirect <", "cat < f"],
    ["backtick `", "echo `whoami`"],
    ["subshell $(", "echo $(whoami)"],
    ["group (", "(cd x && y)"],
    ["newline", "a\nb"],
  ])("refuses a command carrying a shell operator (%s)", (_label, command) => {
    expect(() => parseCheckCommand(command)).toThrow(CheckCommandError);
  });

  it("allows a bare $ that is not a subshell (kept literal, never expanded)", () => {
    expect(parseCheckCommand("echo $HOME")).toEqual(["echo", "$HOME"]);
  });

  it("rejects an unterminated quote and an empty command", () => {
    expect(() => parseCheckCommand("echo 'oops")).toThrow(CheckCommandError);
    expect(() => parseCheckCommand("   ")).toThrow(CheckCommandError);
  });
});

describe("resolveCheckArgv", () => {
  it("uses the explicit args form verbatim (no tokenizing)", () => {
    expect(resolveCheckArgv({ command: "npm", args: ["run", "build"] })).toEqual([
      "npm",
      "run",
      "build",
    ]);
    // A metacharacter in an explicit arg is a literal, not re-parsed.
    expect(resolveCheckArgv({ command: "grep", args: ["a|b"] })).toEqual([
      "grep",
      "a|b",
    ]);
  });

  it("tokenizes the legacy string form", () => {
    expect(resolveCheckArgv({ command: "npm test" })).toEqual(["npm", "test"]);
  });
});

describe("runShellCheck (P3-B: no host shell)", () => {
  it("runs a valid check as a bare argv, never as /bin/sh -c <string>", async () => {
    const result = await runShellCheck({
      name: "version",
      command: process.execPath,
      args: ["--version"],
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    // The exact contract: spawn(file, argvArray) with NO shell option.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe(process.execPath);
    expect(args).toEqual(["--version"]);
    expect(options).not.toHaveProperty("shell", true);
    expect(file).not.toContain("/bin/sh");
  });

  it("splits a legacy string check to argv and runs it (npm-test shape)", async () => {
    // Quote the exe so a path with spaces still tokenizes to one arg.
    const result = await runShellCheck({
      name: "version-string",
      command: `"${process.execPath}" --version`,
    });
    expect(result.ok).toBe(true);
    const [file, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(file).toBe(process.execPath);
    expect(args).toEqual(["--version"]);
  });

  it("refuses an operator command as a failed check and never executes it", async () => {
    const marker = path.join(
      os.tmpdir(),
      `muon-p3b-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    expect(fs.existsSync(marker)).toBe(false);

    const result = await runShellCheck({
      name: "malicious",
      command: `touch ${marker} && echo pwned`,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.outputTail).toContain("refused");
    // Nothing spawned: the shell chain never ran, the file never appeared.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
  });
});
