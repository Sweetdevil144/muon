import { afterEach, describe, expect, it, vi } from "vitest";
import { MuonApiHttpError } from "@muon/client";
import {
  exitCodeForError,
  failCommand,
  formatRefusal,
} from "../src/lib/refusal.js";

describe("formatRefusal (TODO 7.6)", () => {
  it("rewrites 401/403 into an actionable message", () => {
    const err = new MuonApiHttpError(403, "Forbidden", "403 Forbidden, no");
    expect(formatRefusal(err, "fleet")).toMatch(/you can only reach/);
    expect(formatRefusal(err, "fleet")).toMatch(/muon agents/);
    expect(exitCodeForError(err)).toBe(2);
  });

  it("passes through ordinary errors with exit 1", () => {
    const err = new Error("socket hang up");
    expect(formatRefusal(err, "fleet")).toBe("socket hang up");
    expect(exitCodeForError(err)).toBe(1);
  });
});

// CLI #4: failCommand is now the ONE catch-block ending every command routes
// through, so a 401/403 anywhere in the surface honors the documented exit
// contract (2 = the brain refused your authority) instead of printing a raw
// "403 Forbidden" and exiting 1.
describe("failCommand (the shared catch-block ending)", () => {
  const stderrLines: string[] = [];
  const priorExit = process.exitCode;

  afterEach(() => {
    stderrLines.length = 0;
    process.exitCode = priorExit;
    vi.restoreAllMocks();
  });

  function captureStderr() {
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  }

  it("a 403 prints the actionable refusal and exits 2", () => {
    captureStderr();
    failCommand(
      new MuonApiHttpError(403, "Forbidden", "403 Forbidden"),
      "Memory promotion failed."
    );
    expect(process.exitCode).toBe(2);
    expect(stderrLines.join("")).toMatch(/you can only reach/);
    // The surface name is the fallback's leading clause, not the sentence.
    expect(stderrLines.join("")).toMatch(/Memory promotion/);
    expect(stderrLines.join("")).not.toMatch(/failed\.'/);
  });

  it("an ordinary error keeps the old byte-identical output and exit 1", () => {
    captureStderr();
    failCommand(new Error("socket hang up"), "Memory promotion failed.");
    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("")).toContain("error: socket hang up");
  });

  it("a non-Error keeps the command's own fallback sentence", () => {
    captureStderr();
    failCommand("weird", "Memory promotion failed.");
    expect(process.exitCode).toBe(1);
    expect(stderrLines.join("")).toContain("error: Memory promotion failed.");
  });
});
