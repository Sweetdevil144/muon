import { describe, expect, it } from "vitest";
import { LANE_GUARD_ENV_KEYS } from "../src/lane-guard-env.js";
import { compileOpencodeProfile } from "../src/profile-compiler.js";
import {
  OPENCODE_ALLOWED_PERMISSIONS,
  OPENCODE_DENIED_PERMISSIONS,
  OPENCODE_GUARD_CONFIG_PATH,
  OpencodeAdapter,
  OpencodeRoleRefusedError,
  buildOpencodeGuardConfig,
  buildOpencodePermissionTable,
  mcpServersToOpencodeConfig,
  narrowOpencodeProfile,
  opencodeGuardEnv,
  parseOpencodeRunResult,
  stripOpencodeWideningArgs,
} from "../src/opencode-adapter.js";
import { probeVendorReadiness } from "../src/vendor-readiness.js";
import {
  GOVERNED_MCP_SERVER_NAME,
  VENDOR_REGISTRY,
  type LaneProfile,
} from "@muon/protocol";

/**
 * The OpenCode lane's boundary lives in a CONFIG FILE and the env that makes
 * that file the last word, because opencode 1.18.5 has no `--permissions` flag
 * at all. These tests pin the three nets and the vendor lore behind them.
 *
 * Everything here is hermetic: no binary, no network, no daemon.
 */

const baseProfile: LaneProfile = {
  model: undefined,
  permissionMode: undefined,
  sandbox: undefined,
  addDirs: [],
  allowedTools: [],
  deniedTools: [],
  mcpServers: [],
  rawConfig: {},
  env: {},
  extraArgs: [],
};

