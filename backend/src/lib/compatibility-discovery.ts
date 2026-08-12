import fs from "node:fs";
import {
  INSTALLABLE_VENDORS,
  defaultVendorIo,
  vendorConfigPath,
  type InstallableVendorSpec,
  type McpConfigScope,
  type VendorConfigRoots,
} from "@muon/client/mcp-vendor-config";
import {
  discoverMcpServers,
  type ImportedItem,
  type VendorId,
} from "@muon/protocol";

/**
 * ADR-0038 D1, the DISCOVER half and nothing else — the source enumerator
 * `packages/protocol/src/compatibility-import.ts` was written against and then
 * shipped without.
 *
 * That module takes an ALREADY-PARSED configuration and never touches a
 * filesystem. This is the piece that does: it resolves each vendor's config
 * file, reads it under a byte cap, turns the bytes into an object, and hands
 * that object to `discoverMcpServers`. Every judgment about what an entry IS,
 * and every decision about what MUON refuses to carry, stays over there. This
 * file decides only WHICH FILES ARE READ.
 *
 * ── the three rules this file exists to hold ────────────────────────────────
 *
 * 1. NO CALLER SUPPLIES A PATH. `discoverCompatibilityInventory()` takes no
 *    path, no vendor filter, no scope — only the roots seam the rest of the
 *    repo already uses for tests. Paths come from `vendorConfigPath()` over
 *    `INSTALLABLE_VENDORS`, the SHARED table `muon mcp install/status` writes
 *    and reads through. A second path table here is how the two drift; a path
 *    that arrives from a request is an arbitrary-file-read oracle wearing an
 *    inventory's clothes. The route (`backend/src/routes/compatibility.ts`)
 *    accepts no input at all for the same reason.
 *
 * 2. A FILE MUON COULD NOT READ IS A REPORTED FACT. Missing, not a regular
 *    file, over the cap, unparseable — each lands in `sources` with a status
 *    and a reason. Showing 4 of a user's 5 servers with no explanation is the
 *    lie `DiscoveryResult.unreadable` exists one level down to prevent, and
 *    the same rule has to hold one level up or it does not hold at all.
 *
 * 3. VALUES ARE NEVER CARRIED. Env and header NAMES only — enforced by
 *    `discoverMcpServers`/`readNameOnly`, which is the single decider. This
 *    file deliberately does NOT re-implement a redaction or credential-name
 *    rule of its own: two places deciding what a secret is means one of them
 *    is eventually wrong. A parse failure's `reason` names the file and the
 *    failure CATEGORY, never the bytes (see `parseJsonRoot` — `JSON.parse`'s
 *    own message quotes the offending source text, which in these files is
 *    somebody's token).
 *
 * WHAT IS DELIBERATELY ABSENT: any notion of enabling. There is no `enabled`
 * field, no lane binding, no id to enable BY, and no function here that could
 * grow one. ADR-0038 D1 splits import into discover (a read, grants nothing)
 * and enable (an authority act, per-item, human-only), and its two open
 * questions — MCP servers only? which lanes may an enabled item reach? — are
 * still the founder's. Extending this file toward enable needs that ADR
 * revisited first, not a new export here.
 */

/**
 * USER SCOPE ONLY, and this is a security decision rather than an omission.
 *
 * `INSTALLABLE_VENDORS` also describes a `project` scope for claude-code and
 * cursor, resolved against `roots.cwd`. The brain is an embedded child process
 * whose cwd is wherever it was spawned — not the repo the human is looking at
 * — so a project-scope read here would either report the wrong file or need a
 * workspace path from the caller. The second option is rule 1 above with extra
 * steps. `muon compat mcp` says so in its footer rather than leaving a user to
 * wonder why their `.mcp.json` is missing.
 */
const DISCOVERY_SCOPE: McpConfigScope = "user";

/**
 * The most bytes MUON will read from one vendor config.
 *
 * Measured on this machine 2026-08-08: `~/.claude.json` 82KB (it accumulates
 * per-project history and is by far the largest of the four), codex 7.7KB,
 * cursor 974B, opencode 558B. 8MiB is ~100x the realistic worst case, which is
 * the point — the cap exists to bound what a runaway or hostile file can make
 * the brain allocate, not to be tight enough to refuse a real user's config.
 * Hitting it is reported (`sources[].status = "unreadable"`), never silent.
 */
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

export type CompatibilitySourceStatus = "read" | "absent" | "unreadable";

