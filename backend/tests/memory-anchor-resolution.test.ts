import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// D1 (docs/design/memory-index-decisions.md §D1, option B) — the WRITE path, with
// real SQLite, the real HTTP routes, real git repositories and a real
// `git ls-files`. Nothing is stubbed.
//
// Three properties, and the third is the one this whole design is built around:
//
//   1. RESOLUTION HAPPENS AT INGEST, against the TRACKED-FILE SET of the note's
//      workspace (ADR-0026's partition, which is what a coordinate resolves
//      AGAINST), never against the filesystem.
//   2. FOUR STATES, and `unresolved` is never written when the tracked set could
//      not be read. Collapsing NULL into `unresolved` would assert a fact about a
//      repository we never opened.
//   3. THE WRITE NEVER FAILS. Not for a mistyped path, not for a non-repo
//      workspace, not for a missing `git`. "A gate that refuses to remember a fact
//      because a path was mistyped is worse than one that remembers it weakly."
//
// D1 changes NO READ behaviour, so there is deliberately no read assertion here.

const OPERATOR = "operator-token-anchor-res";
const AGENT = "agent-token-anchor-res";
const JOB_REPO_TOKEN = `job-arr-${"r".repeat(56)}`;
const JOB_WORKTREE_TOKEN = `job-arw-${"w".repeat(56)}`;
const JOB_PLAIN_TOKEN = `job-arp-${"p".repeat(56)}`;
const JOB_NOWS_TOKEN = `job-arn-${"n".repeat(56)}`;

