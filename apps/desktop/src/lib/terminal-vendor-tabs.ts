/**
 * MOVED to `@muon/client` (2026-08-08) so the TUI's vendor-tab layer and the
 * desktop's are the SAME code — numbering, labels, the spawn allowlist and
 * the menu builder cannot drift between surfaces (the governed-op parity
 * rule). This shim keeps the desktop's six historical import sites working;
 * new code imports from `@muon/client/terminal-vendor-tabs`.
 */
export * from "@muon/client/terminal-vendor-tabs";
