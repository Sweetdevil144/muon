import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MISSING `gitnexus` MUST NOT KILL THE SERVER — AND MUST NOT BE LIED ABOUT.
 *
 * `createGitNexusToolDefinitions` resolved the bundled CLI with a bare
 * `require.resolve`, which throws — and it runs inside `createToolDefinitions`,
 * before any transport exists. Measured 2026-08-17 against the release
 * tarball's `muon-mcp`: the process died at start-up with `Cannot find module
 * 'gitnexus/package.json'` and the vendor showed `-32000`, the exact
 * "serve the handshake, name the remedy" failure ADR-0049 was written for.
 *
 * The repo always has `gitnexus` installed, so the absent case is only
 * reachable by making the resolver fail — hence the module mock. Everything
 * asserted below is the contract an INSTALLED artifact depends on.
 *
 * ENV IS ISOLATED, and that is load-bearing rather than tidiness. The absent
 * simulation is defeated by an ambient `MUON_GITNEXUS_BIN`: on a dev machine
 * that exports one, every "no CLI reachable" assertion below silently became a
 * test of the OVERRIDE path instead, and the tarball's actual failure went
 * uncovered on exactly the machines most likely to run the suite.
 */

const ENV_KEYS = ["MUON_GITNEXUS_BIN"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.resetModules();
  vi.doUnmock("node:module");
});

/** Make `require.resolve('gitnexus/...')` throw, as an install without it does. */
function mockAbsentGitNexus(): void {
  vi.doMock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    return {
      ...actual,
      createRequire: (url: string | URL) => {
        const real = actual.createRequire(url);
        const shim = ((id: string) => real(id)) as unknown as NodeJS.Require;
        Object.assign(shim, real);
        shim.resolve = ((id: string) => {
          if (id.startsWith("gitnexus")) {
            throw new Error(`Cannot find module '${id}'`);
          }
          return real.resolve(id);
        }) as NodeJS.RequireResolve;
        return shim;
      },
    };
  });
}

/** Tool definitions built as if no `gitnexus` were installed. */
async function toolsWithoutGitNexus() {
  vi.resetModules();
  mockAbsentGitNexus();
  const { createGitNexusToolDefinitions } = await import(
    "../src/gitnexus-tools.js"
  );
  return createGitNexusToolDefinitions({});
}

/** Tool definitions built the ordinary way, with the CLI resolvable. */
async function toolsWithGitNexus() {
  vi.resetModules();
  vi.doUnmock("node:module");
  const { createGitNexusToolDefinitions } = await import(
    "../src/gitnexus-tools.js"
  );
  return createGitNexusToolDefinitions({});
}

/**
 * `whoami`'s grant AND the code-graph tool names, from ONE module instance.
 *
 * Both halves must come from the same import or the assertion proves nothing:
 * the whole defect being covered here is `whoami` answering from a DIFFERENT
 * resolution than the handlers it is describing.
 */
async function session(absent: boolean): Promise<{
  grant: { codeGraph: string; codeGraphNote: string };
  codeGraphNames: string[];
  callCodeQuery: () => Promise<string>;
}> {
  vi.resetModules();
  if (absent) mockAbsentGitNexus();
  else vi.doUnmock("node:module");
  const { createGitNexusToolDefinitions } = await import(
    "../src/gitnexus-tools.js"
  );
  const { createToolDefinitions } = await import("../src/handlers.js");
  const { MuonApiClient } = await import("@muon/client");
  const codeGraphNames = createGitNexusToolDefinitions({}).map(
    (tool) => tool.name
  );
  const tools = createToolDefinitions(
    new MuonApiClient("http://127.0.0.1:4000", vi.fn()),
    {}
  );
  const whoami = tools.find((tool) => tool.name === "whoami")!;
  const codeQuery = tools.find((tool) => tool.name === "code_query")!;
  const body = (await whoami.handler({})).structuredContent as {
    grant: { codeGraph: string; codeGraphNote: string };
  };
  return {
    grant: body.grant,
    codeGraphNames,
    callCodeQuery: async () => {
      const result = await codeQuery.handler({ query: "anything" });
      return String(
        (result.structuredContent as { error?: string })?.error ?? ""
      );
    },
  };
}

describe("no gitnexus CLI beside this build", () => {
  it("builds the tool definitions instead of throwing", async () => {
    await expect(toolsWithoutGitNexus()).resolves.toBeDefined();
  });

  it("keeps EVERY code-graph tool registered", async () => {
    // Dropping them would be scored by `muon mcp probe` as a stale build —
    // "rebuild your tree" for a problem a rebuild cannot fix. Compared against
    // the resolvable build rather than a hand-written list, so a new
    // code-graph tool is covered the day it lands.
    const absent = (await toolsWithoutGitNexus()).map((tool) => tool.name);
    const present = (await toolsWithGitNexus()).map((tool) => tool.name);
    expect(present.length).toBeGreaterThan(4);
    expect(absent).toEqual(present);
  });

  it("refuses every one of them with the same remedy, and spawns nothing", async () => {
    for (const tool of await toolsWithoutGitNexus()) {
      const result = await tool.handler({});
      expect(result.isError, tool.name).toBe(true);
      const error = String(
        (result.structuredContent as { error?: string }).error
      );
      expect(error, tool.name).toContain("The code graph is unavailable");
      expect(error, tool.name).toContain("MUON_GITNEXUS_BIN");
      // Names what still works, so the refusal is not read as "MUON is broken".
      expect(error, tool.name).toContain("Memory, coordination");
      // …but does NOT promise those tools ANSWER. This process measured one
      // thing; whether memory answers is decided by the session's own scope.
      expect(error, tool.name).not.toMatch(/tools are unaffected\./);
      // Carries the RESOLVER'S own reason rather than assuming "not
      // installed": an exports-map denial by a future gitnexus would otherwise
      // tell an operator to install what they already have.
      expect(error, tool.name).toContain("Cannot find module");
    }
  });

  it("is reported by whoami, so an agent learns before it plans", async () => {
    // The dead end this closes: `review_diff` is the ship preflight's named
    // `nextAction`, so an agent that discovers the absence by CALLING it is
    // already in a loop it cannot leave. `whoami` is the surface that answers
    // "what may I do here", and it said nothing about MUON's own missing half.
    vi.resetModules();
    const { gitNexusCliReachable } = await import("../src/gitnexus-tools.js");
    expect(gitNexusCliReachable({})).toBe(true); // resolvable in this repo
    // AN EXPLICIT BINARY IS NOT PROOF BY ITSELF. A non-empty variable used to
    // count as reachable unconditionally, so a typo or a path inherited from
    // another machine had `whoami` answer "available" beside seven handlers
    // that spawn ENOENT.
    expect(
      gitNexusCliReachable({ MUON_GITNEXUS_BIN: "/opt/gitnexus/nope" })
    ).toBe(false);
    // A real executable does count — this is the operator's supported escape
    // hatch on an install that bundles nothing.
    expect(
      gitNexusCliReachable({ MUON_GITNEXUS_BIN: process.execPath })
    ).toBe(true);
    // A directory is not a CLI, however plausible the path looks.
    expect(gitNexusCliReachable({ MUON_GITNEXUS_BIN: process.cwd() })).toBe(
      false
    );

    const { grant } = await session(false);
    expect(grant.codeGraph).toBe("available");
    // And it does not overclaim: reachable is not the same as indexed.
    expect(grant.codeGraphNote).toMatch(/INDEXED/);
  });

  it("whoami's degraded note names EXACTLY the tools that refuse", async () => {
    // Retyped prose is how this drifted in the first place: the note listed
    // seven tool names beside a builder that was free to register a different
    // set. The list is compared against the BUILT one, from the same module
    // instance, so an eighth code-graph tool is covered the day it lands.
    const { grant, codeGraphNames } = await session(true);
    expect(grant.codeGraph).toBe("unavailable");
    const listed = /every one of them refuses: ([^.]+)\./
      .exec(grant.codeGraphNote)?.[1]
      ?.split(", ");
    expect(listed).toEqual(codeGraphNames);
    // The resolver's own reason travels with it, same as the tool refusals.
    expect(grant.codeGraphNote).toContain("Cannot find module");
    // preflight_edit composes code_impact, so it fails closed here too and the
    // note has to say so — it is the tool a worker reaches for before an edit.
    expect(grant.codeGraphNote).toContain("preflight_edit");
  });

  it("whoami's degraded note makes NO claim about the memory half", async () => {
    // It used to assert "Memory, coordination and review-queue tools are
    // unaffected", which this process never measured — and which `grant.note`
    // in the same payload contradicts for an ungoverned session, where memory
    // comes back 403. Two fields of one tool disagreeing is worse than silence.
    const { grant } = await session(true);
    expect(grant.codeGraphNote).not.toMatch(/unaffected/i);
    // What it says instead: the boundary of the measurement, an explicit
    // refusal to claim anything about memory, and where that answer lives.
    expect(grant.codeGraphNote).toMatch(/what was measured/i);
    expect(grant.codeGraphNote).toMatch(
      /NOTHING about whether memory or coordination will answer/i
    );
    expect(grant.codeGraphNote).toContain("grant.note");
  });

  it("whoami cannot disagree with the handlers beside it (no split brain)", async () => {
    // The measured defect: `gitNexusCliReachable()` was re-derived per whoami
    // call while the tool handlers were frozen at construction, so the one tool
    // whose job is to answer "what may I do here" could say `available` beside
    // seven handlers that refuse.
    const absent = await session(true);
    expect(absent.grant.codeGraph).toBe("unavailable");
    expect(await absent.callCodeQuery()).toContain(
      "The code graph is unavailable"
    );

    const working = await session(false);
    expect(working.grant.codeGraph).toBe("available");
    expect(await working.callCodeQuery()).not.toContain(
      "The code graph is unavailable"
    );
  });

  it("an ungoverned session is not sent into the refusing tools", async () => {
    // The tarball's PRIMARY user: `muon mcp install`, no dispatch lineage. The
    // refusal's whole job is to name a next move, and it named the code-graph
    // tools — the exact seven that refuse on this install.
    vi.resetModules();
    mockAbsentGitNexus();
    const degraded = (await import("../src/handlers.js")).ungovernedSessionRefusal(
      "peer_send",
      "a job-scoped session"
    );
    expect(degraded).toContain("NO `gitnexus` CLI is reachable");
    expect(degraded).toContain("every one of them refuses");
    expect(degraded).not.toMatch(/From here, use the CODE-GRAPH tools/);
    // It still says the memory half is out of reach for its own (unchanged)
    // reason — the fix must not swallow the diagnosis it already carried.
    expect(degraded).toContain("MEMORY tools are partitioned BY JOB");

    vi.resetModules();
    vi.doUnmock("node:module");
    const { ungovernedSessionRefusal } = await import("../src/handlers.js");
    const working = ungovernedSessionRefusal(
      "peer_send",
      "a job-scoped session"
    );
    expect(working).toContain("From here, use the CODE-GRAPH tools");
  });

  it("ship refuses WITHOUT looping the agent back into review_diff", async () => {
    // `ship`'s preflight is fail-closed and stays that way. But on a graphless
    // install `review_diff` itself refuses, so no review can ever be recorded
    // and the "run review_diff, then ship again" nextAction is an order the
    // agent cannot carry out — a permanent loop inside the one refusal that
    // hands out a command.
    vi.resetModules();
    mockAbsentGitNexus();
    const { createOrchestratorToolDefinitions } = await import(
      "../src/orchestrator-tools.js"
    );
    const { createReviewDiffLedger } = await import("../src/review-session.js");
    const ship = createOrchestratorToolDefinitions({} as never, {
      jobId: "job-root",
      delegationToken: "root-job-token",
      chatId: "chat-1",
      chatTaskId: "task-shadow",
      apiBase: "http://localhost:4000",
      reviewLedger: createReviewDiffLedger(),
    }).find((tool) => tool.name === "ship")!;

    const result = await ship.handler({ taskId: "task-1", summary: "done" });
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as {
      _muon: {
        refusal?: {
          rule: string;
          summary: string;
          evidence: { label: string; value: string }[];
          nextAction?: { kind: string; action?: string; command?: string };
        };
      };
    };
    const refusal = payload._muon.refusal;
    // Still typed, still the same rule, still refused.
    expect(refusal?.rule).toBe("ship.review_unavailable");
    // The honest part: it names the install, not a retry.
    expect(refusal?.summary).toContain("review_diff cannot run");
    expect(refusal?.evidence[0]?.value).toContain(
      "no gitnexus CLI is reachable"
    );
    expect(refusal?.nextAction?.kind).toBe("operator");
    expect(refusal?.nextAction?.command).toBeUndefined();
    expect(refusal?.nextAction?.action).toMatch(/operator surface/);
    expect(refusal?.nextAction?.action).toContain("MUON_GITNEXUS_BIN");
  });

  it("ship still names review_diff when the graph IS reachable", async () => {
    // The control case: the ordinary "you never looked" refusal must keep its
    // runnable command, or this fix would have replaced one dead end with
    // another on every healthy install.
    vi.resetModules();
    vi.doUnmock("node:module");
    const { createOrchestratorToolDefinitions } = await import(
      "../src/orchestrator-tools.js"
    );
    const { createReviewDiffLedger } = await import("../src/review-session.js");
    const ship = createOrchestratorToolDefinitions({} as never, {
      jobId: "job-root",
      delegationToken: "root-job-token",
      chatId: "chat-1",
      chatTaskId: "task-shadow",
      apiBase: "http://localhost:4000",
      reviewLedger: createReviewDiffLedger(),
    }).find((tool) => tool.name === "ship")!;

    const result = await ship.handler({ taskId: "task-1", summary: "done" });
    const payload = result.structuredContent as {
      _muon: { refusal?: { nextAction?: { kind: string; command?: string } } };
    };
    expect(payload._muon.refusal?.nextAction?.kind).toBe("command");
    expect(payload._muon.refusal?.nextAction?.command).toContain(
      'review_diff({ taskId: "task-1" })'
    );
  });

  it("is in the INSTRUCTIONS too — the channel a session reads first", async () => {
    // `whoami` covers the agent that thinks to ask. `initialize` covers every
    // agent, and it was the one telling them "Call `code_query` before you
    // grep" on a build where that tool cannot answer. Asserted through a real
    // client over a real transport, under the same resolver failure the tarball
    // hits, so this proves the WIRING and not just the string builder.
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const read = async (absent: boolean): Promise<string> => {
      const tools = absent
        ? await toolsWithoutGitNexus()
        : await toolsWithGitNexus();
      // Imported AFTER the mock is in place, so the factory resolves through it.
      const { buildMuonServer } = await import("../src/server-factory.js");
      const server = buildMuonServer(tools, { mode: "worker" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const instructions = client.getInstructions() ?? "";
      await client.close();
      return instructions;
    };

    const degraded = await read(true);
    expect(degraded).toContain("THE CODE GRAPH IS ABSENT FROM THIS INSTALL");
    expect(degraded).toContain("MUON_GITNEXUS_BIN");
    expect(degraded).not.toContain("Call `code_query` before you grep");

    const working = await read(false);
    expect(working).toContain("Call `code_query` before you grep");
    expect(working).not.toContain("THE CODE GRAPH IS ABSENT");
  });

  it("still uses an explicitly configured binary when one is given", async () => {
    // The refusal is for "no CLI reachable", not "no BUNDLED CLI" — an
    // operator who points MUON at an installed GitNexus must keep the tools.
    // `options.binary` is an IN-PROCESS injection by a caller that already
    // resolved it, so it is trusted as given and deliberately not stat'd.
    vi.resetModules();
    const { createGitNexusToolDefinitions } = await import(
      "../src/gitnexus-tools.js"
    );
    const run = vi.fn(async () => ({ stdout: "{}", stderr: "", code: 0 }));
    const tools = createGitNexusToolDefinitions({
      binary: "/opt/gitnexus/bin/gitnexus",
      run: run as never,
    });
    const repoMap = tools.find((tool) => tool.name === "repo_map")!;
    const result = await repoMap.handler({});
    expect(
      String((result.structuredContent as { error?: string }).error ?? "")
    ).not.toContain("The code graph is unavailable");
  });

  it("a broken MUON_GITNEXUS_BIN refuses instead of pretending", async () => {
    // Measured hole: the override was proof by mere presence, so this install
    // registered seven tools, told `whoami` they were available, and produced a
    // raw ENOENT per call. It must refuse with the reason instead — and NOT
    // silently fall back to the bundled CLI, because naming a binary is a
    // declaration of intent and using a different graph would be the worse lie.
    vi.resetModules();
    process.env.MUON_GITNEXUS_BIN = "/opt/gitnexus/definitely-not-here";
    const { createGitNexusToolDefinitions } = await import(
      "../src/gitnexus-tools.js"
    );
    const spawned = vi.fn();
    const repoMap = createGitNexusToolDefinitions({
      run: spawned as never,
    }).find((tool) => tool.name === "repo_map")!;
    const result = await repoMap.handler({});
    const error = String(
      (result.structuredContent as { error?: string }).error ?? ""
    );
    expect(error).toContain("The code graph is unavailable");
    expect(error).toContain("MUON_GITNEXUS_BIN=/opt/gitnexus/definitely-not-here");
    expect(spawned).not.toHaveBeenCalled();
  });

  it("resolves ONCE per process, so two callers cannot disagree", async () => {
    // Per-process determinism is the property, and a mid-process env change not
    // being picked up is the deliberate cost of it: a session whose answer
    // changes between two calls is the split brain this replaces. Restarting is
    // the supported way to change it, which every refusal already says.
    vi.resetModules();
    const { gitNexusCliReachable } = await import("../src/gitnexus-tools.js");
    expect(gitNexusCliReachable()).toBe(true);
    process.env.MUON_GITNEXUS_BIN = "/opt/gitnexus/definitely-not-here";
    expect(gitNexusCliReachable()).toBe(true); // memoised, on purpose
    // An EXPLICIT env argument is a question about another environment, so it
    // bypasses the memo rather than being answered from it.
    expect(
      gitNexusCliReachable({ MUON_GITNEXUS_BIN: "/opt/gitnexus/nope" })
    ).toBe(false);
  });
});