/** Committed in `repoA` before the app boots. */
const TRACKED = "src/pay/charge.ts";
const TRACKED_CASE_VARIANT = "src/pay/Charge.ts";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let repoA: string;
let worktreeInA: string;
let plainB: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let resolution: typeof import("../src/lib/anchor-resolution.js");
let app: FastifyInstance;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "muon",
      GIT_AUTHOR_EMAIL: "muon@example.invalid",
      GIT_COMMITTER_NAME: "muon",
      GIT_COMMITTER_EMAIL: "muon@example.invalid",
    },
  });
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-anchor-write-")));
  repoA = path.join(dir, "repo-a");
  // The exact shape `execute.ts` hands a worker under an editing harness.
  worktreeInA = path.join(repoA, ".muon", "worktrees", "task-worktree");
  plainB = path.join(dir, "plain-b");
  mkdirSync(path.join(repoA, "src", "pay"), { recursive: true });
  mkdirSync(worktreeInA, { recursive: true });
  mkdirSync(plainB, { recursive: true });

  git(repoA, "init", "--initial-branch=main");
  writeFileSync(path.join(repoA, TRACKED), "export const charge = 1;\n");
  writeFileSync(path.join(repoA, "README.md"), "repo a\n");
  git(repoA, "add", TRACKED, "README.md");
  git(repoA, "commit", "-m", "init");

  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_GRAPH_DISABLE_FTS = "1";
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;

  db = await import("../src/lib/db.js");
  ledger = await import("../src/lib/memory-ledger.js");
  graphLib = await import("../src/lib/graph.js");
  resolution = await import("../src/lib/anchor-resolution.js");
  await db.ensureSchema();

  const job = (
    id: string,
    taskId: string,
    chatId: string,
    workspacePath?: string
  ) => ({
    id,
    kind: "oneshot",
    vendor: "codex",
    taskId,
    chatId,
    brief: `${id} anchor resolution job`,
    status: "running",
    dispatchedBy: "human",
    ...(workspacePath ? { workspacePath } : {}),
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      job("job-arr-repo", "task-arr-repo", "chat-ARR-REPO", repoA),
      job("job-arr-worktree", "task-arr-worktree", "chat-ARR-WT", worktreeInA),
      job("job-arr-plain", "task-arr-plain", "chat-ARR-PLAIN", plainB),
      job("job-arr-none", "task-arr-none", "chat-ARR-NONE"),
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-arr-repo", JOB_REPO_TOKEN],
      ["job-arr-worktree", JOB_WORKTREE_TOKEN],
      ["job-arr-plain", JOB_PLAIN_TOKEN],
      ["job-arr-none", JOB_NOWS_TOKEN],
    ].map(([jobId, token]) => ({
      jobId: jobId!,
      tokenHash: createHash("sha256").update(token!).digest("hex"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  // Every ingest here mirrors to the graph on a FIRE-AND-FORGET chain, and D1
  // asserts nothing about the mirror, so those chains are all still queued when
  // this file ends. Drain them before closing the store — otherwise teardown logs
  // one "graph mirror failed: Connection is closed" per write, which is noise that
  // would hide a real mirror failure the next time one happens.
  await graphLib?.awaitGraphMirrors();
  await graphLib?.closeGraph();
  await db.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function postNote(
  token: string,
  body: Record<string, unknown>
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/memory",
    headers: auth(token),
    payload: { createdBy: "human", ...body },
  });
  // THE WRITE NEVER FAILS: every single call in this file asserts 201, including
  // the mistyped paths, the non-repo workspace and the missing-`git` run.
  expect(response.statusCode).toBe(201);
  return response.json().note.id as string;
}

/** `{ "<kind>:<value>": resolution }` for one note — the shape that makes a wrong
 *  answer readable in a diff instead of an index into an array. */
async function anchorsOf(noteId: string): Promise<Record<string, string | null>> {
  const rows = await db.prisma.memoryAnchor.findMany({
    where: { noteId },
    select: { kind: true, value: true, resolution: true },
    orderBy: [{ kind: "asc" }, { value: "asc" }],
  });
  return Object.fromEntries(
    rows.map((row) => [`${row.kind}:${row.value}`, row.resolution])
  );
}

describe("D1 write path: the four states, on real anchor rows", () => {
  it("RESOLVED: a tracked path in the job's own repository", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Charges settle in minor units whiskey-tango",
      modules: [TRACKED],
    });
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED}`]: "resolved",
    });
  });

  it("UNRESOLVED: a case-variant and a typo, with the tracked set in hand", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "constraint",
      text: "Refund windows are ninety days xray-quebec",
      modules: [TRACKED_CASE_VARIANT, "src/pya/charge.ts"],
    });
    // The APFS hazard, live: the filesystem ACCEPTS the wrong-case path, so a
    // `stat()`-based resolver would have stored a second, forked anchor string that
    // `preEditContext`'s exact-string membership test then misses.
    expect(existsSync(path.join(repoA, TRACKED_CASE_VARIANT))).toBe(
      process.platform === "darwin"
    );
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED_CASE_VARIANT}`]: "unresolved",
      "module:src/pya/charge.ts": "unresolved",
    });
  });

  it("PLANNED: an explicit declaration, and the undeclared sibling stays unresolved", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "convention",
      text: "The new settlement module owns idempotency yankee-romeo",
      modules: ["src/pay/settle.ts", "src/pay/typo.ts"],
      plannedCoordinates: ["src/pay/settle.ts"],
    });
    expect(await anchorsOf(id)).toMatchObject({
      "module:src/pay/settle.ts": "planned",
      // A TYPO can never silently become "planned" — that is the entire reason the
      // declaration is explicit and per-coordinate.
      "module:src/pay/typo.ts": "unresolved",
    });
  });

  it("NULL because UNKNOWABLE: a non-git workspace, a job with no workspace, and an operator write", async () => {
    const nonGit = await postNote(JOB_PLAIN_TOKEN, {
      kind: "attempt",
      text: "A workspace that is not a git repository zulu-mike",
      modules: [TRACKED, "src/anything.ts"],
    });
    // NOT `unresolved`. We never opened a repository, so we have nothing to assert.
    expect(await anchorsOf(nonGit)).toMatchObject({
      [`module:${TRACKED}`]: null,
      "module:src/anything.ts": null,
    });

    const noWorkspace = await postNote(JOB_NOWS_TOKEN, {
      kind: "attempt",
      text: "A job with no bound workspace alpha-victor",
      modules: [TRACKED],
    });
    expect(await anchorsOf(noWorkspace)).toMatchObject({
      [`module:${TRACKED}`]: null,
    });

    // An operator write has no DERIVED workspace at all (ADR-0026 §8 residue), so
    // the human's own writes land NULL today. That is a consequence of ADR-0026's
    // rollout, not of D1, and it is the honest answer while it holds.
    const operator = await postNote(OPERATOR, {
      kind: "decision",
      text: "An operator write has no derived workspace bravo-whisky",
      modules: [TRACKED],
    });
    expect(await anchorsOf(operator)).toMatchObject({
      [`module:${TRACKED}`]: null,
    });
  });

  it("NULL: a `planned` declaration still lands on a workspace with no tracked set", async () => {
    const id = await postNote(JOB_PLAIN_TOKEN, {
      kind: "convention",
      text: "A planned file in a non-git workspace charlie-xray",
      modules: ["src/future.ts", "src/other.ts"],
      plannedCoordinates: ["src/future.ts"],
    });
    // `resolved`/`unresolved` are OUR observations and need the set; `planned` is
    // the CALLER's claim and needs nothing. Dropping it here would leave the enum
    // member with no producer at all on a non-git workspace — and the founder's own
    // machine has one.
    expect(await anchorsOf(id)).toMatchObject({
      "module:src/future.ts": "planned",
      "module:src/other.ts": null,
    });
  });

  it("REALITY WINS over the declaration", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Declaring a file that already exists delta-uniform",
      modules: [TRACKED],
      plannedCoordinates: [TRACKED],
    });
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED}`]: "resolved",
    });
  });
});

describe("D1 write path: what is NOT a coordinate", () => {
  it("task, lane, chat, workspace and topic anchors are NULL by construction", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Non-coordinate anchors carry no resolution echo-sierra",
      modules: [TRACKED],
      topics: ["payments"],
      laneId: "lane-arr",
    });
    const anchors = await anchorsOf(id);
    // A taskId is not a path, and neither is a chat id, a lane key, a topic or the
    // absolute workspace root a coordinate resolves AGAINST. Each is NULL because
    // it is not a coordinate — not because we failed to resolve it.
    expect(anchors["task:task-arr-repo"]).toBeNull();
    expect(anchors["chat:chat-ARR-REPO"]).toBeNull();
    expect(anchors["lane:lane-arr"]).toBeNull();
    expect(anchors["topic:payments"]).toBeNull();
    expect(anchors[`workspace:${repoA}`]).toBeNull();
    // ...while the coordinate beside them did resolve, so this is not vacuous.
    expect(anchors[`module:${TRACKED}`]).toBe("resolved");
  });
});

describe("D1 write path: symbols resolve by their MODULE PREFIX only", () => {
  it("resolves a symbol from its module, and gives the AUTO-DERIVED module the same answer", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Symbol anchors ride the module prefix foxtrot-november",
      symbols: [`${TRACKED}#charge`, "src/ghost.ts#vanish"],
    });
    expect(await anchorsOf(id)).toMatchObject({
      [`symbol:${TRACKED}#charge`]: "resolved",
      // ADR-0012's degrade guarantee mints this module anchor from the symbol id;
      // it must not disagree with the symbol it came from.
      [`module:${TRACKED}`]: "resolved",
      "symbol:src/ghost.ts#vanish": "unresolved",
      "module:src/ghost.ts": "unresolved",
    });
  });

  it("cannot catch the measured junk id, because that is D2's problem", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "A file basename used as a symbol name golf-oscar",
      symbols: ["README.md#README.md"],
    });
    // Three of the six live `Symbol` ids on the founder's brain are exactly this
    // shape, and their module prefix IS tracked — so they resolve. Validating the
    // NAME half needs the code index, which §D1 rejected as the identity resolver.
    // Pinned so a green suite is never read as "the junk is gone".
    expect(await anchorsOf(id)).toMatchObject({
      "symbol:README.md#README.md": "resolved",
      "module:README.md": "resolved",
    });
  });

  it("declaring the SYMBOL declares its file, so the derived module agrees", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "convention",
      text: "A planned symbol in a planned file hotel-papa",
      symbols: ["src/pay/plan.ts#build"],
      plannedCoordinates: ["src/pay/plan.ts#build"],
    });
    expect(await anchorsOf(id)).toMatchObject({
      "symbol:src/pay/plan.ts#build": "planned",
      "module:src/pay/plan.ts": "planned",
    });
  });
});

