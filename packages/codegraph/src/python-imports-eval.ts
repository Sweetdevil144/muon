import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractImports, resolvePythonImport } from "./adapters/python.js";
import { toWorkspaceRelativePosix } from "./paths.js";

/**
 * ADR-0016 §10 / gate 1, the HONEST, labeled eval of the Python MODULE-LEVEL
 * import adapter, the sibling of ADR-0015's `symbol-refs-eval`. It scores the
 * SHIPPED extractor + resolver (`extractImports` → `resolvePythonImport`, the exact
 * indexer path) against a hand-labeled fixture of ground-truth INTRA-REPO import
 * edges per file + an explicit MUST-NOT set (docstring import-lines,
 * `importlib`/`__import__`, `sys.path`-only, root-escaping relatives, package/name
 * ambiguity, namespace packages).
 *
 * PRECISION IS THE GATE (the ADR-0016 cardinal sin applied at MODULE level):
 * precision = |emitted ∩ expected| / |emitted| MUST be ≈ 1.0, a single WRONG module
 * edge fails the merge. RECALL is explicitly SECONDARY and is deliberately lowered
 * by the conservative `from X import n → X`-only rule (`degradedMisses`): a missed
 * import is safe under-inclusion, a coarse `__init__.py` edge still covers it.
 *
 * FAITHFUL + PURE. Resolution runs over an in-memory `exists` predicate (a Set, no
 * fs, no network, no clock), so every number is a reproducible fact, the same
 * discipline as the other evals. It validates the LOGIC on a small designer-authored
 * set, not a large-corpus benchmark.
 */

export const PYTHON_IMPORTS_EVAL_HONESTY =
  "This eval scores the SHIPPED Python import extractor+resolver on a small, " +
  "hand-labeled fixture (like ADR-0015 symbol-refs-eval). PRECISION is the gate " +
  "(must be ~1.0, a single wrong MODULE edge fails); RECALL is secondary and is " +
  "deliberately lowered by the conservative `from X import n → X`-only rule. Pure " +
  "in-memory (an `exists` Set, no fs/network/clock), so every number is reproducible.";

/** The synthetic repo root the eval resolves/canonicalizes against (never on disk). */
export const PY_EVAL_ROOT = "/repo";

export type PyEvalFile = {
  /** Workspace-relative POSIX module path (e.g. `app/main.py`). */
  module: string;
  text: string;
};

export type PyEvalScenario = {
  id: string;
  /** The §5.3 degrade row (or "capture") this scenario exercises. */
  rule: string;
  files: PyEvalFile[];
  /** Extra paths that EXIST for resolution but carry no imports (rare, most are
   *  modeled as empty `files`). */
  alsoExists?: string[];
  /** Ground-truth intra-repo edges the adapter SHOULD emit: fromModule → targets. */
  expectedEdges: Record<string, string[]>;
  /** Edges that must NEVER be emitted (precision negatives). */
  mustNot?: Record<string, string[]>;
  /** Count of intra-repo edges a FULLER analyzer would find but v1 deliberately
   *  skips (the conservative recall lever), counted as recall false-negatives. */
  degradedMisses?: number;
};

export type PyEvalSet = {
  scenarios: PyEvalScenario[];
};

/** The absolute existence set for one scenario (all `files` + `alsoExists`). */
function existenceSet(scenario: PyEvalScenario): Set<string> {
  const set = new Set<string>();
  for (const file of scenario.files) {
    set.add(path.join(PY_EVAL_ROOT, file.module));
  }
  for (const extra of scenario.alsoExists ?? []) {
    set.add(path.join(PY_EVAL_ROOT, extra));
  }
  return set;
}

/**
 * Build the emitted intra-repo edge set (`"from|to"` module pairs) for one scenario,
 * using the REAL `extractImports` + `resolvePythonImport`, the exact indexer path.
 * Self-edges are dropped (the indexer drops `target === file`).
 */
export function buildScenarioEdges(scenario: PyEvalScenario): Set<string> {
  const existsSet = existenceSet(scenario);
  const exists = (p: string) => existsSet.has(p);
  const edges = new Set<string>();
  for (const file of scenario.files) {
    const fromFile = path.join(PY_EVAL_ROOT, file.module);
    for (const ref of extractImports(file.text)) {
      const abs = resolvePythonImport(PY_EVAL_ROOT, fromFile, ref, exists);
      if (!abs) {
        continue;
      }
      const toModule = toWorkspaceRelativePosix(PY_EVAL_ROOT, abs);
      if (toModule === null || toModule === file.module) {
        continue;
      }
      edges.add(`${file.module}|${toModule}`);
    }
  }
  return edges;
}

