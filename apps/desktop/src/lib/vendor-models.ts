/**
 * Live / fallback model catalogs for the Mission Agent config menu.
 *
 * TODO 3.1: prefer the vendor CLI when a listing command exists —
 *   `codex debug models`, `cursor-agent models` / `--list-models`,
 *   `opencode models`. Claude Code has no model-listing command, so it stays
 *   on hardcoded latest-tier aliases + allowCustom.
 */

import {
  VENDOR_CAPABILITY_DESCRIPTORS,
  type VendorKey,
} from "@muon/adapters/vendor-capabilities";
import { VENDOR_IDS, type VendorId } from "@muon/client/vendors";
import { execFile } from "node:child_process";
import { readFile as readFileFs } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type VendorModelOption = {
  id: string;
  label: string;
  /** Effort levels this model advertises (Codex catalog); empty → use defaults. */
  efforts: string[];
  defaultEffort?: string;
};

export type VendorModelCatalog = {
  vendor: VendorId;
  source: "cli" | "fallback";
  models: VendorModelOption[];
};

const CLAUDE_FALLBACK: VendorModelOption[] = [
  { id: "fable", label: "Fable (latest)", efforts: ["low", "medium", "high"] },
  { id: "opus", label: "Opus (latest)", efforts: ["low", "medium", "high"] },
  { id: "sonnet", label: "Sonnet (latest)", efforts: ["low", "medium", "high"] },
  { id: "haiku", label: "Haiku (latest)", efforts: ["low", "medium", "high"] },
];

const CODEX_FALLBACK: VendorModelOption[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "low",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    efforts: ["low", "medium", "high"],
    defaultEffort: "low",
  },
];

/**
 * TODO 3.2: probed on `cursor-agent 2026.07.23-e383d2b` (`cursor-agent models`).
 * The old `["auto","sonnet","opus","gpt-5.6-sol"]` list contained NONE of the
 * account's live ids verbatim. This fallback is a short CURRENT slice for when
 * the CLI probe fails; live discovery (below) is the picker source of truth.
 */
const CURSOR_FALLBACK: VendorModelOption[] = [
  { id: "auto", label: "Auto (default)", efforts: ["low", "medium", "high"] },
  {
    id: "gpt-5.6-sol-high",
    label: "GPT-5.6 Sol 1M High",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-opus-5-thinking-high",
    label: "Opus 5 1M Thinking",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-fable-5-thinking-high",
    label: "Fable 5 1M Thinking",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "kimi-k3-high",
    label: "Kimi K3 High",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "cursor-grok-4.5-high",
    label: "Cursor Grok 4.5",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "composer-2.5",
    label: "Composer 2.5",
    efforts: ["low", "medium", "high"],
  },
];

type CodexDebugModel = {
  slug?: string;
  display_name?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
};

function parseCodexDebugModels(stdout: string): VendorModelOption[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as {
    models?: CodexDebugModel[];
  };
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return models
    .filter(
      (entry) =>
        typeof entry.slug === "string" &&
        entry.slug.length > 0 &&
        entry.visibility !== "hidden" &&
        entry.slug !== "codex-auto-review"
    )
    .map((entry) => {
      const efforts = (entry.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter((effort): effort is string => typeof effort === "string")
        // Ultra is a multi-agent mode in Codex UI — keep single-agent efforts.
        .filter((effort) => effort !== "ultra");
      return {
        id: entry.slug!,
        label: entry.display_name ?? entry.slug!,
        efforts: efforts.length > 0 ? efforts : ["low", "medium", "high", "xhigh"],
        defaultEffort: entry.default_reasoning_level,
      };
    });
}

/**
 * WAVE D: a TOTAL `Record<VendorId, …>`, so a new vendor must state its
 * catalogue rather than inherit one. `[]` is the honest answer for a lane whose
 * models are whatever the operator configured.
 *
 * This totality is load-bearing, not cosmetic. Before it, `listVendorModels`
 * was typed to three vendors and any other id fell THROUGH to the Codex branch —
 * so widening the parameter without this table would have made "list OpenCode's
 * models" spawn the Codex binary and return Codex's catalogue.
 */
const VENDOR_FALLBACK_MODELS: Record<VendorId, VendorModelOption[]> = {
  "claude-code": CLAUDE_FALLBACK,
  codex: CODEX_FALLBACK,
  cursor: CURSOR_FALLBACK,
  // EMPTY ON PURPOSE, and TODO 3.4 did not change it. opencode's ids are now
  // VALIDATED (registry `idShape`), but validating a form is not the same as
  // knowing a list: which `provider/model` pairs exist is a fact about THIS
  // machine's authed providers, so the only honest offline answer is "none —
  // run the live probe". A fallback here would suggest models the operator's
  // account may not have.
  opencode: [],
  fake: [],
};

/**
 * Parse `cursor-agent models` / `--list-models` text:
 *   `<id> - <label>`
 * Header lines ("Available models") and blanks are skipped.
 */
function parseCursorModels(stdout: string): VendorModelOption[] {
  const models: VendorModelOption[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^available models$/i.test(trimmed)) continue;
    const sep = trimmed.indexOf(" - ");
    const rawId = (sep >= 0 ? trimmed.slice(0, sep) : trimmed).trim();
    const rawLabel = (sep >= 0 ? trimmed.slice(sep + 3) : rawId).trim();
    const id = boundedModelId(rawId);
    if (!id || seen.has(id) || /\s/.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: rawLabel.slice(0, 120) || id,
      efforts: ["low", "medium", "high"],
    });
  }
  return models;
}

