/**
 * @muon/codegraph, CG-1: a local, in-process, TS/JS reverse code-graph that
 * implements the `CodeGraphProvider` seam for the P2.5 pre-edit hero. Zero
 * native/WASM deps (`ts.preProcessFile` for imports + `ts.createSourceFile` for the
 * symbol layer, NO `ts.Program`), no egress, degrade-to-null/module. Two layers:
 * a file-import reverse-index (ADR-0011) and, on top of it, a name-based,
 * import-resolved reverse SYMBOL-reference graph that returns the symbols which
 * transitively reference the edit target (ADR-0015), degrading to the module edge
 * on any ambiguity so a symbol edge is never wrong.
 * See docs/adr/0011-local-code-graph.md and docs/adr/0015-symbol-level-reference-impact.md.
 */

export {
  LocalCodeGraphProvider,
  type LocalCodeGraphOptions,
} from "./provider.js";
export {
  buildReverseImportIndex,
  BudgetExceededError,
  DEFAULT_BUDGET,
  type ReverseImportIndex,
  type IndexBudget,
  type BuildOptions,
} from "./indexer.js";
export {
  reverseClosure,
  reverseSymbolClosure,
  type ClosureResult,
  type SymbolClosureResult,
} from "./closure.js";
export { extractImportSpecifiers } from "./scanner.js";
export { extractSymbolDefs, type SymbolDef } from "./symbols.js";
export {
  extractSymbolReferences,
  type SymbolReference,
  type SymbolReferenceResult,
} from "./symbol-refs.js";
export {
  runSymbolRefsEval,
  emittedReferencers,
  buildScenarioSymbolReverse,
  formatSymbolRefsEvalReport,
  DEFAULT_SYMBOL_REFS_EVAL_SET,
  SYMBOL_REFS_EVAL_HONESTY,
  EVAL_ROOT,
  type RefEvalSet,
  type RefEvalScenario,
  type RefEvalReport,
  type RefEvalFile,
} from "./symbol-refs-eval.js";
export { createResolver, type Resolver, type TsconfigPaths } from "./resolver.js";
export { loadTsconfigPaths } from "./tsconfig.js";
// ADR-0016, the LanguageAdapter seam + the shipped adapters.
export {
  createRegistry,
  defaultRegistry,
  DEFAULT_LANGS,
  type ImportRef,
  type LanguageAdapter,
  type LanguageContext,
  type AdapterRegistry,
} from "./adapter.js";
export {
  typescriptAdapter,
  SUPPORTED_EXTENSIONS as TS_SUPPORTED_EXTENSIONS,
} from "./adapters/typescript.js";
export {
  pythonAdapter,
  extractImports as extractPythonImports,
  resolvePythonImport,
  PYTHON_EXTENSIONS,
  type PathExists,
} from "./adapters/python.js";
// REC-010, the Python symbol layer (ADR-0015 parity) + its eval.
export { extractPythonSymbolReferences } from "./python-symbol-refs.js";
export {
  runPythonSymbolRefsEval,
  emittedPyReferencers,
  buildScenarioPySymbolReverse,
  formatPythonSymbolRefsEvalReport,
  DEFAULT_PYTHON_SYMBOL_REFS_EVAL_SET,
  PYTHON_SYMBOL_REFS_EVAL_HONESTY,
  PY_REF_EVAL_ROOT,
  type PyRefEvalSet,
  type PyRefEvalScenario,
  type PyRefEvalReport,
  type PyRefEvalFile,
} from "./python-symbol-refs-eval.js";
export {
  runPythonImportsEval,
  emittedPythonEdges,
  buildScenarioEdges,
  formatPythonImportsEvalReport,
  DEFAULT_PYTHON_IMPORTS_EVAL_SET,
  PYTHON_IMPORTS_EVAL_HONESTY,
  PY_EVAL_ROOT,
  type PyEvalSet,
  type PyEvalScenario,
  type PyEvalReport,
  type PyEvalFile,
} from "./python-imports-eval.js";
export {
  toWorkspaceRelativePosix,
  isSupportedSourceFile,
  isRootAllowed,
  isWithin,
  toSymbolId,
  moduleOfSymbol,
  deriveModulesFromSymbols,
  SUPPORTED_EXTENSIONS,
  PROBE_EXTENSIONS,
  IGNORED_DIRS,
} from "./paths.js";
