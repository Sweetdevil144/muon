import { z } from "zod";
import type { AgentRole } from "./agent-role.js";

/**
 * ROADMAP P7 — runtime-registerable custom agents. The other half of Wave 5
 * BYO agents that a compile-time registry edit
 * (`packages/protocol/src/vendor.ts`, ADR-0022) cannot serve: an operator's own
 * CLI, named at runtime, with no adapter, no PR, and — the whole point of this
 * file — no authority beyond one narrow grant.
 *
 * A custom agent is DELIBERATELY NOT a `VendorId`. It is never added to
 * `VENDOR_IDS`, never gets a `VENDOR_REGISTRY` row, and is invisible to every
 * `Record<VendorId, …>` table in the tree. That keeps it out of every
 * governance surface keyed on `VendorId` (dispatch, delegate, fleet, the
 * coordinator seat, MCP install) STRUCTURALLY — `vendorIdSchema.safeParse` on
 * a custom id already fails, with no code in this file having to say so.
 *
 * But "not a vendor" is a NEGATIVE definition, and ADR-0022 rule 2 is exactly
 * "never derive an allowed set by subtraction — `ALLOWED = SUPERSET −
 * FORBIDDEN` has broken this codebase three times." Defining the ungoverned
 * tier as "everything a vendor is not" would be that mistake on a second axis.
 * So this module states the tier POSITIVELY instead: `UNGOVERNED_AUTHORITY`
 * below is the ONE authority object every custom agent gets, byte-identical,
 * every field `false`/`[]` except exactly one — `terminalTabOnly: true`. It is
 * a constant, not a per-entry field. Registering a custom agent lets an
 * operator name a binary, its args, and a label; there is no field anywhere in
 * `CustomAgentRegistrationInput` an operator could set to ask for a role, a
 * dispatch seat, a coordinator seat, or brain/MCP access, because none exists.
 * "Positively defined" here means the strongest version available: there is no
 * allow-list to widen, because there is no input that reaches authority at
 * all.
 *
 * IDENTITY IS DISJOINT FROM THE VENDOR NAMESPACE BY CONSTRUCTION, not by
 * convention or by remembering not to collide. Every custom agent id is
 * `custom:<slug>` (`CUSTOM_AGENT_ID_PREFIX`), and `VendorId` never contains a
 * `:` — see `VENDOR_IDS` in `./vendor.js`. So `isVendorId(x)` and
 * `isUngovernedAgentId(x)` can never both be true for the same string: a
 * registered custom agent can never be mistaken for (or silently promoted
 * into) a vendor, and a vendor id can never be mistaken for a custom agent.
 * This is the same disjointness ADR-0022 §8 flagged as unresolved for the
 * terminal-native takeover namespace (`opencode`, `copilot`, `amp`, `gemini`,
 * `vibe`) — closed here by prefix rather than left to a shared keyspace.
 *
 * PURITY: like `vendor.ts`, this module is data + `zod` only. No `node:`
 * imports, no filesystem, no behaviour. Persistence (`~/.muon` / the resolved
 * data dir) lives in `@muon/client`; spawn resolution lives host-side in
 * `apps/desktop`. This file only says what a custom agent IS and what it is
 * NOT permitted to become.
 */

/** Every custom agent id carries this prefix. Chosen specifically because no
 *  `VendorId` literal contains `:` — see `VENDOR_IDS` in `./vendor.js`. */
export const CUSTOM_AGENT_ID_PREFIX = "custom:" as const;

/**
 * Lowercase-slug shape: `[a-z0-9]` then up to 63 more `[a-z0-9-]`. One pattern
 * has to double as a pty tab id, a JSON object key, and a CLI argument, so it
 * stays boring on purpose — no spaces, no path separators, no leading hyphen.
 */
export const CUSTOM_AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `"shell"` is the plain-terminal kind (`SHELL_TERMINAL_KIND`,
 *  `apps/desktop/src/lib/terminal-vendor-tabs.ts`) and lives outside BOTH the
 *  vendor and custom-agent namespaces. Reserved here too so a custom agent can
 *  never be registered under the id the plain terminal already answers to. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["shell"]);

/** An upper bound on how many custom agents one operator may register. A
 *  runtime-registerable tier still needs SOME ceiling — an unbounded list is
 *  an unbounded set of host-spawnable binaries sitting in a JSON file. */
export const MAX_CUSTOM_AGENTS = 20;

export type UngovernedAgentId = `custom:${string}`;

/** Build a custom agent id from a slug. The ONLY way this file constructs one
 *  — never string concatenation at a call site — so the prefix can never be
 *  spelled two ways. */
