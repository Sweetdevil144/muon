import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalCodeGraphProvider,
  extractSymbolDefs,
  toWorkspaceRelativePosix,
} from "@muon/codegraph";
import { MuonGraph, type MemoryNoteInput } from "@muon/graph";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resetCodeGraphProvider,
  selectCodeGraphProvider,
} from "../src/lib/codegraph.js";
import { preEditContext } from "../src/lib/preedit.js";
import { validateWorkspacePath } from "../src/lib/workspace.js";

// CG-1 (ADR-0011), the LOAD-BEARING integration: the local reverse-import
// provider fused THROUGH the real `preEditContext` over a real `MuonGraph`.
//
// THE #1 CORRECTNESS REQUIREMENT (ADR reviewer note 1, the path-namespace
// crux): memory MODULE anchors are stored VERBATIM and matched by exact string
// (`preedit.ts:250` exactSet.has / graph `list_contains(n.modules, $module)`).
// Every real capture path uses a WORKSPACE-RELATIVE POSIX path (ledger fixtures:
// `src/auth.ts`, `backend/src/lib/preedit.ts`, `package.json`, no `./`, no
// leading `/`). If the provider emitted `./src/b.ts` or an absolute path the
// fusion would silently return ZERO. This test PROVES the provider canonicalizes
// to exactly that namespace and that a governed memory anchored to a transitive
// importer IS surfaced via the `source:"codegraph"` blast-radius.

let graph: MuonGraph;
let graphDir: string;
let repo: string;
let mono: string;
let env: NodeJS.ProcessEnv;
let monoEnv: NodeJS.ProcessEnv;
let provider: LocalCodeGraphProvider;
let monoProvider: LocalCodeGraphProvider;

async function governed(input: MemoryNoteInput) {
  const note = await graph.addMemoryNote(input);
  await graph.updateMemoryNote(note.id, { confirmed: true });
  return note;
}

function write(rel: string, content: string) {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(async () => {
  graphDir = mkdtempSync(join(tmpdir(), "cg-fusion-graph-"));
  graph = new MuonGraph(join(graphDir, "test.lbug"), { disableFts: true });
  await graph.init();

  // A fixture repo: c → b → a (each imports the previous). Editing `src/a.ts`
  // ripples up to `src/b.ts` (d1) and `src/c.ts` (d2).
  repo = realpathSync(mkdtempSync(join(tmpdir(), "cg-fusion-repo-")));
  write("package.json", JSON.stringify({ name: "fixture-repo" }));
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "import { a } from './a.js';\nexport const b = a + 1;");
  write("src/c.ts", "import { b } from './b.js';\nexport const c = b + 1;");
  write("src/unrelated.ts", "export const u = 0;"); // imports nothing → never in radius

  // The provider wired with the CANONICAL P3-B allowlist (validateWorkspacePath),
  // allowlisting the temp repo via MUON_WORKSPACE_ROOTS. cwd=repo so the relative
  // target resolves.
  env = { MUON_WORKSPACE_ROOTS: repo };
  provider = new LocalCodeGraphProvider({
    cwd: repo,
    env,
    validateRoot: (root) => validateWorkspacePath(root, { env }).ok,
  });

  // A MONOREPO fixture (F-1): a root package.json AND a nested backend/package.json.
  // The edit target lives in the sub-package; the anchor namespace is
  // monorepo-root-relative (`backend/src/…`). `backend/src/b.ts` imports
  // `backend/src/a.ts`.
  mono = realpathSync(mkdtempSync(join(tmpdir(), "cg-fusion-mono-")));
  writeFileSync(join(mono, "package.json"), JSON.stringify({ name: "mono" }));
  mkdirSync(join(mono, "backend/src"), { recursive: true });
  writeFileSync(
    join(mono, "backend/package.json"),
    JSON.stringify({ name: "inner" })
  );
  writeFileSync(join(mono, "backend/src/a.ts"), "export const a = 1;");
  writeFileSync(
    join(mono, "backend/src/b.ts"),
    "import { a } from './a.js';\nexport const b = a + 1;"
  );
  monoEnv = { MUON_WORKSPACE_ROOTS: mono };
  monoProvider = new LocalCodeGraphProvider({
    cwd: mono,
    env: monoEnv,
    validateRoot: (root) => validateWorkspacePath(root, { env: monoEnv }).ok,
  });
});

