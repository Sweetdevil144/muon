import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-0038 slice 2 — ENABLE, against a real database.
 *
 * Slice 1 could not grant anything, and its tests could therefore only check
 * that it did not try. This half CAN, so these tests are about authority:
 *
 *   D1  discovery is a read; enable is an authority act, human-only.
 *   D2  the diff is computed from state MUON re-read, never from the request.
 *   D3  a fingerprint that moved DISABLES the item; it does not warn.
 *   D6  an enable binds ONE item to ONE lane. Never the workspace.
 *   D7  MCP servers only. An unknown kind is refused, not passed through.
 *   D8  an agent-dispatched lane may hold one, and the tiering that permits
 *       that is split: enable/disable are operator, attest is not — because
 *       the runner's own token is agent-tier, and an operator-only attest
 *       would leave D8 decided and dead.
 *
 * The ENUMERATOR is mocked, as in the discovery route's own tests: a real call
 * would read the developer's `~/.claude.json`. What is real here is the store,
 * the tiering and the drift arithmetic.
 */

const OPERATOR = "operator-token-compat-enable";
const AGENT = "agent-token-compat-enable";
const LANE_KEY = "claude";

type Shape = {
  transport: "stdio" | "http" | "sse" | "unknown";
  command?: string;
  args: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
};

function server(name: string, shape: Partial<Shape> = {}) {
  return {
    kind: "mcp_server" as const,
    name,
    provenance: { vendor: "claude", sourcePath: "/home/dev/.claude.json" },
    shape: {
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", `${name}-mcp`],
      envKeys: [],
      headerKeys: [],
      ...shape,
    },
    secretsRefused: [],
    state: "discovered" as const,
  };
}

/** The live inventory the mocked enumerator returns. Tests mutate it. */
const live = vi.hoisted(() => ({
  items: [] as unknown[],
  unreadable: [] as { vendor: string; sourcePath: string; name: string; reason: string }[],
  sources: [] as unknown[],
}));

const discover = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/compatibility-discovery.js", () => ({
  discoverCompatibilityInventory: discover,
}));

let app: FastifyInstance;
let db: typeof import("../src/lib/db.js");
let dir: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-compat-enable-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  await db.ensureSchema();
  await db.prisma.lane.create({
    data: { key: LANE_KEY, name: "Claude", provider: "claude", role: "implementer" },
  });
  await db.prisma.lane.create({
    data: { key: "codex", name: "Codex", provider: "codex", role: "reviewer" },
  });

  // A live job in each lane: the agent tier may attest only a lane it is
  // actually executing, so the fixture has to look like a real run.
  await db.prisma.task.create({
    data: {
      id: "task-attest",
      title: "Attest",
      description: "fixture",
      status: "in_progress",
      workspacePath: process.cwd(),
    },
  });
  // A LIVE RUNNER holding the launch lease, and jobs stamped with it: the
  // agent tier must PROVE it is the runner executing that job, not merely name
  // one.
  const leaseHash = createHash("sha256").update(LEASE_TOKEN).digest("hex");
  await db.prisma.runner.create({
    data: { host: LEASE_HOST, leaseHash, lastSeenAt: new Date() },
  });
  for (const [vendor, id] of Object.entries(LIVE_JOB)) {
    await db.prisma.dispatchJob.create({
      data: {
        id,
        vendor,
        taskId: "task-attest",
        brief: "work",
        status: "running",
        host: LEASE_HOST,
        runnerLeaseHash: leaseHash,
      },
    });
  }

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
  live.items = [server("linear"), server("filesystem")];
  live.unreadable = [];
  discover.mockReset();
  discover.mockImplementation(() => live);
  await db.prisma.importedCapability.deleteMany({});
});

function enable(laneKey: string, body: unknown, token = OPERATOR) {
  return app.inject({
    method: "POST",
    url: `/api/compatibility/mcp/lanes/${laneKey}/enable`,
    headers: auth(token),
    payload: body,
  });
}

