import {
  capRefusesDispatch,
  describeCapVerdict,
  evaluateCap,
  laneCostsFromUsageEvents,
  summarizeMissionCost,
  type CapVerdict,
  type LaneCost,
  type MissionCost,
} from "@muon/protocol";
import { prisma } from "./db.js";

/**
 * ADR-0036 D6/D7 — the mission's observed spend, and the brake it feeds.
 *
 * WHAT THIS IS, stated precisely because the type it produces is a floor and
 * every past bug on this surface came from reading a floor as a total:
 *
 *   `observedUsd` sums the lanes whose VENDOR reported dollars. Today that is
 *   Claude alone (`token-usage.ts` reads `total_cost_usd` from a result
 *   message; codex reports tokens, cursor reports nothing), so partial
 *   coverage is the NORMAL case in a mixed crew, not the exception.
 *
 * The brake built on it is therefore SOUND AND INCOMPLETE, which ADR-0036 D6
 * settles rather than papers over:
 *
 *   - a refusal is never wrong — `observed >= cap` implies `actual >= cap`
 *     with certainty, so the cap cannot stop a mission that has spent less;
 *   - a non-refusal is not a promise — unreported lanes may already have
 *     passed the cap, which is why every verdict carries its coverage and why
 *     `unenforceable` does NOT refuse.
 *
 * Nothing here multiplies tokens by a price, at any layer.
 */

/**
 * A backstop on the DISTINCT tasks one mission's cost is derived from.
 *
 * Not a page size: a mission's jobs share a handful of tasks, so this is not a
 * shape MUON produces today. It exists so an admission check can never become
 * an unbounded scan — and, crucially, hitting it is REPORTED (`truncated`)
 * rather than absorbed, because a bound that quietly under-reports money is
 * the total-presented-as-covered lie in a rarer costume.
 */
const MAX_MISSION_TASKS = 500;

/**
 * The reads this module makes, so a caller inside a transaction can hand it
 * the TRANSACTION rather than the ambient client.
 *
 * Not a nicety. The delegate route does its admission inside a serializable
 * transaction that already holds SQLite's write lock; a read issued on the
 * ambient client from in there is a second connection waiting on a lock the
 * caller itself is holding. Threading `tx` keeps the whole admission on one
 * connection, and keeps it reading the same snapshot the rest of the checks do.
 */
type MissionCostDb = Pick<typeof prisma, "dispatchJob" | "event" | "orchestratorChat">;

export type MissionCostReading = {
  readonly cost: MissionCost;
  readonly laneCosts: readonly LaneCost[];
  /** Lanes that ran and reported nothing — D3 requires naming them. */
  readonly silentLanes: readonly string[];
  /**
   * True when the mission had more distinct tasks than one read may cover, so
   * the figure omits some. `cost.complete` is forced false when this is set:
   * an incomplete read must never be able to claim full coverage.
   */
  readonly truncated: boolean;
  /**
   * Tasks another chat also dispatched into, and which are therefore excluded
   * from this mission's spend. Named rather than counted: "which of my tasks
   * is not on this bill" is the question a human asks next.
   */
  readonly contestedTasks: readonly string[];
};

/**
 * What this chat has cost so far, derived on read from the event spine.
 *
 * Derived rather than stored, for the same reason ADR-0043's questions are:
 * the vendor already puts `metadata.usage.costUsd` on the spine, so a stored
 * mirror would be a second source of truth that could disagree with the
 * receipt. The arithmetic itself is `laneCostsFromUsageEvents`, shared with
 * the run bundle — a brake that refused on one number while the receipt
 * printed another would be worse than no brake.
 */
