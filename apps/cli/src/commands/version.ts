import type { Command } from "commander";
import { loadBrainCommit, type BrainCommit } from "../lib/brain-commit.js";
import { readCliVersion } from "../lib/app-version.js";
import { printJson } from "../lib/output.js";
import { failCommand } from "../lib/refusal.js";

export type VersionCommandDependencies = {
  readAppVersion?: () => Promise<string>;
  loadBrainCommit?: () => Promise<BrainCommit>;
};

async function readAppVersion(): Promise<string> {
  return readCliVersion(import.meta.url);
}

export function registerVersionCommand(
  program: Command,
  dependencies: VersionCommandDependencies = {}
) {
  program
    .command("version")
    .description("Print the MUON app version and indexed brain commit")
    .action(async () => {
      try {
        const [appVersion, brain] = await Promise.all([
          (dependencies.readAppVersion ?? readAppVersion)(),
          (dependencies.loadBrainCommit ?? loadBrainCommit)(),
        ]);
        printJson({
          appVersion,
          brainRepo: brain.repoName,
          brainCommit: brain.graphCommit ?? null,
          headCommit: brain.headCommit ?? null,
          stale: brain.stale ?? null,
        });
      } catch (error) {
        failCommand(error, "Version check failed.");
      }
    });
}
