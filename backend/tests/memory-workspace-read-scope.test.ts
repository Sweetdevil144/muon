import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// ── ADR-0026 §11 STEP 3 + STEP 4 — the READ path over the real HTTP routes ────
//
// The sibling of `memory-chat-scope.test.ts`, and deliberately so: §5 says a
// visibility question must be testable in BOTH DIRECTIONS, that the chat fence
// already has such a file, and that "a workspace fence gets the sibling file".
//
// Real SQLite ledger, real LadybugDB mirror, real routes. Every assertion is a
// PAIR — the foreign-workspace note is not returned AND the same-workspace note
// still is — because a fence with only the first half is indistinguishable from a
// fence that returns nothing.
//
// What this file pins that the graph-level test cannot:
//   • DERIVATION. The agent tier's coordinate comes from the authenticated
//     capability, so an agent cannot ask for another repo even by naming it — and
//     naming one is REFUSED rather than silently overridden.
//   • §8's NULL POLICY as a tier rule: the residue is operator-only, requires an
//     explicit request, and is refused outright for an agent.
//   • The LIBRARY where-clause, which is SQL and never touches the graph — the one
//     surface §1 measured actually leaking.
//   • §6 through the library's `chatId OR scope:"global"` admission, which is a
//     second, independently written copy of the read rule.

const OPERATOR = "operator-token-ws-read";
const AGENT = "agent-token-ws-read";
const JOB_A_TOKEN = `job-rda-${"a".repeat(56)}`;
const JOB_B_TOKEN = `job-rdb-${"b".repeat(56)}`;
const MOD = "src/pay/charge.ts";
// Distinctive tokens so the lexical scan matches deterministically (FTS off).
const SHARED_TERM = "quebec-romeo";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let workspaceA: string;
let workspaceB: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let app: FastifyInstance;