/**
 * Parse `opencode models` — one `provider/model` id per line (models.dev-backed).
 */
function parseOpencodeModels(stdout: string): VendorModelOption[] {
  const models: VendorModelOption[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const id = boundedModelId(line.trim());
    if (!id || seen.has(id) || !id.includes("/") || /\s/.test(id)) continue;
    seen.add(id);
    models.push({ id, label: id, efforts: [] });
  }
  return models;
}

type CliCatalogProbe = {
  file: string;
  args: readonly string[];
  parse: (stdout: string) => VendorModelOption[];
};

/** Vendors with a live listing command. Claude stays fallback-only (no CLI list). */
const CLI_CATALOG_PROBES: Partial<Record<VendorId, CliCatalogProbe>> = {
  codex: {
    file: "codex",
    args: ["debug", "models"],
    parse: parseCodexDebugModels,
  },
  cursor: {
    file: "cursor-agent",
    args: ["models"],
    parse: parseCursorModels,
  },
  opencode: {
    file: "opencode",
    args: ["models"],
    parse: parseOpencodeModels,
  },
};

export async function listVendorModels(
  vendor: VendorId
): Promise<VendorModelCatalog> {
  const probe = CLI_CATALOG_PROBES[vendor];
  if (!probe) {
    return {
      vendor,
      source: "fallback",
      models: VENDOR_FALLBACK_MODELS[vendor] ?? [],
    };
  }
  try {
    const { stdout } = await execFileAsync(probe.file, [...probe.args], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, TERM: "dumb" },
    });
    const models = probe.parse(String(stdout));
    if (models.length > 0) {
      return { vendor, source: "cli", models };
    }
  } catch {
    // Fall through to the static latest-known list.
  }
  return {
    vendor,
    source: "fallback",
    models: VENDOR_FALLBACK_MODELS[vendor] ?? [],
  };
}

/** Static known ids (S5 descriptor) — used when CLI fetch is unavailable. */
export function fallbackKnownModels(vendor: VendorId): string[] {
  return (
    VENDOR_CAPABILITY_DESCRIPTORS[vendor as VendorKey]?.models?.known ?? []
  );
}

