import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsStatus } from "../src/api.js";
import { clearDocsIndexCache, ensureDocsIndex } from "../src/index-build.js";
import { ROOT_CANON, TIER_PRIOR, adrStatusOf, priorFor } from "../src/tier.js";
import { makeRepo, seedCorpus, type FixtureRepo } from "./fixture-repo.js";
import { REPO_ROOT, realCorpus } from "./real-corpus.js";

// T6 + T7: tier is DATA, derived from `docs/README.md`'s own link edges, and a
// canon set that resolves empty is a LOUD degradation rather than a quiet
// narrowing. Canon is never derived by subtraction.


let repo: FixtureRepo;

beforeEach(() => {
  clearDocsIndexCache();
  repo = makeRepo();
  seedCorpus(repo);
});

afterEach(() => {
  repo.cleanup();
  clearDocsIndexCache();
});

describe("T6 — tier derivation", () => {
  it("canon comes from docs/README.md's LINKS, including a directory no rule covers", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.canon.source).toBe("docs/README.md");
    expect(index.files.get("docs/adr/0001-a.md")?.tier).toBe("canon");
    // `docs/testing/**` has no directory rule at all; it is canon only because
    // the precedence document lists it. This is the case a transcribed constant
    // gets wrong the first time someone edits the index and not the code.
    expect(index.files.get("docs/testing/walkthrough.md")?.tier).toBe("canon");
  });

  it("the root supplement is canon by convention, with no index entry", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.get("README.md")?.tier).toBe("canon");
    expect(index.files.get("docs/README.md")?.tier).toBe("canon");
  });

  it("the positive directory rules classify the rest", async () => {
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.get("docs/adr/0002-b.md")?.tier).toBe("adr");
    expect(index.files.get("docs/design/note.md")?.tier).toBe("proposal");
    expect(index.files.get("docs/research/old.md")?.tier).toBe("historical");
  });

  it("a NEW directory is `unclassified`, never canon — canon is never derived by subtraction", async () => {
    repo.write("docs/whatever/new.md", "# Brand new\n\nBody.\n");
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.files.get("docs/whatever/new.md")?.tier).toBe("unclassified");
  });

  it("renaming the canon HEADING collapses canon to the root supplement AND degrades loudly", async () => {
    repo.write(
      "docs/README.md",
      readFileSync(path.join(repo.root, "docs/README.md"), "utf8").replace(
        "## Canonical current documents",
        "## Documents that are current and canonical"
      )
    );
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.canon.source).toBe("root-supplement-only");
    expect([...index.canon.paths].sort()).toEqual([...ROOT_CANON].sort());
    expect(index.files.get("docs/adr/0001-a.md")?.tier).toBe("adr");
    // NOT a quiet reclassification: it is on EVERY response.
    const status = docsStatus(index);
    expect(status.degradation.active).toBe(true);
    expect(status.degradation.entries.map((entry) => entry.code)).toContain(
      "canon-unreadable"
    );
    expect(status.degradation.reason).toContain("docs/README.md");
    expect(status.degradation.action).toContain("Canonical current documents");
    expect(status.provenance.tierSource).toBe("root-supplement-only");
  });

  it("deleting docs/README.md entirely degrades the same way, never silently", async () => {
    repo.remove("docs/README.md");
    const index = await ensureDocsIndex(repo.root, { force: true });
    expect(index.canon.source).toBe("root-supplement-only");
    expect(docsStatus(index).degradation.entries.map((entry) => entry.code)).toContain(
      "canon-unreadable"
    );
  });

  it("every ROOT_CANON entry exists in THIS repository, so a rename fails loudly", async () => {
    const index = await realCorpus();
    for (const entry of ROOT_CANON) {
      expect([entry, index.files.has(entry)]).toEqual([entry, true]);
    }
  });
});

