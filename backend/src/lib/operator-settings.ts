import {
  standingApproverIsWatching,
  type StandingApproverGrant,
  EMPTY_MEMORY_INGEST_POLICY,
  parseMemoryLifecyclePolicy,
  parseMemoryIngestPolicy,
  type MemoryIngestPolicy,
  type MemoryLifecyclePolicy,
} from "@muon/protocol";
import { prisma } from "./db.js";

// ── #133 operator-tier server-side settings ──────────────────────────────────
//
// HUMAN-owned posture flags, read at request time by privileged handlers and
// persisted in the durable ledger (OperatorSetting) so a value survives a
// restart. They are OPERATOR-ONLY by construction: the only writer is the
// operator-tier route (requireOperator), so a free-form request body can never
// set one, and nothing here reads an env var — an agent-controlled process
// environment can never flip a flag either. Absent row = the documented default.

/** Setting key for the #133 crew-visible admission toggle. */
export const AUTO_CONFIRM_AGENT_MEMORY_KEY = "autoConfirmAgentMemory";
export const MEMORY_COMPACTION_RETENTION_DAYS_KEY =
  "memoryCompactionRetentionDays";
/** R3 TTL: days an eligible agent note stays recallable (0 = TTL disabled). */
export const MEMORY_TTL_DAYS_KEY = "memoryTtlDays";
/** R3 TTL: highest trust a note may carry and still receive a TTL. */
export const MEMORY_TTL_TRUST_CEILING_KEY = "memoryTtlTrustCeiling";
/** TODO 4.11 — explicit kind table, activated only by a preview-bound migration. */
export const MEMORY_LIFECYCLE_POLICY_KEY = "memoryLifecyclePolicyV1";
/** R4 — whether the lane-backed memory miner runs after a job finishes. */
export const MEMORY_MINING_KEY = "memoryMining";
/** TODO 4.7 — operator-authored deterministic ingest deny/allow patterns (JSON). */
export const MEMORY_INGEST_POLICY_KEY = "memoryIngestPolicy";
/**
 * The standing-approver LEASE: the instant (ISO-8601) the operator's live watch
 * on the approval inbox lapses unless it is renewed. Stored beside the posture
 * flags because it has the same single writer (requireOperator) and the same
 * "an agent-controlled env can never fake it" property — but it is NOT a flag:
 * it is only ever true for the next few seconds, by construction.
 */
export const STANDING_APPROVER_LEASE_KEY = "standingApproverLeaseExpiresAt";

/**
 * DEFAULT ON. When enabled, the pre-edit gate ADMITS same-chat UNCONFIRMED agent
 * notes into THAT chat's gate view ("crew-visible"), so an agent-authored
 * observation reaches the next agent in the SAME chat automatically. This is
 * DISTINCT from human confirmation: it NEVER mutates the human-only `confirmed`
 * flag, never auto-confirms, and never widens beyond the request's own chat (the
 * per-chat blast radius is hard-wired in preEditContext — crewChatId is ALWAYS the
 * request's own chatId). Agent notes keep their 'medium' trust, so a
 * `trustFloor:'high'` gate still excludes them (the founder's kill switch). Turning
 * this OFF restores the strict confirmed-only gate for every chat.
 *
 * "AGENT NOTES" MEANS EVERY AGENT AUTHOR, with no exceptions by principal: an
 * explicit `memory_add` proposal (`agent:<vendor>`), a deterministic capture
 * (`muon-capture`), and the LLM extractor's mined prose (`muon-extractor`) are
 * all admitted or all withheld together. Mined notes were briefly carved out
 * (F9) and are not any more — this is the SINGLE posture for "may unconfirmed
 * agent memory reach the crew", and a second, invisible rule underneath it made
 * the switch mean something different from what it says. If mined prose ever
 * needs its own dial, it has to be its own OPERATOR-VISIBLE setting, never a
 * hard-coded narrowing of this one.
 *
 * This does NOT auto-approve memory and no agent can. `confirmed` is set only by
 * a human principal (`confirmingPrincipal`, auth.ts), and only a confirmed note
 * is durable, cross-chat-promotable, and exempt from the R3 TTL. Crew-visible is
 * "usable in this chat now"; confirmed is "a human vouched for this". Collapsing
 * the two is what would make the governance claim decorative.
 */
