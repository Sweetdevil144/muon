import { describe, expect, it } from "vitest";
import {
  VENDOR_IDS,
  VENDOR_REGISTRY,
  isVendorId,
  type VendorId,
} from "@muon/protocol";
import {
  ALL_LANE_GUARD_ENV_KEYS,
  LANE_GUARD_ENV_KEYS,
} from "../src/lane-guard-env.js";
import {
  buildLaneEnvironment,
  buildProviderAwareLaneEnvironment,
} from "../src/lane-runner.js";
import { isSafeDynamicCredentialKey } from "../src/provider-credentials.js";
import {
  RUNNER_ENV_ALLOWLIST,
  sandboxedRunnerEnv,
} from "../src/sandbox/launcher.js";

/**
 * The credential × vendor matrix (ADR-0022 G5 — the BYO-auth blast radius).
 *
 * G5 is named in the ADR as the worst outcome in the whole design: a wrong entry
 * forwards `ANTHROPIC_API_KEY` to a third-party vendor binary. It is the worst
 * because it is SILENT — the wrong key is simply handed over, the vendor may
 * even accept it, and nothing anywhere fails. No existing test could catch it:
 * the suites in `lane-runner.test.ts` and `provider-credential-nonleak.test.ts`
 * check three vendors against a handful of keys they happen to name, so a fourth
 * vendor, or a fourth key on an existing vendor, is invisible to both.
 *
 * This file is the two-directional pin, written BEFORE Wave C5 moved these
 * tables to the registry (the Wave B discipline) and green against the
 * hand-written tables first, so a diff in the refactor shows up here as a
 * failure rather than as a silent widening.
 *
 * TWO DIRECTIONS, and the second is the one that matters:
 *   POSITIVE — each vendor's child receives exactly the credential keys stated
 *              for it below, no more.
 *   NEGATIVE — each vendor's child receives NONE of any OTHER vendor's keys,
 *              asserted for every ordered pair rather than for the pairs a
 *              reviewer happened to think of.
 *
 * VALUES NEVER APPEAR. Every assertion below is about key NAMES. The sentinel
 * values are opaque markers, never asserted on, never printed, and never used to
 * name a test — matching the two-sided contract `mcp-env-contract.ts` already
 * enforces (names on argv, values only in the deny-first filtered child env).
 *
 * THE EXPECTATION TABLE IS HAND-WRITTEN AND INDEPENDENT. It is deliberately NOT
 * derived from `VENDOR_REGISTRY`, because after C5 the implementation reads the
 * registry and a derived expectation would compare the registry against itself.
 * Two independent statements that must agree is the only shape that catches a
 * wrong VALUE; a compile error only ever catches an OMISSION (ADR-0022 §3.4
 * mechanism 5).
 */
const EXPECTED_LANE_CREDENTIAL_KEYS: Record<VendorId, readonly string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
  // `CODEX_HOME` is deliberately ABSENT. It is not a credential, it is the
  // config root, and forwarding it handed every dispatched Codex child the
  // operator's entire `~/.codex` MCP/plugin/hook surface. It is now a LANE
  // GUARD key (see lane-guard-env.ts): the runner may see it so it can find a
  // relocated install, no child may inherit it, and MUON sets its own.
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  cursor: ["CURSOR_API_KEY"],
  // BYO-provider: opencode reads its own `auth.json`, so MUON has nothing to
  // forward — and it would happily USE a key belonging to someone else if it saw
  // one, which is exactly why this is empty rather than absent.
  opencode: [],
  // The dev/test double never spawns a binary at all.
  fake: [],
};

/** The API-key names each vendor OWNS, for the dynamic-nomination refusal. */
const EXPECTED_OWNED_KEYS: Record<VendorId, readonly string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  opencode: [],
  fake: [],
};

/** Vendors whose credentials the long-lived sandboxed runner resolves at all. */
const EXPECTED_RUNNER_FORWARDED: readonly VendorId[] = [
  "claude-code",
  "codex",
  "cursor",
];

/** An id MUON has never heard of. Deliberately not a registry member. */
const UNREGISTERED_VENDOR = "kiro";