const ids = {
  inA: "mem-ws-read-a",
  inB: "mem-ws-read-b",
  unassigned: "mem-ws-read-null",
  globalInB: "mem-ws-read-global-b",
};

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-ws-read-")));
  workspaceA = path.join(dir, "repo-a");
  workspaceB = path.join(dir, "repo-b");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });

  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  // `validateWorkspacePath` allowlists cwd + $HOME by default, and the temp dir is
  // under neither on every platform. Widening it explicitly is what the operator
  // env var is for, and it keeps this test about the FENCE rather than about
  // containment (which `workspace.test.ts` owns).
  process.env.MUON_WORKSPACE_ROOTS = dir;
  delete process.env.MUON_API_TOKEN;

  // TODO 0.6: a full-suite flake came from a cached Prisma client still bound to
  // another file's DATABASE_URL. Reset the module graph after env is set so this
  // file's ledger/app are the ones we just pointed at.
  vi.resetModules();
  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  await db.ensureSchema();

  await db.prisma.dispatchJob.createMany({
    data: [
      {
        id: "job-ws-read-a",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-ws-read-a",
        chatId: "chat-WS",
        brief: "repo A memory job",
        status: "running",
        dispatchedBy: "human",
        workspacePath: workspaceA,
      },
      {
        // THE SHARED CHAT IS THE WHOLE POINT: it isolates the WORKSPACE axis from
        // the chat axis that already fences these reads. Give job B its own chat and
        // every assertion below would pass on the CHAT fence and prove nothing about
        // this ADR.
        //
        // Two RUNNING ROOT jobs cannot share a chat
        // (`DispatchJob_one_active_root_per_chat`, whose predicate is
        // `parentJobId IS NULL AND status IN ('queued','running')`), so job B is a
        // CHILD. That is also the realistic shape for a differing workspace: the
        // delegate branch in `execute.ts` takes `delegation.data.workspacePath`
        // rather than inheriting the parent's, so a child genuinely can execute in a
        // different repo. `running` is required — `resolveActiveAgentJobCapability`
        // refuses any other status.
        id: "job-ws-read-b",
        kind: "oneshot",
        vendor: "codex",
        taskId: "task-ws-read-b",
        chatId: "chat-WS",
        parentJobId: "job-ws-read-a",
        rootJobId: "job-ws-read-a",
        brief: "repo B memory job",
        status: "running",
        dispatchedBy: "human",
        workspacePath: workspaceB,
      },
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-ws-read-a", JOB_A_TOKEN],
      ["job-ws-read-b", JOB_B_TOKEN],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  // The corpus. Four notes whose ONLY meaningful difference is `workspacePath`:
  // same chat, same module anchor, same trust, same author, same matching term.
  // Written straight to the ledger so the partition is exact and so the fixture
  // does not depend on the write path this test is not about.
  const rows = [
    { id: ids.inA, workspacePath: workspaceA, scope: "project" },
    { id: ids.inB, workspacePath: workspaceB, scope: "project" },
    { id: ids.unassigned, workspacePath: null, scope: "project" },
    // §6: promoted global + human-confirmed is the ONLY cross-chat escape hatch,
    // and the workspace term is ANDed OUTSIDE it.
    { id: ids.globalInB, workspacePath: workspaceB, scope: "global" },
  ];
  for (const row of rows) {
    await db.prisma.memoryNote.create({
      data: {
        id: row.id,
        kind: "decision",
        text: `Charges are idempotent by request key ${SHARED_TERM} (${row.id})`,
        textHash: row.id,
        scope: row.scope,
        trust: "high",
        status: "active",
        createdBy: "human",
        taskId: "task-ws-read-a",
        chatId: "chat-WS",
        workspacePath: row.workspacePath,
        modules: [MOD],
        topics: [],
        symbols: [],
      },
    });
    // Human-confirmed across the board: the agent tier reads through the KG-6
    // governed gate, so an unconfirmed corpus would be filtered by the GATE and this
    // file would be measuring that instead of the fence.
    await db.prisma.confirmation.create({
      data: { noteId: row.id, principal: "human", decision: "confirm" },
    });
  }
  await ledger.projectLedgerToGraph();

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  delete process.env.MUON_WORKSPACE_ROOTS;
  rmSync(dir, { recursive: true, force: true });
});

async function noteIds(
  url: string,
  token: string
): Promise<string[]> {
  const response = await app.inject({ method: "GET", url, headers: auth(token) });
  expect(response.statusCode).toBe(200);
  return (response.json().notes as { id: string }[]).map((note) => note.id);
}

describe("ADR-0026 step 3: an AGENT read is fenced to its capability's workspace", () => {
  it("search: repo A's job sees repo A's note and NOT repo B's", async () => {
    const fromA = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&chatId=chat-WS`,
      JOB_A_TOKEN
    );
    expect(fromA).toContain(ids.inA);
    expect(fromA).not.toContain(ids.inB);

    // The mirror image, from the other side. Two one-directional assertions in
    // opposite directions is what makes this a partition rather than a filter that
    // happens to favour repo A.
    const fromB = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&chatId=chat-WS`,
      JOB_B_TOKEN
    );
    expect(fromB).toContain(ids.inB);
    expect(fromB).not.toContain(ids.inA);
  });

  it("recall: the module-anchored read, the one ADR-0026 exists for", async () => {
    const fromA = await noteIds(
      `/api/memory/recall?module=${encodeURIComponent(MOD)}&chatId=chat-WS`,
      JOB_A_TOKEN
    );
    expect(fromA).toContain(ids.inA);
    expect(fromA).not.toContain(ids.inB);
  });

  it("§8: an agent never sees the unassigned residue, from either side", async () => {
    for (const token of [JOB_A_TOKEN, JOB_B_TOKEN]) {
      const found = await noteIds(
        `/api/memory/search?q=${SHARED_TERM}&chatId=chat-WS`,
        token
      );
      expect(found).not.toContain(ids.unassigned);
    }
  });

  it("§6: a confirmed promoted-GLOBAL note does not cross the workspace", async () => {
    const fromA = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&chatId=chat-WS`,
      JOB_A_TOKEN
    );
    expect(fromA).not.toContain(ids.globalInB);
    // Visible from its OWN workspace, so the exclusion above is the workspace term
    // and not the confirmed/global admission having broken.
    const fromB = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&chatId=chat-WS`,
      JOB_B_TOKEN
    );
    expect(fromB).toContain(ids.globalInB);
  });

  it("§4: an agent naming ANOTHER workspace is REFUSED, not silently overridden", async () => {
    // Refused rather than corrected, exactly as a mismatched `chatId` claim is: a
    // tolerated-but-ignored claim is an oracle for which repos exist.
    const response = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent(workspaceB)}`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(response.statusCode).toBe(403);

    // Naming its OWN workspace is fine and changes nothing — the derived value was
    // already that, so an honest claim is neither rewarded nor punished.
    const honest = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent(workspaceA)}&chatId=chat-WS`,
      JOB_A_TOKEN
    );
    expect(honest).toContain(ids.inA);
    expect(honest).not.toContain(ids.inB);
  });

  it("§4: an out-of-allowlist agent claim is refused with the SAME message, and never reduced", async () => {
    // `/etc` is outside every workspace root, so `validateWorkspacePath` refuses it.
    // Two things are asserted, and the SECOND is the security-relevant one:
    //  1. it is a 403, not the operator branch's 400 — an agent claim is a capability
    //     question, and the allowlist reason names every configured root.
    //  2. the body is byte-for-byte what a valid-but-foreign claim returns, so an
    //     agent cannot tell "not allowlisted" from "not yours" and therefore cannot
    //     map the machine by watching which claims are tolerated.
    const outside = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent("/etc/muon-not-a-workspace")}`,
      headers: auth(JOB_A_TOKEN),
    });
    const foreign = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent(workspaceB)}`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().message).toBe(foreign.json().message);
    expect(outside.json().message).not.toContain("MUON_WORKSPACE_ROOTS");
  });

  it("§8: the unscoped residue view is refused for an agent", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/memory/search?q=${SHARED_TERM}&unscoped=true`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(response.statusCode).toBe(403);
  });

  it("the HERO GATE is fenced too — the surface where a collision is dangerous", async () => {
    const preedit = async (token: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/memory/preedit",
        headers: auth(token),
        payload: { module: MOD, chatId: "chat-WS" },
      });
      expect(response.statusCode).toBe(200);
      return (response.json().memories as { id: string }[]).map(
        (note) => note.id
      );
    };
    const fromA = await preedit(JOB_A_TOKEN);
    expect(fromA).toContain(ids.inA);
    expect(fromA).not.toContain(ids.inB);
    expect(fromA).not.toContain(ids.unassigned);

    const fromB = await preedit(JOB_B_TOKEN);
    expect(fromB).toContain(ids.inB);
    expect(fromB).not.toContain(ids.inA);
  });

  it("the PROVENANCE WALK is fenced, so a foreign note's existence stays hidden", async () => {
    const walk = await app.inject({
      method: "GET",
      url: `/api/memory/neighbors/${encodeURIComponent(`note:${ids.inA}`)}?hops=2&chatId=chat-WS`,
      headers: auth(JOB_A_TOKEN),
    });
    expect(walk.statusCode).toBe(200);
    const entityIds = (walk.json().nodes as { entityId: string }[]).map(
      (node) => node.entityId
    );
    expect(entityIds).toContain(ids.inA);
    expect(entityIds).not.toContain(ids.inB);
  });
});

describe("ADR-0026 step 3: the OPERATOR library, the surface §1 measured leaking", () => {
  it("spans every workspace with NO coordinate, and exactly one WITH one", async () => {
    // The measured leak, reproduced: the operator page with no coordinate spans
    // multiple workspaces. This is §5's monotonicity, not a regression — the fence
    // lands because the CLI/TUI/desktop now always send a coordinate.
    const unscopedPage = await app.inject({
      method: "GET",
      url: "/api/memory/library?limit=200",
      headers: auth(OPERATOR),
    });
    expect(unscopedPage.statusCode).toBe(200);
    const spread = new Set(
      (unscopedPage.json().notes as { workspacePath: string | null }[]).map(
        (note) => note.workspacePath ?? "unscoped"
      )
    );
    expect(spread.size).toBeGreaterThan(1);

    // …and with the coordinate every surface now sends, exactly one.
    const fenced = await app.inject({
      method: "GET",
      url: `/api/memory/library?limit=200&workspace=${encodeURIComponent(workspaceA)}`,
      headers: auth(OPERATOR),
    });
    expect(fenced.statusCode).toBe(200);
    const rows = fenced.json().notes as {
      id: string;
      workspacePath: string | null;
    }[];
    expect(new Set(rows.map((row) => row.workspacePath))).toEqual(
      new Set([workspaceA])
    );
    const fencedIds = rows.map((row) => row.id);
    expect(fencedIds).toContain(ids.inA);
    expect(fencedIds).not.toContain(ids.inB);
    expect(fencedIds).not.toContain(ids.unassigned);
    expect(fencedIds).not.toContain(ids.globalInB);
  });

  it("§6: the library's own `chatId OR global` copy of the rule is fenced too", async () => {
    // The library where-clause is SQL and is a SECOND, independently written copy of
    // the read rule. Folding the workspace term INTO its `OR` (rather than ANDing it
    // outside) would re-admit repo B's promoted global note here while the graph
    // paths correctly refused it.
    const fenced = await app.inject({
      method: "GET",
      url: `/api/memory/library?limit=200&chatId=chat-WS&workspace=${encodeURIComponent(workspaceA)}`,
      headers: auth(OPERATOR),
    });
    expect(fenced.statusCode).toBe(200);
    const fencedIds = (fenced.json().notes as { id: string }[]).map(
      (row) => row.id
    );
    expect(fencedIds).toContain(ids.inA);
    expect(fencedIds).not.toContain(ids.globalInB);

    // Non-vacuous: without the workspace term that global note IS admitted by the
    // chat clause, so the exclusion above is the new term doing work.
    const chatOnly = await app.inject({
      method: "GET",
      url: "/api/memory/library?limit=200&chatId=chat-WS",
      headers: auth(OPERATOR),
    });
    expect(
      (chatOnly.json().notes as { id: string }[]).map((row) => row.id)
    ).toContain(ids.globalInB);
  });

  it("§8: the operator residue view returns ONLY unassigned notes, and LABELS them", async () => {
    const residue = await app.inject({
      method: "GET",
      url: "/api/memory/library?limit=200&unscoped=true",
      headers: auth(OPERATOR),
    });
    expect(residue.statusCode).toBe(200);
    const rows = residue.json().notes as {
      id: string;
      workspacePath: string | null;
    }[];
    expect(rows.map((row) => row.id)).toEqual([ids.unassigned]);
    // THE LABEL. Every row states its (absent) workspace, so a human adjudicating
    // the residue in the review queue can tell it apart from assigned memory.
    expect(rows.every((row) => row.workspacePath === null)).toBe(true);
  });

  it("refuses `workspace` and `unscoped` together rather than preferring one", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/memory/library?unscoped=true&workspace=${encodeURIComponent(workspaceA)}`,
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a workspace outside the allowlist with the existing reason", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/memory/library?workspace=%2Fetc",
      headers: auth(OPERATOR),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("outside the allowed");
  });

  it("reduces a WORKTREE path to the parent repo, so a read matches the write", async () => {
    // The single most likely way a read and a write disagree: the write path stored
    // `repoRootOf(<repo>/.muon/worktrees/<taskId>)` = the repo root, so a read that
    // did NOT reduce would fence to a path no note carries and return nothing.
    const worktree = path.join(workspaceA, ".muon", "worktrees", "task-x");
    mkdirSync(worktree, { recursive: true });
    const found = await noteIds(
      `/api/memory/library?limit=200&workspace=${encodeURIComponent(worktree)}`,
      OPERATOR
    );
    expect(found).toContain(ids.inA);
    expect(found).not.toContain(ids.inB);
  });
});

