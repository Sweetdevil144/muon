import {
  copyFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER_SOURCE = path.join(HERE, "fake-codex-app-server.mjs");

/**
 * Materializes the wire-level fake codex app-server (fake-codex-app-server.mjs)
 * as an executable literally named `codex` inside a fresh temp directory, so a
 * test can prepend that directory to `PATH` and have
 * `commandExists("codex")`/`spawn("codex", ["app-server", ...])` — the REAL
 * production seam in codex-session-driver.ts's `spawnCodexTransport` — resolve
 * to this double instead of a real vendor CLI. No MUON source is touched: the
 * driver runs its unmodified production transport end-to-end.
 *
 * `muonToolNames` (pass @muon/protocol's `MUON_CONTEXT_TOOL_NAMES`, or the
 * orchestrator set) is written to a sibling `tools.json` the fake server reads
 * at startup, so it can satisfy CodexSessionDriver's unconditional MUON MCP
 * capability preflight (codex-capability-preflight.ts `requiredMuonTools`).
 */
export function installFakeCodexBinary(options?: {
  muonToolNames?: readonly string[];
}): { binDir: string; cleanup: () => void } {
  const binDir = mkdtempSync(path.join(tmpdir(), "muon-fake-codex-bin-"));
  const binPath = path.join(binDir, "codex");
  copyFileSync(FAKE_SERVER_SOURCE, binPath);
  chmodSync(binPath, 0o755);
  writeFileSync(
    path.join(binDir, "tools.json"),
    JSON.stringify(options?.muonToolNames ?? [])
  );
  return {
    binDir,
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}