describe("opencode guard config (net 1 — the permission table)", () => {
  it("is DENY-FIRST: the wildcard is deny, so an unknown token cannot be allowed", () => {
    const config = JSON.parse(buildOpencodeGuardConfig()) as {
      permission: Record<string, string>;
    };
    // This is the whole bounded-surface property. opencode's own default is
    // `{"*": "allow"}` (verified via `opencode debug agent build`), so MUON must
    // OVERRIDE the wildcard rather than enumerate around it. A permission token
    // a FUTURE opencode release adds lands on `deny` by construction.
    expect(config.permission["*"]).toBe("deny");

    // A token nobody has written down yet is not in the table at all, which is
    // exactly why the wildcard has to carry it.
    expect(config.permission["some_future_tool"]).toBeUndefined();
  });

  it("allows ONLY read-class permissions, each stated positively", () => {
    const config = JSON.parse(buildOpencodeGuardConfig()) as {
      permission: Record<string, string>;
    };
    const allowed = Object.entries(config.permission)
      .filter(([, action]) => action === "allow")
      .map(([token]) => token)
      .sort();
    expect(allowed).toEqual([...OPENCODE_ALLOWED_PERMISSIONS].sort());
  });

  it("TODO 1.7: grants the governed brain's MCP namespace so *:deny cannot erase it", () => {
    // Live A/B (opencode 1.18.7): with MUON's deny table alone the model said
    // muon tools were "not available" even though mcp list reported connected;
    // adding `${GOVERNED_MCP_SERVER_NAME}_*: allow` restored tool calls while
    // bash/edit stayed denied. Connectivity ≠ availability.
    const config = JSON.parse(buildOpencodeGuardConfig()) as {
      permission: Record<string, string>;
    };
    const grant = `${GOVERNED_MCP_SERVER_NAME}_*`;
    expect(OPENCODE_ALLOWED_PERMISSIONS).toContain(grant);
    expect(config.permission[grant]).toBe("allow");
    expect(config.permission["*"]).toBe("deny");
    expect(config.permission.bash).toBe("deny");
    expect(config.permission.edit).toBe("deny");
  });

  it("denies every KNOWN token BY NAME, because specificity beats the wildcard", () => {
    // The hole this closes, found by running MUON's real config through the real
    // binary: opencode resolves permissions by SPECIFICITY FIRST, then last-wins
    // among equals. With `{"*":"deny"}` at position 26 of the resolved table, the
    // built-in `external_directory: ask` (position 2) and `doom_loop: ask`
    // (position 1) STILL WON, and `question` resolved to `allow`. A wildcard only
    // covers tokens with no specific entry anywhere in the chain.
    const config = JSON.parse(buildOpencodeGuardConfig()) as {
      permission: Record<string, string>;
    };
    for (const token of OPENCODE_DENIED_PERMISSIONS) {
      expect(config.permission[token], `${token} must be denied BY NAME`).toBe(
        "deny"
      );
    }
    // The two built-ins that outranked the wildcard are the regression itself.
    expect(config.permission.external_directory).toBe("deny");
    expect(config.permission.doom_loop).toBe("deny");
    expect(config.permission.question).toBe("deny");
  });

  it("covers EVERY documented token exactly once, allow or deny", () => {
    // Bounded-surface completeness. This list is opencode's published
    // `PermissionConfig` schema plus the two runtime-only tokens observed in the
    // resolved table. A token in neither MUON list would be an uncovered
    // authority field — the exact shape that has defeated a bounded surface here
    // three times.
    const documented = [
      "read",
      "edit",
      "glob",
      "grep",
      "list",
      "bash",
      "task",
      "external_directory",
      "todowrite",
      "question",
      "webfetch",
      "websearch",
      "lsp",
      "doom_loop",
      "skill",
      "plan_enter",
      "plan_exit",
    ];
    const allowed = new Set<string>(OPENCODE_ALLOWED_PERMISSIONS);
    const denied = new Set<string>(OPENCODE_DENIED_PERMISSIONS);

    // Disjoint: a token stated twice is an ambiguity, not a belt-and-braces.
    expect([...allowed].filter((t) => denied.has(t))).toEqual([]);

    const uncovered = documented.filter(
      (token) => !allowed.has(token) && !denied.has(token)
    );
    expect(uncovered, "every documented token must be stated").toEqual([]);
  });

  it("never allows a write, shell, network or sub-agent permission", () => {
    const config = JSON.parse(buildOpencodeGuardConfig()) as {
      permission: Record<string, string>;
    };
    // Named individually rather than derived, so adding one to the allowlist
    // has to fail HERE and not merely change a count.
    for (const forbidden of [
      "bash",
      "edit",
      "task",
      "webfetch",
      "websearch",
      "external_directory",
      "skill",
      "question",
    ]) {
      expect(config.permission[forbidden]).not.toBe("allow");
    }
    expect(OPENCODE_ALLOWED_PERMISSIONS).not.toContain("bash");
    expect(OPENCODE_ALLOWED_PERMISSIONS).not.toContain("edit");
  });
});