/**
 * Every credential key in the matrix, present at once, so a vendor that leaks
 * leaks visibly. The values are opaque markers and are never asserted on.
 */
const CREDENTIAL_SENTINELS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sentinel-a",
  ANTHROPIC_BASE_URL: "sentinel-b",
  CLAUDE_CONFIG_DIR: "sentinel-c",
  OPENAI_API_KEY: "sentinel-d",
  OPENAI_BASE_URL: "sentinel-e",
  CURSOR_API_KEY: "sentinel-f",
};

/**
 * `CODEX_HOME` is NOT a credential and no longer lives in the table above.
 *
 * It is a LANE GUARD key: the vendor's config ROOT, which MUON sets to an
 * isolated directory so a dispatched child cannot inherit the operator's
 * personal `~/.codex` MCP/plugin/hook surface. Its rules differ from a
 * credential's in exactly one direction — MUON's own override MUST reach the
 * owning lane's child, because that override IS the guard — so it gets its own
 * sentinel and its own assertions below rather than being smuggled into the
 * credential sweep, where "codex receives it" would have read as a leak.
 *
 * DERIVED from the registry, not enumerated: opencode's four permission levers
 * (TODO 1.9) joined this set, and a hand-written table would have left them
 * unswept — i.e. the three assertions below would have kept passing while saying
 * nothing about the newest guard keys. Deriving the SUBJECT of a test from the
 * source of truth is safe in the direction that matters: a key added there
 * gains coverage automatically, and a key removed there loses a sentinel that
 * was pinning nothing.
 */
const GUARD_SENTINELS: Record<string, string> = Object.fromEntries(
  [...ALL_LANE_GUARD_ENV_KEYS].map((key) => [
    key,
    `sentinel-ambient-guard-${key}`,
  ])
);

/** Non-credential ambient noise a real parent env carries. */
const AMBIENT = {
  PATH: "/usr/bin",
  HOME: "/tmp/home",
  USER: "tester",
  XDG_CONFIG_HOME: "/tmp/home/.config",
  AWS_SECRET_ACCESS_KEY: "sentinel-cloud",
  GEMINI_API_KEY: "sentinel-gemini",
  MUON_OPERATOR_TOKEN: "sentinel-operator",
  MUON_RUNNER_LEASE_TOKEN: "sentinel-lease",
  MUON_RUNNER_HOST: "sentinel-host",
  MUON_AGENT_TOKEN: "sentinel-agent",
} as const;

const PARENT_ENV: NodeJS.ProcessEnv = {
  ...AMBIENT,
  ...CREDENTIAL_SENTINELS,
  ...GUARD_SENTINELS,
};

const ALL_CREDENTIAL_KEYS = Object.keys(CREDENTIAL_SENTINELS);

/** The credential keys actually present in a built child env, sorted. */
function credentialKeysIn(env: NodeJS.ProcessEnv): string[] {
  return ALL_CREDENTIAL_KEYS.filter((key) => env[key] !== undefined).sort();
}

