import path from "node:path";
import { pathToFileURL } from "node:url";
import { reverseSymbolClosure } from "./closure.js";
import { toWorkspaceRelativePosix } from "./paths.js";
import { extractPythonSymbolReferences } from "./python-symbol-refs.js";

/**
 * REC-010 (ADR-0015 parity) — the HONEST, labeled eval of the PYTHON symbol-level
 * reference extractor, the sibling of `symbol-refs-eval.ts` (TS) and
 * `python-imports-eval.ts` (the Python MODULE layer). It scores the SHIPPED
 * `extractPythonSymbolReferences` + `reverseSymbolClosure` (the exact indexer /
 * provider path) against a hand-labeled fixture of ground-truth referencers per
 * target `M#foo`:
 *   - TRUE  referencers — symbols that DO reference the target and are CAPTURED
 *     (recall true-positives), plus symbols that DO reference it but are
 *     DELIBERATELY DEGRADED (star / `__init__` re-export / unaliased import /
 *     conditional import / shadowing / monkey-patch) → recall false-negatives
 *     (`degradedTrue`);
 *   - FALSE referencers — symbols in importing-but-not-referencing modules,
 *     shadowed locals, patched aliases — which must NEVER be emitted (a single
 *     one fails PRECISION, the merge gate).
 *
 * PRECISION IS THE GATE (ADR-0015 reviewer note 1 / the ADR-0016 cardinal rule):
 * precision MUST be 1.0, one wrong symbol edge fails the merge. RECALL is
 * explicitly SECONDARY: the `degradedTrue` referencers intentionally lower it
 * (under-inclusion via degrade is safe; the coarse module edge still covers them).
 *
 * FAITHFUL + PURE: the REAL extractor over an in-memory `exists` Set (the
 * `python-imports-eval` pattern — no fs, no network, no clock), so every number
 * is a reproducible fact. It validates the LOGIC on a designer-authored set,
 * not a large-corpus benchmark.
 */

export const PYTHON_SYMBOL_REFS_EVAL_HONESTY =
  "This eval scores the SHIPPED Python symbol-reference extractor on a small, " +
  "hand-labeled fixture (like ADR-0015 symbol-refs-eval / ADR-0016 " +
  "python-imports-eval). PRECISION is the gate (must be 1.0, a single wrong " +
  "symbol edge fails); RECALL is secondary and is deliberately lowered by the " +
  "degrade fixtures. Pure in-memory (an `exists` Set, no fs/network/clock), so " +
  "every number is reproducible.";

/** The synthetic repo root the eval resolves/canonicalizes against (never disk). */
export const PY_REF_EVAL_ROOT = "/repo";

export type PyRefEvalFile = {
  /** Workspace-relative POSIX module path (e.g. `b.py`). */
  module: string;
  text: string;
};

export type PyRefEvalScenario = {
  id: string;
  /** The degrade-table row (or "capture") this scenario exercises. */
  rule: string;
  files: PyRefEvalFile[];
  /** Extra paths that EXIST for resolution but carry no source (e.g. inits). */
  alsoExists?: string[];
  /** The callee symbol id whose referencers we query (`<module>#<name>`). */
  target: string;
  /** Ground-truth referencers the extractor SHOULD capture (recall positives). */
  trueReferencers: string[];
  /** Ground-truth referencers that DO reference the target but the extractor
   *  DELIBERATELY degrades (recall false-negatives; precision-safe). */
  degradedTrue?: string[];
  /** Symbols that must NEVER be emitted for this target (precision negatives). */
  falseReferencers: string[];
};

export type PyRefEvalSet = {
  scenarios: PyRefEvalScenario[];
};

/**
 * Build the reverse SYMBOL-reference adjacency for one scenario's files, using
 * the REAL `extractPythonSymbolReferences` over an in-memory `exists` Set — the
 * same call the indexer makes through `pythonAdapter.createContext`.
 */