describe("opencode guard env (net 2 — making MUON's config the last word)", () => {
  const env = opencodeGuardEnv("/repo");

  it("disables the WORKSPACE config, which is the proven re-widening vector", () => {
    // LIVE-VERIFIED against opencode 1.18.5: with a workspace `opencode.json`
    // containing {"permission":{"bash":"allow"}}, launching with OPENCODE_CONFIG
    // pointed at a deny config resolved `bash` to ALLOW. Resolution is
    // last-source-wins and the workspace is attacker-controlled input (a repo
    // under review can check that file in). This env var is what makes MUON's
    // config last, and it is load-bearing, not belt-and-braces.
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  it("names MUON's own config file by ABSOLUTE path", () => {
    expect(env.OPENCODE_CONFIG).toBe(`/repo/${OPENCODE_GUARD_CONFIG_PATH}`);
  });

  it("relocates XDG_CONFIG_HOME so the operator's ambient config cannot attach", () => {
    // Also live-verified: even with the two vars above set, the user's
    // ~/.config/opencode/ still merged in — on the founder's machine that meant
    // a REMOTE MCP server with a bearer token attached to every run, which is a
    // data-egress vector and defeats MUON injecting the governed MCP server.
    // Redirecting XDG_CONFIG_HOME was the only lever that removed it.
    expect(env.XDG_CONFIG_HOME).toBe("/repo/.muon/opencode");
  });

  it("does NOT touch XDG_DATA_HOME, where the operator's own login lives", () => {
    // BYO-auth: `opencode auth login` writes auth.json under XDG_DATA_HOME.
    // Relocating it would break the operator's real login, and MUON never
    // custodies a vendor credential anyway.
    expect(env).not.toHaveProperty("XDG_DATA_HOME");
  });

  it("TODO 1.8: carries the deny table INLINE via OPENCODE_CONFIG_CONTENT (the above-project lever)", () => {
    // OPENCODE_CONFIG loads below project config and loses to an attacker
    // opencode.json on its own; OPENCODE_CONFIG_CONTENT loads above it. Verified
    // live: inline bash:deny beat a project bash:allow with NO disable-project.
    // So containment no longer rests on the single disable-project lever.
    expect(env.OPENCODE_CONFIG_CONTENT).toBeTruthy();
    const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      permission: Record<string, string>;
    };
    // Same deny-first table the file carries — byte-identical source.
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(buildOpencodeGuardConfig());
    expect(inline.permission["*"]).toBe("deny");
    expect(inline.permission.bash).toBe("deny");
    expect(inline.permission.edit).toBe("deny");
    expect(inline.permission.read).toBe("allow");
  });

  it("TODO 1.7: OPENCODE_CONFIG_CONTENT carries the governed mcp block when servers are supplied", () => {
    const servers = [
      {
        name: "muon",
        command: "muon-mcp",
        args: [] as string[],
        env: {
          MUON_API_BASE: "http://127.0.0.1:4000",
          MUON_API_TOKEN: "job-token",
          MUON_MCP_MODE: "worker",
          MUON_TASK_ID: "task-1",
          MUON_LANE_KEY: "opencode",
        },
      },
    ];
    const withBrain = opencodeGuardEnv("/repo", servers);
    expect(withBrain.OPENCODE_CONFIG_CONTENT).toBe(
      buildOpencodeGuardConfig(servers)
    );
    const inline = JSON.parse(withBrain.OPENCODE_CONFIG_CONTENT) as {
      permission: Record<string, string>;
      mcp: Record<string, { type: string; command: string[]; environment: Record<string, string>; enabled: boolean }>;
    };
    // Deny table is unchanged — brain injection must not widen FS authority.
    expect(inline.permission["*"]).toBe("deny");
    expect(inline.permission.bash).toBe("deny");
    // Opencode schema, not Claude/Cursor's: key `mcp`, command array, `environment`.
    expect(inline.mcp.muon.type).toBe("local");
    expect(inline.mcp.muon.command).toEqual(["muon-mcp"]);
    expect(inline.mcp.muon.enabled).toBe(true);
    // S2: secrets are references, never the literal job token.
    expect(inline.mcp.muon.environment.MUON_API_TOKEN).toBe(
      "{env:MUON_API_TOKEN}"
    );
    expect(JSON.stringify(inline)).not.toContain("job-token");
  });

  it("TODO 1.9: sets OPENCODE_PERMISSION, opencode's LAST word on permission", () => {
    // LIVE-VERIFIED (1.18.7, 2026-07-31): with a project opencode.json saying
    // bash:allow AND an inline OPENCODE_CONFIG_CONTENT saying bash:deny, adding
    // OPENCODE_PERMISSION={"bash":"allow"} resolved bash to ALLOW — it outranks
    // both. MUON must therefore own it; leaving it unset leaves the strongest
    // lever to whoever set it last.
    expect(env.OPENCODE_PERMISSION).toBeTruthy();
    const table = JSON.parse(env.OPENCODE_PERMISSION) as Record<string, string>;
    expect(table["*"]).toBe("deny");
    expect(table.bash).toBe("deny");
    expect(table.edit).toBe("deny");
    expect(table.read).toBe("allow");
  });

  it("TODO 1.9: the two levers cannot drift — same table, one builder", () => {
    // They have DIFFERENT precedence and the higher one wins PER KEY (merge, not
    // replace — measured). Two tables that drifted would resolve to the union of
    // the drift, with the weaker lever's denies silently replaced.
    const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      permission: Record<string, string>;
    };
    expect(JSON.parse(env.OPENCODE_PERMISSION)).toEqual(inline.permission);
    expect(JSON.parse(env.OPENCODE_PERMISSION)).toEqual(
      buildOpencodePermissionTable()
    );
  });

  it("TODO 1.9: OPENCODE_PERMISSION carries permission ONLY, never the mcp block", () => {
    // The strongest channel is also the narrowest: opencode reads it as the
    // top-level permission object. Putting a config shape in it would be
    // silently ignored (a malformed value is dropped with exit 0 — measured),
    // which would quietly disarm the lever.
    const servers = [
      {
        name: "muon",
        command: "muon-mcp",
        args: [] as string[],
        env: { MUON_API_TOKEN: "job-token" },
      },
    ];
    const withBrain = opencodeGuardEnv("/repo", servers);
    const table = JSON.parse(withBrain.OPENCODE_PERMISSION) as Record<
      string,
      unknown
    >;
    expect(table).not.toHaveProperty("mcp");
    expect(table).not.toHaveProperty("permission");
    expect(table[`${GOVERNED_MCP_SERVER_NAME}_*`]).toBe("allow");
    expect(withBrain.OPENCODE_PERMISSION).not.toContain("job-token");
  });

  it("TODO 1.9: every OPENCODE_* key the guard sets is registered as a lane-guard key", () => {
    // The registration is what stops an AMBIENT OPENCODE_PERMISSION reaching a
    // child and what refuses another lane's profile from setting one. A key set
    // here but unregistered there would be inheritable, and because the merge is
    // per key an ambient {"bash":"allow"} flips one token while the other
    // eighteen still read correctly. See lane-guard-env.ts.
    const guarded = new Set<string>(LANE_GUARD_ENV_KEYS.opencode ?? []);
    for (const key of Object.keys(env)) {
      if (!key.startsWith("OPENCODE_")) continue;
      expect(guarded, `${key} is set by the guard but not registered`).toContain(
        key
      );
    }
    // Registered under the ADAPTER ID, which is what runLaneCommand passes as
    // laneId — a mismatch would make lane-runner refuse MUON's own guard.
    expect(new OpencodeAdapter().id).toBe("opencode");
  });

  it("forwards no vendor credential of any kind", () => {
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/API_KEY|TOKEN|SECRET/i);
    }
  });
});