export function customAgentId(slug: string): UngovernedAgentId {
  return `${CUSTOM_AGENT_ID_PREFIX}${slug}`;
}

/**
 * Narrowing predicate over the CUSTOM AGENT namespace — the ungoverned twin of
 * `isVendorId`. An id outside this shape is not a custom agent, including
 * every real `VendorId` (none of which carries the `custom:` prefix) and the
 * plain `"shell"` kind.
 */
export function isUngovernedAgentId(value: unknown): value is UngovernedAgentId {
  return typeof value === "string" && value.startsWith(CUSTOM_AGENT_ID_PREFIX);
}

/** The slug half of a custom agent id, or `null` if `value` is not one. */
export function ungovernedAgentSlug(value: unknown): string | null {
  return isUngovernedAgentId(value) ? value.slice(CUSTOM_AGENT_ID_PREFIX.length) : null;
}

/**
 * THE ungoverned authority posture. Every admission surface that a custom
 * process could otherwise reach is restated here and forced to its most
 * restrictive value, plus the one grant this tier actually earns. This is a
 * sibling contract to `VendorEntry.authority` (ADR-0022 §3.1), not a field-for-
 * field copy: vendor-only facts such as `tier1` and `terminalTakeover` do not
 * apply to the separate `custom:` namespace.
 *
 * `supportedRoles: []` — holds no crew role, ever.
 * `coordinatorSeat/dispatchable/delegatable/fleetSizeable/evaluator/planner`
 *   — every seat and every admission surface a `VendorId` could reach: `false`.
 * `brainAccess` — no governed MCP/brain server is ever wired into the spawn.
 * `mcpInstall` — `muon mcp install` (and its desktop/CLI equivalents) never
 *   target a custom agent; there is no vendor MCP config format to write one
 *   into.
 * `terminalTabOnly` — the one positive grant: this id may appear as a human
 *   terminal tab, spawned by the OPERATOR clicking a button, exactly as a
 *   plain shell would be.
 */
export type UngovernedAgentAuthority = {
  readonly terminalTabOnly: true;
  readonly supportedRoles: readonly AgentRole[];
  readonly coordinatorSeat: false;
  readonly dispatchable: false;
  readonly delegatable: false;
  readonly fleetSizeable: false;
  readonly evaluator: false;
  readonly planner: false;
  readonly brainAccess: false;
  readonly mcpInstall: false;
};

/**
 * The SINGLE instance of `UngovernedAgentAuthority` in the process. Every
 * `UngovernedAgentEntry` this module produces (`createUngovernedAgentEntry`,
 * `parseUngovernedAgentEntry`) points at this exact object rather than
 * constructing an equivalent one, so "every custom agent has the same
 * authority" is an identity fact, not merely a value one.
 */
export const UNGOVERNED_AUTHORITY: UngovernedAgentAuthority = Object.freeze({
  terminalTabOnly: true,
  supportedRoles: Object.freeze([]) as readonly AgentRole[],
  coordinatorSeat: false,
  dispatchable: false,
  delegatable: false,
  fleetSizeable: false,
  evaluator: false,
  planner: false,
  brainAccess: false,
  mcpInstall: false,
});

/** A registered runtime custom agent — identity + spawn argv only. There is no
 *  authority INPUT anywhere in this type; `authority` is always
 *  `UNGOVERNED_AUTHORITY`. */
export type UngovernedAgentEntry = {
  readonly id: UngovernedAgentId;
  readonly slug: string;
  /** Full label ("My Local Agent"). */
  readonly displayName: string;
  /** Compact label for the terminal tab bar / tab title. */
  readonly shortLabel: string;
  /** Glyph key; the desktop icon map falls back to a generic "ungoverned"
   *  glyph for any key it does not recognise. */
  readonly iconKey: string;
  /** The binary MUON spawns. Resolved against PATH host-side, exactly like a
   *  vendor's `execution.commandCandidates[0]` — never a shell string. */
  readonly command: string;
  /** Fixed argv appended after `command`. Never renderer-suppliable at spawn
   *  time (`apps/desktop/src/lib/terminal-spawn.ts` reads this from the HOST's
   *  own read of the persisted registry, not from the IPC payload). */
  readonly args: readonly string[];
  readonly createdAt: string;
  readonly authority: UngovernedAgentAuthority;
};

export const customAgentSlugSchema = z
  .string()
  .regex(
    CUSTOM_AGENT_SLUG_PATTERN,
    "must be a lowercase slug: letters, digits, and hyphens, starting with a letter or digit, at most 64 characters"
  )
  .refine((slug) => !RESERVED_SLUGS.has(slug), {
    message: "'shell' is reserved for the plain terminal and cannot be a custom agent slug",
  });

