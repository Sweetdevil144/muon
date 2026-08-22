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
 *
 * AND SO IS EVERY CAPABILITY CLAIM. Same rule, learned again on 2026-08-17: this
 * text told every agent to "call `code_query` before you grep" on installs where
 * no `gitnexus` CLI is reachable and all seven code-graph tools refuse. A
 * workflow instruction is a claim about what this install can DO, so it is
 * composed from the same resolver `whoami` reports from, never asserted.
 *
 * INCLUDING THE VERY FIRST SENTENCE, which is where that fix stopped short: it
 * still opened with "a memory graph a human confirms, and a code graph over this
 * repository" on an install whose next sentence read "THE CODE GRAPH IS ABSENT
 * FROM THIS INSTALL". A session reads the assertion before the correction, so
 * both are composed from the one `codeGraph` value below.
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
  /**
   * This seat's own hands are the ones that edit the workspace.
   *
   * TRUE for a session a human attached to their own coding agent — that
   * agent has its vendor's Write/Edit/Bash and a human watching the prompts.
   * FALSE for every seat MUON spawned: a worker edits inside the worktree
   * MUON gave it under MUON's own rules, and a coordinator has no Write tool
   * at all. Telling the wrong seat "you edit" is the one direction that is
   * both false and dangerous, which is why this is a positive per-mode flag
   * rather than `!spawned` — a future spawned-but-editing mode must opt in
   * deliberately, not inherit the kit by arithmetic (ADR-0022 rule 2).
   */
  readonly codes?: boolean;
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
    codes: true,
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
    codes: true,
  },
};

/** A hand-registered session (`muon mcp install`) — the S1 case, and the default. */
const ATTACHED_VOICE: ModeVoice = {
  holding:
    "the read tier: MUON's shared brain, attached to a session a human started",
  may: [],
  spawned: false,
  crewControl: false,
  codes: true,
};

