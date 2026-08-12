import { describe, expect, it } from "vitest";
import type { DispatchJobRecord } from "../src/types.js";
import { selectMissionRoot, selectMissionRootId } from "../src/mission-root.js";

/**
 * THE REAL RUN, frozen once for every surface.
 *
 * A founder ran "Add a --version flag to the CLI" and opened the crew views
 * while the crew was still working. The chat's dispatch rows, verbatim:
 *
 *   cdeeca56  claude-code  orchestrator  done     d0   ← the mission root
 *     81070509  codex        delegate    running  d1   implementer
 *     74d002b7  claude-code  delegate    running  d1   docs
 *   705bb486  claude-code  orchestrator  done     d0   ← a LATER, CHILDLESS turn
 *
 * Peer traffic (4 envelopes) is stamped `missionId = cdeeca56`. Every surface
 * used to answer "the newest row wins" and addressed `705bb486` instead: the
 * desktop chart said "no dispatch yet" on every lane, and `muon crew coord` /
 * the TUI cockpit would have printed an empty mission. These are the rows that
 * must never resolve that way again — on any surface.
 */

function job(
  id: string,
  input: Partial<DispatchJobRecord> = {}
): DispatchJobRecord {
  return {
    id,
    kind: "session",
    vendor: "claude-code",
    taskId: `task-${id}`,
    brief: `Work for ${id}`,
    status: "running",
    dispatchedBy: "human:desktop",
    interruptRequested: false,
    steerMessages: [],
    createdAt: "2026-07-26T12:00:00.000Z",
    ...input,
  };
}

const MISSION_ROOT = "job-cdeeca56";
const LATER_ROOT = "job-705bb486";
const CODEX_CHILD = "job-81070509";
const DOCS_CHILD = "job-74d002b7";

/** The four rows, in creation order — exactly as the API returns them. */
function liveMissionJobs(): DispatchJobRecord[] {
  return [
    job(MISSION_ROOT, {
      capabilityMode: "orchestrator",
      status: "done",
      delegationDepth: 0,
      createdAt: "2026-07-26T12:00:00.000Z",
      startedAt: "2026-07-26T12:00:04.000Z",
      lastProgressAt: "2026-07-26T12:03:30.000Z",
    }),
    job(CODEX_CHILD, {
      vendor: "codex",
      capabilityMode: "delegate",
      parentJobId: MISSION_ROOT,
      rootJobId: MISSION_ROOT,
      delegationDepth: 1,
      status: "running",
      createdAt: "2026-07-26T12:03:08.000Z",
      startedAt: "2026-07-26T12:03:10.000Z",
      lastProgressAt: "2026-07-26T12:06:00.000Z",
    }),
    job(DOCS_CHILD, {
      capabilityMode: "delegate",
      parentJobId: MISSION_ROOT,
      rootJobId: MISSION_ROOT,
      delegationDepth: 1,
      status: "running",
      createdAt: "2026-07-26T12:03:20.000Z",
      startedAt: "2026-07-26T12:03:22.000Z",
      lastProgressAt: "2026-07-26T12:06:05.000Z",
    }),
    // The follow-up orchestrator turn: newest row in the chat, no crew at all.
    job(LATER_ROOT, {
      capabilityMode: "orchestrator",
      status: "done",
      delegationDepth: 0,
      createdAt: "2026-07-26T12:03:44.000Z",
      startedAt: "2026-07-26T12:03:45.000Z",
      lastProgressAt: "2026-07-26T12:03:50.000Z",
    }),
  ];
}

describe("selectMissionRootId — the live crew wins", () => {
  it("names the root that OWNS the working children, not the newest childless turn", () => {
    // The old rule on these exact rows: `jobs[jobs.length - 1].rootJobId ?? id`
    // — the follow-up turn, whose mission holds nothing.
    const jobs = liveMissionJobs();
    expect(jobs[jobs.length - 1]!.id).toBe(LATER_ROOT);
    expect(selectMissionRootId(jobs)).toBe(MISSION_ROOT);
  });

  it("is order-independent — the API's page order cannot change the answer", () => {
    const reversed = [...liveMissionJobs()].reverse();
    expect(selectMissionRootId(reversed)).toBe(MISSION_ROOT);
  });

  it("carries the tree the chart draws alongside the id the read is addressed by", () => {
    const choice = selectMissionRoot(liveMissionJobs())!;
    expect(choice.missionId).toBe(MISSION_ROOT);
    expect(choice.root?.id).toBe(MISSION_ROOT);
    expect(choice.root?.children.map((child) => child.id).sort()).toEqual(
      [CODEX_CHILD, DOCS_CHILD].sort()
    );
  });

  it("counts a FRESH queued child as live work — a mission is not over while work is pending", () => {
    const jobs = liveMissionJobs().map((record) =>
      record.id === CODEX_CHILD || record.id === DOCS_CHILD
        ? { ...record, status: "queued", startedAt: null, lastProgressAt: null }
        : record
    );
    // Pinned: "queued" only speaks for a mission inside the freshness horizon,
    // so this assertion has to name the instant it is asking about.
    const now = Date.parse("2026-07-26T12:06:10.000Z");
    expect(selectMissionRootId(jobs, { now })).toBe(MISSION_ROOT);
    // …and hours later the same rows no longer hold the panel: nothing in that
    // mission is live any more, it simply has the only crew in the chat.
    expect(
      selectMissionRootId(jobs, { now: now + 6 * 60 * 60_000 })
    ).toBe(MISSION_ROOT);
  });
});