const AUTO_CONFIRM_AGENT_MEMORY_DEFAULT = true;
const MEMORY_COMPACTION_RETENTION_DAYS_DEFAULT = 30;

/**
 * R3 TTL defaults. 30 days deliberately MATCHES the compaction retention window
 * above so an operator holds ONE mental model of "how long does un-governed
 * memory stick around", and it is long enough that an unreviewed-but-useful
 * agent note survives a normal review cycle while short enough that a three-
 * month-old guess stops competing with a confirmed fact for recall.
 *
 * The ceiling is 'medium' because that is the trust an ordinary agent note gets
 * (parsePrincipal: agent → medium). A 'low'-only ceiling would make the policy
 * inert on the exact notes it exists for. 'high' is NOT a legal ceiling: a
 * high-trust note never auto-expires, which is an invariant, not a dial.
 */
const MEMORY_TTL_DAYS_DEFAULT = 30;
const MEMORY_TTL_TRUST_CEILING_DEFAULT: MemoryTtlTrustCeiling = "medium";

/** The only trust levels a TTL may ever apply to. */
export type MemoryTtlTrustCeiling = "low" | "medium";

export type MemoryTtlPolicy = {
  /** Days an eligible note stays recallable before it hides. 0 = TTL disabled. */
  days: number;
  /** A note expires only when its trust is at or below this ceiling. */
  trustCeiling: MemoryTtlTrustCeiling;
};

export type EffectiveMemoryLifecyclePolicy = {
  /** `legacy_global` means no kind table has been activated on this install. */
  source: "legacy_global" | "kind_table";
  policy: MemoryLifecyclePolicy;
  /** Preserves old direct-ledger kinds until an explicit table migration can refuse them. */
  legacyFallbackDays: number | null;
};

/**
 * DEFAULT ON. R4's LLM extraction tier: after a job finishes, a locked-down
 * read-only lane (no tools, no MCP servers) reads the raw output and proposes
 * candidate notes. It shipped behind `MUON_MEMORY_MINE=1` and therefore never
 * ran, which is why a real session left the brain empty — only the three
 * deterministic signals could ever land.
 *
 * This is NOT a gate and grants NO authority: everything it proposes lands
 * UNCONFIRMED through the same dedup-aware ingest and still faces the human
 * confirm/reject gate. What it does cost is one extra BYO-auth lane call per
 * finished job, which is why it is an operator-owned dial and not a constant.
 */
const MEMORY_MINING_DEFAULT = true;

/** Read the #133 crew-visible toggle (default ON when no row has been written). */
export async function getAutoConfirmAgentMemory(): Promise<boolean> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: AUTO_CONFIRM_AGENT_MEMORY_KEY },
    });
    // No row = the product default (ON, the documented first-run posture).
    if (!row) {
      return AUTO_CONFIRM_AGENT_MEMORY_DEFAULT;
    }
    return row.value === "true";
  } catch {
    // FAIL CLOSED (gates fail closed): if the store can't be read, do NOT widen the
    // hero gate — fall back to the STRICT confirmed-only gate (crew OFF), never the
    // ON default, and never 500 the gate over a settings hiccup. Widening is the
    // unsafe direction, so uncertainty resolves to "don't widen".
    return false;
  }
}

/** Persist the #133 crew-visible toggle. Callers MUST gate this behind
 *  requireOperator — an agent tier can never reach it. Returns the stored value. */
export async function setAutoConfirmAgentMemory(enabled: boolean): Promise<boolean> {
  await prisma.operatorSetting.upsert({
    where: { key: AUTO_CONFIRM_AGENT_MEMORY_KEY },
    create: { key: AUTO_CONFIRM_AGENT_MEMORY_KEY, value: String(enabled) },
    update: { value: String(enabled) },
  });
  return enabled;
}

