import { readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type PathExists, pythonAdapter } from "../src/adapters/python.js";
import { moduleOfSymbol, toWorkspaceRelativePosix } from "../src/paths.js";
import { extractPythonSymbolReferences } from "../src/python-symbol-refs.js";

// REC-010 / ADR-0015 parity for Python: the lexical, import-resolved reverse
// SYMBOL-reference extractor. Attribution correctness (true edges), the WHOLE
// degrade matrix (every ambiguity → NO symbol edge, the module edge stands),
// never-throws, F-1 round-trip, no-egress, and the adapter wiring over the real
// on-disk fixture. Pure, an in-memory `exists` Set, no fs (except the wiring test).

const ROOT = "/repo";

/** An in-memory `exists` predicate over a set of absolute paths (no fs). */
function existsOver(paths: string[]): PathExists {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

/** Run the extractor for a file `module` (plus `extraFiles` that exist for import
 *  resolution) and return its edges as `callee -> caller` strings. */
function edgesOf(
  module: string,
  text: string,
  extraFiles: string[] = []
): Set<string> {
  const exists = existsOver([
    `${ROOT}/${module}`,
    ...extraFiles.map((f) => `${ROOT}/${f}`),
  ]);
  const { edges } = extractPythonSymbolReferences(
    text,
    module,
    `${ROOT}/${module}`,
    ROOT,
    exists
  );
  return new Set(edges.map((e) => `${e.callee} -> ${e.caller}`));
}

// ── attribution (capture) ─────────────────────────────────────────────────────

describe("extractPythonSymbolReferences, attribution", () => {
  it("attributes a bare from-import usage to its enclosing top-level def", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\ndef bar():\n    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#bar"]));
  });

  it("resolves `from m import helper as h` to the IMPORTED name (m.py#helper)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper as h\ndef baz():\n    return h(1)\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#baz"]));
  });

  it("attributes a NESTED def usage to the top-level def (ADR-0012 Decision-1)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    def inner():\n" +
        "        return helper()\n" +
        "    return inner\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#bar"]));
  });

  it("attributes a method-body usage to the top-level CLASS id", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "class C:\n" +
        "    def method(self):\n" +
        "        return helper(1)\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#C"]));
  });

  it("attributes a decorator to the decorated top-level def", () => {
    const e = edgesOf(
      "b.py",
      "from deco import route\n@route\ndef handler():\n    return 1\n",
      ["deco.py"]
    );
    expect(e).toEqual(new Set(["deco.py#route -> b.py#handler"]));
  });

  it("attributes an alias-attr decorator `@uh.route(...)` to the decorated def", () => {
    const e = edgesOf(
      "b.py",
      "import util.helpers as uh\n" +
        '@uh.route("/x")\n' +
        "def handler():\n" +
        "    return 1\n",
      ["util/helpers.py"]
    );
    expect(e).toEqual(new Set(["util/helpers.py#route -> b.py#handler"]));
  });

  it("attributes a top-level single-target assignment RHS to module#NAME", () => {
    const e = edgesOf("b.py", "from m import helper\nVALUE = helper(2)\n", [
      "m.py",
    ]);
    expect(e).toEqual(new Set(["m.py#helper -> b.py#VALUE"]));
  });

  it("module-alias attribute `uh.compute` → symbol edge; only the FIRST segment", () => {
    const e = edgesOf(
      "b.py",
      "import util.helpers as uh\ndef bar():\n    return uh.compute.deep(1)\n",
      ["util/helpers.py"]
    );
    expect(e).toEqual(new Set(["util/helpers.py#compute -> b.py#bar"]));
  });

  it("a class base `class C(Base):` references Base with caller module#C", () => {
    const e = edgesOf("b.py", "from m import Base\nclass C(Base):\n    pass\n", [
      "m.py",
    ]);
    expect(e).toEqual(new Set(["m.py#Base -> b.py#C"]));
  });

  it("a def-line annotation `def bar(x: Helper)` captures Helper -> bar", () => {
    const e = edgesOf(
      "b.py",
      "from m import Helper\ndef bar(x: Helper):\n    return x\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#Helper -> b.py#bar"]));
  });

  it("a one-liner `def f(): return helper()` still attributes to f", () => {
    const e = edgesOf("b.py", "from m import helper\ndef f(): return helper()\n", [
      "m.py",
    ]);
    expect(e).toEqual(new Set(["m.py#helper -> b.py#f"]));
  });

  it("a from-binding passed to getattr / as a kwarg VALUE is a reference", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        '    return getattr(helper, "config")\n' +
        "def baz():\n" +
        "    return call(cfg=helper)\n",
      ["m.py"]
    );
    expect(e).toEqual(
      new Set(["m.py#helper -> b.py#bar", "m.py#helper -> b.py#baz"])
    );
  });

  it("an UNREFERENCED import emits no edge", () => {
    const e = edgesOf("b.py", "from m import helper\ndef bar():\n    return 1\n", [
      "m.py",
    ]);
    expect(e).toEqual(new Set());
  });
});