export async function readMissionCost(
  chatId: string,
  db: MissionCostDb = prisma
): Promise<MissionCostReading> {
  // DISTINCT, not `take: N`.
  //
  // An adversarial review found the earlier version taking the first 500 job
  // ROWS with no ordering and deriving both the spend and the lane coverage
  // from them. Two consequences, and the second is the one that matters:
  // spend from later jobs was omitted (which keeps the figure a floor, so the
  // brake stayed sound), and the DENOMINATOR was truncated too — so a mission
  // past the bound could report `complete: true`, i.e. "all lanes reporting",
  // while hundreds of jobs were silently dropped. That is precisely the total-
  // presented-as-covered lie D1 exists to prevent.
  //
  // What the arithmetic actually needs is the distinct TASK ids and the
  // distinct VENDORS — both bounded by the shape of a mission rather than by
  // its length — so it asks for those instead of for rows.
  const [taskRows, vendorRows] = await Promise.all([
    db.dispatchJob.findMany({
      where: { chatId },
      select: { taskId: true },
      distinct: ["taskId"],
      orderBy: { taskId: "asc" },
      take: MAX_MISSION_TASKS + 1,
    }),
    db.dispatchJob.findMany({
      // LANES THE MISSION RAN, which is what the coverage claims to count.
      //
      // It was every job in the chat, so a QUEUED one put its vendor in the
      // denominator as "reporting nothing", turning an otherwise complete
      // figure into a partial one and naming a lane the cap "cannot be
      // enforced against" that had not spent anything to enforce against.
      //
      // Excluding `queued` was the right idea tested the wrong way: a job
      // INTERRUPTED or FAILED before launch is not queued either, and it never
      // spent a cent. `startedAt` is the actual question — did this lane ever
      // run — so it is the one asked. A job that never started has no spend to
      // be silent about.
      where: { chatId, startedAt: { not: null } },
      select: { vendor: true },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
    }),
  ]);
  if (taskRows.length === 0) {
    return {
      cost: summarizeMissionCost([]),
      laneCosts: [],
      silentLanes: [],
      truncated: false,
      contestedTasks: [],
    };
  }

  // AND IF THE BOUND IS EVER HIT, SAY SO. A read this large is not a shape
  // MUON produces today (a mission's jobs share a handful of tasks), so this
  // is a backstop rather than a routine path — but a backstop that quietly
  // under-reports money is the same defect in a rarer costume.
  const truncated = taskRows.length > MAX_MISSION_TASKS;
  const candidates = taskRows.slice(0, MAX_MISSION_TASKS).map((row) => row.taskId);

  // A CONTESTED TASK BELONGS TO NOBODY'S BILL.
  //
  // Spend is derived from events, and an event carries a TASK, not a job — so
  // "what did this mission cost" is really "what did this mission's tasks
  // cost". An adversarial review found the gap that opens when two chats
  // dispatch into the SAME task: each would have counted the other's spend,
  // inflating a receipt and — worse — refusing a dispatch on money a different
  // mission spent.
  //
  // A task that more than one chat dispatched into is therefore excluded
  // rather than split. Splitting would need a per-job attribution the ledger
  // does not carry, and guessing one is the invention this whole module
  // refuses. Excluding it under-counts, which keeps the figure a floor and the
  // brake sound — and it is REPORTED, because a human comparing this against a
  // vendor invoice needs to know a task was left out and why.
  const contested =
    candidates.length === 0
      ? []
      : (
          await db.dispatchJob.findMany({
            where: {
              taskId: { in: candidates },
              // A NON-CHAT job counts as another owner too.
              //
              // This was `NOT: { chatId }`, which in SQL is `chatId != ?` —
              // and that is NULL, not TRUE, for a row whose `chatId` IS NULL.
              // So a plain `muon run` against the same task was never detected
              // as contesting it, and its spend was charged to this chat: an
              // inflated receipt, and a dispatch refused on a stranger's money.
              OR: [{ chatId: { not: chatId } }, { chatId: null }],
            },
            select: { taskId: true },
            distinct: ["taskId"],
          })
        ).map((row) => row.taskId);
  const contestedSet = new Set(contested);
  const taskIds = candidates.filter((taskId) => !contestedSet.has(taskId));

  const events = await db.event.findMany({
    where: { taskId: { in: taskIds } },
    select: { laneId: true, metadata: true },
  });

  // EVERY lane the mission ran is in the denominator, so a silent vendor is
  // counted as non-reporting rather than dropped — the difference between a
  // partial figure and one that merely looks complete.
  const laneCosts = laneCostsFromUsageEvents(
    events,
    vendorRows.map((row) => row.vendor)
  );
  const summary = summarizeMissionCost(laneCosts);
  const partial = truncated || contested.length > 0;
  return {
    // A read that dropped ANYTHING can never claim completeness, whatever the
    // lanes say — a bounded read and a contested task are different reasons
    // for the same fact.
    cost: partial ? { ...summary, complete: false } : summary,
    laneCosts,
    silentLanes: laneCosts
      .filter((lane) => !lane.reported)
      .map((lane) => lane.laneId),
    truncated,
    contestedTasks: contested,
  };
}

export type MissionCapCheck = {
  readonly verdict: CapVerdict | null;
  readonly refuses: boolean;
  /** The one rendering — coverage always travels with the figure. */
  readonly summary: string;
  readonly reading: MissionCostReading;
};

/**
 * Test a chat's cap against what it has spent.
 *
 * Returns a decision rather than throwing, so the two admission sites (a fresh
 * dispatch and a delegation) can render the same refusal in their own shapes
 * without either one re-deriving what the verdict means.
 */
export async function checkMissionCostCap(
  chatId: string | null | undefined,
  db: MissionCostDb = prisma
): Promise<MissionCapCheck | null> {
  if (!chatId) return null; // not a chat-scoped mission — nothing to cap.
  const chat = await db.orchestratorChat.findUnique({
    where: { id: chatId },
    select: { costCapUsd: true },
  });
  if (!chat || chat.costCapUsd === null || chat.costCapUsd === undefined) {
    return null; // no cap set — deliberately NOT the same as a cap that passes.
  }

  const reading = await readMissionCost(chatId, db);
  const verdict = evaluateCap(reading.cost, chat.costCapUsd);
  return {
    verdict,
    refuses: capRefusesDispatch(verdict),
    summary: describeCapVerdict(verdict, reading.silentLanes),
    reading,
  };
}

/**
 * THE ONE ADMISSION GUARD, for every path that creates new work.
 *
 * The check was written out at four call sites — the dispatch preflight, both
 * root-creation transaction branches, and delegation — and an adversarial
 * review made the obvious point: a fifth dispatch path, or a change to the
 * policy, now has four places to stay consistent with, and the cost of missing
 * one is a mission that keeps spending past its cap.
 *
 * `refuse` is passed in rather than thrown here because the two admission
 * sites shape their HTTP refusals differently and this module has no fastify.
 * What it owns is the decision and the sentence.
 */
export async function assertMissionCostCap(
  chatId: string | null | undefined,
  refuse: (message: string) => never,
  db: MissionCostDb = prisma
): Promise<void> {
  const check = await checkMissionCostCap(chatId, db);
  if (check?.refuses) refuse(missionCapRefusal(check));
}

/**
 * The refusal message a blocked dispatch carries.
 *
 * ADR-0033: a refusal explains itself. It states the observed floor, the cap,
 * the coverage, and — because a human's next move is to decide whether the
 * work is worth more money — that raising it is theirs to do.
 */
export function missionCapRefusal(check: MissionCapCheck): string {
  return `${check.summary}. Raising the cap is an operator act; an agent can request one but never grant it.`;
}
