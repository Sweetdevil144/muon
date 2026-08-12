import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRegistry, defaultRegistry } from "../src/adapter.js";
import {
  type PathExists,
  extractImports,
  pythonAdapter,
  resolvePythonImport,
} from "../src/adapters/python.js";
import { typescriptAdapter } from "../src/adapters/typescript.js";
import { buildReverseImportIndex } from "../src/indexer.js";
import { toWorkspaceRelativePosix } from "../src/paths.js";
import { LocalCodeGraphProvider } from "../src/provider.js";

// ADR-0016 R1, the Python MODULE-LEVEL adapter: the §5.1 logical-line scanner, the
// §5.2 package/`__init__.py`/relative resolver, the §5.3 degrade matrix, and the
// binding merge gates (docstring merge-blocker, no-regression, no-egress/no-deps,
// F-1 round-trip) over a real on-disk fixture repo.

const ROOT = "/repo";

/** An in-memory `exists` predicate over a set of absolute paths (no fs). */
function existsOver(paths: string[]): PathExists {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

// ── §5.1 the scanner ─────────────────────────────────────────────────────────

describe("extractImports, the §5.1 logical-line scanner", () => {
  it("parses `import a` / `import a.b.c` / `import a.b as c` / `import a, b.c`", () => {
    expect(extractImports("import a")).toEqual([
      { specifier: "a", relativeLevel: 0 },
    ]);
    expect(extractImports("import a.b.c")).toEqual([
      { specifier: "a.b.c", relativeLevel: 0 },
    ]);
    expect(extractImports("import a.b as c")).toEqual([
      { specifier: "a.b", relativeLevel: 0 },
    ]);
    expect(extractImports("import a, b.c")).toEqual([
      { specifier: "a", relativeLevel: 0 },
      { specifier: "b.c", relativeLevel: 0 },
    ]);
  });

  it("parses `from a.b import (x, y)` with a dotted specifier + members", () => {
    expect(extractImports("from a.b import (x, y)")).toEqual([
      { specifier: "a.b", relativeLevel: 0, members: ["x", "y"] },
    ]);
  });

  it("parses `from . import c` and `from ..pkg.mod import e` with dot levels", () => {
    expect(extractImports("from . import c")).toEqual([
      { specifier: "", relativeLevel: 1, members: ["c"] },
    ]);
    expect(extractImports("from ..pkg.mod import e")).toEqual([
      { specifier: "pkg.mod", relativeLevel: 2, members: ["e"] },
    ]);
  });

  it("only matches at logical-line start (assignments / f-strings ignored)", () => {
    expect(extractImports("x = import_lib")).toEqual([]);
    expect(extractImports('y = f"import os {x}"')).toEqual([]);
    expect(extractImports("importlib.import_module('os')")).toEqual([]);
  });

  it("captures an INDENTED import (a conditional / TYPE_CHECKING block)", () => {
    const src = "if True:\n    import pkg.util\n";
    expect(extractImports(src)).toEqual([
      { specifier: "pkg.util", relativeLevel: 0 },
    ]);
  });

  it("is PURE and never throws (→ [] on doubt)", () => {
    expect(extractImports("from from from")).toEqual([]);
    expect(extractImports("")).toEqual([]);
    expect(Array.isArray(extractImports("¯\\_(ツ)_/¯ not python"))).toBe(true);
  });
});

// ── §5.2 the resolver ────────────────────────────────────────────────────────

describe("resolvePythonImport, the §5.2 package/relative resolver", () => {
  it("absolute `a.b.c` → deepest of a/b/c.py | a/b/c/__init__.py", () => {
    const exists = existsOver(["/repo/a/b/c.py", "/repo/a/__init__.py"]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/main.py",
      { specifier: "a.b.c", relativeLevel: 0 },
      exists
    );
    expect(hit).toBe(path.resolve("/repo/a/b/c.py"));
  });

  it("resolves a package via its __init__.py when there is no leaf .py", () => {
    const exists = existsOver(["/repo/pkg/__init__.py"]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/main.py",
      { specifier: "pkg", relativeLevel: 0, members: ["x"] },
      exists
    );
    expect(hit).toBe(path.resolve("/repo/pkg/__init__.py"));
  });

  it("`from X import n` resolves to X ONLY, never speculatively X/n.py (conservative)", () => {
    // Both pkg/__init__.py AND pkg/n.py exist; the edge must be pkg/__init__.py.
    const exists = existsOver(["/repo/pkg/__init__.py", "/repo/pkg/n.py"]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/main.py",
      { specifier: "pkg", relativeLevel: 0, members: ["n"] },
      exists
    );
    expect(hit).toBe(path.resolve("/repo/pkg/__init__.py"));
    expect(hit).not.toBe(path.resolve("/repo/pkg/n.py"));
  });

  it("resolves against the file's PACKAGE ROOT (src/-layout) as well as the repo root", () => {
    // `src/pkg` is a package; `src` is NOT → package root is `/repo/src`.
    const exists = existsOver([
      "/repo/src/pkg/__init__.py",
      "/repo/src/pkg/mod.py",
      "/repo/src/pkg/other.py",
    ]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/src/pkg/mod.py",
      { specifier: "pkg.other", relativeLevel: 0 },
      exists
    );
    expect(hit).toBe(path.resolve("/repo/src/pkg/other.py"));
  });

  it("relative `from .sibling import x` → the sibling module in the file's package", () => {
    const exists = existsOver([
      "/repo/pkg/__init__.py",
      "/repo/pkg/sibling.py",
    ]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/pkg/mod.py",
      { specifier: "sibling", relativeLevel: 1, members: ["x"] },
      exists
    );
    expect(hit).toBe(path.resolve("/repo/pkg/sibling.py"));
  });

  it("SELF-GUARD: a root-escaping relative import → null (isWithin / F-1)", () => {
    const exists = existsOver(["/repo/x.py", "/x.py"]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/mod.py",
      { specifier: "x", relativeLevel: 6 },
      exists
    );
    expect(hit).toBeNull();
  });

  it("an unresolvable / external import → null (safe under-inclusion)", () => {
    const exists = existsOver(["/repo/main.py"]);
    expect(
      resolvePythonImport(
        ROOT,
        "/repo/main.py",
        { specifier: "os", relativeLevel: 0 },
        exists
      )
    ).toBeNull();
  });

  it("HARDENING (review LOW-2): a relative import that over-walks ABOVE root and RE-ENTERS → null", () => {
    // `from ...repo.x import y` in /repo/pkg/mod.py walks /repo/pkg → /repo → / then
    // `repo.x` re-enters /repo/x.py (which IS within root). Invalid Python (beyond
    // top-level package), the isWithin(base) guard must null it, not fabricate an edge.
    const exists = existsOver(["/repo/x.py", "/repo/pkg/mod.py"]);
    const hit = resolvePythonImport(
      ROOT,
      "/repo/pkg/mod.py",
      { specifier: "repo.x", relativeLevel: 3 },
      exists
    );
    expect(hit).toBeNull();
  });
});

// ── GATE 2: the docstring merge-blocker + the whole §5.3 degrade matrix ───────

describe("GATE 2, docstring merge-blocker (MANDATORY) + the §5.3 degrade matrix", () => {
  const exists = existsOver([
    "/repo/pkg/__init__.py",
    "/repo/pkg/util.py",
    "/repo/pkg/secret.py",
  ]);
  const edgesOf = (src: string, from = "/repo/app.py") =>
    extractImports(src)
      .map((ref) => resolvePythonImport(ROOT, from, ref, exists))
      .filter((hit): hit is string => hit !== null);

  it('HARDENING (review LOW-1): a string BEFORE `import` on one logical line (invalid Python) emits NO edge', () => {
    // `""" a """ import pkg.secret """ b """` is a syntax error (a string-expr can't be
    // followed by `import`); the non-whitespace sentinel blanking must stop the blanked
    // leading string from looking like a leading `import`.
    expect(edgesOf('""" a """ import pkg.secret """ b """')).toEqual([]);
    expect(edgesOf("''' x ''' import pkg.secret ''' y '''")).toEqual([]);
  });

  it('an indented """…import os…""" docstring emits NO edge', () => {
    const src =
      "def f():\n" +
      '    """\n' +
      "    import pkg.secret\n" +
      "    from pkg import secret\n" +
      '    """\n' +
      "    return 1\n";
    expect(extractImports(src)).toEqual([]);
    expect(edgesOf(src)).toEqual([]);
  });

  it("a single-quoted ''' block is ALSO tracked (no edge)", () => {
    const src = "'''\nimport pkg.secret\n'''\n";
    expect(extractImports(src)).toEqual([]);
  });

  it("dynamic __import__ / importlib.import_module → no edge", () => {
    const src =
      "import importlib\n" +
      'm = importlib.import_module("pkg.util")\n' +
      'n = __import__("pkg")\n';
    // `import importlib` is external → null; the dynamic calls aren't statements.
    expect(edgesOf(src)).toEqual([]);
  });

  it("namespace package (PEP 420): leaf resolves by file, missing __init__ → no package edge", () => {
    const nsExists = existsOver(["/repo/ns/leaf.py"]); // NO ns/__init__.py
    const edges = (src: string) =>
      extractImports(src)
        .map((ref) => resolvePythonImport(ROOT, "/repo/app.py", ref, nsExists))
        .filter((h): h is string => h !== null);
    expect(edges("import ns.leaf")).toEqual([path.resolve("/repo/ns/leaf.py")]);
    expect(edges("from ns import thing")).toEqual([]); // coarse, never wrong
  });

  it("`from a import *` keeps the module edge to a", () => {
    expect(edgesOf("from pkg import *")).toEqual([
      path.resolve("/repo/pkg/__init__.py"),
    ]);
  });

  it("conditional / TYPE_CHECKING import is KEPT (safe over-inclusion)", () => {
    const src =
      "from typing import TYPE_CHECKING\n" +
      "if TYPE_CHECKING:\n" +
      "    import pkg.util\n";
    expect(edgesOf(src)).toEqual([path.resolve("/repo/pkg/util.py")]);
  });

  it("sys.path insert / runtime path trick → null (under-inclusion, safe)", () => {
    const src = 'import sys\nsys.path.insert(0, "vendor")\nimport vendored\n';
    expect(edgesOf(src)).toEqual([]);
  });

  it("root-escaping relative (`from ...... import x`) → null", () => {
    expect(edgesOf("from ...... import x", "/repo/mod.py")).toEqual([]);
  });

  it("multi-line parenthesized from-import is joined → one module edge", () => {
    const src = "from pkg import (\n    a,\n    b,\n)\n";
    expect(edgesOf(src)).toEqual([path.resolve("/repo/pkg/__init__.py")]);
  });
});

// ── the on-disk fixture repo (real fs) ────────────────────────────────────────

const FIXTURE = realpathSync(
  fileURLToPath(new URL("./fixtures/python", import.meta.url))
);
const J = (rel: string) => path.join(FIXTURE, rel);

describe("Python adapter over a real fixture repo (indexer + provider)", () => {
  it("builds the reverse-import graph with conservative from-import + docstring suppression", () => {
    const index = buildReverseImportIndex({ root: FIXTURE });
    // service ← main (import app.service); util ← service (from app.util import helper).
    expect(index.reverse.get(J("app/service.py"))).toEqual(
      new Set([J("app/main.py")])
    );
    expect(index.reverse.get(J("app/util.py"))).toEqual(
      new Set([J("app/service.py")])
    );
    // `from app import config` → the PACKAGE __init__.py, not config.py (conservative).
    expect(index.reverse.get(J("app/__init__.py"))).toEqual(
      new Set([J("app/main.py")])
    );
    // config.py is an ORPHAN, the from-import never speculatively linked it.
    expect(index.reverse.get(J("app/config.py"))).toBeUndefined();
    // DOCSTRING SUPPRESSION over real fs: util.py's docstring `import app.service`
    // is NOT an edge, service's only importer stays `main`, util imports nothing.
    expect(index.forward.get(J("app/util.py"))).toBeUndefined();
    // REC-010: Python now populates the SYMBOL layer — the one unambiguous
    // from-import usage (service.py) and NOTHING from main.py (unaliased
    // `import app.service` = degrade row 7; `from app import config` → __init__
    // = degrade row 8).
    expect(index.symbolReverse.get("app/util.py#helper")).toEqual(
      new Set(["app/service.py#serve"])
    );
    expect(index.symbolReverse.size).toBe(1);
  });

  it("provider.impact for a .py target returns the reverse closure in canonical POSIX", async () => {
    const provider = new LocalCodeGraphProvider({ cwd: FIXTURE, env: {} });
    const radius = await provider.impact({ module: "app/util.py" });
    expect(radius).not.toBeNull();
    expect(radius!.source).toBe("codegraph");
    expect(radius!.modules).toEqual(["app/service.py", "app/main.py"]);
    expect(radius!.depth).toBe(2);
  });

  it("a conservatively-orphaned target (config) → empty modules (codegraph ran)", async () => {
    const provider = new LocalCodeGraphProvider({ cwd: FIXTURE, env: {} });
    const radius = await provider.impact({ module: "app/config.py" });
    expect(radius).not.toBeNull();
    expect(radius!.modules).toEqual([]);
  });

  it("GATE 3: a .py SYMBOL target returns SYMBOL-level referencers (never-widen)", async () => {
    const provider = new LocalCodeGraphProvider({ cwd: FIXTURE, env: {} });
    const radius = await provider.impact({ symbol: "app/util.py#helper" });
    expect(radius).not.toBeNull();
    // NEVER WIDEN: `modules` is byte-identical to the module-level closure.
    expect(radius!.modules).toEqual(["app/service.py", "app/main.py"]);
    // REC-010: the target PLUS its symbol referencers. `app/main.py#run` is
    // correctly ABSENT (main.py has no symbol binding — degrade rows 7/8).
    expect(radius!.symbols).toEqual([
      "app/util.py#helper",
      "app/service.py#serve",
    ]);
  });

  it("ACCEPTANCE: symbol layer disabled (maxSymbolScanMs<=0) ⇒ module-level behavior unchanged, echo-only symbols", async () => {
    const provider = new LocalCodeGraphProvider({
      cwd: FIXTURE,
      env: {},
      budget: { maxSymbolScanMs: 0 },
    });
    const radius = await provider.impact({ symbol: "app/util.py#helper" });
    expect(radius).not.toBeNull();
    expect(radius!.modules).toEqual(["app/service.py", "app/main.py"]);
    expect(radius!.symbols).toEqual(["app/util.py#helper"]);
  });

  it("GATE 5: every Python module in the radius round-trips through the shared F-1 canonicalizer", async () => {
    const provider = new LocalCodeGraphProvider({ cwd: FIXTURE, env: {} });
    const radius = await provider.impact({ module: "app/util.py" });
    for (const mod of radius!.modules) {
      // Workspace-relative POSIX, and it fuses back to itself against a memory anchor
      // of the same shape (the exact-string match the hero does).
      expect(mod.startsWith("/") || mod.startsWith(".")).toBe(false);
      expect(toWorkspaceRelativePosix(FIXTURE, path.join(FIXTURE, mod))).toBe(mod);
    }
  });
});

// ── GATE 3: no-regression, [ts, python] over a TS repo is byte-for-byte [ts] ──

describe("GATE 3, no-regression: [ts, python] over a TS-only repo == [ts] alone", () => {
  let tsRepo: string;

  beforeAll(() => {
    tsRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "cg-tspy-")));
    writeFileSync(path.join(tsRepo, "package.json"), "{}");
    mkdirSync(path.join(tsRepo, "src"), { recursive: true });
    writeFileSync(path.join(tsRepo, "src/a.ts"), "export const a = 1;");
    writeFileSync(
      path.join(tsRepo, "src/b.ts"),
      "import { a } from './a.js';\nexport const b = a + 1;"
    );
    writeFileSync(
      path.join(tsRepo, "src/c.ts"),
      "import { b } from './b.js';\nexport const c = b + 1;"
    );
  });

  afterAll(() => rmSync(tsRepo, { recursive: true, force: true }));

  it("the reverse/forward/symbol index is byte-for-byte identical", () => {
    const tsOnly = buildReverseImportIndex({
      root: tsRepo,
      registry: createRegistry([typescriptAdapter]),
    });
    const withPy = buildReverseImportIndex({
      root: tsRepo,
      registry: createRegistry([typescriptAdapter, pythonAdapter]),
    });
    expect(withPy.reverse).toEqual(tsOnly.reverse);
    expect(withPy.forward).toEqual(tsOnly.forward);
    expect(withPy.symbolReverse).toEqual(tsOnly.symbolReverse);
    expect(withPy.files).toEqual(tsOnly.files);
    expect(withPy.fileCount).toEqual(tsOnly.fileCount);
    expect(withPy.symbolLayerAvailable).toEqual(tsOnly.symbolLayerAvailable);
    // The symbol layer is still ALIVE for the TS files (not disabled by Python).
    expect(withPy.symbolLayerAvailable).toBe(true);
    expect(withPy.symbolReverse.get("src/a.ts#a")).toEqual(
      new Set(["src/b.ts#b"])
    );
  });

  it("provider radius (incl. referencer symbols) is identical with [ts] vs [ts, python]", async () => {
    const tsOnly = new LocalCodeGraphProvider({
      cwd: tsRepo,
      env: {},
      adapters: createRegistry([typescriptAdapter]),
    });
    const withPy = new LocalCodeGraphProvider({
      cwd: tsRepo,
      env: {},
      adapters: createRegistry([typescriptAdapter, pythonAdapter]),
    });
    const a = await tsOnly.impact({ symbol: "src/a.ts#a" });
    const b = await withPy.impact({ symbol: "src/a.ts#a" });
    expect(b).toEqual(a);
    expect(b!.modules).toEqual(["src/b.ts", "src/c.ts"]);
    expect(b!.symbols).toEqual(["src/a.ts#a", "src/b.ts#b", "src/c.ts#c"]);
  });

  it("the default registry is [ts, python] (MUON_CODEGRAPH_LANGS overridable)", () => {
    expect(defaultRegistry({}).isSupported("x.py")).toBe(true);
    expect(defaultRegistry({}).isSupported("x.ts")).toBe(true);
    // The reversible rollback lever: TS-only.
    const tsLang = defaultRegistry({ MUON_CODEGRAPH_LANGS: "ts" });
    expect(tsLang.isSupported("x.ts")).toBe(true);
    expect(tsLang.isSupported("x.py")).toBe(false);
  });
});

// ── GATE 4: no egress / no native deps ────────────────────────────────────────

describe("GATE 4, no egress / no native deps", () => {
  it("NO EGRESS: extraction + indexing over the Python fixture opens no socket", () => {
    const netConnect = vi.spyOn(net, "connect");
    const netSocketConnect = vi.spyOn(net.Socket.prototype, "connect");
    const httpsRequest = vi.spyOn(https, "request");
    try {
      extractImports("import a\nfrom . import b\n");
      pythonAdapter
        .createContext(FIXTURE)
        .resolveImport(J("app/main.py"), { specifier: "app.service", relativeLevel: 0 });
      buildReverseImportIndex({ root: FIXTURE });
      expect(netConnect).not.toHaveBeenCalled();
      expect(netSocketConnect).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      netConnect.mockRestore();
      netSocketConnect.mockRestore();
      httpsRequest.mockRestore();
    }
  });

  it("NO NATIVE DEPS: package.json still declares ONLY typescript (the ADR-0008 asar trap)", () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8"
      )
    );
    expect(Object.keys(pkg.dependencies)).toEqual(["typescript"]);
  });
});
