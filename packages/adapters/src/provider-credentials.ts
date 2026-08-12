import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  VENDOR_IDS,
  VENDOR_REGISTRY,
  isVendorId,
  type VendorId,
} from "@muon/protocol";
import { OPERATOR_TOKEN_ENV_VARS } from "./sandbox/credential-policy.js";

export type VendorCredentialMethod =
  | "vendor-login"
  | "api-key"
  | "custom-provider"
  | "local-provider";

export type VendorCredentialEvidence = {
  ready: boolean;
  method?: Exclude<VendorCredentialMethod, "vendor-login">;
  detail?: string;
  environmentKeys: string[];
};

export type CredentialResolverOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readConfig?: (path: string) => string | undefined;
};

const MAX_CONFIG_BYTES = 256 * 1024;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_NAME =
  /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|CREDENTIAL|CREDENTIALS|AUTH)$/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]+$/;

const PROCESS_CONTROL_ENV_KEYS = new Set<string>([
  ...OPERATOR_TOKEN_ENV_VARS,
  "MUON_RUNNER_HOST",
  "MUON_RUNNER_LEASE_TOKEN",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
]);

/**
 * Who owns which API-key name, as `credentials.ownedKeys` in the ADR-0022
 * registry (WAVE C5 — this used to be a hand-written three-vendor table).
 *
 * Total over `VendorId` by construction, so a new vendor must STATE which names
 * it owns; `[]` is the statement opencode makes, being BYO-provider. This is
 * what `isSafeDynamicCredentialKey` refuses against, and it is the only thing
 * stopping a trusted-but-wrong Codex provider config from nominating
 * `ANTHROPIC_API_KEY` as "its" credential — ADR-0022 G5.
 */
const VENDOR_OWNED_CREDENTIAL_KEYS = new Map<VendorId, ReadonlySet<string>>(
  VENDOR_IDS.map((id) => [
    id,
    new Set<string>(VENDOR_REGISTRY[id].credentials.ownedKeys),
  ])
);

function emptyEvidence(): VendorCredentialEvidence {
  return { ready: false, environmentKeys: [] };
}

function hasCredentialValue(
  env: NodeJS.ProcessEnv,
  key: string
): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function defaultReadConfig(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function stripTomlComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(raw: string): string | undefined {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (
    value.length >= 2 &&
    value.startsWith("'") &&
    value.endsWith("'") &&
    !value.slice(1, -1).includes("'")
  ) {
    return value.slice(1, -1);
  }
  return undefined;
}

function parseProviderTable(line: string): string | undefined {
  const unquoted = line.match(
    /^\[\s*model_providers\.([A-Za-z0-9_-]+)\s*\]$/
  );
  if (unquoted) {
    return unquoted[1];
  }
  const quoted = line.match(
    /^\[\s*model_providers\.(?:"([^"]+)"|'([^']+)')\s*\]$/
  );
  const provider = quoted?.[1] ?? quoted?.[2];
  return provider && PROVIDER_ID.test(provider) ? provider : undefined;
}

type ParsedCodexProvider = {
  valid: boolean;
  activeProvider?: string;
  environmentKey?: string;
};

function parseCodexProviderConfig(text: string): ParsedCodexProvider {
  let scope: "root" | "provider" | "other" = "root";
  let currentProvider: string | undefined;
  let activeProvider: string | undefined;
  let activeProviderSeen = false;
  let valid = true;
  const providerTables = new Set<string>();
  const providerEnvironmentKeys = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      const provider = parseProviderTable(line);
      if (provider) {
        if (providerTables.has(provider)) {
          valid = false;
        }
        providerTables.add(provider);
        scope = "provider";
        currentProvider = provider;
      } else {
        scope = "other";
        currentProvider = undefined;
      }
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }
    const [, key, rawValue] = assignment;
    if (scope === "root" && key === "model_provider") {
      const value = parseTomlString(rawValue);
      if (
        activeProviderSeen ||
        value === undefined ||
        !PROVIDER_ID.test(value)
      ) {
        valid = false;
      } else {
        activeProvider = value;
        activeProviderSeen = true;
      }
      continue;
    }
    if (
      scope === "provider" &&
      currentProvider &&
      key === "env_key"
    ) {
      const value = parseTomlString(rawValue);
      if (
        providerEnvironmentKeys.has(currentProvider) ||
        value === undefined
      ) {
        valid = false;
      } else {
        providerEnvironmentKeys.set(currentProvider, value);
      }
    }
  }

  const selected = activeProvider ?? "openai";
  if (!valid) {
    return { valid: false };
  }
  if (selected !== "openai" && !providerTables.has(selected)) {
    return { valid: false };
  }
  return {
    valid: true,
    activeProvider: selected,
    environmentKey: providerEnvironmentKeys.get(selected),
  };
}

/**
 * The operator's ACTIVE non-`openai` Codex model provider, by id, or `undefined`
 * when there is none (or the config is unreadable/contradictory).
 *
 * Read by the ambient-config guard, and only to REFUSE. MUON's isolated
 * `CODEX_HOME` carries no `config.toml`, so a governed child cannot see the
 * operator's `[model_providers.*]` block and would silently fall back to the
 * built-in `openai` provider — i.e. to a DIFFERENT ACCOUNT than the one the
 * operator configured. Codex's own capability preflight already refuses to
 * start a turn when the active custom provider's credential is unavailable to
 * the child; this is the same refusal moved to the one place that can still
 * see both sides.
 *
 * Returns an ID only. No credential value is read, compared, or returned — the
 * provider table's `env_key` is a NAME, and even that is not surfaced here.
 */