describe("selectMissionRootId — the other orderings", () => {
  it("follows a new turn once IT is the one doing the work", () => {
    const jobs = liveMissionJobs().map((record) =>
      record.id === LATER_ROOT
        ? { ...record, status: "running" }
        : { ...record, status: "done" }
    );
    expect(selectMissionRootId(jobs)).toBe(LATER_ROOT);
  });

  it("keeps a settled mission's crew rather than an empty later turn", () => {
    const jobs = liveMissionJobs().map((record) => ({
      ...record,
      status: "done",
    }));
    expect(selectMissionRootId(jobs)).toBe(MISSION_ROOT);
  });

  it("prefers the more recent of two missions that both dispatched and finished", () => {
    const jobs = [
      ...liveMissionJobs().map((record) => ({ ...record, status: "done" })),
      job("job-later-root", {
        capabilityMode: "orchestrator",
        status: "done",
        delegationDepth: 0,
        createdAt: "2026-07-26T13:00:00.000Z",
        lastProgressAt: "2026-07-26T13:04:00.000Z",
      }),
      job("job-later-child", {
        vendor: "codex",
        capabilityMode: "delegate",
        parentJobId: "job-later-root",
        rootJobId: "job-later-root",
        delegationDepth: 1,
        status: "done",
        createdAt: "2026-07-26T13:01:00.000Z",
        lastProgressAt: "2026-07-26T13:03:30.000Z",
      }),
    ];
    expect(selectMissionRootId(jobs)).toBe("job-later-root");
  });

  it("is deterministic when two roots carry identical signals", () => {
    const twins = [
      job("job-a", { capabilityMode: "orchestrator", status: "done" }),
      job("job-b", { capabilityMode: "orchestrator", status: "done" }),
    ];
    const first = selectMissionRootId(twins);
    expect(first).toBe(selectMissionRootId([...twins].reverse()));
    expect(first).toBe("job-b");
  });
});

/**
 * F3 — the ranking must be POLL-STABLE and must not be hijackable by a corpse.
 * These four scenarios were measured against the first cut of this rule, which
 * counted any queued descendant as live crew and broke ties on the newest
 * activity anywhere in the subtree.
 */
