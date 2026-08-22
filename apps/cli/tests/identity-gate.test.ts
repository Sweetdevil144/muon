import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDoctorCommand } from "../src/commands/doctor.js";
import { registerLoginCommands } from "../src/commands/login.js";
import { registerMcpCommands } from "../src/commands/mcp.js";
import { registerSetupCommands } from "../src/commands/setup.js";
import { registerUninstallCommand } from "../src/commands/uninstall.js";
import { registerUpdateCommand } from "../src/commands/update.js";
import { registerVersionCommand } from "../src/commands/version.js";
import type { MuonApiClient } from "../src/lib/api-client.js";
import {
  CLI_DIAGNOSTIC_COMMANDS,
  CLI_IDENTITY_GATE_EXEMPT_COMMANDS,
  CLI_IDENTITY_GATE_EXIT_CODE,
  checkCliIdentityGate,
  cliCommandPath,
  isCliDiagnosticCommand,
  resetCliIdentityGate,
  resolveCliIdentityGate,
} from "../src/lib/identity-gate.js";

/**
 * ADR-0052 at the CLI boundary.
 *
 * The first describe is the one that matters most: a dev checkout must be
 * UNGATED, and it must be ungated because there is nothing to arm — not because
 * a flag happens to be unset.
 */

const GRANT = {
  token: "c".repeat(64),
  issuedAt: "2026-08-17T00:00:00.000Z",
  version: 1,
};

/** The real command tree, for the paths the exempt list names. */
function program(): Command {
  const root = new Command();
  root.name("muon");
  const createClient = (() => ({}) as MuonApiClient) as () => MuonApiClient;
  registerVersionCommand(root);
  registerUpdateCommand(root);
  registerDoctorCommand(root, createClient);
  registerUninstallCommand(root);
  registerLoginCommands(root, createClient);
  registerMcpCommands(root, undefined, createClient);
  registerSetupCommands(root, undefined, createClient);
  // A representative non-exempt command, registered the same way.
  root.command("agents").action(() => undefined);
  root.command("dispatch").command("start").action(() => undefined);
  return root;
}

function find(root: Command, commandPath: string): Command {
  let cursor: Command = root;
  for (const name of commandPath.split(" ")) {
    const next = cursor.commands.find(
      (command) => command.name() === name || command.aliases().includes(name)
    );
    if (!next) throw new Error(`no such command: muon ${commandPath}`);
    cursor = next;
  }
  return cursor;
}

const GATED = {
  required: true,
  satisfied: false,
  state: "locked",
  misconfigured: false,
  doorMissing: false,
} as const;
/** ADR-0052 F3 — verified here, the install record has not landed. Refuses
 *  exactly as hard, and must never carry the sign-in remedy. */
const DEFERRED = { ...GATED, state: "locked-unregistered" } as const;
const OPEN = {
  required: true,
  satisfied: true,
  state: "open",
  misconfigured: false,
  doorMissing: false,
} as const;
const DEV = {
  required: false,
  satisfied: true,
  state: "unarmed",
  misconfigured: false,
  doorMissing: false,
} as const;

describe("a dev checkout is never gated", () => {
  afterEach(() => {
    resetCliIdentityGate();
    delete process.env.MUON_REQUIRE_GITHUB_LOGIN;
    delete process.env.MUON_GITHUB_CLIENT_ID;
  });

  it("resolves required:false with no bake, even with a client id in the env", () => {
    const gate = resolveCliIdentityGate(
      { MUON_GITHUB_CLIENT_ID: "Iv1.abcdef1234567890" } as NodeJS.ProcessEnv,
      import.meta.url
    );
    expect(gate.required).toBe(false);
    expect(gate.misconfigured).toBe(false);
  });

  it("lets EVERY command through when the gate is not armed", () => {
    const root = program();
    for (const commandPath of ["agents", "dispatch start", "mcp attach"]) {
      expect(
        checkCliIdentityGate(find(root, commandPath), DEV).allowed,
        commandPath
      ).toBe(true);
    }
  });

  it("this repo's own manifest carries no bake — asserted, not assumed", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "..", "package.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(manifest.muonDistributed).toBeUndefined();
  });
});

describe("cliCommandPath", () => {
  it("names the path without the root, at every depth", () => {
    const root = program();
    expect(cliCommandPath(find(root, "agents"))).toBe("agents");
    expect(cliCommandPath(find(root, "mcp status"))).toBe("mcp status");
    expect(cliCommandPath(find(root, "dispatch start"))).toBe("dispatch start");
  });
});

