/**
 * THE FIRST THING AN ATTACHED SESSION IS TOLD.
 *
 * `docs/design/cc-as-superagent-delivery.md` §3.3 calls this "the single
 * highest-leverage discoverability change in this whole note", and the reason is
 * structural: a session a HUMAN launched has no MUON system prompt. MUON never
 * compiles its profile and never spawned it. The only two channels MUON owns are
 * this `instructions` field on `initialize` and the tool descriptions — and for
 * one commit after `muon mcp install` shipped, this one was empty. A session could
 * hold 24 MUON tools and be told nothing about what they were for.
 *
 * CORRECTED AFTER REVIEW: that premise is true of the ATTACHED case and was
 * applied to every session with no mode — which, until the runner started
 * declaring `worker`, included every MUON-SPAWNED WORKER. Those sessions were
 * told MUON had not spawned them, did not interpose on their tools, and had a
 * human sitting at their terminal. All three are false for a worker, and false in
 * the direction that invites it to act as if ungoverned. The mode is now DECLARED
 * at spawn (`muon-mcp-injection.ts`), so each voice describes a session that
 * actually exists.
 *
 * THE ORDER IS THE DESIGN. §3.3 fixes it as the order in which a wrong belief
 * costs the most: what you are holding, the one workflow that makes the dual graph
 * load-bearing, what you cannot do, where the human is, and the honest boundary.
 *
 * EVERY NUMBER IS DERIVED. The tool count comes from the tool list actually
 * registered, never from a literal — a hardcoded "24 tools" is the drift this repo
 * has already paid for more than once, and it would be read as authoritative by a
 * model that cannot check it.
 */

/** What a mode may do, stated POSITIVELY. Never `EVERYTHING − forbidden`: a tier
 *  derived by subtraction silently grants whatever the next release adds, which
 *  has broken delegate launch and delegate dispatch in this repo before. */
type ModeVoice = {
  /** How the session should understand its own authority, in one clause. */
  readonly holding: string;
  /** The crew verbs this mode genuinely has. Empty = it coordinates nothing. */
  readonly may: readonly string[];
  /** Whether MUON's runner, rather than the human's vendor CLI, spawned it. */
  readonly spawned: boolean;
  /** Whether the positively granted inventory contains crew-control verbs. */
  readonly crewControl: boolean;
  /**
   * Control verbs this mode explicitly does NOT hold despite `crewControl`.
   * Only meaningful for a POSITIVE partial grant (ADR-0028 Tier C) — a fully
   * hermetic worker/orchestrator states its absence of crew control via
   * `crewControl: false` instead, so this stays undefined there.
   */
  readonly explicitlyExcluded?: readonly string[];
};

const MODE_VOICE: Record<string, ModeVoice> = {
  worker: {
    holding:
      "a governed worker's toolset, because MUON dispatched you into an isolated worktree",
    may: [],
    spawned: true,
    crewControl: false,
  },
  orchestrator: {
    holding:
      "the crew-control toolset as well, because a MUON runner started you as a coordinator",
    may: ["dispatch a crew", "steer or interrupt a lane", "file a gate"],
    spawned: true,
    crewControl: true,
  },
  delegate: {
    holding:
      "a delegate's toolset, because a MUON coordinator spawned you as a child",
    may: ["report to your parent"],
    spawned: true,
    crewControl: false,
  },
  observer: {
    holding:
      "the attached-observer tier for a session a human started: shared brain plus bounded crew reads",
    may: ["read one mission's fleet, tasks, dispatches, budgets, workflows, roles, and approvals"],
    spawned: false,
    crewControl: false,
  },
  "attached-coordinator": {
    holding:
      "the attached-coordinator tier for a session a human started: shared brain, bounded crew reads, and a bounded crew-control grant on one mission",
    may: [
      "create tasks",
      "dispatch a governed child",
      "steer or interrupt an in-scope job",
      "file a ship review",
      "assign crew roles",
      "propose a workflow",
    ],
    // `spawned: false` is deliberate and load-bearing, NOT an oversight: this
    // mode holds crew-control verbs, but MUON still did not spawn the PROCESS
    // — the human's own terminal did — so `boundary` below must read the
    // honest non-hermetic text (MUON governs the crew and memory; it neither
    // compiles nor observes this session's own native tools), never the
    // spawned-worker text that claims an approval hook this session has none of.
    spawned: false,
    crewControl: true,
    explicitlyExcluded: ["set_fleet", "raise_budget", "apply_workflow"],
  },
};