export function muonServerInstructions(input: {
  readonly toolCount: number;
  readonly mode?: string;
  /**
   * Whether the code-graph half of the dual graph can do anything here.
   *
   * REQUIRED, not optional, and for the reason `renderProbe` states about its
   * own gate argument: an optional degrade field is one a second caller drops
   * without noticing, and the dropped case is silence — the exact "call
   * `code_query` before you grep" sentence this field was added to make honest.
   *
   * The word is `whoami`'s own (`grant.codeGraph`) because it is the same fact,
   * and the value comes from the same resolver — `gitNexusCliReachable`, which
   * wraps `resolveBundledGitNexusCli`. There is no second resolution anywhere:
   * `initialize` and `whoami` cannot disagree about whether this install has a
   * code graph.
   */
  readonly codeGraph: "available" | "unavailable";
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

  // WHAT MUON IS HERE — the same fact, in the sentence that comes FIRST.
  //
  // The opening line asserted the dual graph unconditionally while the clause
  // below said "THE CODE GRAPH IS ABSENT FROM THIS INSTALL", so a tarball
  // session read the false half first and the correction two sentences later.
  // Both now read `input.codeGraph`, which is one resolution
  // (`gitNexusCliReachable`) at one call site: the two sentences cannot
  // contradict each other, because there is one value to contradict.
  const brainLine =
    input.codeGraph === "available"
      ? "a memory graph a human confirms, and a code graph over this repository"
      : "a memory graph a human confirms — and on THIS install, that half alone";

  // The code-graph clause, in the ONE state this install is actually in. The
  // degrade names both remedies because they are the only two there are, and it
  // names the substitute (grep, read the files) so the sentence is not merely a
  // prohibition — an agent left with a gap fills it by retrying the tool.
  const codeGraphLine =
    input.codeGraph === "available"
      ? "Call `code_query` before you grep — it answers with execution flows rather than string matches."
      : "THE CODE GRAPH IS ABSENT FROM THIS INSTALL: no `gitnexus` CLI is reachable, so `code_query` and every other code-graph tool is listed but will refuse — grep and read the files instead, do not plan work that depends on the graph, and tell the human that installing GitNexus, or pointing MUON at one with MUON_GITNEXUS_BIN, restores them.";

  // H4 — the crew-babysitting kit, ONE documented turn, rendered only for a
  // mode that actually holds the verbs (naming them to a read-tier session
  // would advertise tools it does not have, the exact drift the instructions
  // lock exists to catch).
  const babysit = voice.crewControl
    ? "BABYSIT THE CREW IN ONE TURN: `fleet_status` (live seats per vendor, queueing, blockers) then `dispatch_status` (per-job truth — stall/watchdog reasons stated honestly, open blocking questions listed, and a finished job's packet contract named, so a degraded packet can never read as success). Then act: `steer` nudges a running job, `interrupt` stops a runaway, `question_status` shows what the crew is waiting on a human for, and `peer_wait` waits boundedly on a peer's lifecycle. A refusal from any of these is TYPED — it names the rule and the lawful next tool; it is never an invitation to retry harder."
    : undefined;

  // ── THE CODING KIT (attached seats only) ────────────────────────────────
  //
  // WHY THIS EXISTS, measured 2026-08-20: the attached instructions had a
  // crew-babysitting kit (H4) and nothing at all about the work the human
  // actually started this session to do. A human's Claude/Codex/Cursor holds
  // MUON's brain plus its OWN Write/Edit/Bash, and nothing here said "you
  // edit" — so a one-module instruction got answered with recon and fan-out,
  // and MUON read as a supervisor to route around rather than a brain to
  // consult.
  //
  // Rendered only for a seat whose own hands edit (`voice.codes`): saying it
  // to a MUON-spawned worker would describe authority it does not have, and
  // to a coordinator a Write tool it was never given.
  //
  // Ordered deliberately: what you ARE, then the two calls that pay for
  // themselves before an edit, then the ONE thing that turns a one-file change
  // into a mission. The anti-pattern is named because it is the default
  // behaviour of every vendor's own subagent feature — it is not enough to
  // omit the encouragement, the habit has to be contradicted.
  const codingKit = voice.codes
    ? "YOU ARE THE ONE WHO CODES HERE. This is your session with your own editing tools, and MUON is the brain beside them, not a supervisor to route around: it does not hold your Write tool and never asks for it. Read and edit directly. Two calls pay for themselves before you touch a symbol — `memory_preedit` (blast radius fused with the decisions already recorded about it) and `code_query` (execution flows, not string matches); `preflight_edit` records the pair atomically when you want the edit on the record. DO NOT SPAWN A CREW FOR A ONE-MODULE CHANGE. That includes your vendor's own subagent/Task feature: a second agent for a one-file edit costs a full context and a hand-off to save nothing, and MUON cannot govern a native subagent you spawn. Fan out only when the work is genuinely disjoint — separate packages, separate roles, or a sweep across many files — and when it is, `repo_map` with your ACTUAL instruction sizes it honestly (it answers 0 for a single-unit ask however large this repository is)."
    : undefined;

  return [
    // 1. What you are holding — and which halves of the brain this install has.
    `MUON is the shared brain for this machine: ${brainLine}. You are holding ${voice.holding} — ${input.toolCount} tools.`,

    // 2. The one workflow that makes the moat load-bearing — WHEN both halves
    //    of the dual graph are actually here. On an install with no reachable
    //    `gitnexus` CLI (the release tarball, measured 2026-08-17) the seven
    //    code-graph tools are still registered and every one of them refuses,
    //    so "call `code_query` before you grep" sent every agent on that build
    //    to a tool that cannot answer. The advice is REPLACED rather than
    //    dropped: an agent told nothing infers nothing, and would keep reaching
    //    for the graph it was told about in the tool list.
    `BEFORE YOU EDIT A SYMBOL, call \`memory_preedit\`. It returns that symbol's blast radius fused with the decisions previously recorded about it, which is the one thing you cannot get by reading the file. ${codeGraphLine} If you are unsure what you are or what you may do here, call \`whoami\` rather than guessing.`,

    // 2.4 (seats that edit): the coding kit — what the human started this
    //     session to do, which nothing here used to mention.
    ...(codingKit ? [codingKit] : []),

    // 2.5 (crew-control modes only): the one-turn babysit kit.
    ...(babysit ? [babysit] : []),

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
