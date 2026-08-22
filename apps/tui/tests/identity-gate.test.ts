import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TUI_IDENTITY_GATE_EXIT_CODE,
  TUI_LOCKED_STILL_AVAILABLE,
  guardTuiIdentityGate,
  resolveTuiIdentityGate,
  tuiIdentityGateRefusal,
  type TuiIdentityGate,
} from "../src/lib/identity-gate.js";

/**
 * ADR-0052 F1 — the desk shipped UNGATED.
 *
 * `bundle-release.mjs` declares `muon-tui` beside the `muonDistributed` bake,
 * and this surface never read the gate: an installed tarball gave a stranger
 * the whole desk (dispatch, crew, memory, a live PTY in the workspace) with no
 * identity verified. These tests hold the two halves that make that impossible
 * to regress — a distributed bake refuses, and a dev checkout is untouched.
 */

let dir: string;
const ORIGINAL_DATA_DIR = process.env.MUON_DATA_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-tui-gate-"));
  // The gate reads the credential from the resolved data dir. Pointing it at a
  // temp profile is what keeps this test from depending on whether the machine
  // running it happens to be signed in.
  process.env.MUON_DATA_DIR = path.join(dir, "profile");
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.MUON_DATA_DIR;
  else process.env.MUON_DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A manifest beside a fake entry, the way a release tarball lays it out. */
function bakeAt(manifest: Record<string, unknown>): string {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  return `file://${path.join(dir, "muon-tui.mjs")}`;
}

const CLIENT_ID = "Iv1.abcdef1234567890";