export function readCodexActiveCustomProvider(
  codexHome: string,
  readConfig: (path: string) => string | undefined = defaultReadConfig
): string | undefined {
  const config = readConfig(join(codexHome, "config.toml"));
  if (config === undefined) {
    return undefined;
  }
  const parsed = parseCodexProviderConfig(config);
  // An INVALID config is not evidence of a custom provider. Refusing on it
  // would fail every governed Codex run for an operator whose personal config
  // has an unrelated duplicate key — a config MUON no longer even reads.
  if (!parsed.valid || !parsed.activeProvider) {
    return undefined;
  }
  return parsed.activeProvider === "openai" ? undefined : parsed.activeProvider;
}

export function isSafeDynamicCredentialKey(
  vendor: string,
  key: string
): boolean {
  if (
    !ENVIRONMENT_NAME.test(key) ||
    !CREDENTIAL_NAME.test(key) ||
    key.startsWith("MUON_") ||
    PROCESS_CONTROL_ENV_KEYS.has(key)
  ) {
    return false;
  }
  for (const [owner, keys] of VENDOR_OWNED_CREDENTIAL_KEYS) {
    if (owner !== vendor && keys.has(key)) {
      return false;
    }
  }
  return true;
}

function directApiKeyEvidence(
  env: NodeJS.ProcessEnv,
  key: string,
  detail: string
): VendorCredentialEvidence {
  return hasCredentialValue(env, key)
    ? {
        ready: true,
        method: "api-key",
        detail,
        environmentKeys: [key],
      }
    : emptyEvidence();
}

function codexEvidence(
  options: CredentialResolverOptions,
  env: NodeJS.ProcessEnv,
  owned: OwnedCredential
): VendorCredentialEvidence {
  const homeDir = options.homeDir ?? homedir();
  const configuredHome = env.CODEX_HOME;
  const codexHome =
    configuredHome && isAbsolute(configuredHome)
      ? configuredHome
      : join(homeDir, ".codex");
  const readConfig = options.readConfig ?? defaultReadConfig;
  const config = readConfig(join(codexHome, "config.toml"));
  if (config === undefined) {
    return directApiKeyEvidence(env, owned.key, owned.detail);
  }

  const parsed = parseCodexProviderConfig(config);
  if (!parsed.valid || !parsed.activeProvider) {
    return emptyEvidence();
  }
  if (parsed.activeProvider === "openai") {
    return directApiKeyEvidence(env, owned.key, owned.detail);
  }

  const key = parsed.environmentKey;
  if (!key || !isSafeDynamicCredentialKey(owned.vendor, key)) {
    return emptyEvidence();
  }
  return hasCredentialValue(env, key)
    ? {
        ready: true,
        method: "custom-provider",
        detail: "configured with the active Codex provider",
        environmentKeys: [key],
      }
    : {
        ready: false,
        method: "custom-provider",
        detail: "the active Codex provider credential is not configured",
        environmentKeys: [key],
      };
}

/**
 * Vendors whose credential evidence needs MORE than "is the owned API key set".
 *
 * A total `Record<VendorId, …>` (ADR-0022 §3.4 mechanism 4): `null` is the
 * statement "the owned key is the whole story", so a new vendor cannot inherit
 * Codex's config-file resolver by accident, and cannot inherit the plain path
 * either — it has to type one of the two.
 *
 * The PARSING stays here rather than in the registry on purpose. ADR-0022 §6.2:
 * each vendor's status/config output differs and the parsing is
 * security-relevant, so the registry names which interpreter runs; it never
 * encodes how the interpreting is done.
 */
const VENDOR_CREDENTIAL_RESOLVERS: {
  readonly [K in VendorId]:
    | ((
        options: CredentialResolverOptions,
        env: NodeJS.ProcessEnv,
        owned: OwnedCredential
      ) => VendorCredentialEvidence)
    | null;
} = {
  "claude-code": null,
  codex: codexEvidence,
  cursor: null,
  // BYO-provider: `opencode auth login` writes its own `auth.json`, which MUON
  // neither reads nor relocates. There is no env credential to resolve.
  opencode: null,
  // The dev/test double never authenticates.
  fake: null,
};

/** The single API-key name a vendor owns, with its user-facing prose. */
type OwnedCredential = {
  readonly vendor: VendorId;
  readonly key: string;
  readonly detail: string;
};

function ownedCredential(vendor: VendorId): OwnedCredential | undefined {
  const entry = VENDOR_REGISTRY[vendor];
  const key = entry.credentials.ownedKeys[0];
  return key === undefined
    ? undefined
    : {
        vendor,
        key,
        // Reproduces the three hand-written strings verbatim: "Claude Code",
        // "Codex", "Cursor" are exactly these vendors' `displayName`s.
        detail: `configured with a ${entry.displayName} API key`,
      };
}

/**
 * WAVE C5: keyed by `VendorId` off the registry instead of three `vendor ===`
 * branches. Fail-closed twice over — an id outside the registry, and a
 * registered vendor that owns no key, both answer "no evidence" rather than
 * falling through to someone else's credential (ADR-0022 G5).
 */
export function resolveVendorCredentialEvidence(
  vendor: string,
  options: CredentialResolverOptions = {}
): VendorCredentialEvidence {
  const env = options.env ?? process.env;
  if (!isVendorId(vendor)) {
    return emptyEvidence();
  }
  const owned = ownedCredential(vendor);
  if (!owned) {
    return emptyEvidence();
  }
  const resolver = VENDOR_CREDENTIAL_RESOLVERS[vendor];
  return resolver
    ? resolver(options, env, owned)
    : directApiKeyEvidence(env, owned.key, owned.detail);
}