describe("T7 — ADR status", () => {
  it("parses every header style present in this repository's ADR corpus", () => {
    expect(adrStatusOf("# A\n\n- **Status:** Accepted (2026-08-17)\n")).toBe("accepted");
    expect(adrStatusOf("# A\n\n**Status:** Accepted (P0) · **Date:** 2026-07-11\n")).toBe(
      "accepted"
    );
    expect(adrStatusOf("# A\n\nStatus: accepted\n")).toBe("accepted");
    expect(adrStatusOf("# A\n\nStatus: accepted · 2026-08-11\n")).toBe("accepted");
    expect(adrStatusOf("# A\n\n- **Status:** Proposed (2026-08-07)\n")).toBe("proposed");
  });

  it("`superseded` wins over `accepted` on the same line; `supersedes` does not", () => {
    expect(adrStatusOf("# A\n\nStatus: Accepted, later superseded by ADR-0009\n")).toBe(
      "superseded"
    );
    expect(adrStatusOf("# A\n\nStatus: Accepted (supersedes ADR-0007)\n")).toBe("accepted");
  });

  it("an unparseable Status is `unknown`, NEVER `accepted`", () => {
    expect(adrStatusOf("# A\n\n- **Status:** IMPLEMENTED, KG-7…KG-11 shipped\n")).toBe(
      "unknown"
    );
    expect(adrStatusOf("# A\n\nNo status line at all.\n")).toBe("unknown");
  });

  it("stops at the first `##`, so a later `Status:` in prose cannot retitle the ADR", () => {
    expect(
      adrStatusOf("# A\n\nStatus: proposed\n\n## Context\n\nStatus: accepted\n")
    ).toBe("proposed");
    expect(adrStatusOf("# A\n\n## Context\n\nStatus: accepted\n")).toBe("unknown");
  });

  it("reads the real ADR corpus without ever inventing `accepted`", async () => {
    const index = await realCorpus();
    const adrs = [...index.files.values()].filter((file) =>
      file.path.startsWith("docs/adr/")
    );
    expect(adrs.length).toBeGreaterThan(40);
    for (const adr of adrs) {
      expect([adr.path, adr.adrStatus]).toEqual([
        adr.path,
        expect.stringMatching(/^(accepted|proposed|superseded|unknown)$/),
      ]);
    }
    // The two ADRs whose status line says only "IMPLEMENTED" must land unknown.
    const statuses = new Set(adrs.map((adr) => adr.adrStatus));
    expect(statuses.has("unknown")).toBe(true);
    expect(statuses.has("accepted")).toBe(true);
  });
});

describe("the tier prior is bounded in [0.5, 1.0] and may only demote", () => {
  it("every tier prior is inside the ADR's stated band", () => {
    for (const value of Object.values(TIER_PRIOR)) {
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const status of ["accepted", "proposed", "superseded", "unknown"] as const) {
      const value = priorFor("adr", status);
      expect(value).toBeGreaterThanOrEqual(0.5);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("a superseded ADR is demoted below an accepted one, and never to zero", () => {
    expect(priorFor("adr", "superseded")).toBeLessThan(priorFor("adr", "accepted"));
    expect(priorFor("adr", "superseded")).toBeGreaterThan(0);
    expect(priorFor("historical", null)).toBeLessThan(priorFor("canon", null));
  });

  it("an unparseable ADR status is NOT treated as accepted by the prior", () => {
    expect(priorFor("adr", "unknown")).toBeLessThan(priorFor("adr", "accepted"));
  });
});

describe("the real corpus distributes across every tier", () => {
  it("reports a plausible tier distribution with a live canon set", async () => {
    const index = await realCorpus();
    const status = docsStatus(index);
    expect(status.provenance.tierSource).toBe("docs/README.md");
    // Bounds, not exact counts: this tree moves under the test.
    expect(status.tiers.canon).toBeGreaterThanOrEqual(15);
    expect(status.tiers.adr).toBeGreaterThanOrEqual(40);
    expect(status.tiers.proposal).toBeGreaterThanOrEqual(5);
    expect(status.tiers.historical).toBeGreaterThanOrEqual(40);
    expect(status.tiers.unclassified).toBeGreaterThanOrEqual(1);
    const total =
      status.tiers.canon +
      status.tiers.adr +
      status.tiers.proposal +
      status.tiers.historical +
      status.tiers.unclassified;
    expect(total).toBe(status.corpus.corpus);
  });

  it("agrees with the ADR count `git ls-files` reports for docs/adr", async () => {
    const tracked = execFileSync("git", ["ls-files", "--", "docs/adr/*.md"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean).length;
    const index = await realCorpus();
    const seen = [...index.files.values()].filter((file) =>
      file.path.startsWith("docs/adr/")
    ).length;
    expect(seen).toBeGreaterThanOrEqual(tracked);
  });
});