describe("ADR-0026 step 3: the operator SEARCH and RECALL routes", () => {
  it("fences search in both directions", async () => {
    const fromA = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent(workspaceA)}`,
      OPERATOR
    );
    expect(fromA).toContain(ids.inA);
    expect(fromA).not.toContain(ids.inB);
    expect(fromA).not.toContain(ids.unassigned);

    const fromB = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&workspace=${encodeURIComponent(workspaceB)}`,
      OPERATOR
    );
    expect(fromB).toContain(ids.inB);
    expect(fromB).not.toContain(ids.inA);
  });

  it("fences recall in both directions", async () => {
    const fromA = await noteIds(
      `/api/memory/recall?module=${encodeURIComponent(MOD)}&workspace=${encodeURIComponent(workspaceA)}`,
      OPERATOR
    );
    expect(fromA).toContain(ids.inA);
    expect(fromA).not.toContain(ids.inB);

    const fromB = await noteIds(
      `/api/memory/recall?module=${encodeURIComponent(MOD)}&workspace=${encodeURIComponent(workspaceB)}`,
      OPERATOR
    );
    expect(fromB).toContain(ids.inB);
    expect(fromB).not.toContain(ids.inA);
  });

  it("§8: the operator residue view on search returns ONLY the unassigned note", async () => {
    const found = await noteIds(
      `/api/memory/search?q=${SHARED_TERM}&unscoped=true`,
      OPERATOR
    );
    expect(found).toEqual([ids.unassigned]);
  });
});