describe("the gated CLI's positive exempt list", () => {
  it("every exempt name is a REAL command — no drift between the list and the tree", () => {
    const root = program();
    for (const commandPath of CLI_IDENTITY_GATE_EXEMPT_COMMANDS) {
      expect(() => find(root, commandPath), commandPath).not.toThrow();
    }
  });

  it("is exactly the ADR's set, corrected", () => {
    // `doctor` and `uninstall` were absent (2026-08-17 review), which made a
    // locked install one a person could neither diagnose with the command every
    // refusal points at nor remove with the tool that put it there.
    // `mcp uninstall` was absent too, found while wiping a real machine
    // (2026-08-18): `mcp install` writes MUON's row into the USER'S OWN
    // ~/.claude.json / ~/.codex/config.toml / ~/.cursor/mcp.json, and gating
    // its removal left MUON's trace in a third party's file with no supported
    // way to take it out.
    // `setup` joined (2026-08-20): the guided wizard's FIRST step IS the
    // sign-in, so gating it behind "run `muon login`" made the wizard
    // unreachable on exactly the locked machines it exists to onboard.
    expect([...CLI_IDENTITY_GATE_EXEMPT_COMMANDS].sort()).toEqual([
      "doctor",
      "login",
      "logout",
      "mcp probe",
      "mcp status",
      "mcp uninstall",
      "setup",
      "uninstall",
      "update",
      "version",
    ]);
  });

  it("a locked install can still DIAGNOSE and REMOVE itself", () => {
    // The two dead ends, named individually: every other refusal in MUON points
    // at `muon doctor`, and an install nothing can uninstall is a trap.
    const root = program();
    for (const commandPath of ["doctor", "uninstall", "mcp uninstall"]) {
      expect(
        checkCliIdentityGate(find(root, commandPath), GATED).allowed,
        commandPath
      ).toBe(true);
    }
  });

  it("a locked install can withdraw the row it wrote into a vendor's own config", () => {
    // `mcp install` is a WRITE into a file MUON does not own. Whatever happens
    // to sign-in afterwards, undoing that write must stay available, or MUON
    // leaves a row in someone else's config that only hand-editing removes.
    // `mcp install` itself stays gated: adding a trace is starting something.
    const root = program();
    expect(checkCliIdentityGate(find(root, "mcp uninstall"), GATED).allowed).toBe(true);
    expect(checkCliIdentityGate(find(root, "mcp install"), GATED).allowed).toBe(false);
  });

  it("lets the exempt commands run while locked", () => {
    const root = program();
    for (const commandPath of CLI_IDENTITY_GATE_EXEMPT_COMMANDS) {
      expect(
        checkCliIdentityGate(find(root, commandPath), GATED).allowed,
        commandPath
      ).toBe(true);
    }
  });

  it("refuses everything else with exit 12 and the shared copy", () => {
    const root = program();
    for (const commandPath of ["agents", "dispatch start", "mcp attach", "mcp install"]) {
      const verdict = checkCliIdentityGate(find(root, commandPath), GATED);
      expect(verdict.allowed, commandPath).toBe(false);
      if (verdict.allowed) continue;
      expect(verdict.exitCode).toBe(CLI_IDENTITY_GATE_EXIT_CODE);
      expect(verdict.exitCode).toBe(12);
      expect(verdict.refusal).toContain(`muon ${commandPath}`);
      expect(verdict.refusal).toContain("muon login");
      expect(verdict.refusal).toContain("records this install");
      // The refusal must not read as a dead end.
      expect(verdict.refusal).toContain("muon mcp status");
    }
  });

  it("the DEFERRED state refuses just as hard, with the right instruction", () => {
    // F3. Same exit code, same positive exempt list, completely different
    // sentence: this operator has already signed in, and the ordinary copy would
    // send them to do it again.
    const root = program();
    const verdict = checkCliIdentityGate(find(root, "dispatch start"), DEFERRED);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.exitCode).toBe(CLI_IDENTITY_GATE_EXIT_CODE);
    expect(verdict.refusal).toContain("verified but not yet registered");
    // `muon login` registers ONCE; the CLI has no retry loop. Promising one
    // here left a CLI-only install waiting for something that never runs.
    expect(verdict.refusal).toContain("NOTHING here retries it");
    expect(verdict.refusal).toContain("`muon login` is what files the record");
    expect(verdict.refusal).not.toContain("Run `muon login` to open it");
    // Still not a dead end.
    expect(verdict.refusal).toContain("muon doctor");
  });

  it("an OPEN gate refuses nothing", () => {
    const root = program();
    for (const commandPath of ["agents", "dispatch start", "mcp attach"]) {
      expect(
        checkCliIdentityGate(find(root, commandPath), OPEN).allowed,
        commandPath
      ).toBe(true);
    }
  });
});