/** A hand-registered session (`muon mcp install`) — the S1 case, and the default. */
const ATTACHED_VOICE: ModeVoice = {
  holding:
    "the read tier: MUON's shared brain, attached to a session a human started",
  may: [],
  spawned: false,
  crewControl: false,
};

export function muonServerInstructions(input: {
  readonly toolCount: number;
  readonly mode?: string;
}): string {
  // An UNKNOWN mode falls to the attached voice, which is the narrowest one. A
  // mode string MUON does not recognise must never be described as holding more
  // than the read tier.
  const voice: ModeVoice =
    (input.mode ? MODE_VOICE[input.mode] : undefined) ?? ATTACHED_VOICE;
  // MUON SPAWNED THIS SESSION iff a mode was declared. `muon mcp install` writes
  // no mode precisely so an absent one means "a human attached the brain".
  const spawned = voice.spawned;
  const boundary = spawned
    ? "BOUNDARY: MUON spawned you, so MUON DOES interpose — your tool calls pass its approval hook, your edits are confined to the worktree it gave you, and a gate you trip is filed to the human's MUON inbox rather than answered here. There is no human watching this terminal; if you need a decision, say so plainly and stop."
    : "BOUNDARY, stated so you do not assume otherwise: MUON did NOT spawn this session, so it does not govern what you do to the filesystem. Your own vendor permissions do — MUON never interposes on tools it did not spawn. What MUON governs is what you may do to the CREW and to MEMORY. The compensating fact is real: a human is at this terminal answering your vendor's own prompts as they happen, which is a stronger posture than an unattended agent, not a weaker one.";
  // THE MEMORY SENTENCE, corrected. `AUTO_CONFIRM_AGENT_MEMORY_DEFAULT` is TRUE,
  // so a crew-authored note is orchestrator-vouched at ingest, and `vouchedForCrew`
  // admits `confirmedBy === "orchestrator"` into every later child's brief
  // preamble. The previous text — "it does not reach another agent's gate before
  // then" — was therefore false by default, and false in the reassuring direction.
  const memory = spawned
    ? "Memory you add is NOT human-confirmed, but by default MUON's coordinator vouches for a crew-authored note at ingest, which admits it to other agents' briefs IN THIS MISSION. So write what the next agent genuinely needs and nothing you would not want acted on; a human still reviews it before it becomes permanent."
    : "Memory you add is an UNCONFIRMED PROPOSAL: no human has vouched for it, and it is marked as such wherever it surfaces. A human confirms it on a MUON surface to make it permanent.";
  const crew = [
    ...(voice.may.length > 0
      ? [`In this mode you may: ${voice.may.join("; ")}.`]
      : []),
    ...(voice.crewControl
      ? []
      : [
          "You cannot dispatch, steer, interrupt, ship, merge, or approve anything. Those verbs are not in your toolset at all — not withheld at call time, absent.",
        ]),
    ...(voice.explicitlyExcluded && voice.explicitlyExcluded.length > 0
      ? [
          `You do NOT hold ${voice.explicitlyExcluded.join(", ")} — those still require an operator-redeemed gate on a MUON surface, never this session.`,
        ]
      : []),
  ].join(" ");

  return [
    // 1. What you are holding.
    `MUON is the shared brain for this machine: a memory graph a human confirms, and a code graph over this repository. You are holding ${voice.holding} — ${input.toolCount} tools.`,

    // 2. The one workflow that makes the moat load-bearing.
    "BEFORE YOU EDIT A SYMBOL, call `memory_preedit`. It returns that symbol's blast radius fused with the decisions previously recorded about it, which is the one thing you cannot get by reading the file. Call `code_query` before you grep — it answers with execution flows rather than string matches. If you are unsure what you are or what you may do here, call `whoami` rather than guessing.",

    // 3. What you cannot do, positively stated.
    `${crew} ${memory}`,

    // 4. Where the human is.
    "Anything requiring approval is filed to the MUON inbox and answered by the human on a MUON surface — not here. If you need a gate, say so plainly and stop; do not route around it.",

    // 5. The honest boundary, which matters more than it looks — and which is
    //    DIFFERENT for a session MUON spawned versus one a human attached. Saying
    //    the attached version to a worker tells it that it is ungoverned, which is
    //    both false and the most dangerous thing MUON could tell an editing agent.
    boundary,
  ].join("\n\n");
}
