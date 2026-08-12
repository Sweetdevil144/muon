import type { EnsureBrainResult } from "@muon/client/ensure-brain";
import type { BrainTarget } from "./brain-store.js";

export type StartupPlan = {
  /** The honest target the TUI ends up pointed at. */
  target: BrainTarget;
  /** Set when ensureBrain could not bring a brain up (names data dir/log/lockfile). */
  note?: string;
  /** True only for auto-discovered targets (lockfile/default/spawned). */
  reresolvable: boolean;
};

export type ResolveStartupTargetInput = {
  /** The parsed `--api-base` flag value (undefined when not passed). */
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
  ensureBrain: (opts?: { dataDir?: string }) => Promise<EnsureBrainResult>;
  resolveApiBase: (cliValue?: string) => string;
  resolveDataDir: () => string;
};

/**
 * The TUI's mirror of the CLI preAction hook. With NO explicit target we make
 * sure the embedded brain is up (auto-spawn) before building the client; with an
 * explicit `--api-base` / `MUON_API_BASE` the user is pointing at a known brain,
 * so we NEVER auto-spawn over it (F1 no-hijack) and mark the target as not
 * re-resolvable. Returns the honest target (base + data dir + how we found it).
 */
export async function resolveStartupTarget(
  input: ResolveStartupTargetInput
): Promise<StartupPlan> {
  const env = input.env ?? process.env;
  const explicitBase =
    input.apiBase?.trim() ||
    env.MUON_API_BASE?.trim() ||
    env.NEXT_PUBLIC_MUON_API_BASE?.trim();

  if (explicitBase) {
    return {
      target: {
        base: input.resolveApiBase(input.apiBase),
        dataDir: input.resolveDataDir(),
        source: input.apiBase?.trim() ? "flag" : "env",
      },
      reresolvable: false,
    };
  }

  const result = await input.ensureBrain();
  const source: BrainTarget["source"] = result.live
    ? result.started
      ? "spawned"
      : "lockfile"
    : "default";
  return {
    target: {
      base: input.resolveApiBase(),
      dataDir: result.dataDir,
      source,
    },
    note: result.live ? undefined : result.note,
    reresolvable: true,
  };
}