describe("resolveCliIdentityGate under the env flag", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-gate-"));
    resetCliIdentityGate();
  });
  afterEach(() => {
    resetCliIdentityGate();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.MUON_DATA_DIR;
  });

  it("arms, and is unsatisfied with no credential", () => {
    process.env.MUON_DATA_DIR = dir;
    const gate = resolveCliIdentityGate(
      { MUON_REQUIRE_GITHUB_LOGIN: "1" } as NodeJS.ProcessEnv,
      import.meta.url
    );
    expect(gate).toEqual({
      required: true,
      satisfied: false,
      state: "locked",
      misconfigured: false,
      // F14: the flag armed it and this env has no client id, so the gate is ON
      // with no device flow behind it. Still armed (the operator asked), but the
      // dead end is now NAMED instead of discovered.
      doorMissing: true,
    });
  });

  it("a flag-armed gate WITH a client id has a door, and says nothing", () => {
    process.env.MUON_DATA_DIR = dir;
    const gate = resolveCliIdentityGate(
      {
        MUON_REQUIRE_GITHUB_LOGIN: "1",
        MUON_GITHUB_CLIENT_ID: "Iv1.abcdef1234567890",
      } as NodeJS.ProcessEnv,
      import.meta.url
    );
    expect(gate.required).toBe(true);
    expect(gate.doorMissing).toBe(false);
  });

  it("reports locked-unregistered when a deferred registration is pending", async () => {
    // F3 — the offline first sign-in. The CLI must refuse just as hard and say
    // something completely different, because "Run `muon login`" is the one
    // instruction that does not apply here.
    process.env.MUON_DATA_DIR = dir;
    const { markInstallRegistrationPending } = await import(
      "@muon/client/github-identity-gate"
    );
    markInstallRegistrationPending("desktop", dir);
    const gate = resolveCliIdentityGate(
      { MUON_REQUIRE_GITHUB_LOGIN: "1" } as NodeJS.ProcessEnv,
      import.meta.url
    );
    expect(gate.state).toBe("locked-unregistered");
    expect(gate.satisfied).toBe(false);
  });

  it("is satisfied once a credential AND grant are persisted", async () => {
    process.env.MUON_DATA_DIR = dir;
    const { writeIdentityCredential } = await import(
      "@muon/client/github-identity-gate"
    );
    writeIdentityCredential(
      {
        github: { login: "octocat", id: 1 },
        token: "gho_" + "x".repeat(20),
        grant: GRANT,
      },
      dir
    );
    const gate = resolveCliIdentityGate(
      { MUON_REQUIRE_GITHUB_LOGIN: "1" } as NodeJS.ProcessEnv,
      import.meta.url
    );
    expect(gate.satisfied).toBe(true);
  });
});