afterAll(async () => {
  await graph.close();
  rmSync(graphDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(mono, { recursive: true, force: true });
});

describe("CG-1 path-namespace fusion E2E (ADR-0011 #1 requirement)", () => {
  it("surfaces a governed memory anchored to a TRANSITIVE IMPORTER via source:'codegraph'", async () => {
    // A governed note ON the edit target, and one on `src/b.ts`, which
    // transitively imports the target. Both anchored in the workspace-relative
    // POSIX namespace, exactly as real capture stores them.
    const onTarget = await governed({
      kind: "decision",
      text: "Module a uses a fixed base value",
      modules: ["src/a.ts"],
      trust: "high",
      createdBy: "human",
    });
    const onImporter = await governed({
      kind: "constraint",
      text: "Module b must preserve a's invariant when it imports it",
      modules: ["src/b.ts"],
      trust: "high",
      createdBy: "human",
    });
    // A note nobody in the radius is anchored to → must NOT surface.
    const offRadius = await governed({
      kind: "convention",
      text: "Unrelated module convention",
      modules: ["src/unrelated.ts"],
      trust: "high",
      createdBy: "human",
    });

    const ctx = await preEditContext(graph, { module: "src/a.ts" }, { provider });

    // THE CRUX: the provider produced a real code-graph radius...
    expect(ctx.blastRadius.source).toBe("codegraph");
    // ...in the EXACT anchor namespace (workspace-relative POSIX, no `./`, no `/`).
    expect(new Set(ctx.blastRadius.modules)).toEqual(
      new Set(["src/a.ts", "src/b.ts", "src/c.ts"])
    );
    expect(
      ctx.blastRadius.modules.every((m) => !m.startsWith("/") && !m.startsWith("."))
    ).toBe(true);

    const ids = ctx.memories.map((m) => m.id);
    // The on-target note surfaces (exact tier, proximity 1).
    expect(ids).toContain(onTarget.id);
    expect(ctx.memories.find((m) => m.id === onTarget.id)?.onTarget).toBe(true);
    // THE PAYOFF: the importer's governed memory IS fused over the code-graph
    // radius (onTarget=false, proximity strictly < 1). A namespace mismatch would
    // have silently dropped this.
    expect(ids).toContain(onImporter.id);
    const importerMem = ctx.memories.find((m) => m.id === onImporter.id);
    expect(importerMem?.onTarget).toBe(false);
    expect(importerMem!.proximity).toBeLessThan(1);
    // The off-radius note is NOT surfaced.
    expect(ids).not.toContain(offRadius.id);
  });

  it("PRECEDENCE: a caller-supplied blastRadius short-circuits the provider (source:'provided')", async () => {
    const spy = vi.spyOn(provider, "impact");
    const ctx = await preEditContext(
      graph,
      { module: "src/a.ts" },
      { provider, blastRadius: { modules: ["src/b.ts"], source: "provided" } }
    );
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.blastRadius.source).toBe("provided");
    spy.mockRestore();
  });

  it("DEGRADE: a symbol-only target → provider null → source:'target-only' (unchanged)", async () => {
    const ctx = await preEditContext(graph, { symbol: "someFn" }, { provider });
    expect(ctx.blastRadius.source).toBe("target-only");
  });

  it("MONOREPO (F-1): a governed memory on `backend/src/b.ts` IS fused for an edit to `backend/src/a.ts`", async () => {
    // The transitive importer's governed memory, anchored in the monorepo-root
    // namespace (with the `backend/` prefix), exactly as real capture stores it.
    const onImporter = await governed({
      kind: "constraint",
      text: "backend module b relies on a's invariant",
      modules: ["backend/src/b.ts"],
      trust: "high",
      createdBy: "human",
    });

    const ctx = await preEditContext(
      graph,
      { module: "backend/src/a.ts" },
      { provider: monoProvider }
    );

    expect(ctx.blastRadius.source).toBe("codegraph");
    // The neighbour KEEPS the `backend/` prefix (the F-1 bug emitted `src/b.ts`,
    // which would never match the anchor → the memory would be silently dropped).
    expect(ctx.blastRadius.modules).toContain("backend/src/b.ts");
    expect(ctx.blastRadius.modules).not.toContain("src/b.ts");
    // THE PAYOFF: the importer's governed memory IS surfaced over the radius.
    const ids = ctx.memories.map((m) => m.id);
    expect(ids).toContain(onImporter.id);
    expect(ctx.memories.find((m) => m.id === onImporter.id)?.onTarget).toBe(false);
  });

  it("ON-SYMBOL E2E: a governed memory anchored to a SYMBOL surfaces via the ON-SYMBOL tier when that symbol is the edit target", async () => {
    // CG-1 extracts the symbol id from the ACTUAL fixture file, in the exact anchor
    // namespace (workspace-relative POSIX). The note is anchored to that same id;
    // the gate edits it, one namespace, capture → CG-1 → gate.
    const aAbs = join(repo, "src/a.ts");
    const modulePath = toWorkspaceRelativePosix(repo, aAbs);
    expect(modulePath).toBe("src/a.ts");
    const defs = extractSymbolDefs(readFileSync(aAbs, "utf8"), modulePath!);
    const symId = defs.find((d) => d.name === "a")!.id;
    expect(symId).toBe("src/a.ts#a"); // the fixture defines `export const a`

    const onSymbol = await governed({
      kind: "decision",
      text: "Symbol a holds the canonical base value",
      symbols: [symId],
      trust: "high",
      createdBy: "human",
    });

    const ctx = await preEditContext(graph, { symbol: symId }, { provider });
    // The provider resolved the symbol → module → reverse-import closure; the
    // radius unions the target's OWN (symbol-derived) module with its importers.
    expect(ctx.blastRadius.source).toBe("codegraph");
    expect(new Set(ctx.blastRadius.modules)).toEqual(
      new Set(["src/a.ts", "src/b.ts", "src/c.ts"])
    );
    expect(ctx.blastRadius.symbols).toContain(symId);
    // THE PAYOFF: the symbol-anchored governed memory is surfaced via the on-symbol tier.
    const mem = ctx.memories.find((m) => m.id === onSymbol.id);
    expect(mem?.onSymbol).toBe(true);
    expect(mem?.onTarget).toBe(true);
    expect(mem?.proximity).toBe(1);
  });

  it("ADR-0015 R2/R3: the REFERENCING symbols surface in blastRadius, but as NEIGHBOURS (Tier 0 stays the exact target)", async () => {
    // A governed memory anchored to `src/b.ts#b`, the symbol that REFERENCES the
    // edit target `src/a.ts#a` (b imports and uses a). Real capture stores it as
    // both symbol- and module-anchored (the degrade guarantee).
    const onReferencer = await governed({
      kind: "constraint",
      text: "symbol b references a and must preserve its contract",
      symbols: ["src/b.ts#b"],
      modules: ["src/b.ts"],
      trust: "high",
      createdBy: "human",
    });

    const ctx = await preEditContext(graph, { symbol: "src/a.ts#a" }, { provider });
    expect(ctx.blastRadius.source).toBe("codegraph");
    // R2 OUTPUT CHANGE: the radius now carries the target PLUS its transitive
    // referencers (b uses a, c uses b), not the old echo-only `[#a]`.
    expect(ctx.blastRadius.symbols).toEqual([
      "src/a.ts#a",
      "src/b.ts#b",
      "src/c.ts#c",
    ]);
    // GATE 3 (no on-symbol-tier regression): the referencer note is a NEIGHBOUR,
    // NOT promoted to the on-symbol Tier 0 (that tier is the exact target only).
    const refMem = ctx.memories.find((m) => m.id === onReferencer.id);
    expect(refMem).toBeDefined();
    expect(refMem?.onSymbol).toBe(false);
    expect(refMem?.onTarget).toBe(false);
    expect(refMem?.proximity).toBeLessThan(1);
  });

  it("ADR-0015 R3: referencer symbols reach the activityReader anchors (as neighbours), Tier 0 unchanged", async () => {
    // The reader captures the anchors the hero passes it. Editing `src/a.ts#a`, the
    // referencer `src/b.ts#b` must appear in the activity anchors so a lane editing
    // it surfaces, while the exact-target set stays exactly `[src/a.ts#a]`.
    let seen: { symbols: string[]; modules: string[] } | undefined;
    const ctx = await preEditContext(
      graph,
      { symbol: "src/a.ts#a" },
      {
        provider,
        activityReader: async (anchors) => {
          seen = anchors;
          return [];
        },
      }
    );
    expect(ctx.blastRadius.source).toBe("codegraph");
    expect(seen?.symbols).toContain("src/a.ts#a"); // the exact target
    expect(seen?.symbols).toContain("src/b.ts#b"); // the referencer (neighbour)
    expect(seen?.symbols).toContain("src/c.ts#c");
  });

  it("#1 ROUND-TRIP (the CG-1 F-1 twin, MONOREPO): the symbol namespace resolves to the WORKSPACE ROOT (keeps `backend/`), and the on-symbol memory fuses", async () => {
    // CG-1 extracts the symbol id from the sub-package file, the namespace MUST be
    // the monorepo-ROOT-relative path (`backend/src/a.ts#a`), NOT the inner
    // package's `src/a.ts#a`. If capture wrote one namespace and the gate computed
    // the other, symbol fusion would silently yield ZERO (the #1 correctness risk).
    const aAbs = join(mono, "backend/src/a.ts");
    const modulePath = toWorkspaceRelativePosix(mono, aAbs);
    expect(modulePath).toBe("backend/src/a.ts"); // workspace root, not the inner package
    const symId = extractSymbolDefs(readFileSync(aAbs, "utf8"), modulePath!).find(
      (d) => d.name === "a"
    )!.id;
    expect(symId).toBe("backend/src/a.ts#a");

    const onSymbol = await governed({
      kind: "decision",
      text: "backend module a's base value is fixed",
      symbols: [symId],
      trust: "high",
      createdBy: "human",
    });

    const ctx = await preEditContext(
      graph,
      { symbol: symId },
      { provider: monoProvider }
    );
    expect(ctx.blastRadius.source).toBe("codegraph");
    // The importer keeps the `backend/` prefix (the F-1 bug would emit `src/b.ts`).
    expect(ctx.blastRadius.modules).toContain("backend/src/b.ts");
    expect(ctx.blastRadius.modules).not.toContain("src/b.ts");
    // THE PAYOFF: byte-identical namespace across capture → CG-1 → gate → surfaced.
    const mem = ctx.memories.find((m) => m.id === onSymbol.id);
    expect(mem?.onSymbol).toBe(true);
    expect(mem?.onTarget).toBe(true);
  });
});

