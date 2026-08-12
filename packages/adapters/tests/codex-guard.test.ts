import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  laneProfileSchema,
  MUON_CONTEXT_TOOL_NAMES,
  VENDOR_REGISTRY,
  type LaneEvent,
} from "@muon/protocol";
import { CodexAdapter } from "../src/codex-adapter.js";
import { runCodexCapabilityPreflight } from "../src/codex-capability-preflight.js";
import {
  codexGuardEnv,
  codexStartupExitDetail,
  guardedCodexArgs,
  prepareCodexGuardHome,
  stripCodexWideningArgs,
  ungrantedCodexMcpServers,
  CODEX_AMBIENT_SUPPRESSION_ARGS,
  CODEX_AUTH_FILE,
  CodexGuardHomeError,
  CodexGuardProviderError,
  CODEX_WIDENING_FLAGS,
} from "../src/codex-guard.js";
import {
  CODEX_RPC,
  CodexSessionDriver,
  type RpcTransport,
} from "../src/codex-session-driver.js";
import { buildProviderAwareLaneEnvironment } from "../src/lane-runner.js";

/**
 * THE AMBIENT-CONFIG BREACH, PINNED.
 *
 * Every number in this suite came from the installed `codex` 0.145.0 on the
 * founder's machine, measured through `codex mcp list --json`,
 * `codex doctor --json`, and a real `codex app-server` `mcpServerStatus/list`
 * handshake. No model turn was spent. What was measured:
 *
 *   ambient CODEX_HOME              7 servers, 206 tools, inventory in 5.6s
 *                                   (codex_apps 169, node_repl 3, gitnexus 16,
 *                                   cubic 13, supabase, computer-use,
 *                                   openaiDeveloperDocs) + a live
 *                                   `failed to refresh OAuth tokens for server
 *                                   supabase` on stderr
 *   guard CODEX_HOME                1 server (codex_apps), 169 tools
 *   guard + features.apps=false     1 server (muon), inventory in 33ms
 *
 * and, separately, that `-c mcp_servers={}` does NOT clear the ambient set
 * (`-c` merges at the leaf), that a `-c mcp_servers.<plugin-server>.enabled`
 * override makes the whole config load FAIL, that no project-level config is
 * read, that `codex login status` under the guard still answers
 * `Logged in using ChatGPT`, and that codex rewrites `auth.json` THROUGH a
 * symlink rather than replacing it.
 *
 * The tests below assert the MECHANISM those measurements justify, using fakes,
 * so they stay true on a machine with a different `~/.codex`.
 */

type Message = Parameters<RpcTransport["send"]>[0];

/** A scratch "operator home" so no test ever reads the developer's own. */
function fakeOperatorHome(options: { auth?: string; config?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "muon-codex-operator-"));
  if (options.auth !== undefined) {
    writeFileSync(join(home, CODEX_AUTH_FILE), options.auth);
  }
  if (options.config !== undefined) {
    writeFileSync(join(home, "config.toml"), options.config);
  }
  return home;
}

function scratchGuardHome() {
  return join(mkdtempSync(join(tmpdir(), "muon-codex-guard-")), "home");
}