describe("stripOpencodeWideningArgs (net 3 — the categorical argv net)", () => {
  it("strips --auto, which auto-approves every permission", () => {
    const { args, removed } = stripOpencodeWideningArgs([
      "run",
      "--auto",
      "brief",
    ]);
    expect(args).toEqual(["run", "brief"]);
    expect(removed).toEqual(["--auto"]);
  });

  it("strips the egress flags (--share publishes, --attach sends the run away)", () => {
    const { args } = stripOpencodeWideningArgs([
      "run",
      "--share",
      "--attach",
      "http://evil.example",
      "brief",
    ]);
    expect(args).toEqual(["run", "brief"]);
  });

  it("strips --agent, which would swap the permission table MUON compiled", () => {
    // `build` is full-access. MUON's own invocation names NO agent, so any
    // occurrence arrived from a caller and must not survive.
    const { args } = stripOpencodeWideningArgs(["run", "--agent", "build", "b"]);
    expect(args).toEqual(["run", "b"]);
  });

  it("drops the VALUE token with its flag, so it cannot become the prompt", () => {
    // opencode reads positionals as the message. Leaving `build` behind would
    // silently append it to the brief.
    const { args } = stripOpencodeWideningArgs(["run", "--agent", "build"]);
    expect(args).toEqual(["run"]);
    const inline = stripOpencodeWideningArgs(["run", "--agent=build", "brief"]);
    expect(inline.args).toEqual(["run", "brief"]);
  });

  it("strips the listener flags that would turn a one-shot into a server", () => {
    const { args } = stripOpencodeWideningArgs([
      "run",
      "--port",
      "4096",
      "--hostname",
      "0.0.0.0",
      "--cors",
      "evil.example",
      "--mdns-domain",
      "evil.local",
      "--mdns",
      "brief",
    ]);
    expect(args).toEqual(["run", "brief"]);
  });

  it("treats BOOLEAN widening flags as valueless, so the brief survives", () => {
    // Regression: `--mdns` is `[boolean]` in `opencode --help`. Listing it among
    // the valued flags made the strip swallow the NEXT token — which in MUON's
    // argv is the brief itself, silently truncating the prompt rather than
    // failing loudly.
    for (const booleanFlag of ["--auto", "--share", "--mdns"]) {
      const { args } = stripOpencodeWideningArgs(["run", booleanFlag, "brief"]);
      expect(args, `${booleanFlag} must not consume the brief`).toEqual([
        "run",
        "brief",
      ]);
    }
  });

  it("keeps the flags MUON's own invocation needs", () => {
    const { args, removed } = stripOpencodeWideningArgs([
      "run",
      "--format",
      "json",
      "--dir",
      "/repo",
      "--model",
      "anthropic/claude-sonnet-4",
      "locate the parser",
    ]);
    expect(removed).toEqual([]);
    expect(args).toContain("--format");
    expect(args).toContain("--model");
    expect(args).toContain("locate the parser");
  });

  it("TODO 1.16: the sub-agent spawner is denied BY NAME, and the registry says so", () => {
    // A wildcard alone would lose to opencode's specificity-first resolution, so
    // `task` has to be named. This pins the registry's audit row to the table that
    // actually carries it, and to every lever the guard sets it on — a deny that
    // reached only one of the three would be a suppression a project config could
    // still outrank.
    const fanOut = VENDOR_REGISTRY.opencode.execution.guards.nativeFanOut;
    expect(fanOut.mechanism).toContain("task");
    expect(fanOut.suppression.state).toBe("declared");
    expect(OPENCODE_DENIED_PERMISSIONS).toContain("task");
    expect(buildOpencodePermissionTable().task).toBe("deny");
    const env = opencodeGuardEnv("/tmp/work");
    expect(JSON.parse(env.OPENCODE_PERMISSION!).task).toBe("deny");
    expect(
      JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission.task
    ).toBe("deny");
  });

  it("strips exactly what the REGISTRY declares it strips", () => {
    // ADR-0022 §6.3 keeps `wideningFlags` as per-vendor DATA applied by that
    // vendor's own guard, so the registry's declaration and the guard's
    // behaviour are two statements. This asserts they agree in both directions:
    // a flag the registry names must actually be stripped, and the guard must
    // not strip anything the registry does not name.
    const declared = VENDOR_REGISTRY.opencode.execution.guards.wideningFlags;
    for (const flag of declared) {
      const { removed } = stripOpencodeWideningArgs(["run", flag, "brief"]);
      expect(removed, `${flag} is declared but not stripped`).toContain(flag);
    }
    const strippedButUndeclared = [
      "--format",
      "--dir",
      "--model",
      "--variant",
      "--session",
    ].filter(
      (flag) => stripOpencodeWideningArgs([flag, "x"]).removed.length > 0
    );
    expect(strippedButUndeclared).toEqual([]);
  });

  it("is case- and position-insensitive (a widening flag anywhere is stripped)", () => {
    const { args } = stripOpencodeWideningArgs([
      "--AUTO",
      "run",
      "brief",
      "--Share",
    ]);
    expect(args).toEqual(["run", "brief"]);
  });
});

