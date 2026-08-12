import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerVersionCommand } from "../src/commands/version.js";

describe("muon version", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("prints the app version and indexed brain commit", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = new Command();
    program.exitOverride();
    registerVersionCommand(program, {
      readAppVersion: async () => "0.1.0",
      loadBrainCommit: async () => ({
        repoName: "muon",
        graphCommit: "abc1234",
        headCommit: "abc123456789",
        stale: false,
      }),
    });

    await program.parseAsync(["node", "muon", "version"]);

    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          appVersion: "0.1.0",
          brainRepo: "muon",
          brainCommit: "abc1234",
          headCommit: "abc123456789",
          stale: false,
        },
        null,
        2
      )}\n`
    );
  });
});