/** One vendor config file MUON looked at, and what came of it. */
export type CompatibilitySource = {
  readonly vendor: VendorId;
  readonly scope: McpConfigScope;
  readonly sourcePath: string;
  readonly status: CompatibilitySourceStatus;
  /** Why MUON could not read it. Names the file and the failure, never bytes. */
  readonly reason?: string;
  /** Servers inventoried from this file. */
  readonly items: number;
};

/** An entry that looked like a server and could not be read as one. */
export type CompatibilityUnreadableItem = {
  readonly vendor: VendorId;
  readonly sourcePath: string;
  readonly name: string;
  readonly reason: string;
};

export type CompatibilityInventory = {
  /** Every item is `state: "discovered"` — the only state ADR-0038 D1 has. */
  readonly items: readonly ImportedItem[];
  readonly unreadable: readonly CompatibilityUnreadableItem[];
  /** Every file MUON looked at, including the ones that were not there. */
  readonly sources: readonly CompatibilitySource[];
};

/**
 * Inventory the MCP servers the human's vendor CLIs already have configured.
 *
 * Reads. Records. Grants nothing, enables nothing, and persists nothing — the
 * inventory is recomputed per call, so a config the user edits or deletes stops
 * being reported without MUON having to expire anything.
 *
 * `roots` exists only so MUON's own tests can point the four paths at a temp
 * directory; production takes `defaultVendorIo().roots`, whose
 * `redirectVendorConfigDirs` is hard-coded false.
 */
export function discoverCompatibilityInventory(
  roots: VendorConfigRoots = defaultVendorIo().roots
): CompatibilityInventory {
  const items: ImportedItem[] = [];
  const unreadable: CompatibilityUnreadableItem[] = [];
  const sources: CompatibilitySource[] = [];

  for (const spec of INSTALLABLE_VENDORS) {
    if (!spec.scopes.includes(DISCOVERY_SCOPE)) {
      // A fifth installable vendor with no user scope is REPORTED, never
      // quietly dropped from the inventory (ADR-0022 rule 2 in its other
      // direction: what MUON reads is a positive list, and a gap in it is a
      // fact the human is told).
      sources.push({
        vendor: spec.id,
        scope: DISCOVERY_SCOPE,
        sourcePath: "(none)",
        status: "unreadable",
        reason: `${spec.id} has no user-scope MCP config, and MUON's discovery reads user-scope configs only`,
        items: 0,
      });
      continue;
    }

    const sourcePath = vendorConfigPath(spec, DISCOVERY_SCOPE, roots);
    const reader = readerFor(spec);
    if (!reader) {
      sources.push({
        vendor: spec.id,
        scope: DISCOVERY_SCOPE,
        sourcePath,
        status: "unreadable",
        reason: `MUON has no reader for ${spec.id}'s config format`,
        items: 0,
      });
      continue;
    }

    const file = readBoundedFile(sourcePath);
    if (file.status !== "read") {
      sources.push({
        vendor: spec.id,
        scope: DISCOVERY_SCOPE,
        sourcePath,
        status: file.status,
        ...(file.status === "unreadable" ? { reason: file.reason } : {}),
        items: 0,
      });
      continue;
    }

    const parsed = reader(file.text);
    if (!parsed.ok) {
      sources.push({
        vendor: spec.id,
        scope: DISCOVERY_SCOPE,
        sourcePath,
        status: "unreadable",
        reason: `${sourcePath} ${parsed.reason}`,
        items: 0,
      });
      continue;
    }

    const discovered = discoverMcpServers({
      vendor: spec.id,
      sourcePath,
      config: parsed.config,
    });
    items.push(...discovered.items);
    for (const entry of [...parsed.unreadable, ...discovered.unreadable]) {
      unreadable.push({
        vendor: spec.id,
        sourcePath,
        name: entry.name,
        reason: entry.reason,
      });
    }
    sources.push({
      vendor: spec.id,
      scope: DISCOVERY_SCOPE,
      sourcePath,
      status: "read",
      items: discovered.items.length,
    });
  }

  return { items, unreadable, sources };
}

// ─────────────────────────── reading the bytes ──────────────────────────────

type BoundedRead =
  | { status: "read"; text: string }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };

/**
 * Read one config file under the cap, or say why not.
 *
 * `statSync` runs BEFORE `openSync` deliberately: opening a FIFO blocks until
 * a writer appears, and a read that hangs the brain is worse than one that
 * refuses. Symlinks ARE followed — dotfile managers (stow, chezmoi) symlink
 * exactly these four files, and the path is never caller-supplied, so
 * following one reaches the file the user actually configured.
 */
