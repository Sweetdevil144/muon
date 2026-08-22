/**
 * H10 (2026-08 cycle) — human-speakable session slugs.
 *
 * A job id is a coordinate, not a name: nobody says "cmb4k2xw90003…" in a
 * review. The slug is a DISPLAY projection of the id — deterministic, pure,
 * computed at render time on every surface from the same function, so the
 * TUI strip, the desktop row, `dispatch status`, and MCP payloads can never
 * disagree about what a job is called and nothing needs a column, a
 * migration, or a collision ledger. Identity remains the id everywhere; the
 * trailing id fragment keeps two same-word slugs tellable apart and makes
 * the slug greppable back to its job.
 */

const SLUG_ADJECTIVES = [
  "amber", "bold", "brisk", "calm", "candid", "cedar", "civil", "clear",
  "cobalt", "copper", "coral", "crisp", "deft", "dry", "early", "even",
  "fleet", "frank", "gentle", "glad", "grave", "green", "hardy", "honest",
  "iron", "keen", "late", "lean", "level", "lucid", "mellow", "mild",
  "noble", "north", "olive", "pale", "plain", "prime", "quiet", "rapid",
  "sober", "solid", "sound", "spare", "steady", "stern", "swift", "tidy",
] as const;

const SLUG_NOUNS = [
  "anvil", "arch", "basin", "beacon", "bridge", "brook", "cairn", "cedar",
  "cliff", "comet", "crane", "delta", "dune", "ember", "fern", "fjord",
  "flint", "gale", "glade", "grove", "harbor", "hawk", "heron", "kestrel",
  "knoll", "lantern", "ledge", "linnet", "loom", "mesa", "moor", "otter",
  "oxbow", "pine", "quarry", "quill", "reef", "ridge", "sable", "shoal",
  "sparrow", "spruce", "summit", "tarn", "thrush", "trace", "vale", "wren",
] as const;

/** FNV-1a over the id — stable across processes, no crypto import. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The id fragment that keeps same-word slugs apart and greppable — taken
 * from the id's TAIL, not its head. MUON job ids are cuids, whose leading
 * characters are `c` + a base-36 TIMESTAMP: measured, 200 same-day jobs
 * shared ONE distinct head fragment, which made head-fragment slugs collide
 * at ~16% with 30 concurrent sessions. The cuid's tail is its random block,
 * so the last four characters carry real entropy, and `grep <fragment>`
 * still finds the job (suffix match instead of prefix match).
 */
function idFragment(jobId: string): string {
  const compact = jobId.replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(-4) || "0000").toLowerCase();
}

/**
 * `sessionSlug("cmb4k2xw90003abcd")` → `"rapid-gale-abcd"` (measured, not
 * illustrative — the fragment is the id's TAIL, per `idFragment` above; the
 * old example printed a HEAD fragment the code has never produced).
 * Total function: any non-empty string gets a slug; an empty id gets the
 * honest `"unnamed-0000"` rather than a throw in a render path.
 */
export function sessionSlug(jobId: string): string {
  if (!jobId) return "unnamed-0000";
  const hash = fnv1a(jobId);
  const adjective = SLUG_ADJECTIVES[hash % SLUG_ADJECTIVES.length]!;
  const noun =
    SLUG_NOUNS[Math.floor(hash / SLUG_ADJECTIVES.length) % SLUG_NOUNS.length]!;
  return `${adjective}-${noun}-${idFragment(jobId)}`;
}

/** `sessionSlugLine("cmb4k2xw90003abcd")` → `"rapid-gale-abcd (cmb4k2xw)"` —
 *  the one line surfaces print when they want both the name and the
 *  coordinate. The two id fragments are DIFFERENT ends on purpose: the slug's
 *  tail carries the cuid's entropy (so two same-day jobs are tellable apart),
 *  while the parenthesised head is the id PREFIX an operator pastes into a
 *  prefix search or a ledger lookup. */
export function sessionSlugLine(jobId: string): string {
  return `${sessionSlug(jobId)} (${jobId.slice(0, 8)})`;
}