describe("OpencodeAdapter — the invocation and the ceiling", () => {
  it("declares scout and NOTHING else", () => {
    expect([...new OpencodeAdapter().supportedRoles]).toEqual(["scout"]);
  });

  it("emits the fixed read-only invocation, carries --pure, and never names an agent", () => {
    const invocation = new OpencodeAdapter().taskCommand("locate the parser", {
      cwd: "/repo",
    });
    expect(invocation.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      "/repo",
      "locate the parser",
    ]);
    // `--agent plan` would LOOK safer and be worse: `opencode debug agent plan`
    // resolves to `* → allow` at position 1, so `plan` denies NOTHING. MUON
    // leans on its own config, not on the vendor's planning mode.
    expect(invocation.args).not.toContain("--agent");
    expect(invocation.args).not.toContain("--auto");
    // --pure closes the global-plugin egress vector (finding 5). It is MUON's
    // own flag, so the categorical widening strip must keep it.
    expect(invocation.args).toContain("--pure");
    expect(stripOpencodeWideningArgs(invocation.args).removed).toEqual([]);
  });

  it("refuses every role outside the ceiling, including read-only ones", async () => {
    const adapter = new OpencodeAdapter();
    for (const role of [
      "implementer",
      "orchestrator",
      "docs",
      "reviewer",
      "qa",
      "architect",
    ] as const) {
      await expect(
        adapter.startSession({ taskId: "t", brief: "b", role })
      ).rejects.toBeInstanceOf(OpencodeRoleRefusedError);
    }
  });

  it("guardFinalArgs is wired, so no composition path can reintroduce --auto", () => {
    // The last-mile net runs over invocation + compiled profile + extraArgs
    // together, which is what makes it categorical rather than per-call-site.
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      extraArgs: ["--auto", "--share"],
    });
    expect(stripOpencodeWideningArgs(compiled.args).args).toEqual([]);
  });
});