/**
 * Read the operator-owned retention window. A missing row uses the documented
 * 30-day default; an unreadable/malformed row returns null so compaction skips
 * rather than guessing its destructive boundary.
 */
export async function getMemoryCompactionRetentionDays(): Promise<number | null> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: MEMORY_COMPACTION_RETENTION_DAYS_KEY },
    });
    if (!row) {
      return MEMORY_COMPACTION_RETENTION_DAYS_DEFAULT;
    }
    const value = Number(row.value);
    return Number.isInteger(value) && value >= 1 && value <= 3_650
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the R4 memory-mining toggle (default ON when no row has been written).
 *
 * Unlike the crew-visible gate above this resolves an unreadable store to the
 * documented default (ON) rather than OFF. Mining is not a gate — it widens
 * nothing, admits nothing, and every note it proposes still needs a human — so
 * "uncertainty resolves to don't widen" does not apply; the failure that
 * actually hurts here is the silent one we are fixing, a brain that stays empty
 * because a lookup hiccuped. The operator keeps a guaranteed, network-free off
 * switch in `MUON_MEMORY_MINE=0`, which the runner honours before it ever asks.
 */
export async function getMemoryMining(): Promise<boolean> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: MEMORY_MINING_KEY },
    });
    if (!row) {
      return MEMORY_MINING_DEFAULT;
    }
    return row.value === "true";
  } catch {
    return MEMORY_MINING_DEFAULT;
  }
}

/** Persist the R4 memory-mining toggle. Callers MUST gate this behind
 *  requireOperator — an agent tier can never flip it. Returns the stored value. */
export async function setMemoryMining(enabled: boolean): Promise<boolean> {
  await prisma.operatorSetting.upsert({
    where: { key: MEMORY_MINING_KEY },
    create: { key: MEMORY_MINING_KEY, value: String(enabled) },
    update: { value: String(enabled) },
  });
  return enabled;
}

/**
 * Read the TODO 4.7 ingest deny/allow policy. Missing or malformed rows resolve
 * to the empty policy (allow all). Unlike TTL, uncertainty here is the safe
 * direction — a broken read must not block every ingest.
 */
export async function getMemoryIngestPolicy(): Promise<MemoryIngestPolicy> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: MEMORY_INGEST_POLICY_KEY },
    });
    if (!row) {
      return EMPTY_MEMORY_INGEST_POLICY;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch {
      return EMPTY_MEMORY_INGEST_POLICY;
    }
    const parsed = parseMemoryIngestPolicy(decoded);
    return parsed.ok ? parsed.policy : EMPTY_MEMORY_INGEST_POLICY;
  } catch {
    return EMPTY_MEMORY_INGEST_POLICY;
  }
}

/** Persist the bounded ingest deny/allow policy. Operator-gated callers only. */
export async function setMemoryIngestPolicy(
  policy: MemoryIngestPolicy
): Promise<MemoryIngestPolicy> {
  const parsed = parseMemoryIngestPolicy(policy);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  await prisma.operatorSetting.upsert({
    where: { key: MEMORY_INGEST_POLICY_KEY },
    create: {
      key: MEMORY_INGEST_POLICY_KEY,
      value: JSON.stringify(parsed.policy),
    },
    update: { value: JSON.stringify(parsed.policy) },
  });
  return parsed.policy;
}

/**
 * Read the operator-owned R3 TTL policy. Missing rows use the documented
 * defaults; an unreadable or malformed row returns null so BOTH the ingest stamp
 * and the sweeper skip rather than guess an eviction boundary — exactly the
 * posture compaction takes, and for the same reason: expiry is eviction, and
 * eviction under uncertainty is the unsafe direction.
 *
 * A malformed value never partially applies. One bad row disables the whole
 * policy, so an operator can never end up with a half-configured TTL that
 * expires notes on a ceiling they did not choose.
 */