describe("codex guard — the levers, and why each one is load-bearing", () => {
  it("names CODEX_HOME as MUON's, not as a credential to forward", () => {
    // The registry is the authority. If `CODEX_HOME` reappears here, ambient
    // inheritance is back on and every other test in this file is moot.
    expect(VENDOR_REGISTRY.codex.credentials.envKeys).not.toContain(
      "CODEX_HOME"
    );
    expect(codexGuardEnv("/guard")).toEqual({ CODEX_HOME: "/guard" });
  });

  it("suppresses the built-in apps bridge that CODEX_HOME alone cannot", () => {
    // The measured gap: an empty guard home still exposed `codex_apps` with 169
    // tools. `codex mcp list` never shows it; only the app-server inventory
    // does, which is what the model actually gets.
    //
    // `multi_agent` joins it because vendor-native fan-out was disabled ONLY in
    // the runner's orchestrator profile branch, and the delegate branch resets
    // `rawConfig: {}` — so the workers that actually edit files kept it. A
    // boundary that lives in one mode's branch is not a boundary; this list is
    // the one that runs for every governed Codex child.
    expect(CODEX_AMBIENT_SUPPRESSION_ARGS).toEqual([
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=false",
    ]);
  });

  it("only ever narrows: every suppression arg turns a feature OFF", () => {
    // The categorical property that makes this list safe to grow. A future
    // entry spelled `=true` would widen a governed child's authority through
    // the one list that runs unconditionally.
    const overrides = CODEX_AMBIENT_SUPPRESSION_ARGS.filter(
      (arg) => arg !== "-c"
    );
    expect(overrides.length).toBeGreaterThan(0);
    for (const override of overrides) {
      expect(override).toMatch(/^features\.[a-z0-9_]+=false$/);
    }
  });

  it("declares the same widening flags the registry does", () => {
    // Protocol cannot import adapters, so agreement is asserted rather than
    // shared — the same shape opencode uses.
    expect([...VENDOR_REGISTRY.codex.execution.guards.wideningFlags]).toEqual([
      ...CODEX_WIDENING_FLAGS,
    ]);
  });

  it("TODO 1.16: the registry's fan-out claim names the key this list actually sets", () => {
    // The registry row is the audit-as-DATA; on its own it is only a sentence, so
    // every key it names must be a key this unconditional list really carries. That
    // is the direction worth asserting — the claim is pinned to the EMITTER, not to
    // a comment that could outlive it.
    const fanOut = VENDOR_REGISTRY.codex.execution.guards.nativeFanOut;
    expect(fanOut.mechanism).toContain("multi_agent");
    for (const key of ["features.multi_agent", "features.multi_agent_v2"]) {
      expect(fanOut.suppression.detail).toContain(key);
      expect(CODEX_AMBIENT_SUPPRESSION_ARGS).toContain(`${key}=false`);
    }
    // And `declared`, not `enforced`: codex 0.145 reports `explicitRequestOnly`
    // with these flags set and without them, so MUON emits the suppression and the
    // vendor is not observed honouring it. Pinned to
    // UNGOVERNABLE_MULTI_AGENT_MODES's deliberate omission of that mode, which is
    // the measurement this state reflects — if the mode ever becomes refusable, the
    // state can be raised and this assertion is what says so.
    expect(fanOut.suppression.state).toBe("declared");
    expect(fanOut.suppression.detail).toContain("explicitRequestOnly");
  });
});