// ── the DEGRADE MATRIX, one test per construct ────────────────────────────────

describe("extractPythonSymbolReferences, the degrade matrix (module-level on ANY doubt)", () => {
  it("row 6: `from m import *` degrades the WHOLE file (even other bindings)", () => {
    const e = edgesOf(
      "b.py",
      "from m import *\nfrom n import helper\ndef bar():\n    return helper()\n",
      ["m.py", "n.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 7: unaliased `import util.helpers` + dotted usage → no symbol edge", () => {
    const e = edgesOf(
      "b.py",
      "import util.helpers\ndef bar():\n    return util.helpers.compute(1)\n",
      ["util/helpers.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 8: `from pkg import y` resolving to pkg/__init__.py → no binding", () => {
    const e = edgesOf(
      "b.py",
      "from pkg import helper\ndef bar():\n    return helper()\n",
      ["pkg/__init__.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 9: `import pkg as p` resolving to __init__.py → p.attr is no edge", () => {
    const e = edgesOf(
      "b.py",
      "import pkg as p\ndef bar():\n    return p.helper(1)\n",
      ["pkg/__init__.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 10: an `if TYPE_CHECKING:` (indented) import binds nothing", () => {
    const e = edgesOf(
      "b.py",
      "if TYPE_CHECKING:\n" +
        "    from m import Helper\n" +
        "def bar(x):\n" +
        "    return Helper(x)\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 10: a try/except ImportError import binds nothing", () => {
    const e = edgesOf(
      "b.py",
      "try:\n" +
        "    from m import helper\n" +
        "except ImportError:\n" +
        "    helper = None\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 10b: an indented import REBINDING a top-level binding poisons it", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "if flag:\n" +
        "    from n import helper\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py", "n.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 12: a DUPLICATE local binding across imports poisons the name", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\nfrom n import helper\ndef bar():\n    return helper()\n",
      ["m.py", "n.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 12b: a cross-map duplicate (from-import vs alias) poisons the name", () => {
    const e = edgesOf(
      "b.py",
      "from m import uh\nimport util.helpers as uh\ndef bar():\n    return uh.compute(1)\n",
      ["m.py", "util/helpers.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: shadow by `def NAME` (any indent) poisons module-wide", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "class C:\n" +
        "    def helper(self):\n" +
        "        return 1\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: shadow by `class NAME` poisons module-wide", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\nclass helper:\n    pass\ndef bar():\n    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: an assignment-in-function shadow poisons module-wide", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    helper = 5\n" +
        "    return helper\n" +
        "def baz():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a TUPLE target shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    a, helper = 1, 2\n" +
        "    return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a `for` target shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    for helper in range(3):\n" +
        "        pass\n" +
        "    return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a COMPREHENSION target shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(xs):\n" +
        "    return [helper for helper in xs]\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a `with … as NAME` shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(p):\n" +
        "    with open(p) as helper:\n" +
        "        return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: an `except … as NAME` shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    try:\n" +
        "        pass\n" +
        "    except ValueError as helper:\n" +
        "        return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a LAMBDA param shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\nF = lambda helper: helper + 1\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: a WALRUS target shadow poisons", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(y):\n" +
        "    if (helper := y):\n" +
        "        return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 13: `global` / `del` statements poison the listed names", () => {
    const g = edgesOf(
      "b.py",
      "from m import helper\ndef bar():\n    global helper\n    return helper()\n",
      ["m.py"]
    );
    expect(g).toEqual(new Set());
    const d = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def kill():\n" +
        "    del helper\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(d).toEqual(new Set());
  });

  it("row 13: a def PARAM name shadow poisons (the param itself, module-wide)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(helper):\n" +
        "    return helper()\n" +
        "def baz():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 14: monkey-patching `uh.attr = x` (and aug-assign) poisons the alias", () => {
    const assign = edgesOf(
      "b.py",
      "import util.helpers as uh\n" +
        "def patch():\n" +
        "    uh.compute = 1\n" +
        "def bar():\n" +
        "    return uh.compute(1)\n",
      ["util/helpers.py"]
    );
    expect(assign).toEqual(new Set());
    const aug = edgesOf(
      "b.py",
      "import util.helpers as uh\n" +
        "def patch():\n" +
        "    uh.count += 1\n" +
        "def bar():\n" +
        "    return uh.compute(1)\n",
      ["util/helpers.py"]
    );
    expect(aug).toEqual(new Set());
  });

  it("row 15: a BARE alias (getattr / subscript / passed object) emits nothing", () => {
    const e = edgesOf(
      "b.py",
      "import util.helpers as uh\n" +
        "def bar():\n" +
        '    return getattr(uh, "compute")\n' +
        "def baz():\n" +
        '    return uh["k"]\n' +
        "def qux():\n" +
        "    return use(uh)\n",
      ["util/helpers.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 16: a keyword-argument NAME `f(helper=1)` is not a reference (no poison either)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        "    return f(helper=1)\n" +
        "def baz():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    // The kwarg is skipped; the genuine use in baz still captures.
    expect(e).toEqual(new Set(["m.py#helper -> b.py#baz"]));
  });

  it("row 17: a usage with NO enclosing top-level decl emits nothing", () => {
    expect(
      edgesOf("b.py", "from m import helper\nhelper()\n", ["m.py"])
    ).toEqual(new Set());
    expect(
      edgesOf("b.py", "from m import helper\nif True:\n    helper()\n", ["m.py"])
    ).toEqual(new Set());
  });

  it("row 17b: a CONDITIONAL def body attributes to nothing (no enclosing id)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "if True:\n" +
        "    def bar():\n" +
        "        return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 18: docstring / f-string interiors never fabricate an edge", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        '    """uses helper() heavily"""\n' +
        '    return f"{1}"\n',
      ["m.py"]
    );
    expect(e).toEqual(new Set());
    // An f-string PREFIX adjacent to the blanked string is not a reference to `f`.
    const prefix = edgesOf(
      "b.py",
      'from m import f\ndef bar():\n    return f"hello"\n',
      ["m.py"]
    );
    expect(prefix).toEqual(new Set());
  });

  it("row 19: a `;` multi-statement line degrades the WHOLE file", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\ndef bar(): x = 1; return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 19: `exec(` / `globals()` degrade the WHOLE file", () => {
    const ex = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        '    exec("helper = 1")\n' +
        "    return helper()\n",
      ["m.py"]
    );
    expect(ex).toEqual(new Set());
    const gl = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        '    globals()["helper"] = 1\n' +
        "    return helper()\n",
      ["m.py"]
    );
    expect(gl).toEqual(new Set());
  });

  it("row 20: `#` in the CALLER module path declines (module-level only)", () => {
    const e = edgesOf(
      "we#ird.py",
      "from m import helper\ndef bar():\n    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("row 11: an EXTERNAL / unresolvable import binds nothing", () => {
    const e = edgesOf(
      "b.py",
      "from os import path as p\ndef bar():\n    return p.join(1)\n",
      []
    );
    expect(e).toEqual(new Set());
  });

  it("row 22: NEVER throws (garbage / empty / non-Python → edges: [])", () => {
    const noFs: PathExists = () => false;
    expect(
      extractPythonSymbolReferences("def (((", "b.py", `${ROOT}/b.py`, ROOT, noFs)
        .edges
    ).toEqual([]);
    expect(
      extractPythonSymbolReferences("", "b.py", `${ROOT}/b.py`, ROOT, noFs).edges
    ).toEqual([]);
    expect(
      extractPythonSymbolReferences(
        "¯\\_(ツ)_/¯ not python",
        "b.py",
        `${ROOT}/b.py`,
        ROOT,
        noFs
      ).edges
    ).toEqual([]);
  });
});

// ── review-finding regressions (precision hardening) ──────────────────────────

describe("extractPythonSymbolReferences, review-finding regressions", () => {
  it("HIGH-1: a same-quote nested f-string (PEP 701) leaks NO code token", () => {
    // `f"{"helper stuff"}"` — the inner literal inverts toLogicalLines' quote
    // pairing and would otherwise surface a bare `helper` as code; degrade.
    const e = edgesOf(
      "b.py",
      'from m import helper\ns = f"{"helper stuff"}"\n',
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("HIGH-1: the reviewer's nested-literal f-string produces zero edges", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\ns = f\"{'nested {helper} literal'}\"\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("HIGH-1: a braced f-string interpolation degrades the whole file", () => {
    const e = edgesOf(
      "b.py",
      'from m import helper\ndef bar():\n    return f"{helper()}"\n',
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("HIGH-1: a plain f-string with NO brace keeps working (no false degrade)", () => {
    // `f"hello"` is not interpolation → the file is NOT degraded; the genuine
    // reference in `bar` still captures. (Guards the row-18 prefix behaviour.)
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar():\n" +
        '    tag = f"hello"\n' +
        "    return helper(tag)\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#bar"]));
  });

  it("HIGH-2: a `case NAME:` capture pattern poisons the imported name", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(x):\n" +
        "    match x:\n" +
        "        case helper:\n" +
        "            return helper\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
  });

  it("MEDIUM-1: a unicode identifier ending in a bound name is not a reference", () => {
    // `Ωhelper` (leading unicode) and `helperΩ` (trailing unicode) must
    // NOT fragment into a bare `helper` reference.
    const prefix = edgesOf(
      "b.py",
      "from m import helper\ndef bar():\n    return Ωhelper()\n",
      ["m.py"]
    );
    expect(prefix).toEqual(new Set());
    const suffix = edgesOf(
      "b.py",
      "from m import helper\ndef bar():\n    return helperΩ()\n",
      ["m.py"]
    );
    expect(suffix).toEqual(new Set());
  });

  it("MEDIUM-1: a genuine reference beside a unicode identifier still captures", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\ndef bar(é):\n    return helper(é)\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#bar"]));
  });

  it("MEDIUM-2: `<<=` and `>>=` shift-assign poison their target", () => {
    const shl = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def setup():\n" +
        "    helper <<= 1\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(shl).toEqual(new Set());
    const shr = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def setup():\n" +
        "    helper >>= 1\n" +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(shr).toEqual(new Set());
  });

  it("MEDIUM-2: `<=` / `>=` stay comparisons (no false poison)", () => {
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        "def bar(n):\n" +
        "    if n <= 1 and n >= 0:\n" +
        "        return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set(["m.py#helper -> b.py#bar"]));
  });

  it("MEDIUM-3: a pathological logical line degrades the file (completes fast)", () => {
    // A single chained-assignment line with thousands of depth-0 `=` × thousands
    // of tokens makes the O(triggers × tokens) poison scan quadratic; the budget
    // guard degrades the whole file instead of hanging. Without the guard this
    // file emits the genuine `bar` (and the `x0`) edge, so the empty-set
    // assertion is the RED/GREEN discriminator.
    const N = 2000;
    const chained =
      Array.from({ length: N }, (_, i) => `x${i}`).join(" = ") + " = helper\n";
    const started = Date.now();
    const e = edgesOf(
      "b.py",
      "from m import helper\n" +
        chained +
        "def bar():\n" +
        "    return helper()\n",
      ["m.py"]
    );
    expect(e).toEqual(new Set());
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ── F-1 round-trip + no-egress ────────────────────────────────────────────────

describe("extractPythonSymbolReferences, F-1 round-trip + no-egress", () => {
  it("F-1: every edge side's module prefix round-trips via toWorkspaceRelativePosix", () => {
    const exists = existsOver([`${ROOT}/src/b.py`, `${ROOT}/src/m.py`]);
    const { edges } = extractPythonSymbolReferences(
      "from src.m import helper\ndef bar():\n    return helper()\n",
      "src/b.py",
      `${ROOT}/src/b.py`,
      ROOT,
      exists
    );
    expect(edges.length).toBe(1);
    for (const edge of edges) {
      for (const id of [edge.callee, edge.caller]) {
        const mod = moduleOfSymbol(id);
        expect(mod.startsWith("/")).toBe(false);
        expect(mod.startsWith(".")).toBe(false);
        expect(toWorkspaceRelativePosix(ROOT, `${ROOT}/${mod}`)).toBe(mod);
      }
    }
  });

  it("NO EGRESS: extraction opens no socket (pure string + exists predicate)", () => {
    const netConnect = vi.spyOn(net, "connect");
    const socketConnect = vi.spyOn(net.Socket.prototype, "connect");
    const httpsRequest = vi.spyOn(https, "request");
    try {
      edgesOf(
        "b.py",
        "from m import helper\ndef bar():\n    return helper()\n",
        ["m.py"]
      );
      expect(netConnect).not.toHaveBeenCalled();
      expect(socketConnect).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      netConnect.mockRestore();
      socketConnect.mockRestore();
      httpsRequest.mockRestore();
    }
  });
});

// ── adapter wiring over the real on-disk fixture ──────────────────────────────

const FIXTURE = realpathSync(
  fileURLToPath(new URL("./fixtures/python", import.meta.url))
);
const J = (rel: string) => path.join(FIXTURE, rel);

describe("pythonAdapter.createContext exposes extractReferences (real fixture)", () => {
  it("service.py yields exactly app/util.py#helper -> app/service.py#serve", () => {
    const ctx = pythonAdapter.createContext(FIXTURE);
    expect(ctx.extractReferences).toBeTypeOf("function");
    const serviceText = readFileSync(J("app/service.py"), "utf8");
    const res = ctx.extractReferences!(
      serviceText,
      "app/service.py",
      J("app/service.py")
    );
    expect(res.edges).toEqual([
      { callee: "app/util.py#helper", caller: "app/service.py#serve" },
    ]);
  });

  it("main.py yields NO symbol edges (unaliased import + __init__ from-import)", () => {
    const ctx = pythonAdapter.createContext(FIXTURE);
    const mainText = readFileSync(J("app/main.py"), "utf8");
    const res = ctx.extractReferences!(mainText, "app/main.py", J("app/main.py"));
    expect(res.edges).toEqual([]);
  });
});
