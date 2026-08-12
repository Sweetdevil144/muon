import { z } from "zod";

/**
 * MUON-normalized permission mode, compiled per vendor:
 * - strict     -> claude `dontAsk` / codex `untrusted` / cursor no --force
 * - default    -> claude `default` / codex `untrusted` / cursor no --force
 * - auto-edits -> claude `acceptEdits` / codex `untrusted` / cursor no --force
 * - full-auto  -> claude `bypassPermissions` / codex `never` / cursor `--force`
 *
 * Codex has no per-class approval axis and its `on-request` is measured
 * (0.145.0) to mean "the model decides" — zero asks across a write-authority
 * session — so every must-ask mode maps to `untrusted` and MUON's own bridge
 * is the layer that grades allowances (see adapters' profile compiler).
 */
export const permissionModeSchema = z.enum([
  "strict",
  "default",
  "auto-edits",
  "full-auto",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const sandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "full-access",
]);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const mcpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .refine((value) => Boolean(value.command) !== Boolean(value.url), {
    message: "Exactly one of command (stdio) or url (http) must be set.",
  });
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Lane profile: every controllable feature of an integrated agent, reachable
 * through MUON. Typed core covers cross-vendor coordination settings; the
 * passthrough fields (`extraArgs`, `rawConfig`, `env`) make any remaining
 * vendor flag or config key reachable without MUON modeling it.
 * See docs/research/vendor-capability-matrix.md.
 */
/**
 * TODO 3.6 — the explicit "pass no flag, let the CLI decide" choice.
 *
 * Distinct from omitting `model` / `null` in the UI: absence means "not yet
 * chosen / inherit the outer default", while this sentinel means the operator
 * deliberately asked for the vendor's own default. Compilers and the dispatch
 * override path both treat it as "emit no model flag". The string is namespaced
 * so it can never collide with a real vendor model id.
 */
export const DEFAULT_MODEL_SENTINEL = "muon/default";

/** True when `model` is the explicit Default sentinel (TODO 3.6). */
export function isDefaultModel(
  model: string | null | undefined
): boolean {
  return typeof model === "string" && model.trim() === DEFAULT_MODEL_SENTINEL;
}

export const laneProfileSchema = z.object({
  model: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
  sandbox: sandboxModeSchema.optional(),
  mcpServers: z.array(mcpServerConfigSchema).default([]),
  contextFiles: z.array(z.string()).default([]),
  addDirs: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
  deniedTools: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Raw CLI flags appended verbatim to the lane invocation. */
  extraArgs: z.array(z.string()).default([]),
  /**
   * Vendor-native config fragment: claude settings JSON, codex config.toml
   * keys (compiled to `-c key=value`), cursor config JSON.
   */
  rawConfig: z.record(z.string(), z.unknown()).default({}),
});
export type LaneProfile = z.infer<typeof laneProfileSchema>;

export const emptyLaneProfile: LaneProfile = laneProfileSchema.parse({});

/** Files an adapter wants written into the run cwd before spawning. */
export type ProfileConfigWrite = {
  relativePath: string;
  contents: string;
};

/** Result of compiling a lane profile to a vendor-native invocation. */
export type CompiledProfile = {
  args: string[];
  env: Record<string, string>;
  configWrites: ProfileConfigWrite[];
  /** Capabilities the profile requested but this lane cannot honor. */
  unsupported: string[];
};
