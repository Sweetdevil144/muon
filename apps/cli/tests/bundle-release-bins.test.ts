import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE TARBALL MUST SHIP EVERY BIN IT CLAIMS.
 *
 * `bundle-release.mjs` bundled `muon` and `muon-tui` and wrote a manifest
 * naming exactly those two, so an operator who installed the release had no
 * `muon-mcp` anywhere on their machine — while `muonMcpUnresolvedRefusal` told
 * them to "install the MUON CLI package (which ships both the 'muon' and
 * 'muon-mcp' bins)". It only ever resolved on a workstation with a dev-checkout
 * symlink on PATH, which is why nobody saw it.
 *
 * This is a SOURCE-SHAPE check, and says so: running the real bundler here
 * would `rm -rf` the operator's `release/`. It holds the three lists that have
 * to agree — the esbuild entries, the manifest `bin` table, and `files` — to
 * each other, so a fourth bin cannot be declared without being built and
 * shipped. The bundle actually BOOTING is verified by hand against a real
 * stdio handshake; a passing test here is not that claim.
 *
 * AND IT NOW CHECKS WHAT SHIPPING A BIN MEANS (ADR-0052). Pinning that three
 * bins are packed was true and insufficient: `muon-tui` was packed beside the
 * `muonDistributed` bake for weeks while reading no gate at all, so an
 * installed tarball handed a stranger the whole desk. Packing a bin arms the
 * gate for that bin's manifest; a bin whose module graph never reaches the gate
 * is therefore an open door standing beside a locked one, and this file will not
 * let a fourth one be declared that way.
 */

// tests/ → apps/cli → apps → the repo root.
const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));

const script = fs.readFileSync(
  path.join(cliRoot, "scripts", "bundle-release.mjs"),
  "utf8"
);

/** How many bins the release is expected to declare. Pinned as a NUMBER so
 *  the regex parse below cannot quietly return `{}` and make every loop in
 *  this file iterate zero times — a reformat of the script (indentation, quote
 *  style) would otherwise turn these tests green by emptying them. */
const EXPECTED_BIN_COUNT = 3;

/** The manifest's `bin` table, as the script literally writes it. */
function declaredBins(): Record<string, string> {
  const table = script.match(/bin: \{([\s\S]*?)\n {6}\},/)?.[1] ?? "";
  const bins: Record<string, string> = {};
  for (const [, name, file] of table.matchAll(
    /"?([a-z-]+)"?: "([a-z0-9-]+\.mjs)"/g
  )) {
    bins[name!] = file!;
  }
  // Loud, and here rather than in one test: every assertion in this file is
  // inside a loop over this object.
  expect(
    Object.keys(bins).length,
    `parsed ${JSON.stringify(bins)} out of the bin table — the parse broke, ` +
      "so nothing below would have been checked"
  ).toBe(EXPECTED_BIN_COUNT);
  return bins;
}

