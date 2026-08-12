import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompatCommands } from "../src/commands/compat.js";
import type { MuonApiClient } from "../src/lib/api-client.js";
import { enableResultSchema } from "@muon/protocol";

// ADR-0038 D1 slice 1 — the surface. `muon compat mcp` SHOWS a user the setup
// they already have. It must show the files it looked at (including the ones
// that were not there), it must repeat that nothing is enabled, and it must
// have no verb that could enable anything.

const INVENTORY = {
  items: [
    {
      kind: "mcp_server" as const,
      name: "linear",
      provenance: {
        vendor: "claude-code",
        sourcePath: "/home/dev/.claude.json",
      },
      shape: {
        transport: "stdio" as const,
        command: "npx",
        args: ["-y", "linear-mcp"],
        envKeys: ["LINEAR_API_KEY"],
        headerKeys: [],
      },
      secretsRefused: ["LINEAR_API_KEY"],
      state: "discovered" as const,
    },
  ],
  unreadable: [
    {
      vendor: "opencode",
      sourcePath: "/home/dev/.config/opencode/opencode.json",
      name: "remote",
      reason: 'MUON reads opencode\'s `type: "local"` entries only',
    },
  ],
  sources: [
    {
      vendor: "claude-code",
      scope: "user",
      sourcePath: "/home/dev/.claude.json",
      status: "read" as const,
      items: 1,
    },
    {
      vendor: "codex",
      scope: "user",
      sourcePath: "/home/dev/.codex/config.toml",
      status: "absent" as const,
      items: 0,
    },
    {
      vendor: "cursor",
      scope: "user",
      sourcePath: "/home/dev/.cursor/mcp.json",
      status: "unreadable" as const,
      reason: "/home/dev/.cursor/mcp.json is not valid JSON",
      items: 0,
    },
  ],
};

const writes: string[] = [];
const errors: string[] = [];