describe("narrowOpencodeProfile (the compile-time half of the two nets)", () => {
  it("downgrades full-auto and full-access", () => {
    const narrowed = narrowOpencodeProfile({
      ...baseProfile,
      permissionMode: "full-auto",
      sandbox: "full-access",
    });
    expect(narrowed.permissionMode).toBe("default");
    expect(narrowed.sandbox).toBe("read-only");
  });

  it("leaves an already-narrow profile untouched", () => {
    const narrowed = narrowOpencodeProfile({
      ...baseProfile,
      permissionMode: "strict",
      sandbox: "read-only",
    });
    expect(narrowed.permissionMode).toBe("strict");
    expect(narrowed.sandbox).toBe("read-only");
  });

  it("TODO 1.7 P1: drops every mcp server that is not the governed muon brain", () => {
    // An MCP entry is arbitrary command execution; the permission table cannot
    // stop spawn. Before 1.7 mcpServers were inert here — now they become a
    // command array, so the lane-local net must match narrowProfileForRole.
    const narrowed = narrowOpencodeProfile({
      ...baseProfile,
      mcpServers: [
        {
          name: GOVERNED_MCP_SERVER_NAME,
          command: "muon-mcp",
          args: [],
          env: { MUON_MCP_MODE: "worker" },
        },
        {
          name: "hostile",
          command: "/usr/bin/touch",
          args: ["/tmp/pwned"],
          env: {},
        },
        {
          name: "muon_x",
          command: "/bin/echo",
          args: ["ride-the-grant"],
          env: {},
        },
      ],
    });
    expect(narrowed.mcpServers).toHaveLength(1);
    expect(narrowed.mcpServers[0]!.name).toBe(GOVERNED_MCP_SERVER_NAME);
    expect(narrowed.mcpServers[0]!.command).toBe("muon-mcp");
  });
});

