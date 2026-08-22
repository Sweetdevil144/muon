// ADR-0031 + the 2026-08-23 observatory extraction: the module moved to
// @muon/client so the CLI and muon-mcp record through the SAME vocabulary,
// spool, and uploader (one module, three surfaces — no drift). This shim
// keeps every desktop import and test path stable.
export * from "@muon/client/observatory";