function readBoundedFile(file: string): BoundedRead {
  let target: fs.Stats;
  try {
    target = fs.statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { status: "absent" }
      : { status: "unreadable", reason: `${file}: ${(error as Error).message}` };
  }
  if (!target.isFile()) {
    return { status: "unreadable", reason: `${file} is not a regular file` };
  }
  if (target.size > MAX_CONFIG_BYTES) {
    return {
      status: "unreadable",
      reason: `${file} is ${target.size} bytes, over MUON's ${MAX_CONFIG_BYTES}-byte read cap`,
    };
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    // Re-checked ON THE FD: the stat above described a PATH, this describes the
    // bytes actually opened. Without it a file swapped between the two calls
    // reads past the cap.
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) {
      return {
        status: "unreadable",
        reason: `${file} changed while MUON was reading it`,
      };
    }
    const buffer = Buffer.alloc(opened.size);
    const read = fs.readSync(fd, buffer, 0, opened.size, 0);
    return { status: "read", text: buffer.subarray(0, read).toString("utf8") };
  } catch (error) {
    return { status: "unreadable", reason: `${file}: ${(error as Error).message}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close; the read's own result is the useful answer.
      }
    }
  }
}

// ───────────────────────── per-vendor config readers ────────────────────────

type ReaderResult =
  | {
      ok: true;
      /** Shaped for `discoverMcpServers`: `mcpServers` or `mcp_servers`. */
      config: unknown;
      /** Entries this reader could not represent. Reported, never dropped. */
      unreadable: readonly { name: string; reason: string }[];
    }
  | { ok: false; reason: string };

type VendorConfigReader = (text: string) => ReaderResult;

/**
 * Which reader each vendor gets — a POSITIVE switch over the shared table, with
 * no default that guesses. An unrecognised vendor returns null and is reported
 * as a gap rather than silently contributing zero servers.
 */
function readerFor(spec: InstallableVendorSpec): VendorConfigReader | null {
  switch (spec.id) {
    // Both spell it `mcpServers` at the top level, which is one of the two
    // spellings `discoverMcpServers` already accepts — nothing to translate.
    case "claude-code":
    case "cursor":
      return readJsonMcpServers;
    case "codex":
      return readCodexMcpServers;
    case "opencode":
      return readOpencodeMcpServers;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a JSON config into its root object.
 *
 * The reason NEVER includes `JSON.parse`'s message. V8 quotes the offending
 * source text in it ("Unexpected token 'x', \"...\" is not valid JSON"), and in
 * these files the offending source text is somebody's API key.
 */
function parseJsonRoot(text: string): { ok: true; root: unknown } | { ok: false; reason: string } {
  if (text.trim() === "") {
    // An empty config is a config with no servers, not a broken one.
    return { ok: true, root: {} };
  }
  try {
    return { ok: true, root: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "is not valid JSON" };
  }
}

const readJsonMcpServers: VendorConfigReader = (text) => {
  const parsed = parseJsonRoot(text);
  return parsed.ok
    ? { ok: true, config: parsed.root, unreadable: [] }
    : { ok: false, reason: parsed.reason };
};

/**
 * opencode nests its servers under `mcp`, not `mcpServers`, and its entry shape
 * is its own: `{ type: "local", command: [argv0, ...args], environment }`.
 * That shape is live-verified in this repo (`readEntryCommand` /
 * `readEntryEnvironment` / `muonJsonEntry` in `mcp-vendor-config.ts`, opencode
 * 1.18.7, 2026-07-30), so it is translated into the spelling
 * `discoverMcpServers` reads.
 *
 * Any OTHER `type` is reported unreadable rather than guessed at. opencode's
 * remote entry shape has never been exercised by this repo, and a guess at a
 * third-party schema inside the path that decides what MUON refuses to carry is
 * exactly the wrong place to be approximately right.
 */
const readOpencodeMcpServers: VendorConfigReader = (text) => {
  const parsed = parseJsonRoot(text);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const root = isRecord(parsed.root) ? parsed.root : {};
  if (root.mcp === undefined || root.mcp === null) {
    return { ok: true, config: {}, unreadable: [] };
  }
  if (!isRecord(root.mcp)) {
    // Hand the wrong-shaped value straight through so `discoverMcpServers`
    // reports it in its own words, rather than restating that judgment here.
    return { ok: true, config: { mcpServers: root.mcp }, unreadable: [] };
  }

  const servers: Record<string, unknown> = {};
  const unreadable: { name: string; reason: string }[] = [];
  for (const [name, raw] of Object.entries(root.mcp)) {
    if (!isRecord(raw)) {
      servers[name] = raw;
      continue;
    }
    if (raw.type !== "local") {
      unreadable.push({
        name,
        reason: `MUON reads opencode's \`type: "local"\` entries only; this one is ${
          typeof raw.type === "string" ? `\`${raw.type}\`` : "untyped"
        }`,
      });
      continue;
    }
    const argv = Array.isArray(raw.command) ? raw.command : [];
    servers[name] = {
      type: "stdio",
      ...(typeof argv[0] === "string" ? { command: argv[0] } : {}),
      args: argv.slice(1),
      // The VALUE side of `environment` is never looked at here — it is passed
      // to the one place that reads names and drops values.
      ...(raw.environment !== undefined ? { env: raw.environment } : {}),
    };
  }
  return { ok: true, config: { mcpServers: servers }, unreadable };
};

// ─────────────────────────── codex's TOML tables ────────────────────────────

/**
 * A BOUNDED, READ-ONLY scan of codex's `[mcp_servers.*]` tables.
 *
 * This is NOT a TOML parser and must not become one. It is the same technique
 * `readCodexEntry` in `@muon/client/mcp-vendor-config` already uses for the one
 * `[mcp_servers.muon]` table `muon mcp status` needs, widened to every server
 * table and given a real value scanner so a multi-line `args` array does not
 * desync it. There is no TOML library in this repo and Node ships no parser;
 * pulling one in for four keys, or shelling out to `codex mcp list`, were both
 * rejected — the vendor binary is often not on PATH and a read must not spawn a
 * vendor process (the same reason `readCodexEntry` gives).
 *
 * The scan is line-oriented OUTSIDE `mcp_servers`, which is what keeps it
 * honest: the rest of a codex config (profiles, sandbox policy, notify hooks)
 * is never value-parsed at all, so syntax this subset does not cover cannot
 * break the servers it does. Inside an `mcp_servers` table, anything the value
 * scanner cannot represent marks THAT SERVER unreadable and moves on — loud and
 * local, never a dropped row and never a dropped file.
 */
const readCodexMcpServers: VendorConfigReader = (text) => {
  const servers: Record<string, unknown> = {};
  const unreadable: { name: string; reason: string }[] = [];
  const refuse = (name: string, reason: string) => {
    delete servers[name];
    if (!unreadable.some((entry) => entry.name === name)) {
      unreadable.push({ name, reason });
    }
  };
  /** Servers already refused; later keys for them are skipped, not re-reported. */
  const refused = new Set<string>();

  // The current `[mcp_servers.<name>]` (or `.<name>.<sub>`) table, or null when
  // the cursor is anywhere else in the file.
  let server: string | null = null;
  let sub: string | null = null;

  let i = 0;
  while (i < text.length) {
    const newline = text.indexOf("\n", i);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(i, lineEnd);
    const trimmed = stripTrailingComment(line).trim();

    if (trimmed === "") {
      i = lineEnd + 1;
      continue;
    }

    if (trimmed.startsWith("[")) {
      const header = parseTableHeader(trimmed);
      server = null;
      sub = null;
      if (header && header.path[0] === "mcp_servers") {
        if (header.arrayOfTables) {
          if (header.path.length >= 2) {
            refused.add(header.path[1]!);
            refuse(
              header.path[1]!,
              "declared as a TOML array-of-tables, which is not a server MUON can read"
            );
          }
        } else if (header.path.length === 1) {
          // `[mcp_servers]` itself: servers may be declared as inline tables
          // directly under it.
          server = "";
        } else if (header.path.length === 2) {
          server = header.path[1]!;
        } else if (header.path.length === 3) {
          server = header.path[1]!;
          sub = header.path[2]!;
        }
        // Anything deeper — `[mcp_servers.<name>.tools.rename]` is real and is
        // in a live codex config — is IGNORED, not refused. MUON's record of a
        // server has a fixed shape (transport, command, args, url, env/header
        // names) and nothing at that depth can populate it, so refusing would
        // delete a server the user really has because of a vendor feature MUON
        // does not model. `server` stays null, so those keys are attributed
        // nowhere.
      }
      i = lineEnd + 1;
      continue;
    }

    if (server === null) {
      i = lineEnd + 1;
      continue;
    }

    const key = parseKeyAt(text, i, lineEnd);
    if (!key) {
      // A line inside a server table that is not `key = …` at all. Skip it
      // rather than refusing the server: a continuation line of a value the
      // scanner already consumed lands here harmlessly.
      i = lineEnd + 1;
      continue;
    }
    if (key.path.length !== 1) {
      // A dotted key (`env.API_KEY = …`). Legal TOML, and not something codex
      // writes for these tables — but dropping it quietly would hide a server's
      // env block, so it refuses the server instead.
      const owner = server === "" ? key.path[0]! : server;
      refused.add(owner);
      refuse(
        owner,
        `MUON does not read dotted keys (\`${key.path.join(".")}\`) inside a codex server table`
      );
      i = lineEnd + 1;
      continue;
    }
    const name = key.path[0]!;

    const owner = server === "" ? name : server;
    if (refused.has(owner)) {
      i = lineEnd + 1;
      continue;
    }

    const value = scanValue(text, key.end);
    // A value must consume the WHOLE right-hand side. Without the trailing
    // check, `started = 1979-05-27T07:32:00Z` (a legal TOML datetime, outside
    // this subset) matched the number `1979` and the server was kept with a
    // value MUON invented — a prefix match reading as a successful parse is
    // strictly worse than refusing.
    if (!value || !onlyCommentRemains(text, value.end)) {
      refused.add(owner);
      refuse(
        owner,
        `MUON could not read the value of \`${name}\` in codex's config`
      );
      i = lineEnd + 1;
      continue;
    }

    if (server === "") {
      servers[name] = value.value;
    } else {
      const entry = isRecord(servers[server])
        ? (servers[server] as Record<string, unknown>)
        : {};
      if (sub === null) {
        entry[name] = value.value;
      } else {
        const nested = isRecord(entry[sub])
          ? (entry[sub] as Record<string, unknown>)
          : {};
        nested[name] = value.value;
        entry[sub] = nested;
      }
      servers[server] = entry;
    }

    // Resume after the value, which may have spanned several lines.
    i = value.end;
    const consumedTo = text.indexOf("\n", i);
    i = consumedTo === -1 ? text.length : consumedTo + 1;
  }

  for (const entry of Object.values(servers)) {
    // codex spells its remote headers `http_headers`; `discoverMcpServers`
    // reads `headers`. Aliasing the KEY NAME (never the values) is the same
    // one-line translation this file already does for `mcp_servers` and for
    // opencode's `environment`, and it is not optional: without it a codex
    // remote server reports ZERO refused credentials while its config really
    // does carry an Authorization header — which is precisely the "told the
    // user the server needed nothing" failure ADR-0038 D5 exists to prevent.
    // Found against a live ~/.codex/config.toml, 2026-08-08.
    if (isRecord(entry) && entry.headers === undefined && isRecord(entry.http_headers)) {
      entry.headers = entry.http_headers;
    }
  }
  return { ok: true, config: { mcp_servers: servers }, unreadable };
};

