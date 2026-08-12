/**
 * ADR-0033's refusal vocabulary, on a BROWSER-SAFE subpath.
 *
 * The canonical module is `@muon/protocol/refusal` — that is where the rule
 * enum and the per-rule disclosure allowlist live, and backend/MCP/CLI import
 * it directly. This file exists for the same reason `crew-liveness.ts` does:
 * the desktop renderer can reach neither alternative. `@muon/protocol` is not a
 * desktop dependency and does not resolve for the renderer bundle, and the
 * `@muon/client` barrel drags index → paths → `node:fs`, which esbuild cannot
 * bundle for a browser target.
 *
 * Re-export only. Adding a second definition of a security-bearing allowlist is
 * exactly the drift this repo has a drift-lock habit about — there is one table,
 * in protocol, and every surface renders from it.
 */

export {
  REFUSAL_RULES,
  buildRefusal,
  describeAction,
  disclosedEvidence,
  projectRefusal,
  refusalTitle,
  renderRefusalLine,
} from "@muon/protocol/refusal";

export type {
  Refusal,
  RefusalAction,
  RefusalAudience,
  RefusalFact,
  RefusalRule,
} from "@muon/protocol/refusal";
