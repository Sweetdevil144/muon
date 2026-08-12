import { z } from "zod";

/**
 * ADR-0038 slice 1 — DISCOVER.
 *
 * WIRED, as of 2026-08-08/09. `discoverCompatibilityInventory` (backend) reads
 * the vendor configs through this module, `GET /api/compatibility/mcp` serves
 * the result, and `muon compat mcp` prints it. An earlier revision of this
 * header warned that nothing called any of it — true then, and left here as a
 * note rather than deleted because it was the accurate description of a
 * security-sensitive parser shipping ahead of its consumer.
 *
 * WHAT IS STILL TRUE, and is the design rather than the state of the work:
 * nothing IN THIS FILE grants anything. Discovery is a read. The authority
 * half lives in `compatibility-enable.ts`, added once the founder answered the
 * ADR's two open questions (D7: MCP servers only; D8: agent-dispatched lanes,
 * bound per lane, human enable only, re-attested per run). No function here
 * may be extended into an enable — that would put the grant inside the parser
 * that reads untrusted configuration, which is the one place it must not be.
 *
 * Feature #12 closes v0.0.1 P0.2: a developer arriving at MUON already has MCP
 * servers configured for `claude` or `codex`, and today MUON ignores all of
 * it. Adopting MUON therefore means rebuilding that setup by hand, or running
 * two configurations that quietly disagree.
 *
 * ADR-0038 D1 splits the feature in two, and this file is the FIRST half:
 * read the vendor's configuration, inventory each item, fingerprint it, record
 * where it came from. That is a read. It grants nothing, it enables nothing,
 * and there is deliberately no function here that could.
 *
 * The second half — ENABLE, binding one item to one lane — is an authority act
 * and is not implemented: it waits on the two open questions ADR-0038 leaves
 * to the founder. Nothing in this module may be extended into it without
 * revisiting that ADR.
 */

/** ADR-0038 D1: the ONLY state a discovered item can be in. */
export const IMPORT_STATE_DISCOVERED = "discovered" as const;

export const importedItemSchema = z.object({
  /** Slice 1 handles MCP servers only — ADR-0038's open question 1. */
  kind: z.literal("mcp_server"),
  name: z.string().min(1).max(128),
  /**
   * ADR-0038 D4. Where this came from, for the human's judgment and the audit
   * trail. It is NEVER an input to an allow decision: "it was already in your
   * ~/.claude.json" is exactly what a drifted or compromised config also
   * shows.
   */
  provenance: z.object({
    vendor: z.string().min(1).max(64),
    sourcePath: z.string().min(1).max(1024),
  }),
  /** The item's shape, secrets excluded. See `secretsRefused`. */
  shape: z.object({
    transport: z.enum(["stdio", "http", "sse", "unknown"]),
    command: z.string().max(512).optional(),
    args: z.array(z.string().max(512)).max(64).default([]),
    url: z.string().max(1024).optional(),
    /** Env variable NAMES only. Values are never read into MUON. */
    envKeys: z.array(z.string().max(128)).max(64).default([]),
    /** Header NAMES only, same rule. */
    headerKeys: z.array(z.string().max(128)).max(32).default([]),
  }),
  /**
   * ADR-0038 D5. The credential-bearing keys MUON deliberately did NOT import.
   * Present so the human is told the item needs a secret they must supply
   * through the vendor's own path — MUON must not become a second place the
   * user's secrets live.
   */
  secretsRefused: z.array(z.string().max(128)).max(96).default([]),
  state: z.literal(IMPORT_STATE_DISCOVERED),
});
export type ImportedItem = z.infer<typeof importedItemSchema>;

export type DiscoverySource = {
  vendor: string;
  /** Absolute path of the file the configuration was read from. */
  sourcePath: string;
  /** Already-parsed configuration. This module never touches a filesystem. */
  config: unknown;
};

export type DiscoveryResult = {
  readonly items: readonly ImportedItem[];
  /**
   * Entries that looked like a server but could not be read as one. Reported
   * rather than dropped: a config MUON could not parse is a fact the human
   * needs, and silently showing 4 of 5 servers is how an import surface lies.
   */
  readonly unreadable: readonly { readonly name: string; readonly reason: string }[];
};

/**
 * Names whose VALUE is treated as a credential no matter what it contains.
 *
 * Deliberately generous and deliberately not clever: this decides what MUON
 * refuses to copy, so over-refusing costs a human one manual step while
 * under-refusing puts a secret in MUON's store. There is no allowlist
 * counterpart — a name that matches nothing here still has its value dropped
 * (see `readEnvKeys`), because EVERY env value is refused. This list only
 * decides which keys are REPORTED to the human as needing a credential.
 */