export function buildScenarioPySymbolReverse(
  files: PyRefEvalFile[],
  alsoExists: string[] = []
): Map<string, Set<string>> {
  const existsSet = new Set<string>();
  for (const file of files) {
    existsSet.add(path.join(PY_REF_EVAL_ROOT, file.module));
  }
  for (const extra of alsoExists) {
    existsSet.add(path.join(PY_REF_EVAL_ROOT, extra));
  }
  const exists = (p: string) => existsSet.has(p);
  const symbolReverse = new Map<string, Set<string>>();
  for (const file of files) {
    const fromFile = path.join(PY_REF_EVAL_ROOT, file.module);
    const modulePath = toWorkspaceRelativePosix(PY_REF_EVAL_ROOT, fromFile);
    if (modulePath === null) {
      continue;
    }
    const { edges } = extractPythonSymbolReferences(
      file.text,
      modulePath,
      fromFile,
      PY_REF_EVAL_ROOT,
      exists
    );
    for (const edge of edges) {
      let set = symbolReverse.get(edge.callee);
      if (!set) {
        set = new Set<string>();
        symbolReverse.set(edge.callee, set);
      }
      set.add(edge.caller);
    }
  }
  return symbolReverse;
}

/** The referencers the shipped path emits for a scenario's target (the REAL
 *  `reverseSymbolClosure`, provider limits). */
export function emittedPyReferencers(scenario: PyRefEvalScenario): string[] {
  const symbolReverse = buildScenarioPySymbolReverse(
    scenario.files,
    scenario.alsoExists ?? []
  );
  return reverseSymbolClosure(symbolReverse, [scenario.target], {
    maxDepth: 3,
    maxSymbols: 256,
  }).symbols;
}

export type PyRefEvalReport = {
  honesty: string;
  scenarios: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** The offending (scenario, emitted-but-not-true) pairs, empty when precision=1. */
  wrongEdges: { scenario: string; emitted: string }[];
};

/**
 * Score the shipped extractor over the labeled set. Micro-averaged: a
 * `trueReferencer` emitted is a TP; missed is an FN; a `degradedTrue` is always
 * an FN (never emitted, by design); ANY emitted symbol not in `trueReferencers`
 * is an FP, the precision-killer. Pure.
 */