/** Is everything from `end` to the end of that line whitespace or a comment? */
function onlyCommentRemains(text: string, end: number): boolean {
  const newline = text.indexOf("\n", end);
  const rest = text.slice(end, newline === -1 ? text.length : newline);
  return stripTrailingComment(rest).trim() === "";
}

/** Strip a `#` comment that is not inside a string. */
function stripTrailingComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

// STICKY (`y`), and matched against the whole document rather than a slice of
// it. `source.slice(i)` inside these scanners copies the remainder of the file
// once per token, which under the 8MiB cap is quadratic on a config that is
// merely large rather than hostile.
const BARE_KEY = /[A-Za-z0-9_-]+/y;

/** One dotted key path, bare or quoted segments. Null when unrecognised. */
function parseDottedKey(
  source: string,
  start = 0
): { path: string[]; end: number } | null {
  const path: string[] = [];
  let i = start;
  for (;;) {
    while (source[i] === " " || source[i] === "\t") i += 1;
    const char = source[i];
    if (char === '"' || char === "'") {
      const string = scanQuotedString(source, i);
      if (!string) return null;
      path.push(string.value);
      i = string.end;
    } else {
      BARE_KEY.lastIndex = i;
      const bare = BARE_KEY.exec(source);
      if (!bare) return null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    while (source[i] === " " || source[i] === "\t") i += 1;
    if (source[i] === ".") {
      i += 1;
      continue;
    }
    return { path, end: i };
  }
}

function parseTableHeader(
  trimmed: string
): { path: string[]; arrayOfTables: boolean } | null {
  const arrayOfTables = trimmed.startsWith("[[");
  const open = arrayOfTables ? 2 : 1;
  const close = arrayOfTables ? "]]" : "]";
  if (!trimmed.endsWith(close)) return null;
  const inner = trimmed.slice(open, trimmed.length - close.length);
  const key = parseDottedKey(inner);
  if (!key || key.end !== inner.length || key.path.length === 0) return null;
  return { path: key.path, arrayOfTables };
}

/** A `key =` at the start of a line, returning the offset just past the `=`. */
function parseKeyAt(
  text: string,
  lineStart: number,
  lineEnd: number
): { path: string[]; end: number } | null {
  const line = text.slice(lineStart, lineEnd);
  const leading = line.length - line.trimStart().length;
  const key = parseDottedKey(line.slice(leading));
  if (!key || key.path.length === 0) return null;
  const cursor = leading + key.end;
  if (line[cursor] !== "=") return null;
  return { path: key.path, end: lineStart + cursor + 1 };
}

function scanQuotedString(
  source: string,
  start: number
): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  // Multi-line (""" / ''') strings are not part of this subset — codex writes
  // none of the four keys MUON reads that way, and pretending otherwise is how
  // a scanner starts guessing.
  if (source.startsWith(quote.repeat(3), start)) return null;
  let value = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\n") return null;
    if (quote === '"' && char === "\\") {
      const escaped = source[i + 1];
      if (escaped === undefined) return null;
      // Enough of TOML's escape table to round-trip a Windows path or a quoted
      // argument. An unknown escape keeps its literal character rather than
      // failing the whole entry.
      value +=
        escaped === "n"
          ? "\n"
          : escaped === "t"
            ? "\t"
            : escaped === "r"
              ? "\r"
              : escaped;
      i += 1;
      continue;
    }
    if (char === quote) {
      return { value, end: i + 1 };
    }
    value += char;
  }
  return null;
}