const CREDENTIAL_NAME = /(key|token|secret|password|passwd|credential|auth|bearer|session|cookie|private|signature|access)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Env/header NAMES, never values.
 *
 * The value is not "sanitized" or "redacted" here — it is never read into a
 * variable that outlives this function. An importer that copies an env block
 * and marks it secret is still a credential store; the only safe handling is
 * not to carry it.
 */
function readNameOnly(source: unknown, limit: number): string[] {
  if (!isRecord(source)) return [];
  return Object.keys(source)
    .filter((key) => key.trim() !== "")
    .slice(0, limit)
    // TRUNCATE rather than let one long name fail the whole record. An earlier
    // revision capped the COUNT but not the LENGTH, so a 129-character env key
    // failed safeParse and discarded the entire server with an unactionable
    // "configuration did not fit MUON's record".
    .map((key) => key.slice(0, 128));
}

const REDACTED = "***";

/**
 * Shapes that are a secret wherever they appear. Deliberately generous: this
 * decides what MUON refuses to carry, and over-refusing costs a human one
 * manual step while under-refusing puts their token in MUON's store.
 */
const SECRET_VALUE = [
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+\S{8,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  // A long opaque run with no separators is a key far more often than a word.
  /(?:^|[=/:,\s])[A-Za-z0-9_-]{28,}(?:$|[/,\s])/,
] as const;

function looksSecret(value: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(value));
}

/**
 * A URL PATH SEGMENT is judged more harshly than a value in general.
 *
 * `looksSecret`'s catch-all needs a 28-character opaque run, which is right
 * for arbitrary text and wrong here: a review found
 * `https://mcp.example.com/s/SUPERSECRETKEYVALUE123456/mcp` — a 24-character
 * key — sailing through, so MUON carried the credential AND reported that it
 * had refused nothing. Remote MCP endpoints put keys in the path routinely
 * (`/s/<key>/mcp`, `/mcp/<token>`), and a path segment is not prose: sixteen
 * opaque characters with no vowel-and-separator structure is a key far more
 * often than a word. Over-refusing costs a human one manual step; the other
 * direction puts their token in MUON's store, which D5 forbids outright.
 */
function looksSecretPathSegment(segment: string): boolean {
  if (looksSecret(segment)) return true;
  return /^[A-Za-z0-9_-]{16,}$/.test(segment) && /[0-9]/.test(segment) === false
    ? // A long all-letter segment is more likely a word ("documentation");
      // require a digit OR mixed case to call it a key.
      /[a-z]/.test(segment) && /[A-Z]/.test(segment)
    : /^[A-Za-z0-9_-]{16,}$/.test(segment);
}

/**
 * ADR-0038 D5 for the two places an earlier revision let a credential through.
 *
 * `env` and `headers` were handled (names only, values never read). `url` and
 * `args` were copied VERBATIM, and both routinely carry secrets in exactly the
 * shapes remote MCP uses:
 *
 *   url  https://mcp.example.com/api/mcp/s/SUPER_SECRET_KEY/mcp   (path key)
 *        https://alice:hunter2@internal.example.com/mcp           (userinfo)
 *   args ["mcp-remote", url, "--header", "Authorization: Bearer ghp_..."]
 *
 * Worse than carrying them: `secretsRefused` was computed only from env and
 * header NAMES, so all three reported zero refused credentials — the surface
 * told the user the server needed nothing from them while holding their token.
 */
function redactUrl(raw: string): { url: string; refused: string[] } {
  const refused: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not parseable as a URL. Fall back to the value-shape check rather than
    // trusting it: an unparseable string is not a safe string.
    return looksSecret(raw)
      ? { url: REDACTED, refused: ["url"] }
      : { url: raw, refused: [] };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    parsed.username = "";
    parsed.password = "";
    refused.push("url.userinfo");
  }
  if (parsed.search !== "") {
    // Query strings on an MCP endpoint are api keys far more often than not,
    // and MUON does not need them to describe what the server IS.
    parsed.search = "";
    refused.push("url.query");
  }
  if (parsed.hash !== "") {
    // THE SAME ARGUMENT AS THE QUERY STRING, and it was missed. OAuth implicit
    // flows put the token in the fragment by design
    // (`…/mcp#access_token=…`), so this is not a hypothetical shape — it is
    // the standard one. MUON does not need a fragment to describe what a
    // server IS, so it goes unconditionally rather than on a shape guess.
    parsed.hash = "";
    refused.push("url.fragment");
  }
  const segments = parsed.pathname.split("/");
  let pathRedacted = false;
  const safeSegments = segments.map((segment) => {
    if (segment !== "" && looksSecretPathSegment(segment)) {
      pathRedacted = true;
      return REDACTED;
    }
    return segment;
  });
  if (pathRedacted) {
    parsed.pathname = safeSegments.join("/");
    refused.push("url.path");
  }
  return { url: parsed.toString(), refused };
}

