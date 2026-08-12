import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-0036 D2/D6/D7 — the dollar cap, from storage to the dispatch it refuses.
 *
 * The cap machinery was pure and test-only for a release because the module
 * could not settle its own design question: *a cap tested against a FLOOR
 * refuses a mission on a number that covers only the lanes that report, so in
 * a mixed crew it is neither a real ceiling nor an honest one.*
 *
 * D6 answers it — the cap is SOUND AND INCOMPLETE, a brake that never brakes
 * early — and these tests are that answer made mechanical:
 *
 *   never brakes early   a refusal only ever fires when observed >= cap, and
 *                        observed is a floor, so actual >= cap is certain.
 *   never claims a total no verdict is rendered without its coverage, and an
 *                        unmeasurable cap does NOT stop work.
 *   refuses NEW work     dispatch and delegation both, never a running lane.
 *   one arithmetic       the brake and the receipt read the same numbers.
 *   D7 storage           the cap is on the CHAT (a chat mints a new root every
 *                        turn, so a job-scoped cap would forget), and the
 *                        operator default is COPIED, never read live.
 */

const OPERATOR = "operator-token-cost-cap";
const AGENT = "agent-token-cost-cap";

let app: FastifyInstance;
let settings: typeof import("../src/lib/operator-settings.js");
let db: typeof import("../src/lib/db.js");
let dir: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-cost-cap-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  settings = await import("../src/lib/operator-settings.js");

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.prisma.event.deleteMany({});
  await db.prisma.dispatchJob.deleteMany({});
  await db.prisma.orchestratorChat.deleteMany({});
  await db.prisma.task.deleteMany({});
  await db.prisma.operatorSetting.deleteMany({});
});

/** A chat with one task, plus whatever spend and cap the test needs. */
async function mission(options: {
  capUsd?: number | null;
  /** [vendor, usd | null] — null means the lane ran and reported nothing. */
  lanes: Array<[string, number | null]>;
}) {
  const chatId = `chat-${Math.abs(options.lanes.length + (options.capUsd ?? 0))}-${
    options.lanes.map(([v]) => v).join("-")
  }`;
  await db.prisma.task.create({
    data: {
      id: `task-${chatId}`,
      title: "Mission",
      description: "cost cap fixture",
      status: "in_progress",
      workspacePath: process.cwd(),
      chatId,
    },
  });
  await db.prisma.orchestratorChat.create({
    data: {
      id: chatId,
      title: "Mission",
      workspacePath: process.cwd(),
      taskId: `task-${chatId}`,
      ...(options.capUsd === undefined || options.capUsd === null
        ? {}
        : { costCapUsd: options.capUsd }),
    },
  });
  for (const [vendor, usd] of options.lanes) {
    await db.prisma.dispatchJob.create({
      data: {
        id: `job-${chatId}-${vendor}`,
        vendor,
        taskId: `task-${chatId}`,
        brief: "work",
        chatId,
        status: "done",
        // A DONE lane RAN. The fixture left this null, which no production
        // path does — every write that sets `running` sets `startedAt` with
        // it — and the coverage query now asks the real question ("did this
        // lane ever launch") rather than the proxy it used to ask.
        startedAt: new Date(),
      },
    });
    if (usd !== null) {
      await db.prisma.event.create({
        data: {
          taskId: `task-${chatId}`,
          laneId: vendor,
          kind: "task.progress",
          message: "usage",
          metadata: { usage: { vendor, costUsd: usd } },
        },
      });
    }
  }
  return chatId;
}

function cost(chatId: string) {
  return app.inject({
    method: "GET",
    url: `/api/chats/${chatId}/cost`,
    headers: auth(OPERATOR),
  });
}

