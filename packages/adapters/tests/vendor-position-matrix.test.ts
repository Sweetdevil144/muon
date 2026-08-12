import { describe, expect, it, vi } from "vitest";
import { laneProfileSchema } from "@muon/protocol";
import {
  ClaudeSessionDriver,
  type ClaudeSessionDriverOptions,
} from "../src/claude-session-driver.js";
import {
  CodexSessionDriver,
  type RpcTransport,
} from "../src/codex-session-driver.js";
import { buildProviderAwareLaneEnvironment } from "../src/lane-runner.js";
import { assertMuonMcpEnvContract } from "../src/mcp-env-contract.js";
import { compileCodexProfile } from "../src/profile-compiler.js";

// ── The vendor × position matrix, at the ENV-CONTRACT boundary ───────────────
//
// Both coordinator-capable vendors must be launchable in BOTH seats, and both
// must FAIL CLOSED the same way when the governed brain's lineage is missing —
// that env-contract death is one of the two failures a Codex superagent hit in
// a real session.
//
// The existing mcp-env-contract suite proves this thoroughly for Codex and not
// at all for Claude Code, even though `ClaudeSessionDriver` calls the same
// assertion. That gap is itself an accidental asymmetry: the two vendors
// deliver the env by DIFFERENT mechanisms (codex forwards declared NAMES from
// its own process env; the Claude SDK receives the VALUES in-process), so only
// one of the two delivery paths was ever pinned. This file pins the matrix.
//
// Hermetic: the Codex transport and the Claude SDK are both injected fakes, so
// no vendor CLI is ever spawned.

const VENDORS = ["claude-code", "codex"] as const;
type Vendor = (typeof VENDORS)[number];

const DELEGATION_TOKEN = "delegation-token-0123456789abcdef";

/**
 * The governed MUON MCP env the runner composes per capability mode, mirrored
 * from `withMuonMcpServer` + executeJob's orchestrator/delegate branches. It is
 * duplicated rather than imported because @muon/core depends on THIS package.
 */
function muonEnv(
  mode: "orchestrator" | "delegate",
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const base: Record<string, string | undefined> = {
    MUON_API_BASE: "http://127.0.0.1:57450",
    MUON_TASK_ID: "task-1",
    MUON_LANE_KEY: mode === "orchestrator" ? "muon-orchestrator" : "worker",
    MUON_JOB_ID: "job-1",
    MUON_WORKSPACE: "/repo",
    MUON_CHAT_ID: "chat-1",
    MUON_MCP_MODE: mode,
    ...(mode === "orchestrator"
      ? {
          MUON_DELEGATION_TOKEN: DELEGATION_TOKEN,
          MUON_CHAT_TASK_ID: "task-1",
        }
      : {
          MUON_DELEGATE_CAN_SPAWN: "true",
          MUON_DELEGATION_TOKEN: DELEGATION_TOKEN,
          MUON_PARENT_JOB_ID: "job-parent",
          MUON_ROOT_JOB_ID: "job-root",
          MUON_DELEGATION_DEPTH: "1",
        }),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    )
  );
}

function profileFor(
  mode: "orchestrator" | "delegate",
  overrides: Record<string, string | undefined> = {}
) {
  return laneProfileSchema.parse({
    permissionMode: "default",
    mcpServers: [
      { name: "muon", command: "muon-mcp", env: muonEnv(mode, overrides) },
    ],
    allowedTools: ["mcp__muon__dispatch"],
  });
}

type Profile = ReturnType<typeof profileFor>;

/**
 * The env each vendor's driver ACTUALLY judges the contract against, mirroring
 * the two delivery mechanisms exactly:
 *   codex  → compiled `env_vars` names resolved against the deny-first lane env
 *   claude → the values handed to the SDK in-process, so nothing is by-name
 */
function deliveredEnv(vendor: Vendor, profile: Profile): Record<string, string> {
  if (vendor === "codex") {
    const lane = buildProviderAwareLaneEnvironment(
      "codex",
      process.env,
      compileCodexProfile(profile).env
    );
    return Object.fromEntries(
      Object.entries(lane).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"
      )
    );
  }
  return profile.mcpServers.find((server) => server.name === "muon")!.env;
}