/**
 * A flag whose VALUE is a credential, whatever that value happens to look
 * like. `--api-key` / `--token=` / `-H Authorization: …` and friends.
 *
 * This is the half `looksSecret` cannot do. Shape detection catches a value
 * that ANNOUNCES itself (`ghp_…`, a JWT, a long opaque run); it cannot catch
 * `["--api-key", "abc123"]`, because `abc123` looks like every other short
 * argument in the world. An adversarial review found exactly that surviving
 * into a stored capability shape — which is ADR-0038 D5 broken, since MUON is
 * then holding a credential it promised never to carry.
 *
 * So POSITION matters as well as shape: whatever follows a credential-named
 * flag is refused on the strength of the flag alone.
 */
const CREDENTIAL_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pass",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "session",
  "cookie",
  "private",
  "signature",
  "access",
]);

/**
 * Is this flag NAME one whose value is a credential?
 *
 * Word-splitting rather than one regex, because the regex this replaced could
 * only see words delimited by `-`, `_` or `.` — so `--api-key` was caught and
 * `--accessToken` was not, and its value was kept, reported as credential-free,
 * persisted, and handed to the runner. camelCase is the ordinary spelling for
 * a large share of CLIs, so that hole was not an edge case.
 *
 * A false positive here refuses a harmless argument; a false negative stores a
 * secret MUON promised never to carry (ADR-0038 D5). The asymmetry is the whole
 * reason this splits generously.
 */
function isCredentialFlagName(flag: string): boolean {
  const name = flag.replace(/^--?/, "");
  if (name.length === 0) return false;
  return name
    // camelCase and PascalCase boundaries become separators too.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_. ]+/)
    .some((word) => CREDENTIAL_WORDS.has(word.toLowerCase()));
}

/** A bare credential flag: `--api-key abc123`, `--accessToken abc123`. */
const CREDENTIAL_FLAG = { test: (flag: string) => /^--?[\w.-]+$/.test(flag) && isCredentialFlagName(flag) };

/** `--token=abc123`, `--api-key:abc123` — the value rides the same argument. */
const CREDENTIAL_FLAG_INLINE = {
  exec(arg: string): [string, string, string, string] | null {
    const match = /^(--?[\w.-]+)([=:])(.+)$/.exec(arg);
    if (!match || !isCredentialFlagName(match[1]!)) return null;
    return [match[0], match[1]!, match[2]!, match[3]!];
  },
};

/** `-H`/`--header` carry `Authorization: Bearer …` as one opaque argument. */
const HEADER_FLAG = /^(?:-H|--header|--headers)$/i;

/**
 * The SAME flag with its value attached: `--header=Authorization: Basic dTpw`.
 *
 * Missed by the standalone form, and the values that ride it are exactly the
 * ones shape detection cannot see — a short Basic credential or a `session=…`
 * cookie looks like any other argument. So the whole thing is refused on the
 * strength of the flag, as the two-argument form already was.
 */
const HEADER_FLAG_INLINE = /^((?:-H|--header|--headers))([=:])(.+)$/i;