describe("ADR-0026: a CLONE is a write, and it is fenced too", () => {
  it("an agent CANNOT clone a note from another workspace, even a confirmed GLOBAL one", async () => {
    // THE REVIEW FINDING. §9 listed `cloneMemoryNote` and asked only that the
    // clone PROPAGATE the source's workspace; the authorization GUARD was never
    // revisited, and its `confirmedGlobal` short-circuit skipped every check. A
    // repo-B agent could therefore clone repo A's confirmed-global note and land a
    // foreign-authored row IN REPO A's partition — visible in repo A's operator
    // library, and orchestrator-vouched by default so it need not even appear in
    // the unvouched review queue. Reproduced by an adversarial review.
    //
    // §6 is why `confirmedGlobal` must not exempt it: promotion widens a note
    // across MISSIONS, never across REPOSITORIES.
    const foreign = await ledger.cloneMemoryNote(ids.globalInB, {
      tier: "agent",
      principal: "agent:job:job-a",
      chatId: "chat-WS",
      workspacePath: workspaceA,
      crewVisible: true,
    });
    expect(foreign.status).toBe("forbidden");
    if (foreign.status === "forbidden") {
      expect(foreign.reason).toContain("another workspace");
    }
  });

  it("and CAN clone one from its OWN workspace — the fence narrows, it does not block", async () => {
    // The other direction, so this is not a test that passes because everything
    // is refused.
    const own = await ledger.cloneMemoryNote(ids.inA, {
      tier: "agent",
      principal: "agent:job:job-a",
      chatId: "chat-WS",
      workspacePath: workspaceA,
      crewVisible: true,
    });
    expect(own.status).toBe("cloned");
  });
});