/** Guard for an IPC-supplied vendor id. The renderer is untrusted. */
export function isVendorModelTarget(value: unknown): value is VendorId {
  return (
    typeof value === "string" && (VENDOR_IDS as readonly string[]).includes(value)
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * U2 — "Vendor default" is not a model name.
 *
 * "Vendor default" is a placeholder for "MUON named no model", which is a fact
 * about MUON, not an answer to "what is this agent running on". The vendor
 * itself knows, and some vendor CLIs will say so out loud. This resolves the
 * model the VENDOR reports, and — when a vendor reports nothing — says exactly
 * that instead of printing a placeholder or inventing a name.
 *
 * The probe is DELIBERATELY separate from `listVendorModels`: the catalog is
 * fetched on app settle, and a `codex doctor` costs ~5s, so folding it into the
 * catalog would put a five-second subprocess back on the first paint the
 * previous commit just cleared. Surfaces resolve lazily, and the result is
 * cached + single-flighted so N tabs asking at once is one probe.
 * ──────────────────────────────────────────────────────────────────────────── */

export type VendorModelResolutionState =
  /**
   * The vendor's own configuration named the model it will run — either a CLI
   * that reported it, or the operator's own vendor settings file.
   */
  | "reported"
  /** The vendor was asked and named NO model — a true, different answer. */
  | "not-reported"
  /** The probe could not run (not installed, timed out, unparseable output). */
  | "probe-failed"
  /** MUON has no way to resolve this vendor's model. Stated, not omitted. */
  | "no-probe";

export type VendorModelResolution = {
  vendor: VendorId;
  /** The reported model id, or null. NEVER a placeholder, never a guess. */
  model: string | null;
  state: VendorModelResolutionState;
  /**
   * Provenance: the exact command that reported it, or the settings file the
   * value was read from (home-relative). Always says WHERE the answer came
   * from, so a displayed model is never an unattributed assertion.
   */
  probe?: string;
  /** Why nothing was reported — shown verbatim so a failure is never silent. */
  reason?: string;
};

type DefaultModelProbe = {
  file: string;
  args: readonly string[];
  /** Read the CLI's OWN report. Returns null when it reported no model. */
  parse: (stdout: string) => string | null;
};

/**
 * Bound + sanitize a vendor-reported model id before it reaches the UI. This is
 * untrusted input (subprocess stdout, or a settings file MUON did not write)
 * rendered as a label, so it is reduced to the character class a model slug can
 * legitimately use.
 *
 * `[` and `]` are IN that class: Claude Code's context-window variants are
 * spelled `opus[1m]` / `sonnet[1m]`, and stripping the brackets would print
 * `opus1m` — a model name that does not exist. A sanitizer that silently
 * rewrites the answer is worse than one that rejects it, so the bracket pair is
 * allowed through. Nothing here is markup-significant: every consumer renders
 * it as React text or an attribute value, both of which escape on write.
 */
function boundedModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._:/@[\]-]/g, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * `codex doctor --json` is Codex's own redacted, machine-readable report of the
 * config it resolved — `checks.config.load.details.model` is the exact slug the
 * interactive banner prints. Read only that field; everything else in the
 * report is diagnostics MUON has no business displaying.
 */
function parseCodexDoctorModel(stdout: string): string | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as {
    checks?: {
      config?: { load?: { details?: Record<string, unknown> } };
    };
  };
  return boundedModelId(parsed.checks?.config?.load?.details?.["model"]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * D1 — reading a preference the user SET is not going behind their back.
 *
 * An earlier revision of this file refused to resolve Claude Code's model on
 * the grounds that MUON "does not read the operator's settings file behind
 * their back". That conflated two different acts, so the distinction is stated
 * here rather than left to be re-litigated:
 *
 *   - Reading a CREDENTIAL (an API key, an OAuth token, a keychain entry) is
 *     taking something the user gave to ANOTHER party, for MUON's own use.
 *     MUON does not do that, and nothing below can: the reader extracts the
 *     `model` key and discards the parsed object without ever looking at,
 *     logging, or forwarding another field.
 *
 *   - Reading a DISPLAY PREFERENCE the user themselves configured, in order to
 *     show it back to them inside their own app, is the opposite act. It is the
 *     app knowing what the user set. Refusing to read it does not protect the
 *     user; it just makes MUON claim ignorance of a fact it is standing on top
 *     of, and prints "not reported" over an answer that is right there.
 *
 * So MUON resolves it — and only it. What is read is one string key from a
 * fixed list of well-known settings paths. What is displayed always names the
 * file it came from, so the user can see exactly which of their own settings
 * MUON is echoing. Nothing here is dispatched: `validateModelForVendor` remains
 * the sole authority over which model a run actually uses, and this resolution
 * never reaches it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One tier of a vendor's settings cascade: where to look, and what to call it. */
type SettingsModelSource = {
  /** Absolute path to the settings file. */
  file: string;
  /** Home-relative display form — provenance the user can recognise. */
  display: string;
};

/**
 * Claude Code's settings cascade, HIGHEST precedence first.
 *
 * This mirrors the order Claude Code itself honours, so MUON reports the model
 * Claude Code would actually resolve rather than whichever file MUON happened
 * to read:
 *
 *   1. Enterprise managed policy  — admin-managed settings, which `claude
 *      --help` notes "still apply" even in safe mode. It outranks everything
 *      the user can write, so it must be consulted FIRST; reading the user file
 *      first would report a model a policy has already overridden.
 *   2. `<project>/.claude/settings.local.json` — the operator's personal,
 *      un-checked-in override for this project.
 *   3. `<project>/.claude/settings.json`       — the project's shared settings.
 *   4. `<config>/settings.json`                — the user's global settings
 *      (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when the operator relocated it).
 *
 * The one tier deliberately absent is command-line arguments, which sit between
 * (1) and (2). MUON passes no `--model` when it names no model — that is the
 * exact case this resolver answers — so there is no argument to consult. If
 * MUON ever did name one, `explicitModel` on the display side already wins, and
 * this resolver is not consulted at all.
 *
 * `projectDir` is supplied by trusted main from the workspace it bound, never
 * by the renderer. A surface cannot ask MUON to read `.claude/settings.json`
 * out of a directory of its choosing.
 */
function claudeCodeSettingsCascade(ctx: {
  projectDir: string | null;
  home: string;
  configDir: string | null;
  platform: NodeJS.Platform;
}): SettingsModelSource[] {
  const sources: SettingsModelSource[] = [];
  const managed = managedPolicySettingsPath(ctx.platform);
  if (managed) sources.push({ file: managed, display: managed });
  if (ctx.projectDir) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const file = path.join(ctx.projectDir, ".claude", name);
      sources.push({ file, display: homeRelative(file, ctx.home) });
    }
  }
  const userDir = ctx.configDir || path.join(ctx.home, ".claude");
  const userFile = path.join(userDir, "settings.json");
  sources.push({ file: userFile, display: homeRelative(userFile, ctx.home) });
  return sources;
}