describe("selectCodeGraphProvider, ALWAYS-ON (ADR-0012 Phase 0, no flag)", () => {
  it("no flag set → a LocalCodeGraphProvider (always-on; NO enable flag, NO off-switch)", async () => {
    resetCodeGraphProvider();
    const p = await selectCodeGraphProvider({});
    expect(p).toBeInstanceOf(LocalCodeGraphProvider);
  });

  it("memoizes the singleton (per-root index cache persists across gate calls; lazy import stays dark-load-free at boot)", async () => {
    resetCodeGraphProvider();
    const p1 = await selectCodeGraphProvider({});
    const p2 = await selectCodeGraphProvider({});
    expect(p1).toBeInstanceOf(LocalCodeGraphProvider);
    expect(p1).toBe(p2); // one memoized instance, the module is loaded once, on first call
  });

  it("DEGRADE-TO-NULL is the only 'off': an unresolvable target → module-only (target-only), byte-for-byte today", async () => {
    resetCodeGraphProvider();
    const p = await selectCodeGraphProvider({});
    // A target that cannot be located on disk under the cwd → the provider degrades
    // to null → module-only fusion (source target-only), identical to the old
    // flag-off path. Proves always-on never fails a hero call when the graph can't help.
    const mod = "backend/src/lib/__does_not_exist_zzz__.ts";
    const note = await governed({
      kind: "decision",
      text: "Always-on path degrades to module-only when the graph cannot resolve the target",
      modules: [mod],
      trust: "high",
      createdBy: "human",
    });
    const ctx = await preEditContext(graph, { module: mod }, { provider: p });
    expect(ctx.blastRadius.source).toBe("target-only");
    expect(ctx.blastRadius.modules).toEqual([mod]);
    expect(ctx.memories.map((m) => m.id)).toContain(note.id);
    expect(ctx.memories.every((m) => m.onTarget)).toBe(true);
  });
});