export async function getMemoryTtlPolicy(): Promise<MemoryTtlPolicy | null> {
  try {
    const rows = await prisma.operatorSetting.findMany({
      where: {
        key: { in: [MEMORY_TTL_DAYS_KEY, MEMORY_TTL_TRUST_CEILING_KEY] },
      },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    const rawDays = byKey.get(MEMORY_TTL_DAYS_KEY);
    let days = MEMORY_TTL_DAYS_DEFAULT;
    if (rawDays !== undefined) {
      const parsed = Number(rawDays);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3_650) {
        return null;
      }
      days = parsed;
    }

    const rawCeiling = byKey.get(MEMORY_TTL_TRUST_CEILING_KEY);
    let trustCeiling = MEMORY_TTL_TRUST_CEILING_DEFAULT;
    if (rawCeiling !== undefined) {
      if (rawCeiling !== "low" && rawCeiling !== "medium") {
        return null;
      }
      trustCeiling = rawCeiling;
    }
    return { days, trustCeiling };
  } catch {
    return null;
  }
}

/**
 * Resolve the one effective write-time lifecycle table. An absent kind-table
 * setting expands the existing global TTL into five identical rows, preserving
 * every pre-4.11 install byte-for-byte. A malformed explicit table fails closed
 * to null: callers stamp no deadline and the sweeper evicts nothing.
 */
export async function getMemoryLifecyclePolicy(): Promise<
  EffectiveMemoryLifecyclePolicy | null
> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: MEMORY_LIFECYCLE_POLICY_KEY },
    });
    if (row) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(row.value);
      } catch {
        return null;
      }
      const parsed = parseMemoryLifecyclePolicy(decoded);
      return parsed.ok
        ? {
            source: "kind_table",
            policy: parsed.policy,
            legacyFallbackDays: null,
          }
        : null;
    }

    const legacy = await getMemoryTtlPolicy();
    if (!legacy) {
      return null;
    }
    return {
      source: "legacy_global",
      legacyFallbackDays: legacy.days,
      policy: {
        version: 1,
        trustCeiling: legacy.trustCeiling,
        daysByKind: {
          decision: legacy.days,
          constraint: legacy.days,
          convention: legacy.days,
          attempt: legacy.days,
          question: legacy.days,
        },
        permanentWhenConfirmedByKind: {
          decision: true,
          constraint: true,
          convention: true,
          attempt: true,
          question: true,
        },
      },
    };
  } catch {
    return null;
  }
}

/** Persist the bounded R3 TTL policy. Callers MUST be operator-gated: a TTL
 *  decides when un-governed memory stops being recalled, so it is a human
 *  posture, never something an agent body can reach. */
export async function setMemoryTtlPolicy(
  policy: MemoryTtlPolicy
): Promise<MemoryTtlPolicy> {
  if (
    !Number.isInteger(policy.days) ||
    policy.days < 0 ||
    policy.days > 3_650
  ) {
    throw new Error("Memory TTL must be 0-3650 days (0 disables expiry).");
  }
  if (policy.trustCeiling !== "low" && policy.trustCeiling !== "medium") {
    throw new Error("Memory TTL trust ceiling must be low or medium.");
  }
  await prisma.$transaction([
    prisma.operatorSetting.upsert({
      where: { key: MEMORY_TTL_DAYS_KEY },
      create: { key: MEMORY_TTL_DAYS_KEY, value: String(policy.days) },
      update: { value: String(policy.days) },
    }),
    prisma.operatorSetting.upsert({
      where: { key: MEMORY_TTL_TRUST_CEILING_KEY },
      create: {
        key: MEMORY_TTL_TRUST_CEILING_KEY,
        value: policy.trustCeiling,
      },
      update: { value: policy.trustCeiling },
    }),
  ]);
  return policy;
}