describe("selectMissionRootId — zombies and stability", () => {
  const NOW = Date.parse("2026-07-26T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  /** An old mission whose child was claimed and never launched. */
  function zombieMission() {
    return [
      job("job-dead-root", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(6 * 60 * 60_000),
        lastProgressAt: ago(5 * 60 * 60_000),
      }),
      job("job-zombie-child", {
        capabilityMode: "delegate",
        parentJobId: "job-dead-root",
        rootJobId: "job-dead-root",
        delegationDepth: 1,
        status: "queued",
        createdAt: ago(5 * 60 * 60_000),
        startedAt: null,
        lastProgressAt: null,
      }),
    ];
  }

  it("does not let ONE stuck queued child hold the panel against the turn the user just started", () => {
    const jobs = [
      ...zombieMission(),
      job("job-new-root", {
        capabilityMode: "orchestrator",
        status: "running",
        createdAt: ago(20_000),
        startedAt: ago(18_000),
        lastProgressAt: ago(4_000),
      }),
    ];
    expect(selectMissionRootId(jobs, { now: NOW })).toBe("job-new-root");
  });

  it("a RUNNING root outranks a terminal root's merely-queued descendant", () => {
    // Even FRESH: a child that is claimed but not launched is not more current
    // than the turn that is executing right now.
    const jobs = [
      job("job-old-root", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(120_000),
      }),
      job("job-old-child", {
        capabilityMode: "delegate",
        parentJobId: "job-old-root",
        rootJobId: "job-old-root",
        delegationDepth: 1,
        status: "queued",
        createdAt: ago(30_000),
        startedAt: null,
        lastProgressAt: null,
      }),
      job("job-running-root", {
        capabilityMode: "orchestrator",
        status: "running",
        createdAt: ago(10_000),
        startedAt: ago(9_000),
      }),
    ];
    expect(selectMissionRootId(jobs, { now: NOW })).toBe("job-running-root");
  });

  it("a fresh queued child still beats a mission where nothing is live at all", () => {
    const jobs = [
      job("job-settled-root", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(600_000),
      }),
      job("job-settled-child", {
        capabilityMode: "delegate",
        parentJobId: "job-settled-root",
        rootJobId: "job-settled-root",
        delegationDepth: 1,
        status: "done",
        createdAt: ago(590_000),
      }),
      job("job-queued-root", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(400_000),
      }),
      job("job-queued-child", {
        capabilityMode: "delegate",
        parentJobId: "job-queued-root",
        rootJobId: "job-queued-root",
        delegationDepth: 1,
        status: "queued",
        createdAt: ago(30_000),
        startedAt: null,
        lastProgressAt: null,
      }),
    ];
    expect(selectMissionRootId(jobs, { now: NOW })).toBe("job-queued-root");
  });

  it("a RUNNING crew still outranks a newer bare turn — the founder's symptom", () => {
    // MUON's turn can end while its children work; a follow-up turn that has
    // dispatched nobody must not blank the chart over a live crew.
    const jobs = [
      job("job-crew-root", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(300_000),
      }),
      job("job-crew-child", {
        capabilityMode: "delegate",
        parentJobId: "job-crew-root",
        rootJobId: "job-crew-root",
        delegationDepth: 1,
        status: "running",
        createdAt: ago(240_000),
        lastProgressAt: ago(3_000),
      }),
      job("job-bare-root", {
        capabilityMode: "orchestrator",
        status: "running",
        createdAt: ago(30_000),
        startedAt: ago(29_000),
      }),
    ];
    expect(selectMissionRootId(jobs, { now: NOW })).toBe("job-crew-root");
  });

  // THE OSCILLATION. Two missions both emitting progress: a tie broken on the
  // newest activity ANYWHERE in the subtree changes hands on every poll, so the
  // chart, the (chatId, missionId) address and the "no peer messages" claim all
  // flip between reads. The root's createdAt is immutable, so it cannot.
  it("never changes its mind while two live missions both emit progress", () => {
    const twoLiveMissions = (aProgress: string, bProgress: string) => [
      job("job-mission-a", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(600_000),
      }),
      job("job-a-child", {
        capabilityMode: "delegate",
        parentJobId: "job-mission-a",
        rootJobId: "job-mission-a",
        delegationDepth: 1,
        status: "running",
        createdAt: ago(560_000),
        lastProgressAt: aProgress,
      }),
      job("job-mission-b", {
        capabilityMode: "orchestrator",
        status: "done",
        createdAt: ago(300_000),
      }),
      job("job-b-child", {
        capabilityMode: "delegate",
        parentJobId: "job-mission-b",
        rootJobId: "job-mission-b",
        delegationDepth: 1,
        status: "running",
        createdAt: ago(260_000),
        lastProgressAt: bProgress,
      }),
    ];

    const polls = [
      // A spoke last…
      selectMissionRootId(twoLiveMissions(ago(1_000), ago(9_000)), { now: NOW }),
      // …then B…
      selectMissionRootId(twoLiveMissions(ago(9_000), ago(1_000)), { now: NOW }),
      // …then A again.
      selectMissionRootId(twoLiveMissions(ago(500), ago(8_000)), { now: NOW }),
    ];
    expect(new Set(polls).size).toBe(1);
    // The newer MISSION wins, and stays won.
    expect(polls[0]).toBe("job-mission-b");
  });
});

describe("selectMissionRootId — rows with no lineage", () => {
  // Chat-bound dispatch always carries a capability mode today, so these are
  // legacy/one-off rows. They must still resolve to an addressable mission
  // rather than erasing the chat's coordination.
  it("uses a lineage-less job's own root id, and its own id when it IS the root", () => {
    expect(selectMissionRootId([job("job-solo", { capabilityMode: null })])).toBe(
      "job-solo"
    );
    expect(
      selectMissionRootId([
        job("job-orphan", { capabilityMode: null, rootJobId: "job-root" }),
      ])
    ).toBe("job-root");
  });

  it("returns null for a chat that has never dispatched", () => {
    expect(selectMissionRootId([])).toBeNull();
    expect(selectMissionRoot([])).toBeNull();
  });
});