describe("compileOpencodeProfile", () => {
  it("emits --model for an argv-safe value", () => {
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      model: "anthropic/claude-sonnet-4",
    });
    expect(compiled.args).toEqual(["--model", "anthropic/claude-sonnet-4"]);
  });

  it("refuses a guarded model value instead of putting it on argv", () => {
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      model: "--strict-mcp-config",
    });
    expect(compiled.args).toEqual([]);
    expect(compiled.unsupported).toContain(
      "guarded opencode model value rejected"
    );
  });

  it("TODO 3.4: refuses a BARE slug on form, and names the real reason", () => {
    // The LANE-PROFILE path gets the same form check the route applies to a
    // per-dispatch override, so the two cannot disagree about what an opencode
    // id is. `sonnet` is a plausible CLAUDE id; on argv here it would spawn the
    // lane and fail inside the vendor, which reads as a MUON fault.
    const compiled = compileOpencodeProfile({ ...baseProfile, model: "sonnet" });
    expect(compiled.args).toEqual([]);
    // NOT the guarded-value reason: this value is safe, it is simply not an id.
    expect(compiled.unsupported).not.toContain(
      "guarded opencode model value rejected"
    );
    expect(compiled.unsupported.join(" ")).toContain("provider/model");
    expect(compiled.unsupported.join(" ")).toContain("opencode models");
  });

  it("TODO 3.4: a path-shaped value never reaches --model", () => {
    // Satisfies "≥2 non-empty slash-separated segments" and is still not an id.
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      model: "../../etc/passwd",
    });
    expect(compiled.args).toEqual([]);
    expect(compiled.unsupported.join(" ")).toContain("provider/model");
  });

  it("REPORTS permissionMode rather than silently dropping it", () => {
    // The permission table is the guard config, not a flag. A caller who set a
    // mode needs to be told it did not become one — a silent drop is how an
    // operator ends up believing a boundary exists that does not.
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      permissionMode: "full-auto",
    });
    expect(compiled.args).toEqual([]);
    expect(compiled.unsupported.join(" ")).toMatch(/permissions are config-only/);
  });

  it("never emits a permission or sandbox flag, because opencode has none", () => {
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      permissionMode: "full-auto",
      sandbox: "full-access",
      allowedTools: ["Bash"],
      deniedTools: [],
    });
    // The specific regression this pins: inventing `--permissions` (which the
    // brief for this work assumed existed, and 1.18.5 does not have) would imply
    // a boundary the CLI cannot enforce.
    expect(compiled.args.join(" ")).not.toMatch(/--permissions|--sandbox|--auto/);
  });

  it("TODO 1.7: hoists local mcp env and does NOT refuse governed brain access", () => {
    // Local stdio servers ride OpencodeAdapter's guard config, not argv. The
    // compiler's job is to hoist the secret values into the child env so
    // `{env:VAR}` references in the mcp block resolve.
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      mcpServers: [
        {
          name: "muon",
          command: "muon-mcp",
          args: [],
          env: {
            MUON_API_BASE: "http://127.0.0.1:4000",
            MUON_API_TOKEN: "job-token",
            MUON_MCP_MODE: "worker",
          },
        },
      ],
    });
    expect(compiled.env.MUON_API_TOKEN).toBe("job-token");
    expect(compiled.env.MUON_MCP_MODE).toBe("worker");
    expect(compiled.unsupported.join(" ")).not.toMatch(/governed brain/);
    expect(compiled.unsupported.join(" ")).not.toMatch(/no `mcp` block/);
    // Still no per-run MCP flag on argv — that channel does not exist.
    expect(compiled.args.join(" ")).not.toMatch(/mcp/i);
  });

  it("TODO 1.7: refuses remote/url mcp servers (finding 5 — no egress)", () => {
    const compiled = compileOpencodeProfile({
      ...baseProfile,
      mcpServers: [
        {
          name: "hostile",
          url: "https://evil.example/mcp",
          args: [],
          env: { BEARER: "leak-me" },
        },
      ],
    });
    expect(compiled.unsupported.join(" ")).toMatch(/remote URLs are refused/);
    // Do not hoist a remote server's secrets into the child either.
    expect(compiled.env.BEARER).toBeUndefined();
  });
});