export function runPythonSymbolRefsEval(evalSet: PyRefEvalSet): PyRefEvalReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const wrongEdges: { scenario: string; emitted: string }[] = [];

  for (const scenario of evalSet.scenarios) {
    const emitted = new Set(emittedPyReferencers(scenario));
    const trueSet = new Set(scenario.trueReferencers);

    for (const truth of scenario.trueReferencers) {
      if (emitted.has(truth)) {
        tp += 1;
      } else {
        fn += 1;
      }
    }
    for (const _degraded of scenario.degradedTrue ?? []) {
      fn += 1;
    }
    for (const got of emitted) {
      if (!trueSet.has(got)) {
        fp += 1;
        wrongEdges.push({ scenario: scenario.id, emitted: got });
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
    honesty: PYTHON_SYMBOL_REFS_EVAL_HONESTY,
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

export function formatPythonSymbolRefsEvalReport(
  report: PyRefEvalReport
): string {
  const pct = (n: number) => n.toFixed(4);
  return [
    "[REC-010 Python symbol-reference impact, HONEST labeled eval]",
    report.honesty,
    `  scenarios: ${report.scenarios}`,
    `  PRECISION=${pct(report.precision)} (GATE: must be 1.0)  RECALL=${pct(
      report.recall
    )}  F1=${pct(report.f1)}`,
    `  tp=${report.truePositives} fp=${report.falsePositives} fn=${report.falseNegatives} (fn includes the deliberate degrade misses)`,
    report.wrongEdges.length === 0
      ? "  wrong edges: NONE (precision gate holds)"
      : `  WRONG EDGES: ${report.wrongEdges
          .map((w) => `${w.scenario}:${w.emitted}`)
          .join(", ")}`,
  ].join("\n");
}

// ── the labeled fixture corpus ────────────────────────────────────────────────

/**
 * Ground truth: capture-cases (precision + recall) and one fixture per degrade
 * row. Every FALSE referencer lives in a module whose MODULE edge still covers
 * it, but must NOT surface as a SYMBOL edge.
 */
export const DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET: PyRefEvalSet = {
  scenarios: [
    {
      id: "attribution",
      rule: "capture",
      files: [
        {
          module: "m.py",
          text: "def helper(x):\n    return x\ndef other(x):\n    return x\n",
        },
        {
          // `bar` references helper → TRUE; `unrelated` imports it but never uses.
          module: "b.py",
          text:
            "from m import helper\n" +
            "def bar():\n" +
            "    return helper(1)\n" +
            "def unrelated():\n" +
            "    return 42\n",
        },
        {
          // `from m import helper as h` → baz references h (= helper) → TRUE.
          module: "c.py",
          text: "from m import helper as h\ndef baz():\n    return h(2)\n",
        },
        {
          // references `other`, NOT helper → must NOT surface for m.py#helper.
          module: "d.py",
          text: "from m import other\ndef uses_other():\n    return other(3)\n",
        },
      ],
      target: "m.py#helper",
      trueReferencers: ["b.py#bar", "c.py#baz"],
      falseReferencers: ["b.py#unrelated", "d.py#uses_other"],
    },
    {
      id: "alias-attr",
      rule: "capture-alias-attr",
      files: [
        {
          module: "util/helpers.py",
          text: "def compute(x):\n    return x\n",
        },
        {
          // `import x.y as m` + `m.attr` → the capture TS deliberately lacks.
          module: "b.py",
          text:
            "import util.helpers as uh\ndef bar():\n    return uh.compute(1)\n",
        },
      ],
      target: "util/helpers.py#compute",
      trueReferencers: ["b.py#bar"],
      falseReferencers: [],
    },
    {
      id: "transitive-chain",
      rule: "capture",
      files: [
        { module: "m.py", text: "v0 = 0\n" },
        { module: "a.py", text: "from m import v0\nv1 = v0 + 1\n" },
        { module: "b.py", text: "from a import v1\nv2 = v1 + 1\n" },
      ],
      target: "m.py#v0",
      trueReferencers: ["a.py#v1", "b.py#v2"],
      falseReferencers: [],
    },
    {
      id: "decorator",
      rule: "capture-decorator",
      files: [
        { module: "deco.py", text: "def route(f):\n    return f\n" },
        {
          module: "b.py",
          text: "from deco import route\n@route\ndef handler():\n    return 1\n",
        },
      ],
      target: "deco.py#route",
      trueReferencers: ["b.py#handler"],
      falseReferencers: [],
    },
    {
      id: "class-attribution",
      rule: "capture-class",
      files: [
        { module: "m.py", text: "def helper(x):\n    return x\n" },
        {
          module: "b.py",
          text:
            "from m import helper\n" +
            "class C:\n" +
            "    def method(self):\n" +
            "        return helper(1)\n",
        },
      ],
      target: "m.py#helper",
      trueReferencers: ["b.py#C"],
      falseReferencers: [],
    },
    {
      id: "toplevel-assignment",
      rule: "capture-assignment",
      files: [
        { module: "m.py", text: "def helper(x):\n    return x\n" },
        { module: "b.py", text: "from m import helper\nVALUE = helper(2)\n" },
      ],
      target: "m.py#helper",
      trueReferencers: ["b.py#VALUE"],
      falseReferencers: [],
    },
    {
      id: "degrade-star-import",
      rule: "star",
      files: [
        { module: "m.py", text: "def helper(x):\n    return x\n" },
        {
          // `bar` genuinely references helper, but a star import means unknown
          // names entered scope → the WHOLE file degrades (recall miss only).
          module: "b.py",
          text: "from m import *\ndef bar():\n    return helper(1)\n",
        },
      ],
      target: "m.py#helper",
      trueReferencers: [],
      degradedTrue: ["b.py#bar"],
      falseReferencers: ["b.py#bar"],
    },
    {
      id: "degrade-init-reexport",
      rule: "init-barrel",
      files: [
        { module: "pkg/util.py", text: "def helper(x):\n    return x\n" },
        { module: "pkg/__init__.py", text: "from .util import helper\n" },
        {
          // imports helper FROM the package __init__ → the defining module is
          // unknowable without executing the barrel → DEGRADE for the target.
          module: "b.py",
          text: "from pkg import helper\ndef bar():\n    return helper(1)\n",
        },
      ],
      target: "pkg/util.py#helper",
      trueReferencers: [],
      degradedTrue: ["b.py#bar"],
      falseReferencers: ["b.py#bar"],
    },
    {
      id: "degrade-init-reexport-sibling",
      rule: "init-barrel",
      files: [
        { module: "pkg/util.py", text: "def helper(x):\n    return x\n" },
        { module: "pkg/__init__.py", text: "from .util import helper\n" },
        {
          module: "b.py",
          text: "from pkg import helper\ndef bar():\n    return helper(1)\n",
        },
      ],
      // The binding is blocked ENTIRELY: b.py#bar surfaces for NEITHER the
      // defining module's id nor the package id.
      target: "pkg/__init__.py#helper",
      trueReferencers: [],
      falseReferencers: ["b.py#bar"],
    },
    {
      id: "degrade-plain-import",
      rule: "unaliased-dotted",
      files: [
        { module: "util/helpers.py", text: "def compute(x):\n    return x\n" },
        {
          // unaliased `import a.b` + `a.b.attr` → dotted-chain attribution is
          // ambiguous (package attr vs submodule) → no binding.
          module: "b.py",
          text:
            "import util.helpers\ndef bar():\n    return util.helpers.compute(1)\n",
        },
      ],
      target: "util/helpers.py#compute",
      trueReferencers: [],
      degradedTrue: ["b.py#bar"],
      falseReferencers: ["b.py#bar"],
    },
    {
      id: "degrade-tryexcept-import",
      rule: "conditional-import",
      files: [
        { module: "m.py", text: "def helper(x):\n    return x\n" },
        {
          // Double-protected: the import is INDENTED (no binding) AND the
          // except-arm assignment poisons the name.
          module: "b.py",
          text:
            "try:\n" +
            "    from m import helper\n" +
            "except ImportError:\n" +
            "    helper = None\n" +
            "def bar():\n" +
            "    return helper(1)\n",
        },
      ],
      target: "m.py#helper",
      trueReferencers: [],
      degradedTrue: ["b.py#bar"],
      falseReferencers: ["b.py#bar"],
    },
    {
      id: "degrade-shadowing",
      rule: "shadowing",
      files: [
        { module: "m.py", text: "def helper(x):\n    return x\n" },
        {
          // `bar` rebinds helper locally → the name is poisoned MODULE-WIDE, so
          // baz's GENUINE use degrades too (recall miss, never a wrong edge).
          module: "b.py",
          text:
            "from m import helper\n" +
            "def bar():\n" +
            "    helper = 5\n" +
            "    return helper\n" +
            "def baz():\n" +
            "    return helper(1)\n",
        },
      ],
      target: "m.py#helper",
      trueReferencers: [],
      degradedTrue: ["b.py#baz"],
      falseReferencers: ["b.py#bar", "b.py#baz"],
    },
    {
      id: "degrade-monkey-patch",
      rule: "monkey-patch",
      files: [
        { module: "util/helpers.py", text: "def compute(x):\n    return x\n" },
        {
          // `uh.compute = fake` mutates the module object → the alias is
          // poisoned, bar's genuine `uh.compute(1)` degrades with it.
          module: "b.py",
          text:
            "import util.helpers as uh\n" +
            "def patch(fake):\n" +
            "    uh.compute = fake\n" +
            "def bar():\n" +
            "    return uh.compute(1)\n",
        },
      ],
      target: "util/helpers.py#compute",
      trueReferencers: [],
      degradedTrue: ["b.py#bar"],
      falseReferencers: ["b.py#patch", "b.py#bar"],
    },
  ],
};

// Runnable: `node dist/python-symbol-refs-eval.js` prints the report. Guarded so
// importing this module (tests / the index barrel) never triggers it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // eslint-disable-next-line no-console
  console.log(
    formatPythonSymbolRefsEvalReport(
      runPythonSymbolRefsEval(DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET)
    )
  );
}