function redactArgs(
  value: unknown,
  limit: number
): { args: string[]; refused: string[] } {
  if (!Array.isArray(value)) return { args: [], refused: [] };
  const refused: string[] = [];
  const strings = value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, limit);

  const args: string[] = [];
  // `valueIsCredential` carries the decision from a flag to the NEXT argument.
  // A flag and its value are two array entries, so a per-entry map — which is
  // what this used to be — structurally cannot see the pair.
  let valueIsCredential = false;
  for (const [index, entry] of strings.entries()) {
    if (valueIsCredential) {
      valueIsCredential = false;
      refused.push(`args[${index}]`);
      args.push(REDACTED);
      continue;
    }

    const headerInline = HEADER_FLAG_INLINE.exec(entry);
    if (headerInline) {
      refused.push(`args[${index}]`);
      args.push(`${headerInline[1]}${headerInline[2]}${REDACTED}`.slice(0, 512));
      continue;
    }

    const inline = CREDENTIAL_FLAG_INLINE.exec(entry);
    if (inline) {
      // Keep the FLAG NAME and drop only its value: the human needs to know
      // which credential the server wants, and the name is what tells them.
      refused.push(`args[${index}]`);
      args.push(`${inline[1]}${inline[2]}${REDACTED}`.slice(0, 512));
      continue;
    }

    if (CREDENTIAL_FLAG.test(entry) || HEADER_FLAG.test(entry)) {
      valueIsCredential = true;
      args.push(entry.slice(0, 512));
      continue;
    }

    // A URL ARGUMENT IS STILL A URL. `redactUrl` strips userinfo, query
    // strings and fragments because every one of them routinely carries a
    // credential — but it was only ever applied to the `url` FIELD. The same
    // endpoint passed as an ARGUMENT (`mcp-remote https://h/mcp?api_key=…`,
    // which is how remote MCP servers are usually spelled) took the generic
    // shape check instead, and a short key in a query string looks like
    // nothing. It was persisted and handed to the runner.
    if (/^https?:\/\//i.test(entry)) {
      const redacted = redactUrl(entry);
      if (redacted.refused.length > 0) refused.push(`args[${index}]`);
      args.push(redacted.url.slice(0, 512));
      continue;
    }

    if (looksSecret(entry)) {
      refused.push(`args[${index}]`);
      args.push(REDACTED);
      continue;
    }
    args.push(entry.slice(0, 512));
  }
  return { args, refused };
}

/**
 * A COMMAND IS A SEQUENCE OF WORDS, and every rule that protects an argument
 * protects those words too.
 *
 * `command` was copied verbatim while `args`, `url`, `env` and headers were all
 * redacted — so a shell-wrapper entry
 * (`sh -c "curl -H 'Authorization: Bearer …'"`, or a command with an inline
 * credential URL) carried the secret straight into the inventory and into the
 * persisted enabled shape. Same word-level pass as `redactArgs`, because there
 * is no reason a credential is safer for being on this side of the config.
 *
 * The rewritten command would not launch, which is correct and not a loss: an
 * item with any refused secret is REFUSED at enable (ADR-0038 D5/D9), so a
 * redacted command is never handed to a lane.
 */
function redactCommand(raw: string): { command: string; refused: string[] } {
  const words = raw.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= 1) {
    // A bare program name. Still shape-checked, because a single opaque token
    // in this position is not a program.
    return looksSecret(raw)
      ? { command: REDACTED, refused: ["command"] }
      : { command: raw, refused: [] };
  }
  const scanned = redactArgs(words, words.length);
  return {
    command: scanned.args.join(" ").slice(0, 512),
    refused: scanned.refused.length > 0 ? ["command"] : [],
  };
}

function transportOf(entry: Record<string, unknown>): ImportedItem["shape"]["transport"] {
  const declared = entry.type ?? entry.transport;
  if (declared === "http" || declared === "sse" || declared === "stdio") {
    return declared;
  }
  if (typeof entry.url === "string" && entry.url.trim() !== "") return "http";
  if (typeof entry.command === "string" && entry.command.trim() !== "") {
    return "stdio";
  }
  return "unknown";
}

/**
 * Inventory the MCP servers in one vendor configuration.
 *
 * Accepts both spellings MUON has to read: claude's `mcpServers` object and
 * codex's `mcp_servers` table. Everything it produces is `discovered`, which
 * ADR-0038 D1 defines as denied — that is the initial state by construction,
 * not the result of filtering a permissive default.
 */
