import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLABLE_VENDORS,
  readVendorEntry,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";
import { readEnrolment } from "@muon/client/enrolment";
import { fakeVendorRunner, type Spawned } from "./helpers/fake-vendor-cli.js";
import {
  enrolmentHealth,
  registerSetupCommands,
  repairEnrolment,
} from "../src/commands/setup.js";

// ── One-click setup, and the repair that needs no human to re-derive it ─────
//
// Every io here is rooted at a fresh mkdtemp with `redirectVendorConfigDirs`,
// so no test can touch a real vendor config.

const MCP_BIN = "/opt/muon/bin/muon-mcp";
const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function harness(opts: { cliOnPath?: string[] } = {}) {
  const home = temp("muon-setup-home-");
  const dataDir = temp("muon-setup-data-");
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  const present = opts.cliOnPath ?? INSTALLABLE_VENDORS.map((spec) => spec.cli);
  const spawns: Spawned[] = [];
  const run = fakeVendorRunner(spawns);
  const io: McpVendorIo = {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd,
      redirectVendorConfigDirs: true,
    },
    // The SHARED fake, which actually writes the config the way the real
    // vendor CLI does — a runner that returns success without writing would
    // let these tests prove an install that never happened.
    run: (command, args, extraEnv) =>
      run(command, args, { ...extraEnv, MUON_TEST_CWD: cwd }),
    which: (command) =>
      // The resolver looks for `muon-mcp` itself; the vendor CLIs are what
      // `present` gates.
      command === "muon-mcp"
        ? MCP_BIN
        : present.includes(command)
          ? `/usr/local/bin/${command}`
          : null,
    isExecutableFile: (p) => p === MCP_BIN,
  };
  return { io, dataDir, home, spawns };
}

async function runSetup(
  h: ReturnType<typeof harness>,
  args: string[]
): Promise<void> {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const program = new Command();
  program.exitOverride();
  registerSetupCommands(program, { io: h.io, dataDir: h.dataDir });
  await program.parseAsync(["node", "muon", "setup", ...args]);
}

describe("muon setup — one step, and it remembers", () => {
  it("installs into every agent CLI DETECTED, and records the choice", async () => {
    const h = harness({ cliOnPath: ["claude", "codex"] });
    vi.spyOn(process, "cwd").mockReturnValue(h.io.roots.cwd);
    await runSetup(h, []);

    const stored = readEnrolment(h.dataDir);
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.enrolment.vendors).toContain("claude-code");
      expect(stored.enrolment.vendors).toContain("codex");
      // The DURABLE mode: no capability file, no token, no lease.
      expect(stored.enrolment.mode).toBe("base");
    }
  });

  it("does NOT install into a CLI the user does not have", async () => {
    // A config file for a tool that will never read it is a success that
    // means nothing.
    const h = harness({ cliOnPath: ["claude"] });
    await runSetup(h, []);
    const stored = readEnrolment(h.dataDir);
    if (stored.ok) {
      expect(stored.enrolment.vendors).toEqual(["claude-code"]);
    }
  });

  it("refuses a vendor it does not know instead of silently skipping it", async () => {
    // A typo that installs nothing while reporting success is how someone
    // believes they are set up and is not.
    const h = harness();
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    await runSetup(h, ["--vendors", "not-a-cli"]);
    expect(process.exitCode).not.toBe(0);
    expect(errors.join("")).toMatch(/not an agent CLI/);
    expect(readEnrolment(h.dataDir).ok, "nothing is recorded on a refusal").toBe(
      false
    );
  });

  it("registers the DURABLE mode — no capability file lands anywhere", async () => {
    const h = harness({ cliOnPath: ["claude"] });
    await runSetup(h, []);
    const spec = INSTALLABLE_VENDORS.find((s) => s.id === "claude-code")!;
    const entry = readVendorEntry(spec, spec.defaultScope, h.io.roots);
    expect(entry.kind).toBe("present");
    if (entry.kind === "present") {
      // The whole reason base mode survives a reboot: nothing to expire.
      expect(entry.env?.MUON_ATTACHED_CAPABILITY_FILE).toBeUndefined();
      expect(entry.env?.MUON_MCP_MODE).toBeUndefined();
    }
  });
});