describe("D1 write path: the workspace a coordinate resolves against", () => {
  it("WORKTREE: a job executing in .muon/worktrees/<taskId> resolves against the PARENT repo", async () => {
    // ADR-0026 §4: without `repoRootOf` this write would resolve against a
    // directory that has no git index of its own, so every coordinate on the most
    // common code path would land NULL.
    const id = await postNote(JOB_WORKTREE_TOKEN, {
      kind: "decision",
      text: "A worktree job resolves against the parent repository india-quebec",
      modules: [TRACKED],
    });
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED}`]: "resolved",
    });
  });

  it("a path tracked in ANOTHER repository is unresolved here", async () => {
    const otherRepo = path.join(dir, "other-repo");
    mkdirSync(path.join(otherRepo, "elsewhere"), { recursive: true });
    git(otherRepo, "init", "--initial-branch=main");
    writeFileSync(path.join(otherRepo, "elsewhere", "only.ts"), "export {};\n");
    git(otherRepo, "add", "elsewhere/only.ts");
    git(otherRepo, "commit", "-m", "init");

    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Another repository's path is not this one's juliet-tango",
      modules: ["elsewhere/only.ts"],
    });
    // The distinction D15 needs: this is an ASSERTION (we held repo A's set), not a
    // NULL. 37 of the 60 live path-shaped entity keys are another repo's paths.
    expect(await anchorsOf(id)).toMatchObject({
      "module:elsewhere/only.ts": "unresolved",
    });
  });
});

describe("D1 write path: the write NEVER fails", () => {
  it("lands the note, active and intact, when `git` is not on PATH", async () => {
    resolution.clearTrackedFileCache();
    const previousPath = process.env.PATH;
    process.env.PATH = path.join(dir, "no-binaries-here");
    let id: string;
    try {
      id = await postNote(JOB_REPO_TOKEN, {
        kind: "decision",
        text: "A brain with no git still remembers kilo-uniform",
        modules: [TRACKED],
      });
    } finally {
      process.env.PATH = previousPath;
      resolution.clearTrackedFileCache();
    }
    const row = await db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("active");
    expect(row.modules).toEqual([TRACKED]);
    // Unknowable, so NULL — never `unresolved`, and never a refused write.
    expect(await anchorsOf(id)).toMatchObject({ [`module:${TRACKED}`]: null });
  });

  it("keeps a note whose ONLY anchor is a mistyped path fully active and anchored", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "constraint",
      text: "A mistyped path must not cost us the fact lima-victor",
      modules: ["src/pay/chrage.ts"],
    });
    const row = await db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("active");
    // The anchor ROW still exists, so the note stays reachable by module recall and
    // by text exactly as before D1. `unresolved` is a label, not a filter — nothing
    // reads this column yet (that is D15 and D4+D6).
    expect(await anchorsOf(id)).toMatchObject({
      "module:src/pay/chrage.ts": "unresolved",
    });
  });

  it("REJECTS an unbounded declaration at the boundary rather than storing it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: auth(JOB_REPO_TOKEN),
      payload: {
        createdBy: "human",
        kind: "decision",
        text: "An unbounded declaration mike-yankee",
        modules: [TRACKED],
        plannedCoordinates: Array.from({ length: 129 }, (_, i) => `src/f${i}.ts`),
      },
    });
    // Every array on this surface is bounded, and a new one that is not is how the
    // next hole opens. 400 at the schema, not a 129-entry declaration in the ledger.
    expect(response.statusCode).toBe(400);
  });
});

describe("D1 write path: a clone and a text-edit successor", () => {
  it("both RE-RESOLVE, and both inherit the source's `planned` declaration", async () => {
    const sourceId = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "Settlement retries are capped at five november-zulu",
      modules: ["src/pay/retry.ts", TRACKED],
      plannedCoordinates: ["src/pay/retry.ts"],
    });
    expect(await anchorsOf(sourceId)).toMatchObject({
      "module:src/pay/retry.ts": "planned",
      [`module:${TRACKED}`]: "resolved",
    });

    const cloned = await ledger.cloneMemoryNote(sourceId, {
      tier: "operator",
      principal: "human",
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status === "cloned") {
      // Inherited, not re-derived as `unresolved`: a clone is how an agent
      // re-anchors a fact, and turning the caller's claim into our assertion would
      // silently discard it.
      expect(await anchorsOf(cloned.note.id)).toMatchObject({
        "module:src/pay/retry.ts": "planned",
        [`module:${TRACKED}`]: "resolved",
      });
    }

    const edited = await ledger.updateMemoryNote(sourceId, {
      text: "Settlement retries are capped at six november-zulu",
    });
    expect(edited).not.toBeNull();
    expect(await anchorsOf(edited!.id)).toMatchObject({
      "module:src/pay/retry.ts": "planned",
      [`module:${TRACKED}`]: "resolved",
    });
  });

  it("a successor sees a file COMMITTED since the predecessor was written", async () => {
    const sourceId = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: "The capture module will own extraction oscar-alpha",
      modules: ["src/pay/capture.ts"],
    });
    expect(await anchorsOf(sourceId)).toMatchObject({
      "module:src/pay/capture.ts": "unresolved",
    });

    writeFileSync(path.join(repoA, "src", "pay", "capture.ts"), "export {};\n");
    git(repoA, "add", "src/pay/capture.ts");
    resolution.clearTrackedFileCache();

    const edited = await ledger.updateMemoryNote(sourceId, {
      text: "The capture module owns extraction oscar-alpha",
    });
    // RE-resolved, not copied. This is why the successor takes a fresh resolver
    // rather than the predecessor's labels.
    expect(await anchorsOf(edited!.id)).toMatchObject({
      "module:src/pay/capture.ts": "resolved",
    });
  });
});

describe("D1 write path: the entry points that deliberately do NOT resolve", () => {
  it("a direct ledger ingest with no workspace resolves nothing — the pack-import shape", async () => {
    // No workspace on the input → no tracked set → every coordinate lands NULL,
    // never `unresolved`, which would assert a fact we do not hold.
    //
    // ADR-0026 §7 step 5 has since landed, so `importMemoryPack` stamps the
    // RECEIVING workspace when the route names one and its coordinates then DO
    // resolve — against this partition's tracked set, which is the set we hold.
    // This case is the shape that remains: an import (or any caller) that names no
    // workspace at all.
    const result = await ledger.ingestMemoryNote({
      kind: "decision",
      text: "An imported claim about a foreign repository papa-bravo",
      createdBy: "pack:ws-deadbeefdeadbeef",
      modules: [TRACKED, "vendor/only/there.ts"],
      trust: "low",
      proposalOnly: true,
    });
    expect(await anchorsOf(result.note.id)).toMatchObject({
      [`module:${TRACKED}`]: null,
      "module:vendor/only/there.ts": null,
    });
  });
});