/**
 * The line that matters for both vendors: was a VENDOR SESSION created?
 *
 * The two drivers reach it differently — Codex builds a transport (a child
 * process in production), Claude calls the SDK's `query()`. Note the ordering
 * differs by design of each driver: Codex asserts the contract before it even
 * constructs a transport, while Claude loads the SDK module first and asserts
 * before `query()`. Loading a module starts no vendor, so both refuse at the
 * same real boundary; these fakes mark exactly that boundary so the matrix can
 * hold both vendors to it.
 */
function claudeSdkReaching(reached: { value: boolean }) {
  return async () => ({
    query: () => {
      reached.value = true;
      throw new Error("query must not be reached");
    },
  }) as never;
}

function codexTransportReaching(reached: { value: boolean }) {
  return (() => {
    reached.value = true;
    throw new Error("transport must not be created");
  }) as unknown as () => RpcTransport;
}

async function startDriver(
  vendor: Vendor,
  profile: Profile,
  reached: { value: boolean }
): Promise<void> {
  const handlers = {
    onEvent: () => undefined,
    onApprovalRequest: async () => ({ behavior: "allow" as const }),
  };
  const input = { taskId: "task-1", brief: "go", profile };
  if (vendor === "codex") {
    await new CodexSessionDriver(codexTransportReaching(reached)).start(
      input,
      handlers
    );
    return;
  }
  await new ClaudeSessionDriver(
    claudeSdkReaching(reached),
    {} as ClaudeSessionDriverOptions
  ).start(input, handlers);
}

describe("vendor × position: the governed MCP env contract is complete in both seats", () => {
  const cases = VENDORS.flatMap((vendor) =>
    (["orchestrator", "delegate"] as const).map(
      (mode) => [vendor, mode] as const
    )
  );

  it.each(cases)(
    "%s in the %s seat delivers every declared name with a value",
    (vendor, mode) => {
      const profile = profileFor(mode);
      const delivered = deliveredEnv(vendor, profile);
      const declared = profile.mcpServers.find(
        (server) => server.name === "muon"
      )!.env;

      for (const name of Object.keys(declared)) {
        expect(
          delivered[name],
          `${name} never reached the ${vendor} child env`
        ).toBeTruthy();
      }
      expect(() =>
        assertMuonMcpEnvContract(profile.mcpServers, delivered)
      ).not.toThrow();
    }
  );
});

describe("vendor × position: both vendors fail closed on missing lineage", () => {
  // `muon-mcp` refuses to serve an orchestrator/delegate toolset without job
  // lineage and exits inside `initialize`, which every vendor reports as an
  // opaque connection-closed string. Refusing on THIS side of the vendor is
  // what turns that into a named cause — and it must behave identically for
  // both vendors, in both seats.
  const cases = VENDORS.flatMap((vendor) =>
    (
      [
        ["orchestrator", "MUON_JOB_ID"],
        ["orchestrator", "MUON_DELEGATION_TOKEN"],
        ["delegate", "MUON_JOB_ID"],
      ] as const
    ).map(([mode, missing]) => [vendor, mode, missing] as const)
  );

  it.each(cases)(
    "%s in the %s seat refuses launch when %s is missing",
    async (vendor, mode, missing) => {
      const profile = profileFor(mode, { [missing]: undefined });
      const reached = { value: false };

      await expect(startDriver(vendor, profile, reached)).rejects.toThrow(
        new RegExp(missing)
      );
      // The refusal happened BEFORE any vendor session existed.
      expect(reached.value).toBe(false);
    }
  );

  it.each(VENDORS)(
    "%s never puts a lineage VALUE in its refusal message",
    async (vendor) => {
      const profile = profileFor("orchestrator", { MUON_JOB_ID: undefined });
      const reached = { value: false };
      await startDriver(vendor, profile, reached).then(
        () => expect.unreachable("launch must have been refused"),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toContain("MUON_JOB_ID");
          expect(message).not.toContain(DELEGATION_TOKEN);
        }
      );
    }
  );
});

describe("vendor × position: a complete contract lets both vendors reach launch", () => {
  it.each(VENDORS)(
    "%s in the orchestrator seat passes the assertion and proceeds to the vendor",
    async (vendor) => {
      const profile = profileFor("orchestrator");
      const reached = { value: false };
      // Both fakes throw the moment they are reached, so "reached" is the
      // evidence that the contract assertion did NOT refuse this launch.
      await expect(startDriver(vendor, profile, reached)).rejects.toThrow();
      expect(reached.value).toBe(true);
    }
  );
});
