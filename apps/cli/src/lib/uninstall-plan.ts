/**
 * `muon uninstall` — the decision half, kept pure so the rules can be tested
 * without removing anything from the machine running the tests.
 *
 * The rule that shapes all of it: **an uninstaller removes the TOOL, never the
 * WORK.** MUON's data dir holds a human-confirmed memory graph — decisions a
 * person vouched for, accumulated over months. No uninstall prompt is informed
 * enough to consent to destroying that, so this one never offers.
 */

/** The npm packages that may own the `muon` / `muon-tui` binaries. */
export const OWNED_PACKAGES = ["muon-cli", "@muon/cli"] as const;

export type UninstallPlan = {
  /** Global npm packages to remove. */
  readonly remove: readonly string[];
  /** Paths deliberately left on disk, with the reason. */
  readonly preserve: readonly { readonly path: string; readonly why: string }[];
  /** True when a live brain must be stopped before the tool disappears. */
  readonly stopBrainFirst: boolean;
};

export function buildUninstallPlan(input: {
  dataDir: string;
  brainIsLive: boolean;
}): UninstallPlan {
  return {
    remove: [...OWNED_PACKAGES],
    preserve: [
      {
        path: input.dataDir,
        why: "your memory graph, code graph and settings — removing MUON does not remove what you recorded with it",
      },
    ],
    // A DETACHED brain outlives the CLI that spawned it. Uninstalling while one
    // runs would leave a process with no supervisor and no `muon shutdown` left
    // to stop it — the user would have to find it by pid. So it is stopped as
    // part of the uninstall rather than left as a trap.
    stopBrainFirst: input.brainIsLive,
  };
}

/**
 * Is this answer a yes?
 *
 * DEFAULT IS NO. Empty input, EOF, a stray newline from a pipe — all of it must
 * read as "no", because the prompt appears in a destructive path and the cost
 * of a wrong "yes" is higher than the cost of asking twice.
 */
export function isAffirmative(answer: string | undefined | null): boolean {
  if (typeof answer !== "string") return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/** The one-line prompt, so every surface asks the same question. */
export function confirmPrompt(): string {
  return "Uninstall the MUON CLI and TUI? [y/N] ";
}

/** What to print after a successful removal — including what was NOT touched. */
export function describePlan(plan: UninstallPlan): string {
  const lines = [`Removed: ${plan.remove.join(", ")}`];
  for (const kept of plan.preserve) {
    lines.push(`Kept:    ${kept.path}`);
    lines.push(`         ${kept.why}.`);
  }
  lines.push("");
  lines.push(
    "To remove that too, delete the directory yourself — deliberately a separate, manual step."
  );
  return lines.join("\n");
}