const LEASE_TOKEN = `lease-${"L".repeat(48)}`;
const LEASE_HOST = "test-host";

function attest(laneKey: string, token = AGENT, jobId = LIVE_JOB[laneKey]) {
  return app.inject({
    method: "POST",
    url: `/api/compatibility/mcp/lanes/${laneKey}/attest`,
    headers: auth(token),
    payload: jobId
      ? { jobId, host: LEASE_HOST, leaseToken: LEASE_TOKEN }
      : {},
  });
}

/** A live job per lane, so the agent tier can attest the lane it is running. */
const LIVE_JOB: Record<string, string> = {
  [LANE_KEY]: "job-live-claude",
  codex: "job-live-codex",
};

describe("D1/D8 — only a human enables", () => {
  it("refuses the agent tier", async () => {
    const response = await enable(
      LANE_KEY,
      { vendor: "claude", name: "linear" },
      AGENT
    );
    expect(response.statusCode).toBe(403);
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("refuses an unauthenticated enable", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/enable`,
      payload: { vendor: "claude", name: "linear" },
    });
    expect(response.statusCode).toBe(401);
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("records WHO approved it from auth, not from the body", async () => {
    // A row whose approver is self-declared is worthless the first time it
    // matters. The operator tier keeps a human id it supplies; anything else
    // is coerced to the generic human operator.
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "linear",
      principal: "agent:sneaky",
    });
    expect(response.statusCode).toBe(200);
    const row = await db.prisma.importedCapability.findFirst();
    expect(row!.enabledBy).not.toBe("agent:sneaky");
  });
});

describe("D6 — one item, one lane", () => {
  it("binds to the lane it was enabled for and to no other", async () => {
    expect((await enable(LANE_KEY, { vendor: "claude", name: "linear" })).statusCode).toBe(200);

    const other = await app.inject({
      method: "GET",
      url: "/api/compatibility/mcp/lanes/codex",
      headers: auth(OPERATOR),
    });
    expect(other.json()).toEqual([]);

    const mine = await app.inject({
      method: "GET",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}`,
      headers: auth(OPERATOR),
    });
    expect((mine.json() as { name: string }[]).map((i) => i.name)).toEqual(["linear"]);
  });

  it("a lane that does not exist is a refusal, not an orphan row", async () => {
    const response = await enable("no-such-lane", { vendor: "claude", name: "linear" });
    expect(response.statusCode).toBe(404);
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("attesting one lane never returns another lane's servers", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const codex = await attest("codex");
    expect(codex.statusCode).toBe(200);
    expect((codex.json() as { servers: unknown[] }).servers).toEqual([]);
  });
});

