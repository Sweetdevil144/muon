import path from "node:path";
import { pathToFileURL } from "node:url";
import { reverseSymbolClosure } from "./closure.js";
import { toWorkspaceRelativePosix } from "./paths.js";
import type { Resolver } from "./resolver.js";
import { extractSymbolReferences } from "./symbol-refs.js";

/**
 * ADR-0015 §6, the HONEST, held-out-style eval of CG-1 symbol-level reference
 * impact, the codegraph sibling of KG-4's `retrieval-eval` and KG-11's
 * `activity-eval`. It scores the SHIPPED extractor (`extractSymbolReferences` +
 * `reverseSymbolClosure`, the exact provider path) against a hand-labeled fixture of
 * ground-truth referencers per target `M#foo`:
 *   - TRUE  referencers, symbols that DO reference the target and are CAPTURED
 *     (recall true-positives), plus symbols that DO reference it but are DELIBERATELY
 *     DEGRADED (namespace / barrel) → recall false-negatives (`degradedTrue`);
 *   - FALSE referencers, symbols in importing-but-not-referencing modules
 *     (`unrelated`), same-name-elsewhere, shadowed locals, computed member keys,
 *     which must NEVER be emitted (a single one fails PRECISION, the gate metric).
 *
 * PRECISION IS THE GATE (ADR-0015 reviewer note 1): precision = |emitted ∩ true| /
 * |emitted| MUST be ≈ 1.0, one wrong symbol edge fails the merge. RECALL is
 * explicitly SECONDARY: the `degradedTrue` referencers intentionally lower it
 * (under-inclusion via degrade is safe; a coarse module edge still covers them).
 *
 * FAITHFUL + PURE. It calls the REAL `extractSymbolReferences` over a fake in-memory
 * resolver (no fs, no network, no clock) so every number is a reproducible fact,
 * the same discipline as the other evals. It is NOT a large-corpus generalization
 * benchmark; it validates the LOGIC on a small, designer-authored set.
 */

export const SYMBOL_REFS_EVAL_HONESTY =
  "This eval scores the SHIPPED symbol-reference extractor on a small, hand-labeled " +
  "fixture (like KG-4 retrieval-eval / KG-11 activity-eval). PRECISION is the gate " +
  "(must be ~1.0, a single wrong symbol edge fails); RECALL is secondary and is " +
  "deliberately lowered by the degrade fixtures. Pure in-memory (no fs/network/clock), " +
  "so every number is reproducible.";

/** The synthetic repo root the eval canonicalizes against (never touches disk). */
export const EVAL_ROOT = "/repo";

export type RefEvalFile = {
  /** Workspace-relative POSIX module path (e.g. `b.ts`). */
  module: string;
  text: string;
};

export type RefEvalScenario = {
  id: string;
  /** The §4 rule this scenario exercises (for the report + the degrade-matrix map). */
  rule: string;
  files: RefEvalFile[];
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

export type RefEvalSet = {
  scenarios: RefEvalScenario[];
};

/**
 * A FAKE resolver over a flat in-memory file set, resolves relative specifiers to
 * their module by extension-probing the known module set, and drops bare/external
 * specifiers (exactly the intra-repo-only contract of the real resolver). Pure.
 */
function fakeResolver(modules: Set<string>): Resolver {
  return {
    resolve(fromFile: string, specifier: string): string | null {
      if (!specifier.startsWith(".")) {
        return null; // external / bare → never an intra-repo edge
      }
      const joined = path.posix.normalize(
        path.posix.join(path.posix.dirname(fromFile), specifier)
      );
      const base = joined.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "");
      const modRel = base.slice(EVAL_ROOT.length + 1);
      for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
        if (modules.has(modRel + ext)) {
          return `${EVAL_ROOT}/${modRel}${ext}`;
        }
      }
      return null;
    },
  };
}

/** Build the reverse SYMBOL-reference adjacency for one scenario's files, using the
 *  REAL `extractSymbolReferences`, the same call the indexer makes. */