describe("vendor credential matrix — completeness (a new vendor must state its answer)", () => {
  it("the id used as the negative control is genuinely outside the registry", () => {
    // WAVE F. ADR-0022 §9.3(2) left this open: an id used as "the vendor MUON has
    // never heard of" is linked to the registry by nothing at all, so registering
    // it would turn the four negative assertions in this file into VACUOUS
    // passes — a zero-authority entry has no credential keys either, so they
    // would all still be green while proving nothing about unknown ids.
    //
    // Registering the control now fails HERE, by name.
    expect(isVendorId(UNREGISTERED_VENDOR)).toBe(false);
    expect(VENDOR_IDS).not.toContain(UNREGISTERED_VENDOR);
  });

  it("the hand-written expectation tables cover exactly the registry's vendors", () => {
    expect(Object.keys(EXPECTED_LANE_CREDENTIAL_KEYS).sort()).toEqual(
      [...VENDOR_IDS].sort()
    );
    expect(Object.keys(EXPECTED_OWNED_KEYS).sort()).toEqual([...VENDOR_IDS].sort());
  });

  it("agrees with the registry's own credential columns", () => {
    // The two statements must agree. This is the only assertion in the file that
    // compares the table to the registry; every behavioural assertion below runs
    // against the hand-written table, so a wrong registry value fails HERE with a
    // name rather than silently redefining what the behaviour tests expect.
    for (const id of VENDOR_IDS) {
      expect([...VENDOR_REGISTRY[id].credentials.envKeys]).toEqual([
        ...EXPECTED_LANE_CREDENTIAL_KEYS[id],
      ]);
      expect([...VENDOR_REGISTRY[id].credentials.ownedKeys]).toEqual([
        ...EXPECTED_OWNED_KEYS[id],
      ]);
      expect(VENDOR_REGISTRY[id].credentials.forwardToRunner).toBe(
        EXPECTED_RUNNER_FORWARDED.includes(id)
      );
    }
  });

  it("every owned key is also forwarded to that vendor's own child", () => {
    // A key a vendor owns but never receives would be a dead declaration; a key
    // it receives without owning is the cross-vendor hazard, covered below.
    for (const id of VENDOR_IDS) {
      for (const key of EXPECTED_OWNED_KEYS[id]) {
        expect(EXPECTED_LANE_CREDENTIAL_KEYS[id]).toContain(key);
      }
    }
  });
});

describe("vendor credential matrix — POSITIVE: what reaches each child", () => {
  for (const id of VENDOR_IDS) {
    it(`${id} receives exactly its own credential keys`, () => {
      expect(credentialKeysIn(buildLaneEnvironment(id, PARENT_ENV))).toEqual(
        [...EXPECTED_LANE_CREDENTIAL_KEYS[id]].sort()
      );
      expect(
        credentialKeysIn(buildProviderAwareLaneEnvironment(id, PARENT_ENV))
      ).toEqual([...EXPECTED_LANE_CREDENTIAL_KEYS[id]].sort());
    });
  }

  it(`an unregistered vendor id receives NO credential key at all`, () => {
    expect(
      credentialKeysIn(buildLaneEnvironment(UNREGISTERED_VENDOR, PARENT_ENV))
    ).toEqual([]);
    expect(
      credentialKeysIn(
        buildProviderAwareLaneEnvironment(UNREGISTERED_VENDOR, PARENT_ENV)
      )
    ).toEqual([]);
  });

  it("no child ever receives an unrelated cloud or third-party secret", () => {
    for (const id of [...VENDOR_IDS, UNREGISTERED_VENDOR]) {
      const env = buildProviderAwareLaneEnvironment(id, PARENT_ENV);
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(env).not.toHaveProperty("GEMINI_API_KEY");
      expect(env).not.toHaveProperty("MUON_OPERATOR_TOKEN");
      expect(env).not.toHaveProperty("MUON_RUNNER_LEASE_TOKEN");
      expect(env).not.toHaveProperty("MUON_AGENT_TOKEN");
      expect(env).not.toHaveProperty("MUON_RUNNER_HOST");
    }
  });
});