describe("D7 — MCP servers only, by a positive list", () => {
  it("refuses a kind that is not on the list", async () => {
    live.items = [{ ...server("some-skill"), kind: "skill" }];
    const response = await enable(LANE_KEY, { vendor: "claude", name: "some-skill" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("ADR-0038 D7");
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });
});

describe("D2 — the shape comes from the config, never from the caller", () => {
  it("refuses to enable a server the vendor's configuration does not have", async () => {
    const response = await enable(LANE_KEY, { vendor: "claude", name: "not-there" });
    expect(response.statusCode).toBe(404);
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("ignores any shape the caller sends and stores what it READ", async () => {
    // THE ATTACK THIS CLOSES. A request that carried its own command would let
    // a caller approve `curl | sh` against a screen that said `npx linear-mcp`.
    // The request schema has no shape field, and the stored row proves the
    // backend re-read rather than trusted.
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "linear",
      shape: { transport: "stdio", command: "curl", args: ["evil.sh"] },
      command: "curl",
    });
    expect(response.statusCode).toBe(200);
    const row = await db.prisma.importedCapability.findFirst();
    expect((row!.shape as { command: string }).command).toBe("npx");
  });

  it("says what was UNREADABLE rather than 'no such server'", async () => {
    // Two different facts a human acts on differently.
    live.items = [];
    live.unreadable = [
      {
        vendor: "claude",
        sourcePath: "/home/dev/.claude.json",
        name: "linear",
        reason: "names neither a command nor a url",
      },
    ];
    const response = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toContain("could not read it");
  });

  it("returns a before/after diff, and it is empty when nothing changed", async () => {
    const first = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(first.json().diff).toMatchObject({ before: [], after: ["linear"], added: ["linear"] });

    const again = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(again.json().diff).toMatchObject({ added: [], removed: [] });
  });
});

describe("D5 — a server MUON cannot make work is REFUSED, not half-enabled", () => {
  it("refuses an item that needs a credential, and says why", async () => {
    // A review traced the earlier behaviour end to end and every case was
    // broken rather than merely incomplete: an `env` credential materializes
    // as `env: {}` and MUON hands the lane its OWN generated server config, so
    // the vendor's copy is never consulted; a credential in a url or an
    // argument is REPLACED with a redaction marker, so the endpoint does not
    // exist. Enabling it and telling the human to "supply them through the
    // vendor's own configuration" was advice that could not work.
    live.items = [
      { ...server("linear", { envKeys: ["LINEAR_API_KEY"] }), secretsRefused: ["LINEAR_API_KEY"] },
    ];
    const response = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("LINEAR_API_KEY");
    expect(response.json().message).toContain("could not authenticate");
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("a server needing NOTHING is enabled, and attests with an empty env", async () => {
    // The case this feature actually serves today: filesystem, git, sqlite.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const attestation = (await attest(LANE_KEY)).json() as {
      servers: { name: string; env: Record<string, string> }[];
    };
    expect(attestation.servers[0]!.env).toEqual({});
  });
});

describe("D3 — drift DISABLES, it does not warn", () => {
  it("hands over the server while its fingerprint still matches", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const response = await attest(LANE_KEY);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { servers: { name: string }[]; disabled: unknown[] };
    expect(body.servers.map((s) => s.name)).toEqual(["linear"]);
    expect(body.disabled).toEqual([]);
  });

  it("disables the item when its COMMAND changes underneath the approval", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("linear", { command: "curl", args: ["evil.sh"] })];

    const body = (await attest(LANE_KEY)).json() as {
      servers: unknown[];
      disabled: { name: string; reason: string }[];
    };
    expect(body.servers, "the changed server does NOT run").toEqual([]);
    expect(body.disabled[0]!.name).toBe("linear");
    expect(body.disabled[0]!.reason).toContain("shape changed");

    const row = await db.prisma.importedCapability.findFirst();
    expect(row!.state, "disabled, not warned").toBe("disabled-drift");
    expect(row!.driftDigest).not.toBe(row!.enabledDigest);
  });

  it("disables the item when it VANISHES from the configuration", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("filesystem")];

    const body = (await attest(LANE_KEY)).json() as {
      disabled: { observedDigest: string; reason: string }[];
    };
    expect(body.disabled[0]!.observedDigest).toBe("absent");
    expect(body.disabled[0]!.reason).toContain("no longer in");
  });

  it("stays disabled on the NEXT run — one drift is not forgiven by a re-read", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("linear", { command: "curl" })];
    await attest(LANE_KEY);
    // Even if the config goes back to what it was, the row is disabled and a
    // HUMAN re-approves it. Silently re-enabling would make the disable a
    // warning after all.
    live.items = [server("linear")];
    const body = (await attest(LANE_KEY)).json() as { servers: unknown[] };
    expect(body.servers).toEqual([]);
    expect((await db.prisma.importedCapability.findFirst())!.state).toBe(
      "disabled-drift"
    );
  });

  it("a human re-enabling clears the drift and binds TODAY's shape", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("linear", { command: "curl" })];
    await attest(LANE_KEY);

    // The human looks, decides the new shape is fine, and re-approves.
    const response = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(response.statusCode).toBe(200);
    const row = await db.prisma.importedCapability.findFirst();
    expect(row!.state).toBe("enabled");
    expect(row!.driftDigest, "the old evidence is cleared, not kept as truth").toBeNull();
    const body = (await attest(LANE_KEY)).json() as { servers: { command: string }[] };
    expect(body.servers[0]!.command).toBe("curl");
  });
});

