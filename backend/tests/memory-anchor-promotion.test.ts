import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

// D15 (docs/design/memory-index-decisions.md §D15, option B) — the WRITE path and
// the one-shot backfill, with real SQLite, the real HTTP route, real git and a real
// `git ls-files`. Nothing is stubbed.
//
// Four properties:
//
//   1. A note that names a TRACKED file in its prose and supplies NO `modules` comes
//      out module-ANCHORED — in the tracked spelling, labelled `resolved`, and with
//      the note's `modules` scalar carrying the same value (the mirror projects
//      `n.modules` and `ANCHORED_TO` from the scalar, so an anchor row without it is
//      an anchor no read path can see).
//   2. A path that does NOT resolve is not promoted, no matter how path-shaped.
//   3. DEDUP IS UNTOUCHED. Two notes that merely quote the same file are not each
//      other's duplicates — a supersede is destructive, and D15 is a decision about
//      the coordinate layer.
//   4. The BACKFILL is dry-run by default, orphans-only, idempotent, and it only
//      ever ADDS.

const OPERATOR = "operator-token-anchor-promo";
const AGENT = "agent-token-anchor-promo";
const JOB_REPO_TOKEN = `job-apr-${"r".repeat(56)}`;
const JOB_PLAIN_TOKEN = `job-app-${"p".repeat(56)}`;