describe("vendor credential matrix — NEGATIVE: no vendor sees another's keys", () => {
  // The pairwise sweep is the point. A reviewer checks the pairs they think of;
  // this checks all of them, and a new vendor adds a row and a column for free.
  for (const holder of VENDOR_IDS) {
    for (const other of VENDOR_IDS) {
      if (holder === other) continue;
      const foreign = EXPECTED_LANE_CREDENTIAL_KEYS[other].filter(
        (key) => !EXPECTED_LANE_CREDENTIAL_KEYS[holder].includes(key)
      );
      if (foreign.length === 0) continue;
      it(`${holder} never receives ${other}'s keys`, () => {
        const env = buildProviderAwareLaneEnvironment(holder, PARENT_ENV);
        for (const key of foreign) {
          expect(env).not.toHaveProperty(key);
        }
      });
    }
  }

  it("a compiled profile cannot smuggle another vendor's key into a child", () => {
    // The override channel is how a compiled profile reaches the child. It is
    // filtered by the SAME allowlist, so a profile that names a foreign key —
    // whether by mistake or by a prompt-injected rawConfig — is dropped.
    for (const holder of VENDOR_IDS) {
      const env = buildProviderAwareLaneEnvironment(holder, PARENT_ENV, {
        ...CREDENTIAL_SENTINELS,
      });
      expect(credentialKeysIn(env)).toEqual(
        [...EXPECTED_LANE_CREDENTIAL_KEYS[holder]].sort()
      );
    }
  });

  /**
   * THE DENY SIDE `CODEX_HOME` USED TO GET FOR FREE.
   *
   * While it sat in `credentials.envKeys` it was kept off a stranger's lane as
   * a side effect of the credential filter. Moving it to `LANE_GUARD_ENV_KEYS`
   * would have silently dropped that, so all three halves are pinned here:
   * nobody inherits the ambient value, only the owning lane's own override may
   * set it, and a stranger's override is refused.
   */
  it("no child inherits an ambient lane-guard key", () => {
    for (const id of [...VENDOR_IDS, UNREGISTERED_VENDOR]) {
      for (const key of Object.keys(GUARD_SENTINELS)) {
        expect(
          buildProviderAwareLaneEnvironment(id, PARENT_ENV),
          `${id} inherited the ambient ${key}`
        ).not.toHaveProperty(key);
      }
    }
  });

  it("only the owning lane's own override may set a lane-guard key", () => {
    for (const id of [...VENDOR_IDS, UNREGISTERED_VENDOR]) {
      const env = buildProviderAwareLaneEnvironment(id, PARENT_ENV, {
        ...GUARD_SENTINELS,
      });
      for (const [key, value] of Object.entries(GUARD_SENTINELS)) {
        const owned = (LANE_GUARD_ENV_KEYS[id] ?? []).includes(key);
        if (owned) {
          // MUON's guard IS this override; refusing it would leave the child
          // on the operator's ambient config root, i.e. unguarded.
          expect(env[key], `${id} lost its own guard key`).toBe(value);
        } else {
          expect(env, `${id} accepted a foreign guard key`).not.toHaveProperty(
            key
          );
        }
      }
    }
  });

  it("an unregistered vendor cannot smuggle a credential through overrides either", () => {
    const env = buildProviderAwareLaneEnvironment(
      UNREGISTERED_VENDOR,
      PARENT_ENV,
      { ...CREDENTIAL_SENTINELS }
    );
    expect(credentialKeysIn(env)).toEqual([]);
  });
});

describe("vendor credential matrix — the dynamic-nomination refusal", () => {
  // A trusted Codex provider config may nominate an arbitrary credential NAME.
  // It must never be able to nominate a name a DIFFERENT vendor owns.
  for (const holder of VENDOR_IDS) {
    it(`${holder} may not nominate another vendor's owned key`, () => {
      for (const other of VENDOR_IDS) {
        for (const key of EXPECTED_OWNED_KEYS[other]) {
          expect(isSafeDynamicCredentialKey(holder, key)).toBe(other === holder);
        }
      }
    });
  }

  it("an unregistered vendor may not nominate any owned key", () => {
    for (const id of VENDOR_IDS) {
      for (const key of EXPECTED_OWNED_KEYS[id]) {
        expect(isSafeDynamicCredentialKey(UNREGISTERED_VENDOR, key)).toBe(false);
      }
    }
  });
});

describe("vendor credential matrix — the sandboxed runner boundary", () => {
  it("resolves exactly the forwarded vendors' credentials, and nothing else", () => {
    const env = sandboxedRunnerEnv({
      apiBase: "http://127.0.0.1:4000",
      agentToken: "agent",
      leaseToken: "lease",
      sandboxed: true,
      parentEnv: PARENT_ENV,
    });
    // Every forwarded vendor's OWNED key survives into the runner, so the later
    // per-lane filter can still deliver it to the matching vendor.
    for (const id of EXPECTED_RUNNER_FORWARDED) {
      for (const key of EXPECTED_OWNED_KEYS[id]) {
        expect(env[key]).toBeDefined();
      }
    }
    expect(env).not.toHaveProperty("MUON_OPERATOR_TOKEN");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
  });

  it("a non-forwarded vendor contributes no credential to the runner env", () => {
    const notForwarded = VENDOR_IDS.filter(
      (id) => !EXPECTED_RUNNER_FORWARDED.includes(id)
    );
    expect(notForwarded.length).toBeGreaterThan(0);
    for (const id of notForwarded) {
      expect(EXPECTED_OWNED_KEYS[id]).toEqual([]);
    }
  });
});