const NUMBER = /[+-]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Whitespace, newlines and comments between tokens of a multi-line value. */
function skipTrivia(source: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (source[i] !== "#") return i;
    const newline = source.indexOf("\n", i);
    if (newline === -1) return source.length;
    i = newline + 1;
  }
}

/**
 * One TOML value, possibly spanning lines. Null for anything outside the subset
 * — which is a REFUSAL of that server, not a silent skip (see the caller).
 */
function scanValue(
  source: string,
  start: number
): { value: unknown; end: number } | null {
  let i = start;
  while (source[i] === " " || source[i] === "\t") i += 1;
  const char = source[i];
  if (char === undefined) return null;

  if (char === '"' || char === "'") {
    const string = scanQuotedString(source, i);
    return string ? { value: string.value, end: string.end } : null;
  }

  if (char === "[") {
    const values: unknown[] = [];
    i = skipTrivia(source, i + 1);
    while (source[i] !== "]") {
      if (i >= source.length) return null;
      const element = scanValue(source, i);
      if (!element) return null;
      values.push(element.value);
      i = skipTrivia(source, element.end);
      if (source[i] === ",") {
        i = skipTrivia(source, i + 1);
      } else if (source[i] !== "]") {
        return null;
      }
    }
    return { value: values, end: i + 1 };
  }

  if (char === "{") {
    const table: Record<string, unknown> = {};
    i = skipTrivia(source, i + 1);
    while (source[i] !== "}") {
      if (i >= source.length) return null;
      const key = parseDottedKey(source, i);
      if (!key || key.path.length !== 1) return null;
      i = key.end;
      if (source[i] !== "=") return null;
      const element = scanValue(source, i + 1);
      if (!element) return null;
      table[key.path[0]!] = element.value;
      i = skipTrivia(source, element.end);
      if (source[i] === ",") {
        i = skipTrivia(source, i + 1);
      } else if (source[i] !== "}") {
        return null;
      }
    }
    return { value: table, end: i + 1 };
  }

  if (source.startsWith("true", i)) return { value: true, end: i + 4 };
  if (source.startsWith("false", i)) return { value: false, end: i + 5 };

  NUMBER.lastIndex = i;
  const number = NUMBER.exec(source);
  if (number) {
    const literal = number[0].replace(/_/g, "");
    return { value: Number(literal), end: i + number[0].length };
  }
  return null;
}