describe("resolveTuiIdentityGate", () => {
  it("a DEV CHECKOUT does not arm — no bake, nothing to unset", () => {
    const gate = resolveTuiIdentityGate({}, bakeAt({ name: "@muon/tui" }));
    expect(gate.required).toBe(false);
    expect(gate.state).toBe("unarmed");
    expect(gate.misconfigured).toBe(false);
    expect(gate.doorMissing).toBe(false);
  });

  it("a DISTRIBUTED bake with a client id arms, and reads LOCKED with no credential", () => {
    const gate = resolveTuiIdentityGate(
      {},
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(gate.required).toBe(true);
    expect(gate.state).toBe("locked");
  });

  it("a distributed bake with NO client id degrades ungated and reports the defect", () => {
    const gate = resolveTuiIdentityGate(
      {},
      bakeAt({ name: "muon-cli", muonDistributed: true })
    );
    expect(gate.required).toBe(false);
    expect(gate.misconfigured).toBe(true);
  });

  it("MUON_REQUIRE_GITHUB_LOGIN=1 with no client id arms a gate with no door, and says so", () => {
    const gate = resolveTuiIdentityGate(
      { MUON_REQUIRE_GITHUB_LOGIN: "1" },
      bakeAt({ name: "@muon/tui" })
    );
    expect(gate.required).toBe(true);
    expect(gate.doorMissing).toBe(true);
    // Not a "misconfiguration": the operator asked for it.
    expect(gate.misconfigured).toBe(false);
  });

  it("MUON_REQUIRE_GITHUB_LOGIN=0 is the escape hatch on a distributed bake", () => {
    const gate = resolveTuiIdentityGate(
      { MUON_REQUIRE_GITHUB_LOGIN: "0" },
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(gate.required).toBe(false);
  });

  it("an OPEN credential in the profile opens the desk", () => {
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, "github-identity.json"),
      JSON.stringify({
        version: 1,
        github: { login: "octocat", id: 583231 },
        token: `gho_${"x".repeat(20)}`,
        grant: {
          token: "a".repeat(64),
          issuedAt: "2026-08-17T00:00:00.000Z",
          version: 1,
        },
        createdAt: "2026-08-17T00:00:00.000Z",
      })
    );
    const gate = resolveTuiIdentityGate(
      {},
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(gate.state).toBe("open");
  });

  it("a DEFERRED registration reads locked-unregistered, not locked", () => {
    const profile = path.join(dir, "profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, "github-registration-pending.json"),
      JSON.stringify({
        version: 1,
        surface: "desktop",
        createdAt: "2026-08-17T00:00:00.000Z",
      })
    );
    const gate = resolveTuiIdentityGate(
      {},
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(gate.state).toBe("locked-unregistered");
  });
});

/**
 * ADR-0052 — THE DESK'S DOOR HAD NO KEY IN IT.
 *
 * The device flow runs through the local brain, which every surface spawns with
 * `{...process.env}`. The CLI republishes the baked client id so that brain can
 * run it; this surface read the same bake and did not, so a desk-spawned brain
 * had no `MUON_GITHUB_CLIENT_ID` at all — `muon login`, the one remedy the desk's
 * own refusal names, had no flow to run. The republish is @muon/client's
 * `resolveGateArming` now, called by both surfaces, so it cannot be present on
 * one and missing on the other.
 */
describe("the baked client id is republished for the brain the desk spawns", () => {
  it("a distributed bake lands the id in the env the desk will hand on", () => {
    const env = {} as NodeJS.ProcessEnv;
    const gate = resolveTuiIdentityGate(
      env,
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(env.MUON_GITHUB_CLIENT_ID).toBe(CLIENT_ID);
    // And the gate still arms off the same bake, so the republish is not a
    // side effect that replaced the reading.
    expect(gate.required).toBe(true);
  });

  it("never overrides an id the operator set for themselves", () => {
    const env = {
      MUON_GITHUB_CLIENT_ID: "Iv1.operators1234567",
    } as NodeJS.ProcessEnv;
    resolveTuiIdentityGate(
      env,
      bakeAt({
        name: "muon-cli",
        muonDistributed: true,
        muonGitHubClientId: CLIENT_ID,
      })
    );
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv1.operators1234567");
  });

  it("a dev checkout publishes nothing — a working tree is untouched", () => {
    const env = {} as NodeJS.ProcessEnv;
    resolveTuiIdentityGate(env, bakeAt({ name: "@muon/tui" }));
    expect(env.MUON_GITHUB_CLIENT_ID).toBeUndefined();
  });

  it("the CLI and the desk resolve arming through the SAME function", async () => {
    // Not a source assertion: both surfaces are driven against the same bake and
    // asked to produce the same effect. A republish added to one and forgotten in
    // the other is exactly the drift that shipped.
    const entry = bakeAt({
      name: "muon-cli",
      muonDistributed: true,
      muonGitHubClientId: CLIENT_ID,
    });
    const cliGate = await import("../../cli/src/lib/identity-gate.js");
    cliGate.resetCliIdentityGate();
    const cliEnv = {} as NodeJS.ProcessEnv;
    const tuiEnv = {} as NodeJS.ProcessEnv;
    cliGate.resolveCliIdentityGate(cliEnv, entry);
    resolveTuiIdentityGate(tuiEnv, entry);
    cliGate.resetCliIdentityGate();
    expect(tuiEnv.MUON_GITHUB_CLIENT_ID).toBe(cliEnv.MUON_GITHUB_CLIENT_ID);
    expect(tuiEnv.MUON_GITHUB_CLIENT_ID).toBe(CLIENT_ID);
  });
});

describe("the desk's refusal copy", () => {
  it("names what is gated, the door, the disclosure, and what still works", () => {
    const copy = tuiIdentityGateRefusal("locked");
    expect(copy).toContain("the MUON desk");
    expect(copy).toContain("muon login");
    expect(copy).toContain("records this install");
    // The record says `cli` — `muon-tui` ships inside the CLI tarball and has
    // no registration of its own. Promising `(tui)` would name a sender that
    // does not exist.
    expect(copy).toContain("(cli)");
    expect(copy).toContain("muon mcp status");
    expect(copy).not.toContain("(tui)");
  });

  it("the DEFERRED state never tells an operator to run the thing they just ran", () => {
    const copy = tuiIdentityGateRefusal("locked-unregistered");
    expect(copy).toContain("verified but not yet registered");
    // The TUI's startup guard only READS the state; it never registers, so a
    // retry promise here was false in the same way the CLI's was.
    expect(copy).toContain("NOTHING here retries it");
    // The wrong remedy: a bare "Run `muon login` to open it" instruction.
    expect(copy).not.toContain("Run `muon login` to open it");
  });
});

describe("guardTuiIdentityGate", () => {
  const collect = () => {
    const written: string[] = [];
    let exited: number | undefined;
    return {
      written,
      exitedCode: () => exited,
      io: {
        write: (text: string) => written.push(text),
        exit: ((code: number) => {
          exited = code;
          // The real guard never returns from here; the fake has to, so the
          // test can assert on what was written before the exit.
          return undefined as never;
        }) as (code: number) => never,
      },
    };
  };

  const gate = (over: Partial<TuiIdentityGate>): TuiIdentityGate => ({
    required: true,
    state: "locked",
    misconfigured: false,
    doorMissing: false,
    ...over,
  });

  it("refuses a locked desk with exit 12 and the plain refusal", () => {
    const io = collect();
    guardTuiIdentityGate(gate({}), io.io);
    expect(io.exitedCode()).toBe(TUI_IDENTITY_GATE_EXIT_CODE);
    expect(io.exitedCode()).toBe(12);
    expect(io.written.join("")).toContain("muon login");
  });

  it("lets an OPEN desk through, writing nothing", () => {
    const io = collect();
    guardTuiIdentityGate(gate({ state: "open" }), io.io);
    expect(io.exitedCode()).toBeUndefined();
    expect(io.written).toEqual([]);
  });

  it("lets an UNARMED desk through byte-identically — a dev checkout is untouched", () => {
    const io = collect();
    guardTuiIdentityGate(gate({ required: false, state: "unarmed" }), io.io);
    expect(io.exitedCode()).toBeUndefined();
    expect(io.written).toEqual([]);
  });

  it("reports the release defect but does NOT lock a degraded build", () => {
    const io = collect();
    guardTuiIdentityGate(
      gate({ required: false, state: "unarmed", misconfigured: true }),
      io.io
    );
    expect(io.exitedCode()).toBeUndefined();
    expect(io.written.join("")).toContain("RELEASE DEFECT");
  });

  it("names the missing client id when the gate is armed by flag with no door", () => {
    const io = collect();
    guardTuiIdentityGate(gate({ doorMissing: true }), io.io);
    expect(io.written.join("")).toContain("MUON_GITHUB_CLIENT_ID");
    expect(io.exitedCode()).toBe(TUI_IDENTITY_GATE_EXIT_CODE);
  });

  it("uses the deferred copy for locked-unregistered", () => {
    const io = collect();
    guardTuiIdentityGate(gate({ state: "locked-unregistered" }), io.io);
    expect(io.exitedCode()).toBe(TUI_IDENTITY_GATE_EXIT_CODE);
    expect(io.written.join("")).toContain("verified but not yet registered");
  });
});

describe("the locked desk is never a dead end", () => {
  it("every command it names is one the CLI actually exempts", async () => {
    // Read from the CLI's OWN positive set rather than restated here: a `muon
    // uninstall` added to one list and forgotten in the other is exactly how a
    // refusal starts naming a command that refuses.
    const cliGate = await import("../../cli/src/lib/identity-gate.js");
    const exempt = cliGate.CLI_IDENTITY_GATE_EXEMPT_COMMANDS;
    // Loud, because every assertion below is inside a loop: a silently empty
    // set would make this test pass by checking nothing.
    expect(exempt.size).toBeGreaterThanOrEqual(TUI_LOCKED_STILL_AVAILABLE.length);
    for (const shown of TUI_LOCKED_STILL_AVAILABLE) {
      expect(
        exempt.has(shown.replace(/^muon /, "")),
        `${shown} is offered to a locked desk but the CLI does not exempt it`
      ).toBe(true);
    }
  });
});