// ── Standing-approver lease (Full Auto) ──────────────────────────────────────
//
// Full Auto ("Auto approve all") is standing operator consent held by a LIVE
// process: the desktop's approvals poller resolves every incoming approval
// through the same operator PATCH a human click uses. Nothing downstream could
// ever learn that, so a coordinator session — which has no interactive operator
// of its own — denied every un-preauthorized tool even with every gate
// deliberately switched off.
//
// This publishes that fact, and ONLY for as long as it is still true. The
// approver renews on its own poll cycle; the moment it stops (toggle off, quit,
// crash, brain unreachable) the lease lapses within TTL and the coordinator's
// fast-deny fires again exactly as it does today. It grants no authority by
// itself: an approval still has to be FILED, and still has to be DECIDED by an
// operator-tier principal.

/**
 * How long ONE renewal buys. Deliberately several desktop poll cycles (5s
 * default) so an ordinary hiccup does not flap the grant, and deliberately far
 * inside `STANDING_APPROVER_LEASE_HORIZON_MS` so a stale row is unusable long
 * before any reader would still believe it.
 */
export const STANDING_APPROVER_LEASE_TTL_MS = 30_000;

/**
 * Read the standing-approver grant. FAIL CLOSED on every uncertainty — no row,
 * an unparseable instant, a lapsed lease, or an unreadable store all report "no
 * approver is watching", which is the state that keeps the coordinator gate
 * denying. Widening is the unsafe direction, so nothing but a live, well-formed
 * lease can produce `active:true`.
 */
export async function getStandingApproverGrant(): Promise<StandingApproverGrant> {
  try {
    const row = await prisma.operatorSetting.findUnique({
      where: { key: STANDING_APPROVER_LEASE_KEY },
    });
    if (!row) {
      return { active: false };
    }
    const expiresAt = Date.parse(row.value);
    if (!Number.isFinite(expiresAt)) {
      return { active: false };
    }
    const grant: StandingApproverGrant = {
      active: true,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    // ONE staleness rule, shared with every reader (@muon/protocol), so the
    // brain and the runner can never disagree about whether a lease is live.
    return standingApproverIsWatching(grant) ? grant : { active: false };
  } catch {
    return { active: false };
  }
}

/**
 * Renew the lease for another TTL. Callers MUST be operator-gated: this asserts
 * that a HUMAN's standing consent is live right now, which is exactly the claim
 * an agent tier must never be able to make. The expiry is computed SERVER-side
 * from a fixed TTL, so no request body carries an authority field at all.
 */
export async function renewStandingApproverLease(): Promise<StandingApproverGrant> {
  const expiresAt = new Date(
    Date.now() + STANDING_APPROVER_LEASE_TTL_MS
  ).toISOString();
  await prisma.operatorSetting.upsert({
    where: { key: STANDING_APPROVER_LEASE_KEY },
    create: { key: STANDING_APPROVER_LEASE_KEY, value: expiresAt },
    update: { value: expiresAt },
  });
  return { active: true, expiresAt };
}

/**
 * Release the lease now (Full Auto switched off, or the approver is quitting),
 * rather than letting it run out its TTL. Idempotent — releasing a lease nobody
 * holds is a no-op — so the approver can call it on every cycle it is off.
 */
export async function releaseStandingApproverLease(): Promise<StandingApproverGrant> {
  await prisma.operatorSetting.deleteMany({
    where: { key: STANDING_APPROVER_LEASE_KEY },
  });
  return { active: false };
}

/** Persist the bounded compaction retention window. Callers MUST be operator-gated. */
export async function setMemoryCompactionRetentionDays(
  retentionDays: number
): Promise<number> {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3_650
  ) {
    throw new Error("Memory compaction retention must be 1-3650 days.");
  }
  await prisma.operatorSetting.upsert({
    where: { key: MEMORY_COMPACTION_RETENTION_DAYS_KEY },
    create: {
      key: MEMORY_COMPACTION_RETENTION_DAYS_KEY,
      value: String(retentionDays),
    },
    update: { value: String(retentionDays) },
  });
  return retentionDays;
}