afterEach(() => {
  writes.length = 0;
  errors.length = 0;
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function run(argv: string[], client: Partial<MuonApiClient>) {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const program = new Command();
  program.exitOverride();
  registerCompatCommands(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

function stubClient() {
  return {
    discoverCompatibilityMcp: vi.fn(async () => INVENTORY),
  } as unknown as Partial<MuonApiClient>;
}

describe("muon compat mcp", () => {
  it("names every config it looked at, including the ones that were not there", async () => {
    await run(["compat", "mcp"], stubClient());
    const out = writes.join("");
    // "0 servers" and "I could not read your config" are different facts. A
    // user whose config MUON never reached must not read a short list as a
    // complete one.
    expect(out).toContain("/home/dev/.claude.json: 1 server(s)");
    expect(out).toContain("/home/dev/.codex/config.toml: not present");
    expect(out).toContain("unreadable — /home/dev/.cursor/mcp.json is not valid JSON");
  });

  it("says the item is not enabled and names the credential MUON refused", async () => {
    await run(["compat", "mcp"], stubClient());
    const out = writes.join("");
    expect(out).toContain("linear (from claude-code, /home/dev/.claude.json)");
    expect(out).toContain("Not enabled.");
    expect(out).toContain("LINEAR_API_KEY");
    expect(out).toContain("Discovery grants nothing.");
    // ADR-0038 D4: the surface states no recommendation and no risk score.
    expect(out).not.toMatch(/\b(safe|trusted|recommended|low risk)\b/i);
  });

  it("reports an entry it could not read instead of dropping the row", async () => {
    await run(["compat", "mcp"], stubClient());
    const out = writes.join("");
    expect(out).toContain("1 entr(y/ies) MUON could not read:");
    expect(out).toContain("remote (opencode,");
  });

  it("says out loud that project-scoped configs are not inspected", async () => {
    await run(["compat", "mcp"], stubClient());
    expect(writes.join("")).toContain(
      "MUON reads user-scope configs only"
    );
  });

  it("--json prints the inventory verbatim", async () => {
    await run(["compat", "mcp", "--json"], stubClient());
    expect(JSON.parse(writes.join(""))).toEqual(INVENTORY);
  });

  it("every enable verb NAMES A LANE, and there is no bulk one", async () => {
    // This test used to assert `["mcp"]` — that the enable half did not exist
    // yet, because ADR-0038's two open questions were the founder's. They were
    // answered on 2026-08-09 (D7: MCP servers only; D8: agent-dispatched lanes
    // allowed, bound per lane), so the verbs exist and what this pins is their
    // SHAPE instead.
    //
    // The invariant that survived the change: D6/D8 build a lane's imported set
    // by listing what it holds. A verb that took no lane, or that took a vendor
    // and enabled everything under it, is not a convenience — it is the
    // "import everything, then subtract the dangerous ones" shape the ADR
    // rejects by name, with a shorter spelling.
    const program = new Command();
    program.exitOverride();
    registerCompatCommands(program, () => stubClient() as MuonApiClient);
    const compat = program.commands.find((cmd) => cmd.name() === "compat")!;
    expect(compat.commands.map((cmd) => cmd.name())).toEqual([
      "mcp",
      "lane",
      "enable",
      "disable",
    ]);

    for (const name of ["enable", "disable", "lane"]) {
      const verb = compat.commands.find((cmd) => cmd.name() === name)!;
      expect(
        verb.usage(),
        `${name} must be unable to run without naming a lane`
      ).toContain("<laneKey>");
    }
    for (const verb of compat.commands) {
      const flags = verb.options.map((option) => option.long);
      expect(flags, `${verb.name()} must not offer a bulk enable`).not.toContain(
        "--all"
      );
    }
  });

  it("enable sends the item's NAME and never a shape", async () => {
    // ADR-0038 D2. The backend re-reads the vendor's own configuration; a
    // request that carried a command would let a caller approve `curl | sh`
    // against a screen that said `npx linear-mcp`.
    // PARSED THROUGH THE REAL CONTRACT. A hand-written mock drifts from the
    // schema silently — that is how this test came to exercise a crashing
    // command for a release. Now a mock missing a field fails here, naming it.
    const enableLaneImport = vi.fn(async () =>
      enableResultSchema.parse({
      item: {
        kind: "mcp_server" as const,
        name: "linear",
        vendor: "claude-code",
        laneKey: "claude",
        enabledDigest: `sha256:${"a".repeat(64)}`,
        state: "enabled" as const,
        secretsRefused: [],
        enabledBy: "human",
        enabledAt: "2026-08-09T10:00:00.000Z",
      },
      diff: { before: [], after: ["linear"], added: ["linear"], removed: [] },
      envNotCarried: [],
      })
    );
    await run(["compat", "enable", "claude", "claude-code", "linear"], {
      enableLaneImport,
    } as unknown as Partial<MuonApiClient>);
    expect(enableLaneImport).toHaveBeenCalledWith("claude", {
      vendor: "claude-code",
      name: "linear",
    });
    // AND IT PRINTED THE SUCCESS, which this used to omit. The mock was
    // missing `envNotCarried`, so the command threw on `.length`, its own
    // catch printed "Enable failed", and the test still passed — it asserted
    // only that the client was CALLED. A command test that never looks at the
    // output cannot tell a working command from a crashing one.
    expect(errors.join(""), "the success path must not error").toBe("");
    expect(writes.join("")).toContain("linear");
    expect(writes.join("")).toContain("added:");

  });

  it("REFUSES an enable that would need a credential, and says why", async () => {
    // ADR-0038 D5 as it actually works. This test used to construct a success
    // response carrying `credentialsStillNeeded`, which the backend cannot
    // emit — it refuses any credential-bearing item before it gets there. A
    // test that builds an impossible response gives confidence in a branch
    // that can never run, so the impossible state is gone from the contract
    // and this asserts the refusal that really happens.
    const { MuonApiHttpError } = await import("@muon/client");
    await run(["compat", "enable", "claude", "claude-code", "linear"], {
      enableLaneImport: vi.fn(async () => {
        throw new MuonApiHttpError(
          409,
          "Conflict",
          '"linear" needs 1 credential(s) MUON deliberately does not carry (LINEAR_API_KEY). MUON hands the lane its OWN generated server config, so the vendor copy of those values is never consulted.'
        );
      }),
    } as unknown as Partial<MuonApiClient>);
    const said = `${writes.join("")}${errors.join("")}`;
    expect(said).toContain("LINEAR_API_KEY");
    expect(said, "and never the advice that was not true").not.toContain(
      "own configuration"
    );
    // Non-zero rather than a specific code: 2 is reserved for an authority
    // refusal (403) and this is a 409. Pinning the exact mapping here would
    // test the error taxonomy rather than this command.
    expect(process.exitCode).toBeGreaterThan(0);
  });

  it("exits 2 on an authority refusal rather than printing a bare 403", async () => {
    const { MuonApiHttpError } = await import("@muon/client");
    await run(["compat", "mcp"], {
      discoverCompatibilityMcp: vi.fn(async () => {
        throw new MuonApiHttpError(403, "Forbidden", "403 Forbidden");
      }),
    } as unknown as Partial<MuonApiClient>);
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("Compatibility discovery");
  });
});