describe("ADR-0026 §11: the fence is a NARROWER, never a widener", () => {
  it("every fenced answer is a strict subset of the unscoped one", async () => {
    // The composition rule, stated once in the ADR and asserted once here: the
    // filter may only remove rows from a set the caller was already authorized to
    // receive. If any change makes it able to ADMIT a row, it has stopped being
    // this design — and this is the test that would fail.
    //
    // `limit=100` (the route max) keeps ranking truncation from pretending a
    // promoted-into-top-K fenced hit is a widening. The corpus in this file is
    // four notes; asserting against that fixture set keeps suite-order noise
    // (standing-arm rows added later in this file, other files' leftover graph
    // state when module cache slipped) from flipping the subset check.
    const corpus = new Set([
      ids.inA,
      ids.inB,
      ids.unassigned,
      ids.globalInB,
    ]);
    const unscoped = (
      await noteIds(`/api/memory/search?q=${SHARED_TERM}&limit=100`, OPERATOR)
    ).filter((id) => corpus.has(id));
    const unscopedSet = new Set(unscoped);
    expect(unscopedSet.size).toBe(corpus.size);
    for (const url of [
      `/api/memory/search?q=${SHARED_TERM}&limit=100&workspace=${encodeURIComponent(workspaceA)}`,
      `/api/memory/search?q=${SHARED_TERM}&limit=100&workspace=${encodeURIComponent(workspaceB)}`,
      `/api/memory/search?q=${SHARED_TERM}&limit=100&unscoped=true`,
    ]) {
      const fenced = (await noteIds(url, OPERATOR)).filter((id) =>
        corpus.has(id)
      );
      expect(fenced.length).toBeGreaterThan(0);
      for (const id of fenced) {
        expect(unscopedSet.has(id)).toBe(true);
      }
      expect(fenced.length).toBeLessThan(unscopedSet.size);
    }
  });

  it("the workspace decision is NOT re-made in applyMemoryExpiry", async () => {
    // ADR-0026 §11's non-negotiable: `applyMemoryExpiry`'s degradation path returns
    // `notes.map(neutral)` and drops NOTHING when the ledger is unreadable, which is
    // safe ONLY because the fence already ran in the candidate query. So the function
    // must never learn the predicate. Asserted structurally — it does not accept a
    // workspace input and does not override the field — because a behavioural test
    // cannot distinguish "never learned it" from "learned it and agreed".
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(import.meta.dirname, "..", "src", "lib", "memory-ledger.ts"),
        "utf8"
      )
    );
    const start = source.indexOf("export async function applyMemoryExpiry");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nexport type MemoryLibraryFilter", start);
    expect(end).toBeGreaterThan(start);
    // Lowercased on both sides so a differently-cased spelling (`_workspacePath`,
    // `WorkspacePath`) cannot slip a re-derivation past a case-sensitive match. The
    // first draft of this assertion was case-sensitive and a mutation naming
    // `_mutatedWorkspacePath` walked straight through it.
    const body = source.slice(start, end).toLowerCase();
    expect(body).not.toContain("workspacepath");
    expect(body).not.toContain("unscopedworkspace");
  });
});