export function discoverMcpServers(source: DiscoverySource): DiscoveryResult {
  const root = isRecord(source.config) ? source.config : {};
  const rawServers = root.mcpServers ?? root.mcp_servers;
  const servers = isRecord(rawServers) ? rawServers : undefined;
  if (!servers) {
    // "No servers key" and "a servers key I could not read" are different
    // facts, and collapsing them showed 0 of N with no explanation — the exact
    // lie the `unreadable` field exists to prevent one level down.
    return rawServers === undefined || rawServers === null
      ? { items: [], unreadable: [] }
      : {
          items: [],
          unreadable: [
            {
              name: "(the mcpServers entry itself)",
              reason: `expected an object of server names, found ${
                Array.isArray(rawServers) ? "an array" : typeof rawServers
              } — no servers could be read from this file`,
            },
          ],
        };
  }

  const items: ImportedItem[] = [];
  const unreadable: { name: string; reason: string }[] = [];

  for (const [name, raw] of Object.entries(servers)) {
    if (name.trim() === "" || name.length > 128) {
      unreadable.push({
        name: name.slice(0, 128) || "(unnamed)",
        reason: "server name is empty or longer than MUON records",
      });
      continue;
    }
    if (!isRecord(raw)) {
      unreadable.push({ name, reason: "entry is not a configuration object" });
      continue;
    }

    const envKeys = readNameOnly(raw.env, 64);
    const headerKeys = readNameOnly(raw.headers, 32);
    const redactedCommand =
      typeof raw.command === "string"
        ? redactCommand(raw.command.slice(0, 512))
        : undefined;
    const command = redactedCommand?.command;
    const rawUrl =
      typeof raw.url === "string" ? raw.url.slice(0, 1024) : undefined;
    const redactedUrl = rawUrl ? redactUrl(rawUrl) : undefined;
    const url = redactedUrl?.url;
    const redactedArgs = redactArgs(raw.args, 64);
    const transport = transportOf(raw);

    if (transport === "unknown") {
      unreadable.push({
        name,
        reason: "names neither a command nor a url, so MUON cannot say what it launches",
      });
      continue;
    }

    const parsed = importedItemSchema.safeParse({
      kind: "mcp_server",
      name,
      provenance: { vendor: source.vendor, sourcePath: source.sourcePath },
      shape: {
        transport,
        ...(command ? { command } : {}),
        args: redactedArgs.args,
        ...(url ? { url } : {}),
        envKeys,
        headerKeys,
      },
      // Every env and header value is refused; these are the names whose value
      // the human will have to supply through the vendor's own path. The url
      // and args coordinates are appended because a secret really was found
      // and removed there — reporting only env/header names told the user the
      // server needed nothing while MUON held their token.
      secretsRefused: [
        ...[...envKeys, ...headerKeys].filter((key) =>
          CREDENTIAL_NAME.test(key)
        ),
        ...(redactedUrl?.refused ?? []),
        ...(redactedCommand?.refused ?? []),
        ...redactedArgs.refused,
      ],
      state: IMPORT_STATE_DISCOVERED,
    });
    if (!parsed.success) {
      unreadable.push({ name, reason: "configuration did not fit MUON's record" });
      continue;
    }
    items.push(parsed.data);
  }

  return { items, unreadable };
}

/**
 * The canonical evidence one item is fingerprinted over (ADR-0038 D3).
 *
 * Sorted and shape-only, so the same server reads the same on every machine.
 * Provenance is EXCLUDED on purpose: moving a config file must not read as the
 * item having changed, and — per D4 — where it came from is not part of what
 * makes it the thing the human approved.
 */
export function importItemEvidence(item: ImportedItem): string {
  return JSON.stringify({
    kind: item.kind,
    // VENDOR is part of the identity; sourcePath is not. Excluding the path is
    // deliberate (D3: a moved config file is not a changed item). Excluding the
    // vendor was not — it made `linear` in ~/.claude.json and an identical
    // `linear` in some other file's codex table produce the SAME evidence, so a
    // second config could inherit an approval the human gave against a screen
    // that said "from claude". D4 says provenance is what the human judges on,
    // which only holds if the thing they approved is keyed by it.
    vendor: item.provenance.vendor,
    name: item.name,
    transport: item.shape.transport,
    command: item.shape.command ?? null,
    args: item.shape.args,
    url: item.shape.url ?? null,
    envKeys: [...item.shape.envKeys].sort(),
    headerKeys: [...item.shape.headerKeys].sort(),
  });
}

/**
 * What a human is shown before deciding. Names the item, what it launches, and
 * every credential MUON refused to carry.
 *
 * It states no recommendation and no risk score. ADR-0038 D4: provenance and
 * shape inform a person's judgment; nothing here concludes anything, because a
 * surface that says "this one looks fine" is one an importer will learn to
 * trust instead of reading.
 */
export function describeImportedItem(item: ImportedItem): string {
  const launches =
    item.shape.transport === "stdio"
      ? `runs \`${item.shape.command ?? "(no command)"}\`${
          item.shape.args.length > 0 ? ` with ${item.shape.args.length} argument(s)` : ""
        }`
      : `connects to ${item.shape.url ?? "(no url)"} over ${item.shape.transport}`;
  const secrets =
    item.secretsRefused.length > 0
      ? ` Needs ${item.secretsRefused.length} credential(s) MUON does not carry (${item.secretsRefused.join(", ")}), so it cannot be enabled: MUON hands a lane its own generated server config and would launch this one without them.`
      : "";
  return `${item.name} (from ${item.provenance.vendor}, ${item.provenance.sourcePath}): ${launches}. Not enabled.${secrets}`;
}