/** Where the admin-managed policy file lives, per platform. */
function managedPolicySettingsPath(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = process.env["PROGRAMDATA"];
    return programData
      ? path.join(programData, "ClaudeCode", "managed-settings.json")
      : "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
  }
  return "/etc/claude-code/managed-settings.json";
}

/** `~/.claude/settings.json`, not `/Users/<name>/…` — shorter, and no username. */
function homeRelative(file: string, home: string): string {
  return home && file.startsWith(home + path.sep)
    ? `~${file.slice(home.length)}`
    : file;
}

type SettingsModelRead =
  /** The file parsed and named a model. */
  | { outcome: "model"; model: string }
  /** No such file — the overwhelmingly common, entirely fine case. */
  | { outcome: "absent" }
  /** The file parsed but sets no usable `model`. */
  | { outcome: "unset" }
  /** The file exists but could not be read or parsed as JSON. */
  | { outcome: "unreadable" };

/**
 * Read EXACTLY the `model` key out of one settings file.
 *
 * Two properties are load-bearing and must not be relaxed:
 *
 *   - Only `model` is extracted. The parsed object is not stored, not logged,
 *     not returned, and no other key is touched. These files hold API-key
 *     helpers, env blocks, hook commands, and permission rules; none of it is
 *     MUON's to see, and none of it can escape this function.
 *   - A parse failure is swallowed, never propagated. `JSON.parse`'s own
 *     SyntaxError embeds a SNIPPET OF THE FILE in its message on modern V8
 *     ("...\"apiKey\": \"sk-…\"... is not valid JSON"). Surfacing that message
 *     as a `reason` would print the very contents this function exists to not
 *     read. The caller gets an outcome, never the error.
 */
async function readSettingsModel(
  file: string,
  readFile: (file: string) => Promise<string>
): Promise<SettingsModelRead> {
  let raw: string;
  try {
    raw = await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // ENOENT/ENOTDIR is "you have not configured this tier", not a fault.
    return code === "ENOENT" || code === "ENOTDIR"
      ? { outcome: "absent" }
      : { outcome: "unreadable" };
  }
  let model: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { outcome: "unreadable" };
    }
    model = (parsed as Record<string, unknown>)["model"];
  } catch {
    // Deliberately no `error` in scope past this point — see the note above.
    return { outcome: "unreadable" };
  }
  if (model === undefined || model === null || model === "") {
    return { outcome: "unset" };
  }
  const bounded = boundedModelId(model);
  return bounded ? { outcome: "model", model: bounded } : { outcome: "unset" };
}