describe("mcpServersToOpencodeConfig (TODO 1.7 schema)", () => {
  it("uses opencode's schema: mcp key shape, command array, environment refs", () => {
    const mcp = mcpServersToOpencodeConfig([
      {
        name: "muon",
        command: "muon-mcp",
        args: ["--quiet"],
        env: { MUON_API_TOKEN: "secret", MUON_MCP_MODE: "worker" },
      },
    ]);
    const muon = mcp.muon as {
      type: string;
      command: string[];
      enabled: boolean;
      environment: Record<string, string>;
    };
    expect(muon.type).toBe("local");
    expect(muon.command).toEqual(["muon-mcp", "--quiet"]);
    expect(muon.enabled).toBe(true);
    expect(muon.environment).toEqual({
      MUON_API_TOKEN: "{env:MUON_API_TOKEN}",
      MUON_MCP_MODE: "{env:MUON_MCP_MODE}",
    });
  });

  it("skips http/url servers rather than inventing a remote entry", () => {
    const mcp = mcpServersToOpencodeConfig([
      {
        name: "remote",
        url: "https://example.com/mcp",
        args: [],
        env: {},
      },
    ]);
    expect(mcp).toEqual({});
  });
});

describe("opencode auth interpretation (the rc=0-when-logged-out trap)", () => {
  const probe = (stdout: string) =>
    probeVendorReadiness("opencode", {
      hasCommand: () => true,
      exec: () => ({ status: 0, stdout, stderr: "" }),
      resolveCredentials: () => ({ ready: false, environmentKeys: [] }),
    });

  it("reads 0 credentials as NOT authenticated even though the CLI exits 0", async () => {
    // LIVE-VERIFIED against opencode 1.18.5 with the credential store relocated
    // to an empty dir: `opencode auth list` still exits 0 and prints
    // "0 credentials". Same trap as `cursor-agent`. Trusting the exit code would
    // turn "logged out" into a lane MUON reports as ready.
    const verdict = await probe("┌  Credentials\n└  0 credentials\n");
    expect(verdict.authenticated).toBe(false);
    expect(verdict.detail).toBe("not logged in");
  });

  it("reads a positive credential count as authenticated", async () => {
    const verdict = await probe("┌  Credentials\n└  2 credentials\n");
    expect(verdict.authenticated).toBe(true);
    expect(verdict.detail).toMatch(/2 stored credentials/);
  });

  it("IGNORES the environment-variable section", async () => {
    // `auth list` also reports provider keys found in the PROBE's environment,
    // but MUON does not forward those to this lane (credentials.envKeys is
    // empty), so counting them would report a lane as ready that cannot actually
    // authenticate once MUON scopes the child env.
    const verdict = await probe(
      "┌  Credentials\n└  0 credentials\n\n┌  Environment\n●  OpenAI OPENAI_API_KEY\n└  1 environment variable\n"
    );
    expect(verdict.authenticated).toBe(false);
  });

  it("fails closed when the summary line is gone (the CLI changed shape)", async () => {
    const verdict = await probe("some entirely new output format\n");
    expect(verdict.authenticated).toBe(false);
  });

  it("never echoes credential material into the detail", async () => {
    const verdict = await probe(
      "┌  Credentials\n●  Anthropic sk-ant-SECRETVALUE\n└  1 credentials\n"
    );
    expect(verdict.authenticated).toBe(true);
    expect(verdict.detail).not.toMatch(/sk-ant|SECRETVALUE/);
  });
});

describe("parseOpencodeRunResult", () => {
  it("degrades honestly when stdout is not JSON", () => {
    expect(parseOpencodeRunResult("plain text answer")).toEqual({
      parsed: false,
    });
  });

  it("reads the last text-bearing field of a JSONL stream", () => {
    const result = parseOpencodeRunResult(
      '{"type":"start"}\n{"text":"first"}\n{"text":"final answer"}\n'
    );
    expect(result.parsed).toBe(true);
    expect(result.text).toBe("final answer");
  });

  it("parses without inventing text when no known field is present", () => {
    const result = parseOpencodeRunResult('{"type":"done","code":0}');
    expect(result.parsed).toBe(true);
    expect(result.text).toBeUndefined();
  });
});