/** Committed in `repoA` before the app boots. Mixed case on purpose. */
const TRACKED = "src/pay/Charge.ts";
const TRACKED_LOWER = "src/pay/charge.ts";
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let dir: string;
let repoA: string;
let plainB: string;
let db: typeof import("../src/lib/db.js");
let ledger: typeof import("../src/lib/memory-ledger.js");
let graphLib: typeof import("../src/lib/graph.js");
let resolution: typeof import("../src/lib/anchor-resolution.js");
let backfill: typeof import("../src/lib/memory-anchor-backfill.js");
let preedit: typeof import("../src/lib/preedit.js");
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
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "muon-anchor-promo-write-")));
  repoA = path.join(dir, "repo-a");
  plainB = path.join(dir, "plain-b");
  mkdirSync(path.join(repoA, "src", "pay"), { recursive: true });
  mkdirSync(plainB, { recursive: true });

  git(repoA, "init", "--initial-branch=main");
  writeFileSync(path.join(repoA, TRACKED), "export const charge = 1;\n");
  writeFileSync(path.join(repoA, "src", "pay", "Settle.ts"), "export {};\n");
  git(repoA, "add", TRACKED, "src/pay/Settle.ts");
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
  backfill = await import("../src/lib/memory-anchor-backfill.js");
  preedit = await import("../src/lib/preedit.js");
  await db.ensureSchema();

  const job = (
    id: string,
    taskId: string,
    chatId: string,
    workspacePath: string
  ) => ({
    id,
    kind: "oneshot",
    vendor: "codex",
    taskId,
    chatId,
    brief: `${id} anchor promotion job`,
    status: "running",
    dispatchedBy: "human",
    workspacePath,
  });
  await db.prisma.dispatchJob.createMany({
    data: [
      job("job-apr-repo", "task-apr-repo", "chat-APR-REPO", repoA),
      job("job-apr-plain", "task-apr-plain", "chat-APR-PLAIN", plainB),
    ],
  });
  await db.prisma.delegationGrant.createMany({
    data: [
      ["job-apr-repo", JOB_REPO_TOKEN],
      ["job-apr-plain", JOB_PLAIN_TOKEN],
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
  expect(response.statusCode).toBe(201);
  return response.json().note.id as string;
}

/** `{ "<kind>:<value>": resolution }` for one note. */
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

const modulesOf = async (noteId: string): Promise<string[]> => {
  const row = await db.prisma.memoryNote.findUniqueOrThrow({
    where: { id: noteId },
    select: { modules: true },
  });
  return Array.isArray(row.modules) ? row.modules.map(String) : [];
};

describe("D15 write path: prose becomes a coordinate", () => {
  it("anchors a note that supplied NO modules, in the TRACKED spelling", async () => {
    // The measured orphan shape: prose names the file (in the wrong case, as the
    // entity namespace would key it) and the caller supplies nothing.
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: `Settlement retries are capped at five, see ${TRACKED_LOWER} whiskey-tango`,
    });
    expect(await modulesOf(id)).toEqual([TRACKED]);
    expect(await anchorsOf(id)).toMatchObject({
      // Not `module:src/pay/charge.ts`. The forked spelling is the failure mode.
      [`module:${TRACKED}`]: "resolved",
    });
  });

  it("UNIONS with the caller's own modules rather than replacing them", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "convention",
      text: `The settle path is ${TRACKED_LOWER} xray-quebec`,
      modules: ["src/pay/Settle.ts"],
    });
    expect((await modulesOf(id)).sort()).toEqual(
      [TRACKED, "src/pay/Settle.ts"].sort()
    );
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED}`]: "resolved",
      "module:src/pay/Settle.ts": "resolved",
    });
  });

  it("does NOT rewrite a caller's own mis-cased module — it adds the resolvable one beside it", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: `The charge module owns idempotency, ${TRACKED} india-quebec`,
      // The caller typed the file the way the ENTITY namespace would key it.
      modules: [TRACKED_LOWER],
    });
    // Two anchors for one file, and that is deliberate: D15 promotes from PROSE and
    // never edits a coordinate the caller supplied. So the caller's value keeps D1's
    // honest `unresolved` label and the promoted one is `resolved` beside it — which
    // is what lets the gate find this note at all. REPAIRING a caller's spelling is a
    // different decision (D9, rename/case repair) and it is not this one.
    expect(await anchorsOf(id)).toMatchObject({
      [`module:${TRACKED}`]: "resolved",
      [`module:${TRACKED_LOWER}`]: "unresolved",
    });
  });

  it("promotes NOTHING it cannot resolve — a typo, another repo's path, no tracked set", async () => {
    const typo = await postNote(JOB_REPO_TOKEN, {
      kind: "attempt",
      text: "The cap lives in src/pay/chrage.ts and in vendor/only/there.ts yankee-romeo",
    });
    expect(await modulesOf(typo)).toEqual([]);
    expect(await anchorsOf(typo)).not.toHaveProperty("module:src/pay/chrage.ts");

    // A non-git workspace: we hold no tracked set, so we make no claim. This is D1's
    // NULL state, and it is why promotion can never be a guess.
    const nonGit = await postNote(JOB_PLAIN_TOKEN, {
      kind: "attempt",
      text: `Even a real path like ${TRACKED} promotes nothing here zulu-mike`,
    });
    expect(await modulesOf(nonGit)).toEqual([]);
  });

  it("a CLONE and a text-edit SUCCESSOR promote from their own text too", async () => {
    const sourceId = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: `Charge capture is idempotent, see ${TRACKED_LOWER} november-zulu`,
    });
    expect(await modulesOf(sourceId)).toEqual([TRACKED]);

    const cloned = await ledger.cloneMemoryNote(sourceId, {
      tier: "operator",
      principal: "human",
    });
    expect(cloned.status).toBe("cloned");
    if (cloned.status === "cloned") {
      expect(await modulesOf(cloned.note.id)).toEqual([TRACKED]);
    }

    // A successor's text is NEW text, so it is promoted from that text — and the
    // PREDECESSOR's promoted coordinates are subtracted first (`successorModules`).
    // This assertion used to read `[TRACKED, "src/pay/Settle.ts"]` and pinned the
    // opposite: the successor inherited the predecessor's scalar verbatim, which
    // ALREADY contained the promoted coordinate, so the set was monotone and an
    // edit that stopped naming a file kept its anchor for ever. That is a real
    // defect, not a taste: the note then surfaces in the pre-edit gate for a file
    // its text does not mention, and `anchorScopedCandidates` can find it through
    // the stale anchor and let a later ingest SUPERSEDE it — a destructive write
    // widened by a coordinate the note no longer carries.
    const edited = await ledger.updateMemoryNote(sourceId, {
      text: "Charge capture is idempotent, see src/pay/Settle.ts november-zulu",
    });
    expect(edited).not.toBeNull();
    expect(await modulesOf(edited!.id)).toEqual(["src/pay/Settle.ts"]);
    // The anchor ROW follows the scalar — the mirror projects `ANCHORED_TO` from
    // it, so a stale scalar is a stale read path, not just a stale column.
    expect(Object.keys(await anchorsOf(edited!.id))).not.toContain(
      `module:${TRACKED}`
    );
  });

  it("a SUCCESSOR keeps what the CALLER supplied, and only un-anchors what the predecessor's PROSE promoted", async () => {
    // The subtraction is the predecessor's PROMOTED set, never its whole scalar.
    // `src/pay/Settle.ts` here is caller-supplied and never appears in either text,
    // so no version of the promotion pass can mint it and no version may remove it.
    // Without that narrowing, a typo fix would silently un-anchor every coordinate
    // a human or an agent had deliberately attached to the note.
    const sourceId = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: `Refunds settle nightly, see ${TRACKED_LOWER} oscar-tango`,
      modules: ["src/pay/Settle.ts"],
    });
    expect((await modulesOf(sourceId)).sort()).toEqual(
      ["src/pay/Settle.ts", TRACKED].sort()
    );

    const edited = await ledger.updateMemoryNote(sourceId, {
      text: "Refunds settle nightly oscar-tango",
    });
    expect(edited).not.toBeNull();
    // The promoted one is gone (the new text names no file); the caller's stays.
    expect(await modulesOf(edited!.id)).toEqual(["src/pay/Settle.ts"]);

    // And it is not one-way: editing the text to name the file again re-promotes it,
    // because promotion is a pure function of (text, tracked set) and is re-run on
    // every write rather than inherited.
    const readded = await ledger.updateMemoryNote(edited!.id, {
      text: `Refunds settle nightly, see ${TRACKED_LOWER} oscar-tango again`,
    });
    expect(readded).not.toBeNull();
    expect((await modulesOf(readded!.id)).sort()).toEqual(
      ["src/pay/Settle.ts", TRACKED].sort()
    );
  });

  it("a NULL tracked set SUBTRACTS nothing — an unreadable repo can never strip a coordinate", async () => {
    // `plainB` is not a git repository, so `trackedFileSet` is NULL and
    // `promoteResolvedPathEntities` promotes nothing. The subtraction must then be
    // a no-op: a workspace we could not read must never be able to take a
    // coordinate away, only to decline to add one. This is the same
    // degrade-to-null direction D1's rule 2 states for the write itself.
    const sourceId = await postNote(JOB_PLAIN_TOKEN, {
      kind: "decision",
      text: `Nothing resolves here, see ${TRACKED_LOWER} papa-uniform`,
      modules: ["src/pay/Settle.ts"],
    });
    expect(await modulesOf(sourceId)).toEqual(["src/pay/Settle.ts"]);

    const edited = await ledger.updateMemoryNote(sourceId, {
      text: "Nothing resolves here papa-uniform",
    });
    expect(edited).not.toBeNull();
    expect(await modulesOf(edited!.id)).toEqual(["src/pay/Settle.ts"]);
  });

  it("the DEDUP decision is untouched: two notes quoting one file are not duplicates", async () => {
    // The hazard this pins. `sharesAnchor` (packages/graph, `classifyIncomingNote`)
    // is task-OR-module-OR-topic, and these two notes come from DIFFERENT tasks in
    // the SAME chat with no caller modules and no topics — so today they share no
    // anchor and are never compared. Their texts differ by ONE token out of twelve
    // (jaccard ≈ 0.9, over the 0.82 duplicate threshold and far over the 0.5
    // supersede threshold), so if a promoted coordinate entered the classifier's
    // module set the second write would NOOP into the first or RETIRE it.
    //
    // Promotion therefore feeds the anchor ROWS and the note's scalar, and never
    // `classifyIncomingNote`. Measured while writing this: widening only
    // `anchorScopedCandidates` changes nothing (the classifier re-applies
    // `sharesAnchor`), so the classifier's own input is the decisive surface.
    //
    // Ingested through the LEDGER rather than the route because `DispatchJob.chatId`
    // is unique — one job per chat — so two same-chat-different-task writes are not
    // constructible through two job tokens.
    const shared = {
      kind: "constraint" as const,
      createdBy: "agent:codex",
      chatId: "chat-APR-DEDUP",
      workspacePath: repoA,
    };
    const one = await ledger.ingestMemoryNote({
      ...shared,
      taskId: "task-apr-dedup-1",
      text: `Refund windows stay ninety days for every settled charge, see ${TRACKED_LOWER} alpha`,
    });
    const two = await ledger.ingestMemoryNote({
      ...shared,
      taskId: "task-apr-dedup-2",
      text: `Refund windows stay ninety days for every settled capture, see ${TRACKED_LOWER} alpha`,
    });
    // The verdict is the assertion: widening the classifier's module set turns this
    // into `duplicate` (the second write is dropped) or `superseded` (the first note
    // is RETIRED).
    expect(one.action).toBe("inserted");
    expect(two.action).toBe("inserted");
    const first = one.note.id;
    const second = two.note.id;
    // Both promoted the SAME coordinate — so the anchor overlap the classifier was
    // NOT shown is real, and this test is not vacuous.
    expect(await modulesOf(first)).toEqual([TRACKED]);
    expect(await modulesOf(second)).toEqual([TRACKED]);
    expect(second).not.toBe(first);
    for (const id of [first, second]) {
      const row = await db.prisma.memoryNote.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("active");
      expect(row.supersededBy).toBeNull();
    }
    // And no contradiction/related edge was minted between them either.
    expect(
      await db.prisma.memoryEdge.count({
        where: { OR: [{ fromId: second, toId: first }, { fromId: first, toId: second }] },
      })
    ).toBe(0);
  });

  it("the promoted anchor reaches the GATE: preEditContext surfaces it", async () => {
    const id = await postNote(JOB_REPO_TOKEN, {
      kind: "decision",
      text: `Charges settle in minor units, ${TRACKED_LOWER} charlie-xray`,
    });
    // DRAIN THE INGEST MIRROR BEFORE CONFIRMING, and this is not ceremony: the
    // ingest's projection chain and the confirm's are two unawaited chains that both
    // `projectMemoryNote` the same id, so under load the ingest chain can land LAST
    // and write its own `confirmed: false` snapshot over the confirm's — the mirror
    // then hides a confirmed note from the confirmed-only gate until the next boot
    // reproject. Measured here: 3 failures in ~20 runs of this file alongside two
    // others before this line existed. That race is PRE-EXISTING and belongs to the
    // mirror's write ordering (`graph.ts` / `updateMemoryNote`), not to D15 — it is
    // reported, not fixed here, and this drain keeps the test measuring D15.
    await graphLib.awaitGraphMirrors();
    // Human confirmation, because the gate is confirmed-only (KG-6).
    await ledger.updateMemoryNote(id, { confirmed: true, principal: "human" });
    await graphLib.awaitGraphMirrors();

    // The three preconditions the gate composes, asserted separately so a failure
    // says WHICH link broke: promotion (the ledger), the mirror's copy of it, and
    // the human confirmation the confirmed-only gate keys on.
    expect(await modulesOf(id)).toEqual([TRACKED]);
    const mirrored = await graphLib.getGraph().getMemoryNote(id);
    expect(mirrored?.modules).toEqual([TRACKED]);
    expect(mirrored?.confirmed).toBe(true);

    const found = await preedit.preEditContext(
      graphLib.getGraph(),
      { module: TRACKED },
      { workspacePath: repoA }
    );
    // §0's number is "the flagship dual-graph query returns nothing". This is the
    // whole point of D15: a note that never named a coordinate now answers it.
    expect(found.memories.map((memory) => memory.id)).toContain(id);
  });
});

describe("D15 backfill: dry run, then apply", () => {
  /** An ORPHAN written the pre-D15 way: the ledger row and its anchors are inserted
   *  directly, so no promotion runs. This is what the 62 measured notes look like. */
  async function orphan(
    id: string,
    text: string,
    workspacePath: string | null
  ): Promise<string> {
    await db.prisma.memoryNote.create({
      data: {
        id,
        kind: "decision",
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
        scope: "project",
        trust: "medium",
        createdBy: "agent:codex",
        chatId: "chat-APR-REPO",
        workspacePath,
        modules: [],
        topics: [],
        symbols: [],
        episodeId: null,
        recordedAt: new Date(),
        validFrom: new Date(),
      },
    });
    return id;
  }

  let anchorable: string;
  let unresolvable: string;
  let noWorkspace: string;

  beforeAll(async () => {
    resolution.clearTrackedFileCache();
    anchorable = await orphan(
      "mem-orphan-anchorable",
      `A pre-D15 note naming ${TRACKED_LOWER} in prose only`,
      repoA
    );
    unresolvable = await orphan(
      "mem-orphan-unresolvable",
      "A pre-D15 note naming vendor/not/here.ts in prose only",
      repoA
    );
    noWorkspace = await orphan(
      "mem-orphan-no-workspace",
      `A residue note naming ${TRACKED} with no workspace`,
      null
    );
  });

  it("DRY RUN writes nothing and reports what it would write", async () => {
    const plan = await backfill.backfillPromotedModuleAnchors();
    expect(plan.applied).toBe(false);
    expect(plan.notes).toBeGreaterThanOrEqual(1);
    expect(plan.examples).toEqual(
      expect.arrayContaining([{ noteId: anchorable, modules: [TRACKED] }])
    );
    // The two that cannot be anchored are COUNTED, not silently dropped: one held a
    // tracked set and the prose named nothing in it, the other had no set at all.
    // Conflating those would assert a fact about a repository we never opened.
    expect(plan.noResolvablePath).toBeGreaterThanOrEqual(1);
    expect(plan.noWorkspace).toBeGreaterThanOrEqual(1);

    // Nothing written. Not the anchor row, not the scalar.
    expect(await anchorsOf(anchorable)).toEqual({});
    expect(await modulesOf(anchorable)).toEqual([]);
  });

  it("APPLY writes the anchor row, the scalar, and `resolved`", async () => {
    const applied = await backfill.backfillPromotedModuleAnchors({ apply: true });
    expect(applied.applied).toBe(true);
    expect(await anchorsOf(anchorable)).toEqual({
      [`module:${TRACKED}`]: "resolved",
    });
    expect(await modulesOf(anchorable)).toEqual([TRACKED]);
    // Untouched, both of them.
    expect(await anchorsOf(unresolvable)).toEqual({});
    expect(await anchorsOf(noWorkspace)).toEqual({});
  });

  it("is IDEMPOTENT, and the note is no longer an orphan", async () => {
    const again = await backfill.backfillPromotedModuleAnchors({ apply: true });
    // Orphans-only, so an already-anchored note is not even a candidate — the
    // property that makes this safe to re-run and safe to resume.
    expect(again.examples.map((example) => example.noteId)).not.toContain(
      anchorable
    );
    expect(await anchorsOf(anchorable)).toEqual({
      [`module:${TRACKED}`]: "resolved",
    });
    expect(await modulesOf(anchorable)).toEqual([TRACKED]);
  });

  it("only ever ADDS: an existing `modules` entry survives", async () => {
    const id = await orphan(
      "mem-orphan-with-scalar",
      `A note whose scalar already names one file and whose prose names ${TRACKED_LOWER}`,
      repoA
    );
    // A scalar entry with NO anchor row: the asymmetry row 23 exists to watch. The
    // backfill unions rather than replacing, or it would DELETE a coordinate to add
    // one.
    await db.prisma.memoryNote.update({
      where: { id },
      data: { modules: ["src/pay/Settle.ts"] },
    });
    await backfill.backfillPromotedModuleAnchors({ apply: true });
    expect((await modulesOf(id)).sort()).toEqual(
      [TRACKED, "src/pay/Settle.ts"].sort()
    );
    // Only the PROMOTED coordinate gets a row; the backfill does not mint anchors
    // for scalar entries it did not derive.
    expect(await anchorsOf(id)).toEqual({ [`module:${TRACKED}`]: "resolved" });
  });
});