describe("the tier split that keeps D8 alive without widening it", () => {
  it("the RUNNER's shared agent token may attest THE LANE IT IS RUNNING", async () => {
    // The runner's own client is agent-tier. An operator-only attest would
    // mean an agent-dispatched lane never receives its imported servers — D8
    // decided and dead.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect((await attest(LANE_KEY, AGENT)).statusCode).toBe(200);
  });

  it("but NOT a lane it has no live job in", async () => {
    // An adversarial review found the shared bearer able to attest any lane it
    // named. Two crossings at once: it enumerates another lane's approved
    // launch configurations, and — because attestation disables on drift — it
    // can knock out that lane's imports as a side effect.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    await db.prisma.dispatchJob.update({
      where: { id: LIVE_JOB[LANE_KEY]! },
      data: { status: "done" },
    });
    const dead = await attest(LANE_KEY, AGENT);
    expect(dead.statusCode).toBe(403);
    await db.prisma.dispatchJob.update({
      where: { id: LIVE_JOB[LANE_KEY]! },
      data: { status: "running" },
    });
  });

  it("and NOT with a job that belongs to a DIFFERENT lane", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const crossed = await attest(LANE_KEY, AGENT, LIVE_JOB.codex);
    expect(crossed.statusCode).toBe(403);
    expect(crossed.json().message).toContain(
      "lease-holding runner of a running job in this lane"
    );
  });

  it("and NOT with a lease it does not hold", async () => {
    // Naming a live job was not enough — ANY holder of the shared token can
    // name any live job. The caller proves it is the lease-holding runner:
    // the lease says which PROCESS, the job's own stamp says which WORK.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const forged = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/attest`,
      headers: auth(AGENT),
      payload: {
        jobId: LIVE_JOB[LANE_KEY],
        host: LEASE_HOST,
        leaseToken: `forged-${"F".repeat(48)}`,
      },
    });
    expect(forged.statusCode).not.toBe(200);
    // The row survives: a refused attestation must not disable anything.
    expect((await db.prisma.importedCapability.findFirst())!.state).toBe(
      "enabled"
    );
  });

  it("and NOT with no job named at all", async () => {
    const anonymous = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/attest`,
      headers: auth(AGENT),
      payload: {},
    });
    expect(anonymous.statusCode).toBe(403);
  });

  it("an OPERATOR still needs no job — it is a human review surface too", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const asHuman = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/attest`,
      headers: auth(OPERATOR),
      payload: {},
    });
    expect(asHuman.statusCode).toBe(200);
  });

  it("attest can only NARROW — it never enables anything", async () => {
    live.items = [server("linear"), server("filesystem")];
    const body = (await attest(LANE_KEY, AGENT)).json() as { servers: unknown[] };
    expect(body.servers, "nothing enabled ⇒ nothing attested").toEqual([]);
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("the lane LISTING stays operator-only — it is a review surface", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}`,
      headers: auth(AGENT),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("one server per NAME per lane — a map key is not shareable", () => {
  it("refuses a second vendor's server with a name the lane already holds", async () => {
    // An adversarial review traced this end to end: the store's key is (lane,
    // vendor, kind, name) so both rows enable; the diff is name-only so it
    // cannot tell them apart; and the runner takes the FIRST match. Which
    // endpoint actually launched was database-order dependent and could differ
    // from the diff the human approved. The collision is refused at the point
    // of decision instead of resolved by luck at spawn.
    live.items = [
      server("linear"),
      { ...server("linear"), provenance: { vendor: "codex", sourcePath: "/c" } },
    ];
    expect(
      (await enable(LANE_KEY, { vendor: "claude", name: "linear" })).statusCode
    ).toBe(200);

    const second = await enable(LANE_KEY, { vendor: "codex", name: "linear" });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain("already has a server named");
    expect(second.json().message, "and names who holds it").toContain("claude");
    expect(await db.prisma.importedCapability.count()).toBe(1);
  });

  it("re-enabling the SAME vendor's server is still fine", async () => {
    // The refusal is about a name collision across vendors, not about
    // re-approving after drift — which is the one thing a human must be able
    // to do.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(
      (await enable(LANE_KEY, { vendor: "claude", name: "linear" })).statusCode
    ).toBe(200);
  });

  it("a different lane may hold the same name — the map is PER LANE", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(
      (await enable("codex", { vendor: "claude", name: "linear" })).statusCode
    ).toBe(200);
  });
});

describe("attestation cannot clobber a decision made after it read", () => {
  it("a re-approval mid-attestation wins, and no phantom disable is reported", async () => {
    // The race an adversarial review found: attest reads the enabled rows,
    // then writes each drifting one. A human re-enabling in between would have
    // been overwritten with `disabled-drift` — silently revoking an approval
    // given AFTER the observation it was based on, and citing evidence that
    // was already stale.
    //
    // Simulated at the exact seam rather than approximated: the read is
    // wrapped so that a re-approval lands BETWEEN the read and the write,
    // which is the only place the bug lives. Setting the row up beforehand
    // would not reproduce it — the sweep would simply read the new digest.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("linear", { command: "curl" })];

    // NOT `vi.spyOn`. A Prisma delegate is Proxy-backed, so its methods are not
    // own properties: `spyOn` assigns one, and `mockRestore` DELETES it rather
    // than putting the original back — leaving `findMany` undefined and every
    // later test in the file failing 500. Swap and restore by assignment.
    const rows = db.prisma.importedCapability as unknown as {
      findMany: (args?: unknown) => Promise<unknown[]>;
      updateMany: (args: unknown) => Promise<unknown>;
    };
    const realFindMany = rows.findMany;
    rows.findMany = async (args?: unknown) => {
      const result = await realFindMany.call(rows, args);
      // The human looks at the new shape and approves it, right here — after
      // the sweep has read, before it writes.
      await rows.updateMany({
        where: { itemName: "linear" },
        data: { enabledDigest: `sha256:${"f".repeat(64)}` },
      });
      return result;
    };

    let body: { disabled: unknown[] };
    try {
      body = (await attest(LANE_KEY)).json() as { disabled: unknown[] };
    } finally {
      rows.findMany = realFindMany;
    }

    const row = await db.prisma.importedCapability.findFirst();
    expect(row!.state, "the human's newer decision stands").toBe("enabled");
    expect(row!.driftDigest, "and carries no drift evidence").toBeNull();
    expect(
      body.disabled,
      "a disable that did not happen is not reported either"
    ).toEqual([]);
  });
});

describe("MUON's own server name is not available to an import", () => {
  it("refuses to enable a server called `muon`", async () => {
    // It would share a key with MUON's governed MCP in the vendor's server
    // map and could replace the one MUON governs through.
    live.items = [server("muon")];
    const response = await enable(LANE_KEY, { vendor: "claude", name: "muon" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("governed MCP server");
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });
});

describe("disable", () => {
  it("takes it back and proves it with a diff", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const response = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/disable`,
      headers: auth(OPERATOR),
      payload: { vendor: "claude", name: "linear" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().diff).toMatchObject({ removed: ["linear"], after: [] });
    expect(await db.prisma.importedCapability.count()).toBe(0);
  });

  it("refuses the agent tier", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    const response = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/disable`,
      headers: auth(AGENT),
      payload: { vendor: "claude", name: "linear" },
    });
    expect(response.statusCode).toBe(403);
    expect(await db.prisma.importedCapability.count()).toBe(1);
  });

  it("says so rather than pretending, when there was nothing to disable", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/disable`,
      headers: auth(OPERATOR),
      payload: { vendor: "claude", name: "linear" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("the persistence boundary refuses what it does not recognise", () => {
  it("an unknown stored state is a refusal, not a silent 'disabled-drift'", async () => {
    // This used to map anything that was not `enabled` to `disabled-drift`, so
    // a state a later migration introduced would have been re-described as a
    // supply-chain disable complete with a reason it never had. A boundary
    // that coerces is one that lies on the exact input it exists to check.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    await db.prisma.importedCapability.updateMany({
      data: { state: "quarantined-by-a-future-migration" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}`,
      headers: auth(OPERATOR),
    });
    // 409, not 500: the framework masks a 500 body, and the operator reading
    // this is the person who can act on it.
    expect(listed.statusCode).toBe(409);
    expect(listed.json().message).toContain("unrecognised state");
    await db.prisma.importedCapability.deleteMany({});
  });
});

describe("a re-approval cannot overwrite a DIFFERENT vendor's decision", () => {
  it("refuses, and the incumbent survives untouched", async () => {
    // An adversarial review found what a plain upsert allowed: enable read the
    // lane's rows and then wrote, so a concurrent decision could be clobbered
    // by the UPDATE path. There are two layers against it now — the advisory
    // check (which is what this exercises, and what a human normally hits) and
    // a vendor-GUARDED update behind it. The whole enable also runs in one
    // serializable transaction, which is why the interleaving cannot be staged
    // from another connection any more; the guard stays as the thing that
    // holds if that isolation is ever relaxed.
    live.items = [
      server("linear"),
      { ...server("linear"), provenance: { vendor: "codex", sourcePath: "/c" } },
    ];
    await enable(LANE_KEY, { vendor: "codex", name: "linear" });
    const incumbent = await db.prisma.importedCapability.findFirst();

    const response = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(response.statusCode).toBe(409);

    const after = await db.prisma.importedCapability.findFirst();
    expect(after!.vendor, "codex's decision stands").toBe("codex");
    expect(after!.enabledDigest, "and was not rewritten").toBe(
      incumbent!.enabledDigest
    );
    expect(await db.prisma.importedCapability.count()).toBe(1);
  });

  it("the SAME vendor re-approving still works", async () => {
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    live.items = [server("linear", { command: "curl" })];
    const again = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(again.statusCode).toBe(200);
    const row = await db.prisma.importedCapability.findFirst();
    expect((row!.shape as { command: string }).command).toBe("curl");
  });

  it("the diff describes THIS approval, computed in one transaction", async () => {
    // The receipt's before/after used to be three separate operations, so a
    // concurrent enable or disable could appear in a diff that claimed to
    // describe this decision — evidence pointing at the wrong human.
    live.items = [server("linear"), server("filesystem")];
    await enable(LANE_KEY, { vendor: "claude", name: "filesystem" });
    const response = await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    expect(response.json().diff).toMatchObject({
      before: ["filesystem"],
      after: ["filesystem", "linear"],
      added: ["linear"],
      removed: [],
    });
  });
});

describe("the persistence boundary refuses what it does not recognise", () => {
  it("an unknown stored state is a refusal, not a silent 'disabled-drift'", async () => {
    // This used to map anything that was not `enabled` to `disabled-drift`, so
    // a state a later migration introduced would have been re-described as a
    // supply-chain disable complete with a reason it never had. A boundary
    // that coerces is one that lies on the exact input it exists to check.
    await enable(LANE_KEY, { vendor: "claude", name: "linear" });
    await db.prisma.importedCapability.updateMany({
      data: { state: "quarantined-by-a-future-migration" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}`,
      headers: auth(OPERATOR),
    });
    // 409, not 500: the framework masks a 500 body, and the operator reading
    // this is the person who can act on it.
    expect(listed.statusCode).toBe(409);
    expect(listed.json().message).toContain("unrecognised state");
    await db.prisma.importedCapability.deleteMany({});
  });
});