describe("the baked client id is republished for the brain it spawns", () => {
  beforeEach(() => resetCliIdentityGate());
  afterEach(() => resetCliIdentityGate());

  it("exports the bake when the env has none, and never overrides one that is set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-bake-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "muon-cli",
          muonDistributed: true,
          muonGitHubClientId: "Iv1.baked1234567890",
        })
      );
      const entry = `file://${path.join(dir, "muon.mjs")}`;

      const fresh = { MUON_REQUIRE_GITHUB_LOGIN: "0" } as NodeJS.ProcessEnv;
      resolveCliIdentityGate(fresh, entry);
      expect(fresh.MUON_GITHUB_CLIENT_ID).toBe("Iv1.baked1234567890");

      resetCliIdentityGate();
      const chosen = {
        MUON_REQUIRE_GITHUB_LOGIN: "0",
        MUON_GITHUB_CLIENT_ID: "Iv1.operators1234567",
      } as NodeJS.ProcessEnv;
      resolveCliIdentityGate(chosen, entry);
      expect(chosen.MUON_GITHUB_CLIENT_ID).toBe("Iv1.operators1234567");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a distributed bake with NO client id degrades ungated and reports the defect", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-nobake-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "muon-cli", muonDistributed: true })
      );
      const gate = resolveCliIdentityGate(
        {} as NodeJS.ProcessEnv,
        `file://${path.join(dir, "muon.mjs")}`
      );
      expect(gate.required).toBe(false);
      expect(gate.misconfigured).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The release defect is reported where a user goes to ASK about the install,
  // not on every command. Until the install registry is deployed every
  // published tarball is legitimately baked without a client id, so the
  // every-invocation warning was noise about the expected posture — and noise
  // on every command is how a real defect later goes unread.
  describe("where a release-side defect is reported", () => {
    const pathOf = (...names: readonly string[]): Command => {
      const root = new Command("muon");
      let cmd = root;
      for (const name of names) {
        const child = new Command(name);
        cmd.addCommand(child);
        cmd = child;
      }
      return cmd;
    };

    it("names every diagnostic surface, and only real commands", () => {
      expect([...CLI_DIAGNOSTIC_COMMANDS].sort()).toEqual([
        "doctor",
        "mcp probe",
        "mcp status",
        "version",
      ]);
    });

    it("reports on the surfaces a user consults about install health", () => {
      for (const names of [["doctor"], ["version"], ["mcp", "status"], ["mcp", "probe"]]) {
        expect(isCliDiagnosticCommand(pathOf(...names))).toBe(true);
      }
    });

    it("stays quiet on the commands that do work", () => {
      for (const names of [
        ["chat"],
        ["dispatch", "status"],
        ["mcp", "install"],
        ["mcp", "attach"],
        ["approve", "list"],
        ["graph", "reindex"],
      ]) {
        expect(isCliDiagnosticCommand(pathOf(...names))).toBe(false);
      }
    });

    it("is its own positive set, not the exempt set minus login/logout", () => {
      // Both sets answer different questions ("may this run while locked" vs
      // "does this explain the install"), so a member added to one must not
      // silently join the other. `uninstall` is the live divergence.
      expect(CLI_IDENTITY_GATE_EXEMPT_COMMANDS.has("uninstall")).toBe(true);
      expect(CLI_DIAGNOSTIC_COMMANDS.has("uninstall")).toBe(false);
    });
  });

  it("a distributed bake WITH a client id arms the gate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-armed-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-armed-data-"));
    try {
      process.env.MUON_DATA_DIR = dataDir;
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "muon-cli",
          muonDistributed: true,
          muonGitHubClientId: "Iv1.baked1234567890",
        })
      );
      const gate = resolveCliIdentityGate(
        {} as NodeJS.ProcessEnv,
        `file://${path.join(dir, "muon.mjs")}`
      );
      expect(gate).toEqual({
        required: true,
        satisfied: false,
        state: "locked",
        misconfigured: false,
        doorMissing: false,
      });
    } finally {
      delete process.env.MUON_DATA_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * WIRING EXCEPTION — text, because it cannot be anything else.
 * `bundle-release.mjs` `rm -rf`s the operator's `release/` at import time, so
 * importing it to drive it would destroy the thing under test. (Its sibling,
 * `apps/desktop/scripts/write-build-config.mjs`, WAS restructured to be
 * importable and is now covered behaviourally; the same treatment here would
 * retire this block.)
 */
describe("the release bake is written by exactly one place", () => {
  it("bundle-release.mjs is the only source of muonDistributed", () => {
    const script = fs.readFileSync(
      path.join(import.meta.dirname, "..", "scripts", "bundle-release.mjs"),
      "utf8"
    );
    expect(script).toContain("muonDistributed: true");
    // The client id is taken from the release environment, never a literal.
    expect(script).toContain("process.env.MUON_GITHUB_CLIENT_ID");
    expect(script).not.toMatch(/muonGitHubClientId:\s*"[A-Za-z0-9.]/);
  });
});

// A guard for the one unforgivable regression: the gate must be checked before
// the hook does anything else, and it must not be reachable in a dev checkout.
//
// WIRING EXCEPTION — the only text assertion this file keeps about behaviour it
// cares about, and deliberately narrow: the DECISION is behavioural above
// (`checkCliIdentityGate` against a real command tree). What is left is ORDER
// inside `src/index.ts`'s `preAction` hook, which cannot be driven in a unit test
// because the hook's own body ends the process. It asserts positions, never a
// policy expression.
describe("the preAction wiring", () => {
  it("checks the gate before the brain is ensured", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "index.ts"),
      "utf8"
    );
    const gateAt = source.indexOf("checkCliIdentityGate(actionCommand");
    const brainAt = source.indexOf("await ensureBrainUnlessExplicitBase(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(brainAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(brainAt);
  });
});