describe("repair — restores a decision, never invents one", () => {
  it("reports drift when a chosen vendor loses its registration", async () => {
    const h = harness({ cliOnPath: ["claude", "codex"] });
    await runSetup(h, []);
    expect(enrolmentHealth(h.io, h.dataDir).status).toBe("healthy");

    // Something removed MUON from one of them — an upgrade, a `mcp remove`.
    const spec = INSTALLABLE_VENDORS.find((s) => s.id === "claude-code")!;
    const configPath = path.join(h.io.roots.home, ".claude.json");
    if (fs.existsSync(configPath)) fs.rmSync(configPath);

    const health = enrolmentHealth(h.io, h.dataDir);
    expect(health.status).toBe("drifted");
    expect(health.drifted).toContain(spec.id);
    expect(health.detail).toMatch(/muon setup --repair/);
  });

  it("re-registers ONLY the drifted vendor, and puts it back", async () => {
    const h = harness({ cliOnPath: ["claude", "codex"] });
    await runSetup(h, []);
    const configPath = path.join(h.io.roots.home, ".claude.json");
    fs.rmSync(configPath, { force: true });

    const results = repairEnrolment(h.io, h.dataDir);
    expect(results.map((row) => row.vendor)).toEqual(["claude-code"]);
    expect(results.every((row) => row.ok)).toBe(true);
    expect(enrolmentHealth(h.io, h.dataDir).status).toBe("healthy");
  });

  it("repairs NOTHING when the human never set up — it has no decision to restore", () => {
    const h = harness();
    const health = enrolmentHealth(h.io, h.dataDir);
    expect(health.status).toBe("never-set-up");
    expect(repairEnrolment(h.io, h.dataDir)).toEqual([]);
    // And it says the remedy is to CHOOSE, not to repair.
    expect(health.detail).toMatch(/muon setup/);
  });

  it("cannot add a vendor the human did not choose", async () => {
    const h = harness({ cliOnPath: ["claude", "codex"] });
    await runSetup(h, ["--vendors", "claude-code"]);
    // codex is installed on the machine but was NOT chosen.
    const results = repairEnrolment(h.io, h.dataDir);
    expect(results.some((row) => row.vendor === "codex")).toBe(false);
  });
});

describe("setup never silently downgrades a coordinator seat", () => {
  /**
   * Found by running this against a real machine that HAD one: setup wrote the
   * base entry over an attached-coordinator registration and took 14 tools
   * (dispatch, ship, interrupt, steer…) away from the next session that vendor
   * started, saying nothing.
   */
  function attachEntry(h: ReturnType<typeof harness>): void {
    const file = path.join(h.io.roots.home, ".claude.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          muon: {
            type: "stdio",
            command: "/opt/muon/bin/muon-mcp",
            args: [],
            env: {
              MUON_MCP_MODE: "attached-coordinator",
              MUON_ATTACHED_CAPABILITY_FILE: "/tmp/cap.json",
            },
          },
        },
      })
    );
  }

  it("LEAVES an attached-coordinator entry alone", async () => {
    const h = harness({ cliOnPath: ["claude"] });
    attachEntry(h);
    await runSetup(h, []);
    const after = JSON.parse(
      fs.readFileSync(path.join(h.io.roots.home, ".claude.json"), "utf8")
    );
    expect(after.mcpServers.muon.env.MUON_MCP_MODE).toBe(
      "attached-coordinator"
    );
  });

  it("does not report a preserved seat as a FAILURE", async () => {
    const h = harness({ cliOnPath: ["claude"] });
    attachEntry(h);
    await runSetup(h, []);
    // Exiting non-zero for doing the right thing makes a healthy machine look
    // broken to anything that checks the code.
    expect(process.exitCode).toBe(0);
  });

  it("replaces it only when the human says --force", async () => {
    const h = harness({ cliOnPath: ["claude"] });
    attachEntry(h);
    await runSetup(h, ["--force"]);
    const after = JSON.parse(
      fs.readFileSync(path.join(h.io.roots.home, ".claude.json"), "utf8")
    );
    expect(after.mcpServers.muon.env.MUON_MCP_MODE).toBeUndefined();
  });
});