/** Walk a vendor's settings cascade top-down; the first tier that names a model wins. */
async function resolveFromSettingsCascade(
  vendor: VendorId,
  sources: SettingsModelSource[],
  readFile: (file: string) => Promise<string>
): Promise<VendorModelResolution> {
  const checked: string[] = [];
  const unreadable: string[] = [];
  for (const source of sources) {
    const read = await readSettingsModel(source.file, readFile);
    if (read.outcome === "model") {
      return {
        vendor,
        model: read.model,
        state: "reported",
        probe: source.display,
      };
    }
    if (read.outcome === "unreadable") unreadable.push(source.display);
    if (read.outcome !== "absent") checked.push(source.display);
  }
  // Missing, unparseable, or key-unset all land here: MUON genuinely does not
  // know, and says so. No tier invents a default to fill the gap.
  const looked = sources.map((source) => source.display).join(", ");
  const parts = [`No ${vendorProseName(vendor)} settings file names a model.`];
  if (unreadable.length > 0) {
    parts.push(`${unreadable.join(", ")} could not be read as JSON.`);
  }
  parts.push(`Looked in: ${looked}.`);
  return {
    vendor,
    model: null,
    state: "not-reported",
    ...(checked.length > 0 ? { probe: checked[0] } : {}),
    reason: parts.join(" "),
  };
}

function vendorProseName(vendor: VendorId): string {
  return vendor === "claude-code" ? "Claude Code" : vendor;
}

/**
 * TOTAL over `VendorId` — a new vendor must STATE that it has no probe rather
 * than inherit one by omission (the same totality rule the fallback catalogue
 * and the terminal allowlist follow). `null` renders as "no probe", which the
 * UI reports honestly; it never degrades into another vendor's answer.
 */
const VENDOR_DEFAULT_MODEL_PROBES: Readonly<
  Record<VendorId, DefaultModelProbe | null>
> = {
  codex: {
    file: "codex",
    args: ["doctor", "--json"],
    parse: parseCodexDoctorModel,
  },
  // claude-code does NOT go through a subprocess. It resolves from the
  // operator's own settings cascade — see `claudeCodeSettingsCascade` and the
  // credential-vs-preference note above it.
  "claude-code": null,
  // `cursor-agent --list-models` enumerates; it marks no default.
  cursor: null,
  // OpenCode's model is whatever the operator configured per provider.
  opencode: null,
  fake: null,
};

/**
 * Vendors resolved by reading their own settings cascade rather than by
 * spawning anything. TOTAL by the same rule as the probe table: a vendor absent
 * from here has no cascade, which is stated, not inferred.
 */
const VENDOR_SETTINGS_CASCADES: Readonly<
  Record<
    VendorId,
    ((ctx: {
      projectDir: string | null;
      home: string;
      configDir: string | null;
      platform: NodeJS.Platform;
    }) => SettingsModelSource[]) | null
  >
> = {
  "claude-code": claudeCodeSettingsCascade,
  codex: null,
  cursor: null,
  opencode: null,
  fake: null,
};

const PROBE_TIMEOUT_MS = 15_000;
const RESOLUTION_TTL_MS = 5 * 60_000;

const resolutionCache = new Map<
  string,
  { at: number; value: VendorModelResolution }
>();
/** Single-flight: N surfaces asking at once is ONE subprocess, not N. */
const resolutionInFlight = new Map<string, Promise<VendorModelResolution>>();

/**
 * The cache is keyed by vendor AND project, not by vendor alone. A vendor's
 * settings cascade includes a project tier, so the same vendor legitimately
 * resolves to different models in different workspaces; a vendor-only key would
 * serve workspace A's answer under workspace B's label — the exact one-fact,
 * two-answers drift this change exists to close.
 */
function resolutionKey(vendor: VendorId, projectDir: string | null): string {
  return `${vendor} ${projectDir ?? ""}`;
}