describe("the release manifest ships every bin it declares", () => {
  it("declares muon, muon-tui and muon-mcp", () => {
    expect(declaredBins()).toEqual({
      muon: "muon.mjs",
      "muon-tui": "muon-tui.mjs",
      "muon-mcp": "muon-mcp.mjs",
    });
  });

  it("builds and packs a file for each one", () => {
    const files = script.match(/files: \[([^\]]*)\]/)?.[1] ?? "";
    for (const outfile of Object.values(declaredBins())) {
      // Built: an esbuild `--outfile` names it.
      expect(script, outfile).toContain(`"${outfile}")}`);
      // Packed: npm only publishes what `files` lists, so a bin missing here
      // is a bin the tarball does not contain.
      expect(files, outfile).toContain(`"${outfile}"`);
    }
  });

  it("and the release pipeline actually RUNS that test script", () => {
    // It did not. `scripts.test` boots all three bundles and nothing executed
    // it — the pipeline went from `bundle-release.mjs` straight to `npm pack`, so
    // the only check that proves the bundles can boot was dead in every release.
    // It has to run BEFORE pack, or a bundle that cannot start still ships.
    const pipeline = fs.readFileSync(
      path.join(repoRoot, "scripts", "release-pipeline.mjs"),
      "utf8"
    );
    const testAt = pipeline.indexOf('run("npm", ["test"], { cwd: join(CLI, "release") })');
    const packAt = pipeline.indexOf('run("npm", ["pack"');
    expect(testAt, "the pipeline never runs the release manifest's own test").toBeGreaterThan(-1);
    expect(packAt).toBeGreaterThan(-1);
    expect(testAt).toBeLessThan(packAt);
  });

  it("verifies each bundle in the manifest's own test script", () => {
    // The seeded-harness-coverage invariant: a manifest that owns files must
    // be verifiable.
    const test = script.slice(
      script.indexOf("const MANIFEST_TEST"),
      script.indexOf("const releaseDir")
    );
    for (const outfile of Object.values(declaredBins())) {
      expect(test, outfile).toContain(outfile);
    }
    // `muon-mcp.mjs` is IMPORTED, not `--check`ed. Both failures that actually
    // shipped were top-level RUNTIME throws (an inlined native addon's
    // `require`, an unresolvable `gitnexus`) and `node --check` passed on both.
    expect(test).toContain("import('./muon-mcp.mjs')");
    expect(test).not.toContain("--check muon-mcp.mjs");
  });

  /**
   * THE ENTRY SOURCE BEHIND EACH BIN.
   *
   * Held here rather than parsed out of the script, because a regex over an
   * esbuild argv is exactly the kind of parse that silently returns nothing —
   * and the assertion below pins each pair against the script's own text, so a
   * changed entry breaks this test rather than quietly retargeting it.
   */
  const ENTRY_BY_BIN: Record<
    string,
    { readonly source: string; readonly inScript: string }
  > = {
    "muon.mjs": {
      source: "apps/cli/src/index.ts",
      inScript: 'join(cliRoot, "src", "index.ts")',
    },
    "muon-tui.mjs": {
      // ADR-0087 D4: the shell desk is the one TUI entry.
      source: "apps/tui/src/shell/index.ts",
      inScript: 'join(tuiRoot, "src", "shell", "index.ts")',
    },
    "muon-mcp.mjs": {
      source: "packages/mcp/src/index.ts",
      inScript: 'join(mcpRoot, "src", "index.ts")',
    },
  };

  /** The ONE gate policy module (ADR-0052 Decision 1). A bundle that does not
   *  contain this file cannot be enforcing the gate, whatever it says. */
  const GATE_POLICY = "packages/client/src/github-identity-gate.ts";

  /** The enforcement call each entry makes. Named per bin because each surface
   *  enforces at its own boundary: a preAction hook, a startup guard, a
   *  `tools/call` predicate. */
  const ENFORCEMENT_BY_BIN: Record<string, string> = {
    "muon.mjs": "checkCliIdentityGate",
    "muon-tui.mjs": "guardTuiIdentityGate",
    "muon-mcp.mjs": "resolveMcpIdentityGate",
  };

  /**
   * Resolve one import specifier to a repo-relative source file, or null when
   * it leaves the workspace (a registry package, a node builtin, JSON).
   *
   * Deliberately small: it only has to be right about the two kinds of edge the
   * @muon closure is made of — relative paths, and `@muon/<pkg>[/<sub>]`, whose
   * exports map every subpath to `dist/<sub>.js` and therefore `src/<sub>.ts`.
   */
  function resolveImport(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith("node:") || specifier.endsWith(".json")) return null;
    let base: string;
    if (specifier.startsWith(".")) {
      base = path.join(path.dirname(path.join(repoRoot, fromFile)), specifier);
    } else if (specifier.startsWith("@muon/")) {
      const [, pkg, ...rest] = specifier.split("/");
      base = path.join(
        repoRoot,
        "packages",
        pkg!,
        "src",
        rest.length > 0 ? rest.join("/") : "index"
      );
    } else {
      return null; // a real registry package
    }
    // `.js` in an ESM import is the compiled name of a `.ts` source; the vendor
    // tree imports `.ts` outright (allowImportingTsExtensions).
    const stem = base.replace(/\.(js|jsx|ts|tsx)$/, "");
    for (const candidate of [
      `${stem}.ts`,
      `${stem}.tsx`,
      path.join(stem, "index.ts"),
      path.join(stem, "index.tsx"),
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.relative(repoRoot, candidate);
      }
    }
    return null;
  }

  /** Every workspace source file the bundler would pull into this entry. */
  function moduleGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const [, specifier] of source.matchAll(
        /(?:from|import)\s*\(?\s*["']([^"']+)["']/g
      )) {
        const next = resolveImport(file, specifier!);
        if (next) queue.push(next);
      }
    }
    return seen;
  }

  it("targets the entry source this file claims for each bin", () => {
    for (const [outfile, entry] of Object.entries(ENTRY_BY_BIN)) {
      const call = script.slice(
        script.indexOf(entry.inScript),
        script.indexOf(`"${outfile}")}`) + outfile.length + 4
      );
      expect(call, `${outfile} is not built from ${entry.source}`).toContain(
        entry.inScript
      );
      expect(
        fs.existsSync(path.join(repoRoot, entry.source)),
        `${entry.source} does not exist`
      ).toBe(true);
    }
  });

  it("declares an entry for every bin it ships", () => {
    // The guard that keeps a fourth bin from skipping the gate check entirely:
    // adding it to the manifest without adding it here fails right here.
    expect(Object.keys(ENTRY_BY_BIN).sort()).toEqual(
      Object.values(declaredBins()).sort()
    );
    expect(Object.keys(ENFORCEMENT_BY_BIN).sort()).toEqual(
      Object.values(declaredBins()).sort()
    );
  });

  it("EVERY declared bin's module graph reaches the ADR-0052 gate", () => {
    for (const [outfile, entry] of Object.entries(ENTRY_BY_BIN)) {
      const graph = moduleGraph(entry.source);
      // Loud about the walk itself: a resolver that silently returned nothing
      // would make the containment assertion below vacuous.
      expect(
        graph.size,
        `${outfile}: the module walk from ${entry.source} found almost nothing`
      ).toBeGreaterThan(5);
      expect(
        graph.has(GATE_POLICY),
        `${outfile} is packed beside the muonDistributed bake but its module ` +
          `graph never reaches ${GATE_POLICY} — an installed tarball would ` +
          `serve this bin ungated`
      ).toBe(true);
      // Reaching the policy is not the same as enforcing it. Some file in the
      // graph has to make the call.
      const enforcement = ENFORCEMENT_BY_BIN[outfile]!;
      const enforced = [...graph].some((file) =>
        fs.readFileSync(path.join(repoRoot, file), "utf8").includes(
          `${enforcement}(`
        )
      );
      expect(
        enforced,
        `${outfile} imports the gate policy but nothing in its graph calls ${enforcement}()`
      ).toBe(true);
    }
  });

  it("packs the desk's optional native helpers beside muon-tui.mjs", () => {
    // pi-tui's modifier helper loads `native/darwin/prebuilds/...` BESIDE the
    // running entry and degrades SILENTLY to "no modifier held" when the file
    // is missing — so a tarball without it ships a silent capability loss
    // (the degrade-stated rule, ADR-0026 §9). The script must copy the
    // prebuilds into the release and `files` must publish the directory.
    expect(script).toContain('"native", "darwin", "prebuilds"');
    const files = script.match(/files: \[([^\]]*)\]/)?.[1] ?? "";
    expect(files).toContain('"native"');
  });

  it("keeps the MCP entry on the CLI externals, never the TUI's", () => {
    // node-pty is the TUI's (native, cannot survive single-file bundling),
    // and bundling the MCP entry with it external would make the release
    // manifest demand a package `muon-mcp` never imports. The @muon/*
    // closure of packages/mcp reaches no registry package beyond
    // @modelcontextprotocol/sdk.
    const mcpEntry = script.slice(script.indexOf('join(mcpRoot, "src", "index.ts")'));
    const call = mcpEntry.slice(0, mcpEntry.indexOf("{ stdio:"));
    expect(call).toContain("EXTERNALS.map");
    expect(call).not.toContain("TUI_EXTERNALS");
  });
});
