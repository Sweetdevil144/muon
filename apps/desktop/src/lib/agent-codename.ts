/**
 * Agent codenames — DISPLAY ONLY.
 *
 * Sub-agents used to surface as "claude-code-1" / "codex-2" (the backend
 * `AgentRecord.name`, `${vendor}-${ordinal}`). That name is a stable
 * routing/identity string and is deliberately LEFT UNCHANGED here. This module
 * derives a memorable, human-facing CODENAME from a stable id (an agent id, or
 * a job id when no agent is bound yet) purely for rendering in the crew tree,
 * the subagent tabs, and the agent panes. It never participates in dispatch,
 * governance, routing, or persistence — swap it out and every key still works.
 *
 * The mapping is deterministic and pure: the same id always yields the same
 * codename, on every surface and across reloads, with no shared state.
 */

/** Curated pool — short, memorable, visually distinct, no vendor connotation. */
export const AGENT_CODENAMES = [
  "Atlas",
  "Nova",
  "Cipher",
  "Orion",
  "Vesper",
  "Quill",
  "Onyx",
  "Sable",
  "Lumen",
  "Halcyon",
  "Ember",
  "Cobalt",
  "Zephyr",
  "Kestrel",
  "Juno",
  "Rune",
  "Solace",
  "Vega",
  "Tundra",
  "Pallas",
  "Indigo",
  "Marlow",
  "Cascade",
  "Ferro",
] as const;

/**
 * FNV-1a (32-bit) over the id — a fast, well-distributed, dependency-free
 * string hash. `Math.imul` keeps the multiply in 32-bit space; `>>> 0` coerces
 * to an unsigned int so the modulo below is always a valid pool index.
 */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The stable codename for one id. Deterministic + pure: same id → same name,
 * always. Empty/absent ids fall back to the first pool entry so the UI never
 * renders a blank label.
 */
export function agentCodename(id: string | null | undefined): string {
  if (!id) return AGENT_CODENAMES[0];
  return AGENT_CODENAMES[hashId(id) % AGENT_CODENAMES.length]!;
}

/**
 * Codenames for a whole crew at once, disambiguating the rare case where two
 * ids hash to the SAME pool entry: the first id (in the caller's order) keeps
 * the bare codename; each later collider gets a running numeric suffix
 * ("Nova 2", "Nova 3"). The bare base for any single id is unchanged from
 * `agentCodename`, so a suffix appears ONLY on a genuine collision. Given the
 * same id list in the same order the result is fully deterministic.
 *
 * Callers should pass ids in a stable order (e.g. sorted by ordinal) so a
 * collider's suffix does not flip between renders.
 */
export function agentCodenames(
  ids: ReadonlyArray<string>
): Map<string, string> {
  const assignedPerBase = new Map<string, number>();
  const out = new Map<string, string>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const base = agentCodename(id);
    const count = (assignedPerBase.get(base) ?? 0) + 1;
    assignedPerBase.set(base, count);
    out.set(id, count === 1 ? base : `${base} ${count}`);
  }
  return out;
}