// ── TODO 4.1: the STANDING-MEMORY arm over the real route ────────────────────
//
// `GET /api/memory/recall?standing=true` — the workspace's human-confirmed
// constraint/convention canon plus pinned decisions, no anchor or chat partition. The fixture reuses
// this file's two real workspaces and two agent job capabilities, because the
// arm is a NEW read path and ADR-0026 §9 says every new read path gets the
// both-directions fence test on the day it lands.

describe("TODO 4.1: the standing-memory arm over the real route", () => {
  const standing = {
    constraintA: "mem-standing-constraint-a",
    conventionA: "mem-standing-convention-a",
    unconfirmedA: "mem-standing-unconfirmed-a",
    projectA: "mem-standing-project-a",
    constraintB: "mem-standing-constraint-b",
    decisionA: "mem-standing-decision-a",
    decisionB: "mem-standing-decision-b",
    decisionUnconfirmedA: "mem-standing-decision-unconfirmed-a",
    decisionProjectA: "mem-standing-decision-project-a",
    decisionStaleA: "mem-standing-decision-stale-a",
  };

  beforeAll(async () => {
    // Canon is human-confirmed AND `scope:"global"` — the ONE existing
    // cross-chat rule the arm reuses. A project-scope confirmed note
    // (`projectA`) is the control that must NOT ride.
    const rows = [
      {
        id: standing.constraintA,
        kind: "constraint",
        ws: workspaceA,
        chatId: "chat-WS",
        scope: "global",
        confirm: true,
        pin: false,
      },
      {
        // Confirmed in a DIFFERENT chat: standing memory crosses chats through
        // the promoted-global rule, so this reaches a repo-A brief seeded from
        // chat-WS.
        id: standing.conventionA,
        kind: "convention",
        ws: workspaceA,
        chatId: "chat-standing-other",
        scope: "global",
        confirm: true,
        pin: false,
      },
      {
        id: standing.unconfirmedA,
        kind: "constraint",
        ws: workspaceA,
        chatId: "chat-WS",
        scope: "global",
        confirm: false,
        pin: false,
      },
      {
        // Human-confirmed but PROJECT scope: not promoted, so not canon.
        id: standing.projectA,
        kind: "constraint",
        ws: workspaceA,
        chatId: "chat-WS",
        scope: "project",
        confirm: true,
        pin: false,
      },
      {
        id: standing.constraintB,
        kind: "constraint",
        ws: workspaceB,
        chatId: "chat-WS",
        scope: "global",
        confirm: true,
        pin: false,
      },
      {
        id: standing.decisionA,
        kind: "decision",
        ws: workspaceA,
        chatId: "chat-standing-other",
        scope: "global",
        confirm: true,
        pin: true,
      },
      {
        id: standing.decisionB,
        kind: "decision",
        ws: workspaceB,
        chatId: "chat-standing-other",
        scope: "global",
        confirm: true,
        pin: true,
      },
      {
        id: standing.decisionUnconfirmedA,
        kind: "decision",
        ws: workspaceA,
        chatId: "chat-standing-other",
        scope: "global",
        confirm: false,
        pin: true,
      },
      {
        id: standing.decisionProjectA,
        kind: "decision",
        ws: workspaceA,
        chatId: "chat-WS",
        scope: "project",
        confirm: true,
        pin: true,
      },
      {
        id: standing.decisionStaleA,
        kind: "decision",
        ws: workspaceA,
        chatId: "chat-WS",
        scope: "global",
        confirm: true,
        pin: true,
        staleSince: new Date("2026-07-30T00:00:00.000Z"),
      },
    ];
    for (const row of rows) {
      await db.prisma.memoryNote.create({
        data: {
          id: row.id,
          kind: row.kind,
          text: `standing canon lima-mike (${row.id})`,
          textHash: row.id,
          scope: row.scope,
          trust: "high",
          status: "active",
          createdBy: row.confirm ? "human" : "agent:codex",
          chatId: row.chatId,
          workspacePath: row.ws,
          modules: [],
          topics: [],
          symbols: [],
          staleSince: "staleSince" in row ? row.staleSince : undefined,
        },
      });
      if (row.confirm) {
        await db.prisma.confirmation.create({
          data: { noteId: row.id, principal: "human", decision: "confirm" },
        });
      }
      if (row.pin) {
        await db.prisma.confirmation.create({
          data: { noteId: row.id, principal: "human", decision: "pin" },
        });
      }
    }
    await ledger.projectLedgerToGraph();
  });

  it("agent tier: the arm returns the capability workspace's confirmed canon — both directions", async () => {
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).toContain(standing.constraintA);
    expect(fromA).toContain(standing.conventionA);
    expect(fromA).toContain(standing.decisionA);
    expect(fromA).not.toContain(standing.constraintB);
    expect(fromA).not.toContain(standing.decisionB);
    // The mirror image, so this is a partition and not an A-favouring filter.
    const fromB = await noteIds("/api/memory/recall?standing=true", JOB_B_TOKEN);
    expect(fromB).toContain(standing.constraintB);
    expect(fromB).toContain(standing.decisionB);
    expect(fromB).not.toContain(standing.constraintA);
    expect(fromB).not.toContain(standing.decisionA);
  });

  it("chat-INDEPENDENT: canon confirmed in another chat still arrives (the tier that crosses chats)", async () => {
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).toContain(standing.conventionA);
  });

  it("decision log admits only human-confirmed, pinned, promoted, fresh decisions", async () => {
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).toContain(standing.decisionA);
    // `ids.inA` is human-confirmed, active, repo A — but not curated by pin.
    expect(fromA).not.toContain(ids.inA);
    expect(fromA).not.toContain(standing.decisionUnconfirmedA);
    expect(fromA).not.toContain(standing.decisionProjectA);
    expect(fromA).not.toContain(standing.decisionStaleA);
  });

  it("HUMAN-confirmed only: an unconfirmed constraint never rides, whatever the crew posture says", async () => {
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).not.toContain(standing.unconfirmedA);
  });

  it("PROMOTED-GLOBAL only: a confirmed but project-scope constraint stays chat-bound (the reused cross-chat rule)", async () => {
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).not.toContain(standing.projectA);
    // The promoted-global sibling in the same workspace still rides, so the
    // exclusion is the scope rule and not a collapsed arm.
    expect(fromA).toContain(standing.constraintA);
  });

  it("operator naming a workspace reads that repo's canon", async () => {
    const named = await noteIds(
      `/api/memory/recall?standing=true&workspace=${encodeURIComponent(workspaceB)}`,
      OPERATOR
    );
    expect(named).toContain(standing.constraintB);
    expect(named).not.toContain(standing.constraintA);
  });

  it("UN-BLESS: a human rejecting a standing note removes it from the arm on the next read", async () => {
    // The whole reason the route re-gates over the LEDGER's copies: a canon
    // note the human just un-blessed must not keep riding into every brief.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/memory/${standing.constraintA}`,
      headers: { ...auth(OPERATOR), "content-type": "application/json" },
      payload: { confirmed: false },
    });
    expect(patch.statusCode).toBe(200);
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).not.toContain(standing.constraintA);
    // The rest of the canon is untouched — the removal is the reject, not a
    // collapsed arm.
    expect(fromA).toContain(standing.conventionA);
  });

  it("UNPIN: the append-only curation verdict removes a decision on the next cold start", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/memory/${standing.decisionA}`,
      headers: { ...auth(OPERATOR), "content-type": "application/json" },
      payload: { pinned: false },
    });
    expect(patch.statusCode).toBe(200);
    const fromA = await noteIds("/api/memory/recall?standing=true", JOB_A_TOKEN);
    expect(fromA).not.toContain(standing.decisionA);
    expect(fromA).toContain(standing.conventionA);
  });
});
