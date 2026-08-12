#!/usr/bin/env node
// A wire-level double of the `codex app-server` NDJSON JSON-RPC protocol (v2).
//
// This is NOT the in-memory `fakeAppServer()` used by codex-session-driver.test.ts
// (which substitutes CodexSessionDriver's `RpcTransport` and never crosses a real
// process boundary). This script IS a separate OS process: it reads one JSON
// object per line from its real stdin and writes one JSON object per line to its
// real stdout, exactly the framing `spawnCodexTransport` (codex-session-driver.ts)
// speaks to the REAL `codex` binary. Installed as an executable named `codex` on
// a test's PATH (see fixtures/spawn-fake-codex-binary.ts), it lets
// codex-wire-level-e2e.test.ts drive CodexSessionDriver's PRODUCTION transport
// end-to-end — real spawn, real NDJSON stdio, real line-delimited JSON parsing —
// with zero MUON source changes and no real vendor CLI.
//
// Deterministic and hermetic: no network, no filesystem writes, exits when its
// stdin closes or it is signaled.

import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const send = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

const THREAD_ID = "fake-wire-thread-1";

// codex-capability-preflight.ts unconditionally requires a server literally
// named "muon" to expose `MUON_CONTEXT_TOOL_NAMES` (or the orchestrator set)
// before it releases the brief — this is not gated by the session's profile.
// `installFakeCodexBinary()` (spawn-fake-codex-binary.ts) writes the exact
// granted tool names to `tools.json` NEXT TO this script (not through the
// child's environment: RUNNER_ENV_ALLOWLIST intentionally strips anything
// that isn't a production lane env key, so this reads a sibling file instead,
// resolved from THIS script's own real path since it runs as `codex`).
const toolsPath = join(dirname(fileURLToPath(import.meta.url)), "tools.json");
const MUON_TOOL_NAMES = existsSync(toolsPath)
  ? JSON.parse(readFileSync(toolsPath, "utf8"))
  : [];

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // non-JSON lines are ignored, matching the real transport's tolerance
  }
  const { id, method } = message;

  switch (method) {
    case "initialize": {
      send({
        id,
        result: {
          userAgent: "fake-codex-wire/1.0.0",
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      break;
    }
    case "initialized": {
      // Notification, no reply.
      break;
    }
    case "thread/start": {
      send({
        id,
        result: {
          thread: { id: THREAD_ID },
          model: "fake-codex-wire-model",
          modelProvider: "fake",
          cwd: message.params?.cwd ?? "/repo",
          runtimeWorkspaceRoots: [message.params?.cwd ?? "/repo"],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [message.params?.cwd ?? "/repo"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          reasoningEffort: null,
          multiAgentMode: "explicitRequestOnly",
        },
      });
      break;
    }
    case "account/read": {
      send({ id, result: { account: null, requiresOpenaiAuth: true } });
      break;
    }
    case "config/read": {
      send({
        id,
        result: {
          config: {
            model_provider: "fake",
            approval_policy: "on-request",
            sandbox_mode: "workspace-write",
            apps: null,
          },
          origins: {},
          layers: null,
        },
      });
      break;
    }
    case "configRequirements/read": {
      send({ id, result: { requirements: null } });
      break;
    }
    case "plugin/list": {
      send({
        id,
        result: {
          marketplaces: [],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        },
      });
      break;
    }
    case "mcpServerStatus/list": {
      const data =
        MUON_TOOL_NAMES.length > 0
          ? [
              {
                name: "muon",
                serverInfo: null,
                tools: Object.fromEntries(
                  MUON_TOOL_NAMES.map((name) => [
                    name,
                    { name, inputSchema: { type: "object" } },
                  ])
                ),
                resources: [],
                resourceTemplates: [],
                authStatus: "unsupported",
              },
            ]
          : [];
      send({ id, result: { data, nextCursor: null } });
      break;
    }
    case "turn/start": {
      send({ id, result: {} });
      // Stream one assistant delta, then complete the turn — the shortest
      // sequence a REAL turn produces, over the REAL wire.
      send({
        method: "item/agentMessage/delta",
        params: { delta: "hello from the fake wire-level codex app-server" },
      });
      send({ method: "turn/completed", params: {} });
      break;
    }
    case "turn/interrupt": {
      send({ id, result: {} });
      break;
    }
    default: {
      // Unknown method: reply with an empty result so a strict caller never
      // hangs waiting on this fake forever.
      if (id !== undefined) {
        send({ id, result: {} });
      }
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
