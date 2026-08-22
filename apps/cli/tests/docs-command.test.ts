import { Command } from "commander";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDocsGraph } from "@muon/docgraph";
import {
  makeRepo,
  seedCorpus,
  type FixtureRepo,
} from "../../../packages/docgraph/tests/fixture-repo.js";
import { registerDocsCommands } from "../src/commands/docs.js";

/**
 * ADR-0053 Phase 2 — `muon docs`, asserted on its OUTPUT.
 *
 * A REAL temp git repository, not a mocked graph: the corpus selector, the
 * known-file set, HEAD and `worktreeDirty` are all `git` answers, and a fake
 * would only pin this command against its own assumptions. It also means the
 * parity assertions below compare two real reads of one real tree.
 *
 * The load-bearing test is PARITY: `--json` must print the payload the MCP tool
 * returns, which is the payload the core assembles, byte for byte. The human
 * rendering is composed FROM that payload, so it cannot describe a field the
 * agent surface does not have — and a defect cannot exist on one surface only.
 */

let repo: FixtureRepo;

beforeAll(() => {
  repo = makeRepo();
  seedCorpus(repo);
});

afterAll(() => {
  repo.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Run `muon docs …` against the fixture repository, capturing both streams. */
async function run(
  argv: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerDocsCommands(program);
  await program.parseAsync(["docs", ...argv, "--workspace", repo.root], {
    from: "user",
  });
  const text = (spy: typeof out) =>
    spy.mock.calls.map((call) => String(call[0])).join("");
  return { stdout: text(out), stderr: text(err), exitCode: process.exitCode };
}

/** The `--json` payload, parsed. */
async function json(argv: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run([...argv, "--json"]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** `builtAt` moves between two reads; every other field must not. */
function stableProvenance(payload: Record<string, unknown>): unknown {
  const provenance = payload.provenance as Record<string, unknown> | undefined;
  if (!provenance) return provenance;
  const { builtAt, ...rest } = provenance;
  expect(builtAt).toEqual(expect.any(String));
  return rest;
}

function comparable(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, provenance: stableProvenance(payload) };
}

describe("`muon docs --json` is the same payload the MCP tools return", () => {
  it("query parity — the CLI re-formats nothing", async () => {
    const fromCli = await json(["query", "the gate lives", "--limit", "3"]);
    const fromCore = (await createDocsGraph(repo.root).query("the gate lives", {
      limit: 3,
    })) as unknown as Record<string, unknown>;
    expect(comparable(fromCli)).toEqual(comparable(fromCore));
    // Not a vacuous comparison of two empties.
    expect((fromCli.results as unknown[]).length).toBeGreaterThan(0);
    expect(fromCli.precedence).toEqual(expect.any(String));
  });

  it("context parity — for a document AND for one section", async () => {
    for (const [target, options] of [
      ["docs/adr/0001-a.md", {}],
      ["docs/adr/0001-a.md#context", { includeText: true }],
    ] as const) {
      const argv = [
        "context",
        target,
        ...("includeText" in options ? ["--text"] : []),
      ];
      const fromCli = await json(argv);
      const fromCore = (await createDocsGraph(repo.root).context(
        target,
        options
      )) as unknown as Record<string, unknown>;
      expect(comparable(fromCli), target).toEqual(comparable(fromCore));
    }
  });

  it("impact parity — including the honest empty", async () => {
    for (const path of ["src/tracked.ts", "src/nothing-cites-me.ts"]) {
      const fromCli = await json(["impact", path]);
      const fromCore = (await createDocsGraph(repo.root).impact(
        path
      )) as unknown as Record<string, unknown>;
      expect(comparable(fromCli), path).toEqual(comparable(fromCore));
    }
    // An empty result is a FACT, not a silence — and it says so.
    const empty = await json(["impact", "src/nothing-cites-me.ts"]);
    expect(empty.citedBy).toEqual([]);
    expect(empty.reason).toBe("no documentation cites this path");
  });

  it("status parity", async () => {
    const fromCli = await json(["status"]);
    const fromCore = (await createDocsGraph(
      repo.root
    ).status()) as unknown as Record<string, unknown>;
    expect(comparable(fromCli)).toEqual(comparable(fromCore));
  });
});

describe("the human rendering is composed from that payload", () => {
  it("query names the section, its tier, its lines and the precedence order", async () => {
    const { stdout, exitCode } = await run(["query", "the gate lives"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("docs/adr/0001-a.md#context");
    // `canon`, not `adr`: docs/README.md's precedence section LINKS this file,
    // and the derived canon set beats the directory rule. That ordering is the
    // whole point of deriving tier from the index instead of transcribing it.
    expect(stdout).toMatch(/canon\/accepted/);
    expect(stdout).toMatch(/lines \d+-\d+/);
    expect(stdout).toContain("precedence:");
  });

  it("a historical-only answer returns, labelled, and raises the degradation", async () => {
    // The fixture's only "zzyzx" match lives in research/. It must come back —
    // a historical-only answer is a real answer — and it must not read as canon.
    const { stdout } = await run(["query", "zzyzx protocol"]);
    expect(stdout).toContain("docs/research/old.md");
    expect(stdout).toContain("HISTORICAL");
    expect(stdout).toContain("degradations:");
    expect(stdout).toContain("historical-only");
  });

  it("context shows each citation's resolution state, and marks the in-flight one", async () => {
    const { stdout } = await run(["context", "README.md#fixture-repository"]);
    // `src/tracked.ts` is committed; `src/uncommitted.ts` exists and has never
    // been `git add`ed. Both are `resolved` — the second is NOT missing — and
    // only `tracked` tells them apart.
    expect(stdout).toContain("src/tracked.ts");
    expect(stdout).toContain("src/uncommitted.ts");
    expect(stdout).toMatch(/resolved\s+src\/uncommitted\.ts \(untracked\)/);
    expect(stdout).not.toMatch(/unresolved\s+src\/uncommitted\.ts/);
  });

  it("an ambiguous citation is never resolved by picking", async () => {
    const { stdout } = await run(["context", "docs/adr/0001-a.md#consequences"]);
    expect(stdout).toMatch(/ambiguous\s+src\/index\.ts/);
    expect(stdout).toContain("never resolved by picking");
    // …and a path that never existed is stated as such, not guessed at.
    expect(stdout).toMatch(/unresolved\s+src\/never-existed\.ts/);
  });

  it("impact reports citations and refuses to call them a verdict", async () => {
    const { stdout } = await run(["impact", "src/tracked.ts"]);
    expect(stdout).toMatch(/is cited by \d+ section\(s\)/);
    expect(stdout).toContain("citations, not a verdict");
  });
});

describe("`muon docs status` is the drift report", () => {
  it("prints provenance, the tier distribution, and the citation histogram", async () => {
    const { stdout, exitCode } = await run(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`repository: ${repo.root}`);
    expect(stdout).toMatch(/commit: [0-9a-f]{7,}/);
    // Derived canon (from docs/README.md's links) plus the root supplement —
    // README.md is canon by convention and docs/testing/walkthrough.md is canon
    // because the index links it, which no directory rule would get right.
    expect(stdout).toMatch(/tiers: canon \d+/);
    expect(stdout).toContain("code citations:");
    expect(stdout).toContain("drift report");
    expect(stdout).toContain("unresolved citations");
    expect(stdout).toContain("src/never-existed.ts");
    expect(stdout).toContain("ambiguous citations");
  });

  it("reports a degraded canon set loudly rather than reclassifying quietly", async () => {
    // Rename the precedence heading: canon collapses to the root supplement and
    // EVERY response must say so. `scripts/check-docs.mjs` is the precedent —
    // a validator that could not validate used to print a friendly SKIP.
    const original = "## Canonical current documents";
    repo.write(
      "docs/README.md",
      [
        "# Fixture documentation index",
        "",
        "## Some other heading",
        "",
        "- [`adr/0001-a.md`](adr/0001-a.md): still linked, no longer canon-declaring.",
        "",
      ].join("\n")
    );
    try {
      const status = await json(["status"]);
      const provenance = status.provenance as { tierSource: string };
      expect(provenance.tierSource).toBe("root-supplement-only");
      const degradation = status.degradation as {
        active: boolean;
        entries: { code: string }[];
      };
      expect(degradation.active).toBe(true);
      expect(degradation.entries.map((entry) => entry.code)).toContain(
        "canon-unreadable"
      );
      // The degradation reaches a QUERY too, not just status — it is carried on
      // every response for as long as it is true.
      const { stdout } = await run(["query", "the gate lives"]);
      expect(stdout).toContain("canon-unreadable");
      expect(stdout).toContain("docs/README.md");
    } finally {
      repo.write(
        "docs/README.md",
        [
          "# Fixture documentation index",
          "",
          "Read this before treating a plan as the product boundary.",
          "",
          original,
          "",
          "- [`adr/0001-a.md`](adr/0001-a.md): the accepted decision.",
          "- [`testing/walkthrough.md`](testing/walkthrough.md): canon, in a directory no rule covers.",
          "",
          "## Historical plans and research",
          "",
          "Files in [`research/`](research/) are dated evidence, not instructions.",
          "",
        ].join("\n")
      );
    }
  });

  it("forces a rebuild on `index` and reports what it cost", async () => {
    const payload = await json(["index"]);
    expect(payload.elapsedMs).toEqual(expect.any(Number));
    const provenance = payload.provenance as {
      root: string;
      builtAtCommit: string | null;
      files: number;
    };
    expect(provenance.root).toBe(repo.root);
    expect(provenance.builtAtCommit).toEqual(expect.any(String));
    expect(provenance.files).toBeGreaterThan(0);

    const { stdout } = await run(["index"]);
    expect(stdout).toMatch(/rebuilt in \d+ ms/);
  });
});

describe("a bad argument is refused by name, never answered as an empty corpus", () => {
  /**
   * BOTH of these printed an honest-looking empty with exit 0, which is the one
   * way a read surface can be confidently wrong: the caller asked a question
   * this command never actually put to the corpus.
   *
   * The MCP sibling (`packages/mcp/src/docs-tools.ts`) refuses the same two
   * arguments, and cross-surface parity is what this file exists to hold.
   */
  it("`impact --limit 1O` refuses instead of denying real citations", async () => {
    // The citations are real: the same path with no --limit returns them.
    const cited = await json(["impact", "src/tracked.ts"]);
    expect((cited.citedBy as unknown[]).length).toBeGreaterThan(0);

    const { stdout, stderr, exitCode } = await run([
      "impact",
      "src/tracked.ts",
      "--limit",
      "1O", // a letter O — `Number("1O")` is NaN, and `slice(0, NaN)` is empty
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--limit must be an integer from 1 to 50");
    expect(stderr).toContain("1O");
    // The exact sentence the defect produced, over citations that exist.
    expect(stdout).not.toContain("no documentation cites this path");
  });

  it("`query --limit` outside the cap refuses rather than silently defeating it", async () => {
    // `1e1` is deliberately NOT here: `Number("1e1")` is 10, an integer inside
    // the cap, and the MCP sibling accepts it too. Parity beats pedantry.
    for (const bad of ["0", "-3", "11", "2.5", "", "1O", "ten", "NaN"]) {
      const { stderr, exitCode } = await run([
        "query",
        "the gate lives",
        "--limit",
        bad,
      ]);
      expect(exitCode, bad).toBe(1);
      expect(stderr, bad).toContain("--limit must be an integer from 1 to 10");
    }
    // …and a value inside the cap still works, so the guard is not a wall.
    const ok = await json(["query", "the gate lives", "--limit", "2"]);
    expect((ok.results as unknown[]).length).toBeLessThanOrEqual(2);
  });

  it("`query --tier ADR` refuses and names the valid tiers", async () => {
    const { stdout, stderr, exitCode } = await run([
      "query",
      "the gate lives",
      "--tier",
      "ADR", // right tier, wrong case — a cast made this match nothing
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("no section in this corpus matches that query");
    expect(stderr).toContain("--tier must be one of");
    for (const tier of ["canon", "adr", "proposal", "historical", "unclassified"]) {
      expect(stderr).toContain(tier);
    }
    // The lower-case tier is a real filter, and it answers.
    const { stdout: real, exitCode: realExit } = await run([
      "query",
      "the gate lives",
      "--tier",
      "canon",
    ]);
    expect(realExit).toBe(0);
    expect(real).toContain("docs/adr/0001-a.md#context");
  });

  it("--json gets the refusal as a payload, not an empty result", async () => {
    // A script that only reads stdout must not see `{results: []}` for a
    // question that was never asked.
    const { stdout, exitCode } = await run([
      "query",
      "the gate lives",
      "--tier",
      "nope",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const body = JSON.parse(stdout) as {
      refusal: { code: string; reason: string; action: string };
    };
    expect(body.refusal.code).toBe("invalid-argument");
    expect(body.refusal.reason).toContain("--tier");
  });
});

describe("a refused `muon docs` read explains itself", () => {
  it("renders the reason, the action, and the nearest section ids — exit 1", async () => {
    const { stderr, stdout, exitCode } = await run([
      "context",
      "docs/adr/0002-b.md#section-twoo",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("is addressed by");
    // A renamed heading changes its coordinate, so the recovery is a coordinate.
    expect(stderr).toContain("A renamed heading changes its section id");
    expect(stderr).toContain("nearest: docs/adr/0002-b.md#section-two");
  });

  it("--json emits the refusal as a payload, still exit 1", async () => {
    const { stdout, exitCode } = await run([
      "context",
      "docs/adr/0002-b.md#nope",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const body = JSON.parse(stdout) as {
      refusal: { code: string; reason: string; action: string; nextActions: string[] };
    };
    expect(body.refusal.code).toBe("target-not-found");
    expect(body.refusal.nextActions.length).toBeGreaterThan(0);
    expect(body.refusal.nextActions[0]).toContain("docs/adr/0002-b.md#");
  });

  it("a document that is not in the corpus refuses too, rather than answering empty", async () => {
    const { exitCode, stderr } = await run(["context", "docs/does-not-exist.md"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docs/does-not-exist.md");
  });
});