describe("vendor credential matrix — the COMMON_LANE_ENV_KEYS subtraction (ADR-0022 §6.8)", () => {
  it("the common set every child gets carries no credential key", () => {
    // `COMMON_LANE_ENV_KEYS` is the ONE documented subtraction in the tree. It is
    // legitimate because its superset (`RUNNER_ENV_ALLOWLIST`) is itself a closed
    // allowlist and the subtraction NARROWS, so a new vendor key is removed
    // automatically. This asserts the narrowing actually happened rather than
    // trusting the comment: an unregistered lane is the common set and nothing
    // else, so its credential slice must be empty.
    const common = buildLaneEnvironment(UNREGISTERED_VENDOR, PARENT_ENV);
    expect(credentialKeysIn(common)).toEqual([]);
    for (const id of VENDOR_IDS) {
      for (const key of VENDOR_REGISTRY[id].credentials.envKeys) {
        expect(common).not.toHaveProperty(key);
      }
    }
  });

  it("every vendor credential key is in the runner allowlist it is subtracted from", () => {
    // The subtraction only narrows if the subtrahend is a SUBSET. A vendor key
    // outside `RUNNER_ENV_ALLOWLIST` would never reach a child at all — a silent
    // fail-closed break rather than a leak, but a break.
    for (const id of VENDOR_IDS) {
      for (const key of VENDOR_REGISTRY[id].credentials.envKeys) {
        expect(RUNNER_ENV_ALLOWLIST).toContain(key);
      }
    }
  });
});

describe("vendor credential matrix — the OpenCode launch guard (env-based, not argv)", () => {
  // OpenCode's boundary is the one thing `execution.guards` cannot express
  // (ADR-0022 §9.3(1)): it has no `--permissions` flag, so what makes MUON's deny
  // table the last word is three ENVIRONMENT VARIABLES delivered through the same
  // deny-first filter that strips credentials. If the filter ever ate one of
  // them the lane would silently fall back to the workspace's own config — which
  // is attacker-controlled input.
  const GUARD_ENV = {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG: "/w/.muon-opencode/opencode.json",
    XDG_CONFIG_HOME: "/w/.muon-opencode",
  } as const;

  it("all three guard variables reach the opencode child", () => {
    const env = buildProviderAwareLaneEnvironment("opencode", PARENT_ENV, {
      ...GUARD_ENV,
    });
    for (const [key, value] of Object.entries(GUARD_ENV)) {
      expect(env[key]).toBe(value);
    }
  });

  it("the guard's XDG_CONFIG_HOME overrides the ambient one rather than losing to it", () => {
    // `XDG_CONFIG_HOME` is ALSO in the common lane set, so it arrives twice. The
    // override must win, or the operator's own `~/.config/opencode/` (MCP
    // servers, plugins, provider overrides) re-attaches to a governed run.
    const env = buildProviderAwareLaneEnvironment("opencode", PARENT_ENV, {
      ...GUARD_ENV,
    });
    expect(env.XDG_CONFIG_HOME).toBe(GUARD_ENV.XDG_CONFIG_HOME);
    expect(env.XDG_CONFIG_HOME).not.toBe(AMBIENT.XDG_CONFIG_HOME);
  });

  it("no credential rides along with the guard env", () => {
    const env = buildProviderAwareLaneEnvironment("opencode", PARENT_ENV, {
      ...GUARD_ENV,
      ...CREDENTIAL_SENTINELS,
    });
    expect(credentialKeysIn(env)).toEqual([]);
  });
});