describe("codex guard — the ambient config does not reach the child", () => {
  it("hands the child MUON's guard home, never the operator's", () => {
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    const guardHome = scratchGuardHome();
    try {
      const guard = prepareCodexGuardHome({ guardHome, operatorHome });
      const childEnv = buildProviderAwareLaneEnvironment(
        "codex",
        // The operator's own root is ambient in the parent env, exactly as it
        // is in production when they have relocated their install.
        { PATH: "/usr/bin", HOME: "/tmp/home", CODEX_HOME: operatorHome },
        codexGuardEnv(guard.home)
      );
      expect(childEnv.CODEX_HOME).toBe(guardHome);
      expect(childEnv.CODEX_HOME).not.toBe(operatorHome);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("does not let the ambient value through when MUON sets no guard", () => {
    // The deny side. Before this change `CODEX_HOME` was in `credentials.envKeys`
    // and was COPIED from the parent env, which is how the operator's whole
    // `~/.codex` reached every dispatched child in the first place.
    const childEnv = buildProviderAwareLaneEnvironment("codex", {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/operator/.codex",
    });
    expect(childEnv).not.toHaveProperty("CODEX_HOME");
  });

  it("puts the feature suppression on an invocation that carries no profile", () => {
    // A run with no profile compiles no args at all, so a suppression that
    // lived in the profile compiler would simply not be emitted.
    const { args } = new CodexAdapter().taskCommand("do the thing");
    // Length derived from the list rather than hardcoded, so growing the
    // suppression set cannot silently stop this from checking the whole of it.
    expect(args.slice(0, 1 + CODEX_AMBIENT_SUPPRESSION_ARGS.length)).toEqual([
      "exec",
      ...CODEX_AMBIENT_SUPPRESSION_ARGS,
    ]);
    expect(args.at(-1)).toBe("do the thing");
  });

  it("refuses a guard directory it cannot prove is its own", () => {
    // `mkdirSync(…, {recursive:true})` succeeds on an EXISTING directory, so on
    // a shared /tmp a hostile local user could pre-create the guard path and
    // drop a config.toml in it — re-widening through the exact mechanism this
    // guard removes. Refusing beats narrowing it with a chmod, which would
    // repair the symptom and keep using the directory.
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    const guardHome = scratchGuardHome();
    mkdirSync(guardHome, { recursive: true });
    chmodSync(guardHome, 0o755);
    try {
      expect(() =>
        prepareCodexGuardHome({ guardHome, operatorHome })
      ).toThrow(CodexGuardHomeError);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("creates a private directory when it makes one itself", () => {
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    const guardHome = scratchGuardHome();
    try {
      const guard = prepareCodexGuardHome({ guardHome, operatorHome });
      expect(statSync(guard.home).mode & 0o077).toBe(0);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("refuses a guard home that IS the operator's home", () => {
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    try {
      expect(() =>
        prepareCodexGuardHome({ guardHome: operatorHome, operatorHome })
      ).toThrow(/guard directory/i);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
    }
  });
});

describe("codex guard — BYO-auth survives the isolation", () => {
  it("reaches the operator's own auth.json from the guard home", () => {
    // Verified live that this makes `codex login status` answer
    // "Logged in using ChatGPT" and `codex doctor --json` report
    // `auth.credentials: ok, stored auth mode: chatgpt`. Here we assert the
    // mechanism: the operator's bytes are readable at the guard path.
    const operatorHome = fakeOperatorHome({
      auth: '{"auth_mode":"chatgpt","tokens":{"id_token":"operator-token"}}',
    });
    const guardHome = scratchGuardHome();
    try {
      const guard = prepareCodexGuardHome({ guardHome, operatorHome });
      expect(guard.authLinked).toBe(true);
      expect(readFileSync(join(guard.home, CODEX_AUTH_FILE), "utf8")).toContain(
        "operator-token"
      );
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("writes through the link, so a refreshed token lands in the operator's file", () => {
    // The reason the guard LINKS rather than COPIES. Verified live that codex
    // rewrites auth.json in place through the symlink; if it replaced it, an
    // OAuth refresh would strand a fresh credential inside MUON's directory.
    const operatorHome = fakeOperatorHome({ auth: '{"v":"before"}' });
    const guardHome = scratchGuardHome();
    try {
      const guard = prepareCodexGuardHome({ guardHome, operatorHome });
      writeFileSync(join(guard.home, CODEX_AUTH_FILE), '{"v":"refreshed"}');
      expect(
        readFileSync(join(operatorHome, CODEX_AUTH_FILE), "utf8")
      ).toContain("refreshed");
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("does not fail an operator who authenticates by API key instead", () => {
    // No `auth.json` at all is the normal state for `OPENAI_API_KEY` auth, and
    // that key still reaches the child through `credentials.envKeys`.
    const operatorHome = fakeOperatorHome();
    const guardHome = scratchGuardHome();
    try {
      const guard = prepareCodexGuardHome({ guardHome, operatorHome });
      expect(guard.authLinked).toBe(false);
      expect(guard.home).toBe(guardHome);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("refuses rather than silently switching an operator's custom provider", () => {
    // The honest cost, made loud. The guard home has no config.toml, so
    // `[model_providers.azure]` is not in effect and the child would fall back
    // to the built-in openai provider — a different account.
    const operatorHome = fakeOperatorHome({
      auth: "{}",
      config: [
        'model_provider = "azure"',
        "",
        "[model_providers.azure]",
        'env_key = "AZURE_OPENAI_API_KEY"',
      ].join("\n"),
    });
    const guardHome = scratchGuardHome();
    try {
      expect(() =>
        prepareCodexGuardHome({ guardHome, operatorHome })
      ).toThrow(CodexGuardProviderError);
      expect(() =>
        prepareCodexGuardHome({ guardHome, operatorHome })
      ).toThrow(/'azure'/);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });

  it("does not refuse the ordinary openai operator", () => {
    const operatorHome = fakeOperatorHome({
      auth: "{}",
      config: ['model_provider = "openai"', 'model = "gpt-5.6-sol"'].join("\n"),
    });
    const guardHome = scratchGuardHome();
    try {
      expect(prepareCodexGuardHome({ guardHome, operatorHome }).home).toBe(
        guardHome
      );
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  });
});

describe("codex guard — the widening strip", () => {
  it("removes every flag that would defeat the guard, with its value", () => {
    const { args, removed } = stripCodexWideningArgs([
      "exec",
      "--oss",
      "--profile",
      "work",
      "--enable",
      "apps",
      "--dangerously-bypass-approvals-and-sandbox",
      "--remote",
      "ws://evil",
      "--search",
      "the brief",
    ]);
    // The brief survives, and no value token is left behind as a stray
    // positional — codex reads a positional as the prompt.
    expect(args).toEqual(["exec", "the brief"]);
    expect(removed).toContain("work");
    expect(removed).toContain("apps");
    expect(removed).toContain("ws://evil");
  });

  it("refuses a features override in BOTH directions", () => {
    // A guard that only stripped `=true` would be defeated by the next spelling
    // of "on"; and a kept `-c` with a dropped value would turn the brief into
    // the override.
    for (const value of ["features.apps=true", "features.apps=1", "features.plugins=true"]) {
      const { args } = stripCodexWideningArgs(["exec", "-c", value, "brief"]);
      expect(args).toEqual(["exec", "brief"]);
    }
    expect(
      stripCodexWideningArgs(["-c=features.apps=true", "brief"]).args
    ).toEqual(["brief"]);
  });

  it("keeps MUON's own suppression through MUON's own strip", () => {
    // Getting this wrong would silently re-admit the 169 ambient tools while
    // every other test still passed.
    expect(guardedCodexArgs([...CODEX_AMBIENT_SUPPRESSION_ARGS])).toEqual([
      ...CODEX_AMBIENT_SUPPRESSION_ARGS,
    ]);
  });

  it("leaves the overrides MUON legitimately compiles alone", () => {
    const compiled = [
      "-c",
      'model="gpt-5.6-sol"',
      "-c",
      'approval_policy="untrusted"',
      "-c",
      'mcp_servers.muon.command="muon-mcp"',
    ];
    expect(guardedCodexArgs(compiled)).toEqual(compiled);
  });
});

describe("codex guard — assert the negative", () => {
  it("names the servers MUON did not grant", () => {
    expect(
      ungrantedCodexMcpServers(
        ["muon", "node_repl", "computer-use", "codex_apps"],
        ["muon"]
      )
    ).toEqual(["node_repl", "computer-use", "codex_apps"]);
    expect(ungrantedCodexMcpServers(["muon"], ["muon"])).toEqual([]);
  });

  it("blocks a governed preflight whose inventory exceeds the grant", async () => {
    const preflight = await runCodexCapabilityPreflight({
      call: async (method) => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "muon",
                tools: Object.fromEntries(
                  MUON_CONTEXT_TOOL_NAMES.map((name) => [
                    name,
                    { name, inputSchema: { type: "object" } },
                  ])
                ),
                authStatus: "unsupported",
              },
              {
                name: "node_repl",
                tools: { run: { name: "run", inputSchema: { type: "object" } } },
                authStatus: "unsupported",
              },
            ],
            nextCursor: null,
          };
        }
        if (method === "account/read") {
          return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
        }
        if (method === "config/read") {
          return { config: { model_provider: "openai", apps: null }, origins: {}, layers: null };
        }
        if (method === "configRequirements/read") return { requirements: null };
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
      },
      threadId: "thread-1",
      childEnv: {},
      grantedMcpServers: ["muon"],
      muonToolGate: {
        requiredTools: [...MUON_CONTEXT_TOOL_NAMES],
        timeoutMs: 200,
        pollIntervalMs: 10,
      },
    });

    // The gate used to assert only that MUON's tools were PRESENT, so an
    // ambient Node REPL rode into a governed run with nothing firing.
    expect(preflight.decision).toBe("block");
    expect(preflight.blockReason).toBe("ungranted-mcp-servers");
    expect(preflight.mcp.unexpectedServers).toEqual(["node_repl"]);
    expect(preflight.mcp.requiredMuon).toBe("verified");
  });

  it("leaves an ungoverned lane (no gate) exactly as it was", async () => {
    const preflight = await runCodexCapabilityPreflight({
      call: async (method) => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "muon",
                tools: Object.fromEntries(
                  MUON_CONTEXT_TOOL_NAMES.map((name) => [
                    name,
                    { name, inputSchema: { type: "object" } },
                  ])
                ),
                authStatus: "unsupported",
              },
              { name: "node_repl", tools: {}, authStatus: "unsupported" },
            ],
            nextCursor: null,
          };
        }
        if (method === "account/read") {
          return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
        }
        if (method === "config/read") {
          return { config: { model_provider: "openai", apps: null }, origins: {}, layers: null };
        }
        if (method === "configRequirements/read") return { requirements: null };
        return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
      },
      threadId: "thread-1",
      childEnv: {},
    });

    // A lane that was never given the governed server was never governed.
    expect(preflight.decision).toBe("proceed");
    expect(preflight.mcp.unexpectedServers).toEqual(["node_repl"]);
    expect(preflight.posture).toBe("compatibility-import");
  });
});

describe("codex guard — an exit code is not a diagnosis", () => {
  it("attributes a death during MCP startup, naming signal and grant", () => {
    // The founder hit this twice with zero output; the coordinator could only
    // report an unattributable external kill.
    const detail = codexStartupExitDetail({
      code: 130,
      phase: "mcp-startup",
      grantedServers: ["muon"],
      stderrTail: "MCP client for `supabase` failed to start: OAuth refresh",
    });
    expect(detail).toContain("SIGINT");
    expect(detail).toContain("while its MCP servers were still starting");
    expect(detail).toContain("MUON granted exactly: muon");
    expect(detail).toContain("OAuth refresh");
  });

  it("keeps the old sentence once the child is past startup", () => {
    const detail = codexStartupExitDetail({
      code: 1,
      phase: "ready",
      grantedServers: ["muon"],
    });
    expect(detail).toContain("exited before turn/completed (code 1)");
    expect(detail).not.toContain("MCP servers were still starting");
  });

  it("surfaces the attribution through the driver when app-server dies", async () => {
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    const guardHome = scratchGuardHome();
    const events: LaneEvent[] = [];
    let deliver: (message: Message) => void = () => undefined;
    let onDiagnostic: ((chunk: string) => void) | undefined;
    let resolveExit: (code: number) => void = () => undefined;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const transport: RpcTransport = {
      send: (message) => {
        if (message.method === CODEX_RPC.initialize) {
          // Die during MCP startup, before any inventory can be reported —
          // exactly the shape the founder hit.
          onDiagnostic?.(
            "MCP client for `supabase` failed to start: OAuth token refresh failed"
          );
          setTimeout(() => resolveExit(130), 0);
          return;
        }
        void deliver;
      },
      onMessage: (handler) => {
        deliver = handler;
      },
      close: vi.fn(async () => resolveExit(130)),
      waitForExit: async () => exitPromise,
    };

    const driver = new CodexSessionDriver(
      (_cwd, _args, _env, sink) => {
        onDiagnostic = sink;
        return transport;
      },
      {
        prepareCodexGuardHome: () =>
          prepareCodexGuardHome({ guardHome, operatorHome }),
      }
    );

    try {
      await expect(
        driver.start(
          {
            taskId: "task-exit-130",
            brief: "go",
            profile: laneProfileSchema.parse({
              mcpServers: [{ name: "muon", command: "muon-mcp", env: {} }],
            }),
          },
          {
            onEvent: (event) => events.push(event),
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
      ).rejects.toThrow(/SIGINT/);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("tells the operator what MUON suppressed, once, per run", async () => {
    const operatorHome = fakeOperatorHome({ auth: "{}" });
    const guardHome = scratchGuardHome();
    const events: LaneEvent[] = [];
    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> | undefined;
    let deliver: (message: Message) => void = () => undefined;
    let resolveExit: (code: number) => void = () => undefined;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const transport: RpcTransport = {
      send: () => undefined,
      onMessage: (handler) => {
        deliver = handler;
        void deliver;
      },
      close: vi.fn(async () => resolveExit(0)),
      waitForExit: async () => exitPromise,
    };

    const driver = new CodexSessionDriver(
      (_cwd, args, env) => {
        capturedArgs = args ?? [];
        capturedEnv = env;
        resolveExit(0);
        return transport;
      },
      {
        prepareCodexGuardHome: () =>
          prepareCodexGuardHome({ guardHome, operatorHome }),
      }
    );

    try {
      await driver
        .start(
          { taskId: "task-notice", brief: "go" },
          {
            onEvent: (event) => events.push(event),
            onApprovalRequest: async () => ({ behavior: "allow" }),
          }
        )
        .catch(() => undefined);

      expect(
        events.filter((event) => event.metadata?.codexGuardHome === true)
      ).toHaveLength(1);
      expect(events[0]?.message).toContain("isolated CODEX_HOME");
      // The guard reaches the CHILD, not just the event.
      expect(capturedEnv?.CODEX_HOME).toBe(guardHome);
      // And a session with no profile still carries the suppression.
      expect(capturedArgs).toEqual([...CODEX_AMBIENT_SUPPRESSION_ARGS]);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(guardHome, { recursive: true, force: true });
    }
  }, 20_000);
});