describe("D7 — the cap lives on the mission, and the default is COPIED", () => {
  it("a new chat starts with the operator default", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/chats/settings/cost-cap-default",
      headers: auth(OPERATOR),
      payload: { capUsd: 25 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: { title: "New", workspacePath: process.cwd() },
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json().chat as { id: string; costCapUsd: number };
    expect(chat.costCapUsd).toBe(25);
    expect((await cost(chat.id)).json().capSetBy).toBe("operator-default");
  });

  it("editing the DEFAULT never moves a cap already running", async () => {
    // The whole reason D7 copies rather than references. A default that was
    // read live would silently re-cap a mission in flight.
    await app.inject({
      method: "PUT",
      url: "/api/chats/settings/cost-cap-default",
      headers: auth(OPERATOR),
      payload: { capUsd: 25 },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: { title: "New", workspacePath: process.cwd() },
    });
    const chatId = (created.json().chat as { id: string }).id;

    await app.inject({
      method: "PUT",
      url: "/api/chats/settings/cost-cap-default",
      headers: auth(OPERATOR),
      payload: { capUsd: 1 },
    });
    expect((await cost(chatId)).json().capUsd, "unchanged").toBe(25);

    await app.inject({
      method: "PUT",
      url: "/api/chats/settings/cost-cap-default",
      headers: auth(OPERATOR),
      payload: { capUsd: null },
    });
    expect((await cost(chatId)).json().capUsd, "still unchanged").toBe(25);
  });

  it("no default means NO cap — not a cap of zero", async () => {
    // A zero would refuse the first dispatch of every new chat while reading
    // like a configured limit.
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: { title: "New", workspacePath: process.cwd() },
    });
    expect((created.json().chat as { costCapUsd: number | null }).costCapUsd).toBeNull();
  });

  it("only an operator may set a cap or its default", async () => {
    const chatId = await mission({ lanes: [["claude", 1]] });
    for (const [url, payload] of [
      [`/api/chats/${chatId}/cost-cap`, { capUsd: 5 }],
      ["/api/chats/settings/cost-cap-default", { capUsd: 5 }],
    ] as const) {
      const response = await app.inject({
        method: "PUT",
        url,
        headers: auth(AGENT),
        payload,
      });
      expect(response.statusCode, url).toBe(403);
    }
    const row = await db.prisma.orchestratorChat.findUnique({ where: { id: chatId } });
    expect(row!.costCapUsd).toBeNull();
  });

  it("refuses a cap of zero outright", async () => {
    const chatId = await mission({ lanes: [["claude", 1]] });
    const response = await app.inject({
      method: "PUT",
      url: `/api/chats/${chatId}/cost-cap`,
      headers: auth(OPERATOR),
      payload: { capUsd: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("clearing a cap is null, and it un-caps the mission", async () => {
    const chatId = await mission({ capUsd: 1, lanes: [["claude", 5]] });
    expect((await cost(chatId)).json().refusesDispatch).toBe(true);
    await app.inject({
      method: "PUT",
      url: `/api/chats/${chatId}/cost-cap`,
      headers: auth(OPERATOR),
      payload: { capUsd: null },
    });
    const after = (await cost(chatId)).json();
    expect(after.capUsd).toBeNull();
    expect(after.refusesDispatch).toBe(false);
    expect(after.summary).toBe("no cap set");
  });

  it("setting a cap BELOW what is already spent says so immediately", async () => {
    // An operator should learn this here, not from the next dispatch being
    // refused with no explanation of when it changed.
    const chatId = await mission({ lanes: [["claude", 12]] });
    const response = await app.inject({
      method: "PUT",
      url: `/api/chats/${chatId}/cost-cap`,
      headers: auth(OPERATOR),
      payload: { capUsd: 10 },
    });
    expect(response.json().refusesDispatch).toBe(true);
    expect(response.json().summary).toContain("further dispatch refused");
  });
});

describe("D6 — sound and incomplete: it never brakes early", () => {
  it("does not refuse below the cap", async () => {
    const chatId = await mission({ capUsd: 10, lanes: [["claude", 4]] });
    expect((await cost(chatId)).json().refusesDispatch).toBe(false);
  });

  it("refuses AT the cap, not only past it", async () => {
    // `>=`: the dispatch that would take the mission exactly to the limit is
    // the one worth refusing while the refusal still means something.
    const chatId = await mission({ capUsd: 10, lanes: [["claude", 10]] });
    expect((await cost(chatId)).json().refusesDispatch).toBe(true);
  });

  it("a PARTIAL reading under the cap does not refuse, and says it is partial", async () => {
    // The normal case in a mixed crew: only Claude reports dollars today. It
    // must not brake on a number that covers one lane of two…
    const chatId = await mission({
      capUsd: 10,
      lanes: [["claude", 4], ["codex", null]],
    });
    const body = (await cost(chatId)).json();
    expect(body.refusesDispatch).toBe(false);
    // …and it must not pretend the cap covers the lane it cannot see.
    expect(body.summary).toContain("CANNOT be enforced");
    expect(body.summary).toContain("codex");
  });

  it("a partial reading that has ALREADY passed the cap still refuses", async () => {
    // Sound, not merely conservative: observed is a floor, so `observed >=
    // cap` means actual >= cap with certainty, coverage or no coverage.
    const chatId = await mission({
      capUsd: 10,
      lanes: [["claude", 11], ["codex", null]],
    });
    expect((await cost(chatId)).json().refusesDispatch).toBe(true);
  });

  it("a cap NOTHING can measure does not stop work, and says why", async () => {
    // Refusing on a limit nothing can measure stops a mission for a number
    // nobody has. Wall-clock is what bounds those lanes.
    const chatId = await mission({ capUsd: 10, lanes: [["codex", null]] });
    const body = (await cost(chatId)).json();
    expect(body.refusesDispatch).toBe(false);
    expect(body.summary).toContain("cannot be enforced");
    expect(body.summary).toContain("wall-clock");
  });

  it("a lane that reports garbage is UNREPORTED, never free", async () => {
    const chatId = await mission({ capUsd: 10, lanes: [["claude", 4]] });
    await db.prisma.event.create({
      data: {
        taskId: `task-${chatId}`,
        laneId: "claude",
        kind: "task.progress",
        message: "usage",
        metadata: { usage: { vendor: "codex", costUsd: Number.NaN } },
      },
    });
    const body = (await cost(chatId)).json();
    expect(body.cost.observedUsd, "the garbage adds nothing").toBe(4);
  });

  it("counts EVERY job's spend, however many jobs the mission has", async () => {
    // An adversarial review found the earlier version taking the first 500 job
    // ROWS with no ordering and deriving BOTH the spend and the lane coverage
    // from them — so a long mission could omit later costs and, worse, report
    // `complete: true` while hundreds of jobs were dropped. The read now asks
    // for the DISTINCT tasks and vendors, which are bounded by the shape of a
    // mission rather than by its length.
    const chatId = await mission({ capUsd: 100, lanes: [["claude", 1]] });
    // 600 more jobs, all on the same task and lane — past the old 500 bound.
    await db.prisma.dispatchJob.createMany({
      data: Array.from({ length: 600 }, (_unused, index) => ({
        id: `job-bulk-${chatId}-${index}`,
        vendor: "claude",
        taskId: `task-${chatId}`,
        brief: "work",
        chatId,
        status: "done",
      })),
    });
    await db.prisma.event.create({
      data: {
        taskId: `task-${chatId}`,
        laneId: "claude",
        kind: "task.progress",
        message: "usage",
        metadata: { usage: { vendor: "claude", costUsd: 7 } },
      },
    });
    const body = (await cost(chatId)).json();
    expect(body.cost.observedUsd, "1 + 7, not a truncated 1").toBe(8);
    expect(body.cost.totalLanes, "one distinct vendor, not 601 rows").toBe(1);
    expect(body.cost.complete).toBe(true);
  });

  it("no price table: a token-only lane contributes NOTHING to the figure", async () => {
    const chatId = await mission({ capUsd: 10, lanes: [["codex", null]] });
    await db.prisma.event.create({
      data: {
        taskId: `task-${chatId}`,
        laneId: "codex",
        kind: "task.progress",
        message: "usage",
        metadata: { usage: { vendor: "codex", inputTokens: 400_000 } },
      },
    });
    expect((await cost(chatId)).json().cost.observedUsd).toBe(0);
    expect((await cost(chatId)).json().cost.reportingLanes).toBe(0);
  });
});

describe("D2 — it refuses NEW work, on every path that creates some", () => {
  async function dispatchInto(chatId: string) {
    return app.inject({
      method: "POST",
      url: "/api/dispatch",
      headers: auth(OPERATOR),
      payload: {
        vendor: "claude-code",
        taskId: `task-${chatId}`,
        brief: "more work",
        chatId,
        workspacePath: process.cwd(),
      },
    });
  }

  it("refuses a fresh dispatch once the cap is met", async () => {
    const chatId = await mission({ capUsd: 5, lanes: [["claude", 6]] });
    const response = await dispatchInto(chatId);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("cap");
    expect(response.json().message).toContain("operator act");
  });

  it("the REFUSAL carries its coverage, and the `>=` that qualifies the figure", async () => {
    // D1: no surface may show a total. A refusal is the surface a human is
    // most likely to act on — "you have spent $6" reads very differently from
    // "at least $6, of which one lane of two is invisible to this number".
    const chatId = await mission({
      capUsd: 5,
      lanes: [["claude", 6], ["codex", null]],
    });
    const message = (await dispatchInto(chatId)).json().message as string;
    expect(message, "a floor, not a total").toContain("≥");
    expect(message, "and its coverage").toContain("1 of 2 lanes reporting");
  });

  it("admits a dispatch while the mission is under the cap", async () => {
    const chatId = await mission({ capUsd: 100, lanes: [["claude", 6]] });
    const response = await dispatchInto(chatId);
    expect(response.statusCode, response.body).not.toBe(409);
  });

  it("admits a dispatch when the cap CANNOT be enforced", async () => {
    const chatId = await mission({ capUsd: 1, lanes: [["codex", null]] });
    const response = await dispatchInto(chatId);
    expect(response.statusCode, response.body).not.toBe(409);
  });

  it("does not touch a RUNNING job — the brake is admission-only", async () => {
    // D2: cost arrives at the END of a turn, so an in-flight kill always
    // overshoots the cap it was enforcing and strands unverified work.
    const chatId = await mission({ capUsd: 1, lanes: [["claude", 50]] });
    await db.prisma.dispatchJob.create({
      data: {
        id: `job-live-${chatId}`,
        vendor: "claude-code",
        taskId: `task-${chatId}`,
        brief: "in flight",
        chatId,
        status: "running",
      },
    });
    await dispatchInto(chatId);
    const live = await db.prisma.dispatchJob.findUnique({
      where: { id: `job-live-${chatId}` },
    });
    expect(live!.status).toBe("running");
    expect(live!.interruptRequested).toBe(false);
  });
});

describe("a task two missions share belongs to NEITHER bill", () => {
  it("excludes it, and names it, rather than double-counting", async () => {
    // An adversarial review found the gap: spend is derived from EVENTS, and
    // an event carries a task, not a job. Two chats dispatching into the same
    // task would each have counted the other's money — inflating a receipt
    // and, worse, refusing a dispatch on spend a different mission incurred.
    const mine = await mission({ capUsd: 10, lanes: [["claude", 3]] });
    // A second chat reaches into the SAME task.
    await db.prisma.orchestratorChat.create({
      data: {
        id: "chat-other",
        title: "Other",
        workspacePath: process.cwd(),
        taskId: `task-${mine}`,
      },
    });
    await db.prisma.dispatchJob.create({
      data: {
        id: "job-other",
        vendor: "claude",
        taskId: `task-${mine}`,
        brief: "someone else's work",
        chatId: "chat-other",
        status: "done",
      },
    });

    const body = (await cost(mine)).json();
    expect(body.cost.observedUsd, "contested spend counts for nobody").toBe(0);
    expect(
      body.cost.complete,
      "and an excluded task means the read is not complete"
    ).toBe(false);
  });

  it("a task only THIS mission touches is counted normally", async () => {
    const mine = await mission({ capUsd: 10, lanes: [["claude", 3]] });
    const body = (await cost(mine)).json();
    expect(body.cost.observedUsd).toBe(3);
    expect(body.cost.complete).toBe(true);
  });
});

describe("a spending limit fails CLOSED, not open", () => {
  it("a settings read failure REFUSES the chat rather than creating it uncapped", async () => {
    // An adversarial review named the consequence of the earlier `catch {
    // return null }`: a transient read failure is indistinguishable from "no
    // default", so a chat created in that window came out UNCAPPED while the
    // operator believed a cap was in force. A spending limit must never fail
    // in the permissive direction.
    //
    // The failure is REAL rather than mocked: the default is now read inside
    // the chat-creation transaction (so a concurrent default change cannot be
    // straddled), which means swapping the ambient client no longer reaches
    // it. Removing the table is a read failure at exactly the layer that
    // matters, and it proves the two succeed or fail together.
    await app.inject({
      method: "PUT",
      url: "/api/chats/settings/cost-cap-default",
      headers: auth(OPERATOR),
      payload: { capUsd: 25 },
    });
    await db.prisma.$executeRawUnsafe('ALTER TABLE "OperatorSetting" RENAME TO "OperatorSettingHidden"');

    let created;
    try {
      created = await app.inject({
        method: "POST",
        url: "/api/chats",
        headers: auth(OPERATOR),
        payload: { title: "During an outage", workspacePath: process.cwd() },
      });
    } finally {
      await db.prisma.$executeRawUnsafe('ALTER TABLE "OperatorSettingHidden" RENAME TO "OperatorSetting"');
    }

    expect(created.statusCode, "no chat rather than an uncapped one").not.toBe(201);
    expect(
      await db.prisma.orchestratorChat.count({
        where: { title: "During an outage" },
      })
    ).toBe(0);
  });
});

describe("a MALFORMED default is not the same as no default", () => {
  it("refuses the chat rather than creating it uncapped", async () => {
    // The eighth pass found the remaining half of the fail-open: a stored
    // value MUON cannot read used to resolve to `null` — the same value as an
    // intentional clear — so a corrupted setting silently produced UNCAPPED
    // chats while the operator believed a cap was in force.
    await db.prisma.operatorSetting.create({
      data: { key: "missionCostCapDefaultUsd", value: "not-a-number" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: { title: "Corrupted default", workspacePath: process.cwd() },
    });
    expect(created.statusCode).not.toBe(201);
    expect(
      await db.prisma.orchestratorChat.count({
        where: { title: "Corrupted default" },
      })
    ).toBe(0);
  });

  it("a CLEARED default still creates an uncapped chat — that was asked for", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: { title: "No default set", workspacePath: process.cwd() },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json().chat as { costCapUsd: number | null }).costCapUsd).toBeNull();
  });
});

describe("the coverage counts lanes the mission RAN", () => {
  it("a queued job's vendor is not a silent lane", async () => {
    // The denominator was every job in the chat, so a QUEUED one put its
    // vendor in as "reporting nothing" — turning a complete figure partial and
    // naming a lane the cap "cannot be enforced against" that had not spent
    // anything to enforce against.
    const chatId = await mission({ capUsd: 10, lanes: [["claude", 4]] });
    await db.prisma.dispatchJob.create({
      data: {
        id: `job-queued-${chatId}`,
        vendor: "codex",
        taskId: `task-${chatId}`,
        brief: "not started yet",
        chatId,
        status: "queued",
      },
    });
    const body = (await cost(chatId)).json();
    expect(body.cost.totalLanes, "only the lane that ran").toBe(1);
    expect(body.cost.complete).toBe(true);
    expect(body.silentLanes).toEqual([]);
  });

  it.each(["interrupted", "failed"])(
    "a job %s BEFORE it launched is not a silent lane either",
    async (status) => {
      // Excluding `queued` was the right idea tested the wrong way. A job
      // interrupted or failed before launch is not queued, and it never spent
      // a cent — but it was counted as a lane reporting nothing, which turns a
      // complete figure partial and tells an operator the cap cannot be
      // enforced against a vendor that did no work.
      const chatId = await mission({ capUsd: 10, lanes: [["claude", 4]] });
      await db.prisma.dispatchJob.create({
        data: {
          id: `job-${status}-${chatId}`,
          vendor: "codex",
          taskId: `task-${chatId}`,
          brief: "died before launch",
          chatId,
          status,
          // startedAt stays null — that is the whole point.
        },
      });
      const body = (await cost(chatId)).json();
      expect(body.cost.totalLanes, "only the lane that ran").toBe(1);
      expect(body.cost.complete).toBe(true);
      expect(body.silentLanes).toEqual([]);
    }
  );

  it("a job that ran and reported nothing IS a silent lane", async () => {
    const chatId = await mission({
      capUsd: 10,
      lanes: [["claude", 4], ["codex", null]],
    });
    const body = (await cost(chatId)).json();
    expect(body.cost.totalLanes).toBe(2);
    expect(body.silentLanes).toEqual(["codex"]);
  });
});

describe("clearing the operator default tells the truth about whether it cleared", () => {
  /**
   * `setMissionCostCapDefaultUsd(null)` used to be a `delete()` with a blanket
   * `.catch(() => undefined)`. The intent was to tolerate "no row"; the effect
   * was that ANY database failure returned `null` and the operator was told
   * the default was cleared while the old one stayed live and kept admitting
   * work. A governed write that cannot fail out loud is not governed.
   */
  it("clears a default that exists", async () => {
    await settings.setMissionCostCapDefaultUsd(25);
    expect(await settings.getMissionCostCapDefaultUsd()).toBe(25);
    expect(await settings.setMissionCostCapDefaultUsd(null)).toBeNull();
    expect(await settings.getMissionCostCapDefaultUsd()).toBeNull();
  });

  it("clearing a default that was never set is a success, not an error", async () => {
    await settings.setMissionCostCapDefaultUsd(null);
    await expect(settings.setMissionCostCapDefaultUsd(null)).resolves.toBeNull();
  });

  it("PROPAGATES a real database failure instead of reporting success", async () => {
    const real = db.prisma.operatorSetting.deleteMany;
    db.prisma.operatorSetting.deleteMany = (async () => {
      throw new Error("database is locked");
    }) as never;
    try {
      await expect(settings.setMissionCostCapDefaultUsd(null)).rejects.toThrow(
        "database is locked"
      );
    } finally {
      // Restore by ASSIGNMENT: a Prisma delegate is Proxy-backed, so
      // `mockRestore` would leave the method undefined for every later test.
      db.prisma.operatorSetting.deleteMany = real;
    }
  });
});

describe("a corrupt stored default REACHES the operator", () => {
  /**
   * The refusal message was precise and invisible: an untyped `throw` is masked
   * by Fastify as "Unexpected server error", so the remediation reached the log
   * and never the person who could act on it. A refusal nobody can read is most
   * of the way to not having one.
   */
  it("surfaces the reason and what to type, not a bare 500", async () => {
    await db.prisma.operatorSetting.upsert({
      where: { key: "missionCostCapDefaultUsd" },
      create: { key: "missionCostCapDefaultUsd", value: "not-a-number" },
      update: { value: "not-a-number" },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/chats/settings/cost-cap-default",
        headers: { authorization: `Bearer ${OPERATOR}` },
      });
      expect(response.statusCode, "a refusal, not a crash").toBe(409);
      const said = String(response.json().message ?? response.body);
      expect(said).toContain("not a positive dollar amount");
      expect(said, "and what to type").toContain("muon cost default");
    } finally {
      await db.prisma.operatorSetting.deleteMany({
        where: { key: "missionCostCapDefaultUsd" },
      });
    }
  });
});