describe("enable refuses what it could not actually launch", () => {
  /**
   * Both of these were accepted with a success message and then failed
   * silently at USE. `materializeEnabledServer` parses through a schema that
   * requires exactly one of command or url, so an item carrying both threw on
   * every attestation afterwards — and the lane started WITHOUT the import it
   * had been told it held. An approval that silently does not apply is the
   * fail-open shape this whole module exists to avoid.
   */
  it("refuses an item declaring BOTH a command and a url", async () => {
    live.items = [
      server("both", { url: "https://example.com/mcp" }),
    ];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "both",
      kind: "mcp_server",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("BOTH a command and a url");
  });

  it("refuses an item declaring NEITHER", async () => {
    live.items = [server("neither", { command: undefined })];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "neither",
      kind: "mcp_server",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("neither a command nor a url");
  });

  it("still enables an ordinary stdio server", async () => {
    live.items = [server("fine")];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "fine",
      kind: "mcp_server",
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("enable says which environment it will NOT pass", () => {
  it("names the declared env vars, because they are silently dropped", async () => {
    // MUON imports env NAMES only (D5) and materializes an empty env, so a
    // server declaring NODE_ENV launches without it. That is a defensible
    // bound; saying nothing about it is not — a human debugging a server that
    // starts and then misbehaves has no way to reach this fact.
    live.items = [server("needs-env", { envKeys: ["NODE_ENV", "API_BASE"] })];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "needs-env",
      kind: "mcp_server",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().envNotCarried).toEqual(["NODE_ENV", "API_BASE"]);
  });

  it("is empty for a server that declares none", async () => {
    live.items = [server("no-env")];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "no-env",
      kind: "mcp_server",
    });
    expect(response.json().envNotCarried).toEqual([]);
  });
});

describe("the WIRE matches the contract the client parses", () => {
  /**
   * A review flagged `envNotCarried` as missing from `enableResultSchema` and
   * was wrong — but the gap it pointed at is real: every CLI test mocks the
   * client, so nothing anywhere validated a REAL route response against the
   * schema the client parses it with. That schema's fields are required, so a
   * route that stops returning one turns every successful enable into a
   * client-side throw — and the CLI's catch prints "Enable failed. Nothing was
   * granted." after the capability was already granted.
   *
   * This parses the actual HTTP body through the actual schema.
   */
  it("an enable response parses as EnableResult", async () => {
    const { enableResultSchema } = await import("@muon/protocol");
    live.items = [server("wire-check", { envKeys: ["NODE_ENV"] })];
    const response = await enable(LANE_KEY, {
      vendor: "claude",
      name: "wire-check",
      kind: "mcp_server",
    });
    expect(response.statusCode).toBe(200);
    const parsed = enableResultSchema.safeParse(response.json());
    expect(
      parsed.success ? null : parsed.error.issues,
      "the route's body must satisfy the client's contract"
    ).toBeNull();
    expect(parsed.success && parsed.data.envNotCarried).toEqual(["NODE_ENV"]);
  });

  it("a disable response parses too", async () => {
    const { capabilityDiffSchema } = await import("@muon/protocol");
    live.items = [server("wire-disable")];
    await enable(LANE_KEY, { vendor: "claude", name: "wire-disable", kind: "mcp_server" });
    const response = await app.inject({
      method: "POST",
      url: `/api/compatibility/mcp/lanes/${LANE_KEY}/disable`,
      headers: auth(OPERATOR),
      payload: { vendor: "claude", name: "wire-disable", kind: "mcp_server" },
    });
    expect(response.statusCode).toBe(200);
    const parsed = capabilityDiffSchema.safeParse(response.json().diff);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});