export type VendorModelProbeDeps = {
  /** Injected in tests so the resolver is provable without a vendor CLI. */
  run?: (
    file: string,
    args: readonly string[]
  ) => Promise<{ stdout: string }>;
  /** Injected in tests so the resolver never reads the developer's real files. */
  readFile?: (file: string) => Promise<string>;
  /**
   * The workspace whose project-tier settings apply. Supplied by trusted main
   * from the bound workspace — NEVER by the renderer, which must not be able to
   * name a directory for MUON to read.
   */
  projectDir?: string | null;
  home?: string;
  configDir?: string | null;
  platform?: NodeJS.Platform;
  now?: () => number;
};

/** True when a test injected a source; caching is bypassed so tests cannot bleed. */
function hasInjectedSource(deps: VendorModelProbeDeps): boolean {
  return deps.run !== undefined || deps.readFile !== undefined;
}

/** Drop cached resolutions (tests, and an explicit operator re-probe). */
export function resetVendorModelResolutions(): void {
  resolutionCache.clear();
  resolutionInFlight.clear();
}

async function probeVendorModel(
  vendor: VendorId,
  deps: VendorModelProbeDeps
): Promise<VendorModelResolution> {
  const cascade = VENDOR_SETTINGS_CASCADES[vendor];
  if (cascade) {
    const home = deps.home ?? homedir();
    const sources = cascade({
      projectDir: deps.projectDir ?? null,
      home,
      configDir:
        deps.configDir !== undefined
          ? deps.configDir
          : process.env["CLAUDE_CONFIG_DIR"]?.trim() || null,
      platform: deps.platform ?? process.platform,
    });
    const readFile =
      deps.readFile ?? ((file: string) => readFileFs(file, "utf8"));
    return resolveFromSettingsCascade(vendor, sources, readFile);
  }
  const probe = VENDOR_DEFAULT_MODEL_PROBES[vendor];
  if (!probe) {
    return {
      vendor,
      model: null,
      state: "no-probe",
      reason: `${vendor} exposes no non-interactive command that reports its model.`,
    };
  }
  const command = [probe.file, ...probe.args].join(" ");
  const run =
    deps.run ??
    ((file: string, args: readonly string[]) =>
      execFileAsync(file, [...args], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TERM: "dumb" },
      }).then(({ stdout }) => ({ stdout: String(stdout) })));
  try {
    const { stdout } = await run(probe.file, probe.args);
    const model = probe.parse(stdout);
    if (model) {
      return { vendor, model, state: "reported", probe: command };
    }
    return {
      vendor,
      model: null,
      state: "not-reported",
      probe: command,
      reason: `${command} ran but named no model.`,
    };
  } catch (error) {
    return {
      vendor,
      model: null,
      state: "probe-failed",
      probe: command,
      reason:
        error instanceof Error
          ? `${command} failed: ${error.message.slice(0, 200)}`
          : `${command} failed.`,
    };
  }
}

/**
 * The model this vendor reports it will run when MUON names none.
 *
 * Cached for {@link RESOLUTION_TTL_MS} and single-flighted. A failure is cached
 * too — a missing CLI must not turn every tab open into another 15s timeout —
 * but it is cached as a FAILURE, so the surface still says why.
 *
 * NOTHING calls this on the app-settle path. It is invoked only by a surface
 * that is about to display the answer (the agent menu opening or taking hover
 * focus, the Crew page mounting), so neither the subprocess probe nor the
 * settings read can land in front of first paint.
 */
export async function resolveVendorModel(
  vendor: VendorId,
  deps: VendorModelProbeDeps = {}
): Promise<VendorModelResolution> {
  const now = deps.now ?? Date.now;
  const injected = hasInjectedSource(deps);
  const key = resolutionKey(vendor, deps.projectDir ?? null);
  if (!injected) {
    const cached = resolutionCache.get(key);
    if (cached && now() - cached.at < RESOLUTION_TTL_MS) {
      return cached.value;
    }
    const pending = resolutionInFlight.get(key);
    if (pending) return pending;
  }
  const request = probeVendorModel(vendor, deps).then((value) => {
    if (!injected) {
      resolutionCache.set(key, { at: now(), value });
      resolutionInFlight.delete(key);
    }
    return value;
  });
  if (!injected) {
    resolutionInFlight.set(key, request);
  }
  return request;
}