/** What an operator actually submits at `register` time. No `authority` field
 *  exists on this schema — there is nothing here for a caller to widen. */
export const customAgentRegistrationInputSchema = z.object({
  slug: customAgentSlugSchema,
  displayName: z.string().trim().min(1).max(60),
  shortLabel: z.string().trim().min(1).max(24).optional(),
  iconKey: z.string().trim().min(1).max(40).optional(),
  /** The binary to spawn. A bare command name (resolved against PATH by the
   *  host, mirroring vendor `commandCandidates`) or an absolute path. Never a
   *  shell string — args are a separate, explicit array. */
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(32).default([]),
});
export type CustomAgentRegistrationInput = z.input<
  typeof customAgentRegistrationInputSchema
>;

const ungovernedAgentAuthoritySchema = z.object({
  terminalTabOnly: z.literal(true),
  supportedRoles: z.array(z.string()).length(0),
  coordinatorSeat: z.literal(false),
  dispatchable: z.literal(false),
  delegatable: z.literal(false),
  fleetSizeable: z.literal(false),
  evaluator: z.literal(false),
  planner: z.literal(false),
  brainAccess: z.literal(false),
  mcpInstall: z.literal(false),
});

/** The at-rest / wire shape of a persisted `UngovernedAgentEntry`. Every
 *  `authority` field is a zod LITERAL, not a boolean — a hand-edited JSON file
 *  that flips one bit fails validation rather than silently loading a widened
 *  entry. */
export const ungovernedAgentEntrySchema = z.object({
  id: z.string().refine(isUngovernedAgentId, {
    message: `id must start with '${CUSTOM_AGENT_ID_PREFIX}'`,
  }),
  slug: customAgentSlugSchema,
  displayName: z.string().trim().min(1).max(60),
  shortLabel: z.string().trim().min(1).max(24),
  iconKey: z.string().trim().min(1).max(40),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(32),
  createdAt: z.string().min(1),
  authority: ungovernedAgentAuthoritySchema,
});

/**
 * Build a fresh `UngovernedAgentEntry` from a registration input. `authority`
 * is never taken from `input` (the input schema has no such field) — it is
 * always the one shared `UNGOVERNED_AUTHORITY` constant.
 */
export function createUngovernedAgentEntry(
  input: CustomAgentRegistrationInput,
  opts: { now?: () => string } = {}
): UngovernedAgentEntry {
  const parsed = customAgentRegistrationInputSchema.parse(input);
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    id: customAgentId(parsed.slug),
    slug: parsed.slug,
    displayName: parsed.displayName,
    shortLabel: parsed.shortLabel ?? parsed.displayName.slice(0, 24),
    iconKey: parsed.iconKey ?? "custom-agent",
    command: parsed.command,
    args: parsed.args,
    createdAt: now(),
    authority: UNGOVERNED_AUTHORITY,
  };
}

/**
 * Parse a persisted (untrusted) value into an `UngovernedAgentEntry`, or
 * `null` if it does not validate. `authority` on a SUCCESSFUL parse is always
 * re-stamped to the shared `UNGOVERNED_AUTHORITY` object — a defensive
 * backstop (the schema's literal checks already force the values) so nothing
 * downstream can hold a structurally-authority-shaped-but-distinct object and
 * mutate it out from under every other reader.
 */
export function parseUngovernedAgentEntry(value: unknown): UngovernedAgentEntry | null {
  const result = ungovernedAgentEntrySchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  return {
    id: result.data.id as UngovernedAgentId,
    slug: result.data.slug,
    displayName: result.data.displayName,
    shortLabel: result.data.shortLabel,
    iconKey: result.data.iconKey,
    command: result.data.command,
    args: result.data.args,
    createdAt: result.data.createdAt,
    authority: UNGOVERNED_AUTHORITY,
  };
}

/** Type guard over an already-typed value (e.g. round-tripped through this
 *  same module), for call sites that want a boolean rather than a parse. */
export function isUngovernedAgentEntry(value: unknown): value is UngovernedAgentEntry {
  return ungovernedAgentEntrySchema.safeParse(value).success;
}

/** Identity fallback, mirroring `vendorLabel`/`vendorShortLabel`: an id this
 *  process has no entry for still renders as itself, never blank. */
export function ungovernedAgentLabel(
  id: string,
  entries: readonly UngovernedAgentEntry[]
): string {
  return entries.find((entry) => entry.id === id)?.displayName ?? id;
}