/** The emitted edges for a scenario as `{ from, to }[]` (for assertions/reporting). */
export function emittedPythonEdges(
  scenario: PyEvalScenario
): { from: string; to: string }[] {
  return [...buildScenarioEdges(scenario)].map((e) => {
    const [from, to] = e.split("|");
    return { from, to };
  });
}

function expectedEdgeSet(scenario: PyEvalScenario): Set<string> {
  const set = new Set<string>();
  for (const [from, targets] of Object.entries(scenario.expectedEdges)) {
    for (const to of targets) {
      set.add(`${from}|${to}`);
    }
  }
  return set;
}

export type PyEvalReport = {
  honesty: string;
  scenarios: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** The offending (scenario, wrong edge) pairs, empty when precision = 1. */
  wrongEdges: { scenario: string; edge: string }[];
};

/**
 * Score the shipped extractor+resolver over the labeled set. A ground-truth edge
 * emitted is a TP; a ground-truth edge missed is an FN; each `degradedMisses` is an
 * FN (deliberate, precision-safe); ANY emitted edge not in `expectedEdges` is an FP,
 * the precision-killer (a single one fails the gate). Pure.
 */
export function runPythonImportsEval(evalSet: PyEvalSet): PyEvalReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const wrongEdges: { scenario: string; edge: string }[] = [];

  for (const scenario of evalSet.scenarios) {
    const emitted = buildScenarioEdges(scenario);
    const expected = expectedEdgeSet(scenario);

    for (const want of expected) {
      if (emitted.has(want)) {
        tp += 1;
      } else {
        fn += 1;
      }
    }
    fn += scenario.degradedMisses ?? 0;
    for (const got of emitted) {
      if (!expected.has(got)) {
        fp += 1;
        wrongEdges.push({ scenario: scenario.id, edge: got });
      }
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return {
    honesty: PYTHON_IMPORTS_EVAL_HONESTY,
    scenarios: evalSet.scenarios.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    wrongEdges,
  };
}

export function formatPythonImportsEvalReport(report: PyEvalReport): string {
  const pct = (n: number) => n.toFixed(4);
  return [
    "[ADR-0016 Python module-level import adapter, HONEST labeled eval]",
    report.honesty,
    `  scenarios: ${report.scenarios}`,
    `  PRECISION=${pct(report.precision)} (GATE: must be ~1.0)  RECALL=${pct(
      report.recall
    )}  F1=${pct(report.f1)}`,
    `  tp=${report.truePositives} fp=${report.falsePositives} fn=${report.falseNegatives} (fn includes the conservative degrade misses)`,
    report.wrongEdges.length === 0
      ? "  wrong edges: NONE (precision gate holds)"
      : `  WRONG EDGES: ${report.wrongEdges
          .map((w) => `${w.scenario}:${w.edge}`)
          .join(", ")}`,
  ].join("\n");
}

// ── the labeled fixture ──────────────────────────────────────────────────────

/**
 * Ground truth: capture-cases (precision + recall) and one fixture per §5.3 degrade
 * row. Every MUST-NOT edge is one a NAIVE scanner/resolver would fabricate but the
 * adapter must refuse (docstring line, dynamic import, package/name ambiguity, …).
 */
export const DEFAULT_PYTHON_IMPORTS_EVAL_SET: PyEvalSet = {
  scenarios: [
    {
      id: "absolute-and-from",
      rule: "capture",
      files: [
        { module: "app/__init__.py", text: "" },
        {
          module: "app/main.py",
          text: "import app.service\nfrom app import config\n",
        },
        { module: "app/service.py", text: "from app.util import helper\n" },
        { module: "app/util.py", text: "def helper():\n    return 1\n" },
        { module: "app/config.py", text: "VALUE = 1\n" },
      ],
      expectedEdges: {
        // `import app.service` → the submodule file; `from app import config` →
        // the package `__init__.py` ONLY (conservative, NOT app/config.py).
        "app/main.py": ["app/service.py", "app/__init__.py"],
        "app/service.py": ["app/util.py"],
      },
      mustNot: {
        // The package-vs-name ambiguity: config is resolved to the package, never
        // the speculative submodule.
        "app/main.py": ["app/config.py"],
      },
      // `from app import config` deliberately misses the ideal `app/config.py` edge.
      degradedMisses: 1,
    },
    {
      id: "relative-import",
      rule: "capture",
      files: [
        { module: "pkg/__init__.py", text: "" },
        {
          module: "pkg/mod.py",
          text: "from . import sibling\nfrom .sibling import thing\n",
        },
        { module: "pkg/sibling.py", text: "def thing():\n    return 2\n" },
      ],
      expectedEdges: {
        // `from . import sibling` → the current package's `__init__.py`;
        // `from .sibling import thing` → the sibling module file.
        "pkg/mod.py": ["pkg/__init__.py", "pkg/sibling.py"],
      },
    },
    {
      id: "relative-parent",
      rule: "capture",
      files: [
        { module: "pkg/__init__.py", text: "" },
        { module: "pkg/sub/__init__.py", text: "" },
        { module: "pkg/sub/mod.py", text: "from ..other import x\n" },
        { module: "pkg/other.py", text: "x = 1\n" },
      ],
      expectedEdges: {
        // `from ..other import x` → up one package, then `other` module file.
        "pkg/sub/mod.py": ["pkg/other.py"],
      },
    },
    {
      id: "docstring",
      rule: "docstring",
      files: [
        { module: "pkg/__init__.py", text: "" },
        { module: "pkg/secret.py", text: "" },
        { module: "pkg/real.py", text: "" },
        {
          module: "app.py",
          text:
            '"""Module docstring.\n\n' +
            "    import pkg.secret\n" +
            "    from pkg import secret\n" +
            '"""\n\n\n' +
            "def handler():\n" +
            "    '''Inner docstring\n" +
            "    import pkg.secret\n" +
            "    '''\n" +
            "    return 1\n\n\n" +
            "import pkg.real\n",
        },
      ],
      expectedEdges: {
        // ONLY the real module-level import outside every docstring.
        "app.py": ["pkg/real.py"],
      },
      mustNot: {
        // The triple-quote state machine must suppress the docstring import-lines.
        "app.py": ["pkg/secret.py", "pkg/__init__.py"],
      },
    },
    {
      id: "dynamic-import",
      rule: "dynamic-import",
      files: [
        { module: "pkg/__init__.py", text: "" },
        { module: "pkg/util.py", text: "" },
        {
          module: "app.py",
          text:
            "import importlib\n" +
            'mod = importlib.import_module("pkg.util")\n' +
            'other = __import__("pkg")\n',
        },
      ],
      // `importlib` is external → null; `import_module`/`__import__` are not static
      // import statements → no edge.
      expectedEdges: {},
      mustNot: { "app.py": ["pkg/util.py", "pkg/__init__.py"] },
    },
    {
      id: "namespace-package",
      rule: "namespace",
      // PEP 420: `ns` has NO `__init__.py`.
      files: [
        { module: "ns/leaf.py", text: "" },
        { module: "app.py", text: "import ns.leaf\nfrom ns import thing\n" },
      ],
      expectedEdges: {
        // The leaf module resolves by file existence even without a package init…
        "app.py": ["ns/leaf.py"],
      },
      mustNot: {
        // …but `from ns import thing` finds no package `__init__.py` → no edge.
        "app.py": ["ns/__init__.py"],
      },
    },
    {
      id: "star-import",
      rule: "star",
      files: [
        { module: "pkg/__init__.py", text: "" },
        { module: "app.py", text: "from pkg import *\n" },
      ],
      // `from a import *` → the module edge to `a` is kept.
      expectedEdges: { "app.py": ["pkg/__init__.py"] },
    },
    {
      id: "conditional-typechecking",
      rule: "conditional",
      files: [
        { module: "pkg/__init__.py", text: "" },
        { module: "pkg/util.py", text: "" },
        {
          module: "app.py",
          text:
            "from typing import TYPE_CHECKING\n" +
            "if TYPE_CHECKING:\n" +
            "    import pkg.util\n",
        },
      ],
      // A conditional / TYPE_CHECKING import is a real potential dependency → kept
      // (indented import captured; `typing` is external → null).
      expectedEdges: { "app.py": ["pkg/util.py"] },
    },
    {
      id: "sys-path",
      rule: "sys-path",
      files: [
        {
          module: "app.py",
          text:
            "import sys\n" +
            'sys.path.insert(0, "vendor")\n' +
            "import vendored\n",
        },
      ],
      // `sys` is external; `vendored` matches no candidate base → null (safe miss).
      expectedEdges: {},
    },
    {
      id: "root-escaping-relative",
      rule: "root-escape",
      files: [{ module: "mod.py", text: "from ...... import x\n" }],
      // 6 leading dots walk above the root → isWithin / canonicalizer → null.
      expectedEdges: {},
    },
    {
      id: "multiline-parenthesized",
      rule: "paren-join",
      files: [
        { module: "pkg/__init__.py", text: "" },
        {
          module: "app.py",
          text: "from pkg import (\n    a,\n    b,\n    c,\n)\n",
        },
      ],
      // The logical-line joiner reconstructs the parenthesized clause → module edge.
      expectedEdges: { "app.py": ["pkg/__init__.py"] },
    },
  ],
};

// Runnable: `node dist/python-imports-eval.js` prints the report. Guarded so
// importing this module (tests / the index barrel) never triggers it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // eslint-disable-next-line no-console
  console.log(
    formatPythonImportsEvalReport(
      runPythonImportsEval(DEFAULT_PYTHON_IMPORTS_EVAL_SET)
    )
  );
}