/**
 * ADR-0036 D7 — the operator's DEFAULT mission cost cap.
 *
 * A default, not a cap. It decides what a NEW chat starts with, and is COPIED
 * into that chat's own column at creation; nothing reads it again afterwards.
 *
 * The copy is the decision. If enforcement read this row at dispatch time,
 * editing the default would silently move a cap a human had already approved
 * for a mission in flight — the same failure ADR-0038 D3 disables an imported
 * item for, and the one thing a limit must never do quietly.
 *
 * Absent means NO default, which is deliberately not the same as a default of
 * zero: a zero cap would refuse the very first dispatch of every new chat.
 */
export const MISSION_COST_CAP_DEFAULT_USD_KEY = "missionCostCapDefaultUsd";

export async function getMissionCostCapDefaultUsd(
  db: Pick<typeof prisma, "operatorSetting"> = prisma
): Promise<number | null> {
  // NO try/catch, deliberately.
  //
  // It had one, and an adversarial review named the consequence: a transient
  // read failure returned `null`, which is indistinguishable from "the
  // operator set no default" — so a chat created in that window came out
  // UNCAPPED while the operator believed a cap was in force. That is a
  // spending limit failing OPEN, which is the one direction it must never
  // fail.
  //
  // Letting it throw is also cheap: the only caller creates a chat in the
  // SAME database moments later, so a read that genuinely cannot happen is a
  // create that was going to fail anyway. Better a refused chat than a silent
  // uncapped one.
  const row = await db.operatorSetting.findUnique({
    where: { key: MISSION_COST_CAP_DEFAULT_USD_KEY },
  });
  // NO ROW IS THE ONLY "no default". An operator who never set one, or who
  // cleared theirs, gets an uncapped chat because that is what they asked for.
  if (!row) return null;

  const parsed = Number(row.value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // A ROW THAT EXISTS AND CANNOT BE READ IS NOT "no default". It used to
    // resolve to `null` — the same value as an intentional clear — so a
    // corrupted setting silently produced UNCAPPED chats while the operator
    // believed a cap was in force. Same failing-open shape as the swallowed
    // read below it, and the same answer: refuse, and say what to fix.
    // 409, NOT a bare Error. Fastify masks an untyped throw as "Unexpected
    // server error", so this precise remediation reached the log and never the
    // operator — the refusal was correct and invisible, which is most of the
    // way to not having it. `compatibility-enable.ts` chose a 409 for exactly
    // this reason; this path had not.
    throw Object.assign(
      new Error(
        `The stored default mission cost cap is not a positive dollar amount (${JSON.stringify(
          row.value
        )}). MUON will not create an uncapped mission on the strength of a value it cannot read — set it again with \`muon cost default <usd>\`, or clear it with \`none\`.`
      ),
      { statusCode: 409 }
    );
  }
  return parsed;
}

/**
 * Persist the default. Callers MUST gate this behind `requireOperator` — there
 * is no agent path to a spending limit, not even to its default.
 *
 * `null` clears it. A cleared default is not a cap of zero.
 */
export async function setMissionCostCapDefaultUsd(
  usd: number | null
): Promise<number | null> {
  if (usd === null) {
    // `deleteMany` because it is IDEMPOTENT: clearing a default that was never
    // set is a success, and deleting a row that is not there is not an error.
    //
    // This used to be `delete().catch(() => undefined)`, which was aimed at
    // that same "no row" case but swallowed EVERY failure — so a database
    // error returned `null` and the operator was told the cap was cleared
    // while the old default stayed live and kept admitting work. A governed
    // write that cannot fail out loud is not governed.
    await prisma.operatorSetting.deleteMany({
      where: { key: MISSION_COST_CAP_DEFAULT_USD_KEY },
    });
    return null;
  }
  await prisma.operatorSetting.upsert({
    where: { key: MISSION_COST_CAP_DEFAULT_USD_KEY },
    create: { key: MISSION_COST_CAP_DEFAULT_USD_KEY, value: String(usd) },
    update: { value: String(usd) },
  });
  return usd;
}
