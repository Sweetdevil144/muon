import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── R4 memory-mining toggle (memoryMining) ───────────────────────────────────
//
// The regression these lock down: mining shipped behind an opt-in env var, so a
// real founder session produced an EMPTY brain and looked broken. The setting is
// therefore DEFAULT ON, and the read path must not turn it off on its own.
//
// Tier asymmetry is deliberate and asserted below: WRITE is operator-only like
// every other posture flag; READ is reachable by the SHARED agent bearer (MUON's
// own runner, resolving whether to mine after a job) but NOT by a per-job
// capability — the credential a vendor process actually holds.

const OPERATOR = "operator-token-mining-1";
const AGENT = "agent-token-mining-1";
const JOB_TOKEN = `job-mining-${"j".repeat(55)}`;

const settingRows = new Map<string, { key: string; value: string }>();

const prismaMock = vi.hoisted(() => ({
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  delegationGrant: {
    findFirst: vi.fn(),
  },
  dispatchJob: {
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/preedit.js", () => ({ preEditContext: vi.fn() }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));
vi.mock("../src/lib/activity.js", () => ({ readActivity: () => async () => [] }));
vi.mock("../src/lib/duplicate-work.js", () => ({
  readDuplicateWork: () => async () => [],
}));

/**
 * A BUDGET, not a hang — ADR-0037 ("a flaky check is still a failure").
 *
 * `buildTieredApp` does `vi.resetModules()` and re-imports `app.js`, which
 * pulls the ENTIRE route graph through the transformer with a cold cache. On
 * an idle machine that is well inside vitest's 5s default; under the full
 * suite's parallel load it intermittently is not, and this file was observed
 * timing out in two of five full runs while passing every time in isolation.
 *
 * Raising the budget rather than leaving it to chance, and naming the reason,
 * because the alternative is a red run nobody can reproduce and everyone
 * learns to re-run. Every assertion below is unchanged; only the clock is.
 */
const APP_BUILD_BUDGET_MS = 30_000;

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const SETTING_URL = "/api/memory/settings/memory-mining";

beforeEach(() => {
  vi.clearAllMocks();
  settingRows.clear();
  prismaMock.operatorSetting.findUnique.mockImplementation(
    async (args: { where: { key: string } }) =>
      settingRows.get(args.where.key) ?? null
  );
  prismaMock.operatorSetting.upsert.mockImplementation(
    async (args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }) => {
      const existing = settingRows.get(args.where.key);
      const row = existing
        ? { ...existing, value: args.update.value }
        : { ...args.create };
      settingRows.set(args.where.key, row);
      return row;
    }
  );
  prismaMock.delegationGrant.findFirst.mockResolvedValue({
    jobId: "job-mining",
    tokenHash: createHash("sha256").update(JOB_TOKEN).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  prismaMock.dispatchJob.findUnique.mockResolvedValue({
    id: "job-mining",
    taskId: "task-mining",
    vendor: "codex",
    chatId: "chat-a",
    parentJobId: null,
    rootJobId: "job-mining",
    capabilityMode: "orchestrator",
    workspacePath: "/repo",
    status: "running",
    interruptRequested: false,
  });
});

describe("R4 memoryMining operator setting", () => {
  it("DEFAULT ON: an unset toggle reads true (the self-filling brain fills out of the box)", async () => {
    prismaMock.operatorSetting.findUnique.mockResolvedValue(null);
    const { getMemoryMining } = await import("../src/lib/operator-settings.js");

    await expect(getMemoryMining()).resolves.toBe(true);
  });

  it("honours a stored OFF, and treats anything that is not \"true\" as off", async () => {
    const { getMemoryMining } = await import("../src/lib/operator-settings.js");

    for (const value of ["false", "0", "", "yes"]) {
      prismaMock.operatorSetting.findUnique.mockResolvedValueOnce({
        key: "memoryMining",
        value,
      });
      await expect(getMemoryMining()).resolves.toBe(false);
    }

    prismaMock.operatorSetting.findUnique.mockResolvedValueOnce({
      key: "memoryMining",
      value: "true",
    });
    await expect(getMemoryMining()).resolves.toBe(true);
  });

  it("an UNREADABLE store resolves to the documented default (ON), not to off", async () => {
    // Deliberately NOT the fail-closed posture of the crew-visible gate: mining
    // widens nothing and admits nothing, so resolving uncertainty to "off" would
    // only recreate the silent-empty-brain bug. The guaranteed operator off
    // switch is MUON_MEMORY_MINE=0, which the runner honours without a lookup.
    prismaMock.operatorSetting.findUnique.mockRejectedValue(
      new Error("store unavailable")
    );
    const { getMemoryMining } = await import("../src/lib/operator-settings.js");

    await expect(getMemoryMining()).resolves.toBe(true);
  });

  it("persists the toggle under its own key", async () => {
    const { setMemoryMining } = await import("../src/lib/operator-settings.js");

    await expect(setMemoryMining(false)).resolves.toBe(false);
    expect(prismaMock.operatorSetting.upsert).toHaveBeenCalledWith({
      where: { key: "memoryMining" },
      create: { key: "memoryMining", value: "false" },
      update: { value: "false" },
    });
  });
});

describe("R4 memoryMining route tiers", () => {
  it("DEFAULT ON over the wire; the operator AND the runner's shared agent bearer may READ it", async () => {
    const app = await buildTieredApp();
    for (const token of [OPERATOR, AGENT]) {
      const res = await app.inject({
        method: "GET",
        url: SETTING_URL,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ memoryMining: true });
    }
    await app.close();
  }, APP_BUILD_BUDGET_MS);

  it("REFUSES a per-job capability — the credential a vendor process holds never reads posture", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(JOB_TOKEN),
    });
    // The read widening stops at MUON's own runner; a sub-agent cannot ask.
    expect(res.statusCode).toBe(403);
    await app.close();
  }, APP_BUILD_BUDGET_MS);

  it("WRITE stays operator-only: an agent-tier PUT is 403 and the store is never written", async () => {
    const app = await buildTieredApp();
    const agentPut = await app.inject({
      method: "PUT",
      url: SETTING_URL,
      headers: auth(AGENT),
      payload: { enabled: false },
    });
    expect(agentPut.statusCode).toBe(403);
    expect(prismaMock.operatorSetting.upsert).not.toHaveBeenCalled();
    expect(settingRows.size).toBe(0);

    // …and the agent's own read still reports the unchanged default.
    const agentGet = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(AGENT),
    });
    expect(agentGet.json()).toEqual({ memoryMining: true });
    await app.close();
  }, APP_BUILD_BUDGET_MS);

  it("an operator PUT persists; a later read (either tier) reflects it", async () => {
    const app = await buildTieredApp();
    const put = await app.inject({
      method: "PUT",
      url: SETTING_URL,
      headers: auth(OPERATOR),
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ memoryMining: false });

    const get = await app.inject({
      method: "GET",
      url: SETTING_URL,
      headers: auth(AGENT),
    });
    expect(get.json()).toEqual({ memoryMining: false });
    await app.close();
  }, APP_BUILD_BUDGET_MS);

  it("NOT env-settable: an agent-controllable env var cannot flip the stored value", async () => {
    process.env.memoryMining = "false";
    process.env.MUON_MEMORY_MINE = "0";
    try {
      const app = await buildTieredApp();
      const res = await app.inject({
        method: "GET",
        url: SETTING_URL,
        headers: auth(OPERATOR),
      });
      // The kill switch lives in the RUNNER, not in the brain: the stored
      // posture the route reports is unchanged by anything in this process env.
      expect(res.json()).toEqual({ memoryMining: true });
      await app.close();
    } finally {
      delete process.env.memoryMining;
      delete process.env.MUON_MEMORY_MINE;
    }
  }, APP_BUILD_BUDGET_MS);
});