export function buildScenarioSymbolReverse(
  files: RefEvalFile[]
): Map<string, Set<string>> {
  const modules = new Set(files.map((f) => f.module));
  const resolver = fakeResolver(modules);
  const symbolReverse = new Map<string, Set<string>>();
  for (const file of files) {
    const fromFile = `${EVAL_ROOT}/${file.module}`;
    const modulePath = toWorkspaceRelativePosix(EVAL_ROOT, fromFile);
    if (modulePath === null) {
      continue;
    }
    const { edges } = extractSymbolReferences(
      file.text,
      modulePath,
      resolver,
      fromFile,
      EVAL_ROOT
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

/** The referencers the shipped path emits for a scenario's target. */
export function emittedReferencers(scenario: RefEvalScenario): string[] {
  const symbolReverse = buildScenarioSymbolReverse(scenario.files);
  return reverseSymbolClosure(symbolReverse, [scenario.target], {
    maxDepth: 3,
    maxSymbols: 256,
  }).symbols;
}

export type RefEvalReport = {
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
 * Score the shipped extractor over the labeled set. Micro-averaged over every
 * (target, candidate) decision: a `trueReferencer` emitted is a TP; a
 * `trueReferencer` missed is an FN; a `degradedTrue` is always an FN (never
 * emitted, by design); ANY emitted symbol not in `trueReferencers` is an FP, the
 * precision-killer. Pure.
 */
export function runSymbolRefsEval(evalSet: RefEvalSet): RefEvalReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const wrongEdges: { scenario: string; emitted: string }[] = [];

  for (const scenario of evalSet.scenarios) {
    const emitted = new Set(emittedReferencers(scenario));
    const trueSet = new Set(scenario.trueReferencers);

    for (const truth of scenario.trueReferencers) {
      if (emitted.has(truth)) {
        tp += 1;
      } else {
        fn += 1;
      }
    }
    // Deliberately-degraded true referencers are recall misses (never captured).
    for (const _degraded of scenario.degradedTrue ?? []) {
      fn += 1;
    }
    // Any emitted symbol that is not a ground-truth true referencer is a WRONG edge.
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
    honesty: SYMBOL_REFS_EVAL_HONESTY,
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

export function formatSymbolRefsEvalReport(report: RefEvalReport): string {
  const pct = (n: number) => n.toFixed(4);
  return [
    "[ADR-0015 CG-1 symbol-reference impact, HONEST labeled eval]",
    report.honesty,
    `  scenarios: ${report.scenarios}`,
    `  PRECISION=${pct(report.precision)} (GATE: must be ~1.0)  RECALL=${pct(
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

// ── the labeled fixture ──────────────────────────────────────────────────────

/**
 * The ground-truth set: capture-cases (precision + recall) and one fixture per §4
 * degrade rule. Every FALSE referencer lives in a module that IMPORTS the target's
 * module (so the MODULE edge still covers it) but must NOT surface as a SYMBOL edge.
 */
export const DEFAULT_SYMBOL_REFS_EVAL_SET: RefEvalSet = {
  scenarios: [
    {
      id: "attribution",
      rule: "capture",
      files: [
        {
          module: "m.ts",
          text: "export function foo(){ return 1; }\nexport function other(){ return 2; }",
        },
        {
          // `bar` references foo → TRUE; `unrelated` imports foo but never uses it.
          module: "b.ts",
          text: "import { foo } from './m';\nexport function bar(){ return foo(); }\nexport function unrelated(){ return 42; }",
        },
        {
          // `import { foo as f }` → `baz` references f (= foo) → TRUE.
          module: "c.ts",
          text: "import { foo as f } from './m';\nexport const baz = () => f();",
        },
        {
          // references `other`, NOT foo → must NOT surface for target m.ts#foo.
          module: "d.ts",
          text: "import { other } from './m';\nexport function usesOther(){ return other(); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: ["b.ts#bar", "c.ts#baz"],
      falseReferencers: ["b.ts#unrelated", "d.ts#usesOther"],
    },
    {
      id: "transitive-chain",
      rule: "capture",
      files: [
        { module: "m.ts", text: "export const v0 = 0;" },
        {
          module: "a.ts",
          text: "import { v0 } from './m';\nexport const v1 = v0 + 1;",
        },
        {
          module: "b.ts",
          text: "import { v1 } from './a';\nexport const v2 = v1 + 1;",
        },
      ],
      target: "m.ts#v0",
      trueReferencers: ["a.ts#v1", "b.ts#v2"],
      falseReferencers: [],
    },
    {
      id: "type-only-reference",
      rule: "capture-type",
      files: [
        { module: "m.ts", text: "export interface Foo { x: number; }" },
        {
          module: "b.ts",
          text: "import { Foo } from './m';\nexport function bar(p: Foo){ return p.x; }",
        },
      ],
      target: "m.ts#Foo",
      trueReferencers: ["b.ts#bar"],
      falseReferencers: [],
    },
    {
      id: "default-import",
      rule: "capture-default",
      files: [
        { module: "m.ts", text: "export default function(){ return 0; }" },
        {
          module: "b.ts",
          text: "import main from './m';\nexport function bar(){ return main(); }",
        },
      ],
      target: "m.ts#default",
      trueReferencers: ["b.ts#bar"],
      falseReferencers: [],
    },
    {
      id: "shorthand-property",
      rule: "capture-shorthand",
      files: [
        { module: "m.ts", text: "export const token = 7;" },
        {
          // object SHORTHAND `{ token }` IS a value reference → TRUE.
          module: "b.ts",
          text: "import { token } from './m';\nexport function bar(){ return { token }; }",
        },
      ],
      target: "m.ts#token",
      trueReferencers: ["b.ts#bar"],
      falseReferencers: [],
    },
    {
      id: "degrade-namespace-import",
      rule: "namespace",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        {
          // `m.foo()` genuinely references foo, but a namespace member is aliasable
          // → DEGRADE (recall miss), never a wrong edge.
          module: "b.ts",
          text: "import * as m from './m';\nexport function bar(){ return m.foo(); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      degradedTrue: ["b.ts#bar"],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-barrel-reexport",
      rule: "barrel",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        { module: "barrel.ts", text: "export { foo } from './m';" },
        {
          // imports foo FROM the barrel → callee keys on barrel#foo, never m#foo →
          // DEGRADE for target m.ts#foo (recall miss), never wrong.
          module: "b.ts",
          text: "import { foo } from './barrel';\nexport function bar(){ return foo(); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      degradedTrue: ["b.ts#bar"],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-dynamic-import",
      rule: "dynamic-import",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        {
          // `await import(...)` is not an import DECLARATION → no static binding.
          module: "b.ts",
          text: "export async function bar(){ const { foo } = await import('./m'); return foo(); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-computed-member",
      rule: "computed-member",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        {
          // a string member key `["foo"]` is not a static name → no fabricated edge.
          module: "b.ts",
          text: "const registry: Record<string, () => number> = {};\nexport function bar(){ return registry['foo'](); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-shadowing",
      rule: "shadowing",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        {
          // a module-local `foo` poisons the import binding → no edge (coarse but
          // never wrong): `bar` here uses the LOCAL foo.
          module: "b.ts",
          text: "import { foo } from './m';\nexport function bar(){ const foo = 99; return foo; }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-same-name-across-modules",
      rule: "same-name",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        { module: "other.ts", text: "export function foo(){ return 2; }" },
        {
          // references other.ts#foo, NOT m.ts#foo → must not surface for m.ts#foo.
          module: "b.ts",
          text: "import { foo } from './other';\nexport function bar(){ return foo(); }",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      falseReferencers: ["b.ts#bar"],
    },
    {
      id: "degrade-no-enclosing-decl",
      rule: "no-enclosing",
      files: [
        { module: "m.ts", text: "export function foo(){ return 1; }" },
        {
          // top-level `foo()` has no enclosing top-level declaration → no edge.
          module: "b.ts",
          text: "import { foo } from './m';\nfoo();",
        },
      ],
      target: "m.ts#foo",
      trueReferencers: [],
      falseReferencers: [],
    },
  ],
};

// Runnable: `node dist/symbol-refs-eval.js` prints the report. Guarded so importing
// this module (tests / the indexer) never triggers it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // eslint-disable-next-line no-console
  console.log(
    formatSymbolRefsEvalReport(runSymbolRefsEval(DEFAULT_SYMBOL_REFS_EVAL_SET))
  );
}
