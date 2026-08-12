import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomAgentCommands } from "../src/commands/custom-agents.js";

/**
 * `muon custom-agents register | list | remove` — ROADMAP P7.
 *
 * `MUON_DATA_DIR` is pointed at a throwaway tmp dir for every test so this
 * suite can never read or write an operator's real registered agents.
 */
describe("muon custom-agents", () => {
  const writes: string[] = [];
  const errors: string[] = [];
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-cli-custom-agents-"));
    previousDataDir = process.env.MUON_DATA_DIR;
    process.env.MUON_DATA_DIR = dataDir;
  });

  afterEach(() => {
    writes.length = 0;
    errors.length = 0;
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousDataDir === undefined) {
      delete process.env.MUON_DATA_DIR;
    } else {
      process.env.MUON_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function run(argv: string[]) {
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
    registerCustomAgentCommands(program);
    return program.parseAsync(["node", "muon", ...argv]);
  }

  it("registers an agent and prints its id, marked Ungoverned", async () => {
    await run([
      "custom-agents",
      "register",
      "my-agent",
      "--command",
      "my-agent-bin",
    ]);
    const out = writes.join("");
    expect(out).toContain("custom:my-agent");
    expect(out).toContain("ungoverned");
  });

  it("supports --json on register", async () => {
    await run([
      "custom-agents",
      "register",
      "json-agent",
      "--command",
      "bin",
      "--arg",
      "--flag",
      "--json",
    ]);
    const entry = JSON.parse(writes.join(""));
    expect(entry.id).toBe("custom:json-agent");
    expect(entry.args).toEqual(["--flag"]);
    expect(entry.authority).toMatchObject({
      terminalTabOnly: true,
      dispatchable: false,
      coordinatorSeat: false,
      delegatable: false,
      fleetSizeable: false,
      evaluator: false,
      planner: false,
      brainAccess: false,
      mcpInstall: false,
      supportedRoles: [],
    });
  });

  it("lists registered agents in a table, tagged Ungoverned", async () => {
    await run(["custom-agents", "register", "table-agent", "--command", "bin"]);
    writes.length = 0;
    await run(["custom-agents", "list"]);
    const out = writes.join("");
    expect(out).toContain("custom:table-agent");
    expect(out).toContain("Ungoverned");
  });

  it("reports no agents registered yet", async () => {
    await run(["custom-agents", "list"]);
    expect(writes.join("")).toContain("no custom agents registered");
  });

  it("refuses a duplicate slug with exit code 1", async () => {
    await run(["custom-agents", "register", "dup", "--command", "bin"]);
    await run(["custom-agents", "register", "dup", "--command", "bin"]);
    expect(errors.join("")).toMatch(/already registered/);
    expect(process.exitCode).toBe(1);
  });

  it("removes a registered agent by bare slug or full id", async () => {
    await run(["custom-agents", "register", "removable", "--command", "bin"]);
    await run(["custom-agents", "remove", "removable"]);
    expect(writes.join("")).toContain("removed custom:removable");
    writes.length = 0;
    await run(["custom-agents", "list"]);
    expect(writes.join("")).toContain("no custom agents registered");
  });

  it("reports removal of an unknown id with exit code 1", async () => {
    await run(["custom-agents", "remove", "never-existed"]);
    expect(errors.join("")).toMatch(/no custom agent registered/);
    expect(process.exitCode).toBe(1);
  });

  it("refuses an invalid slug shape", async () => {
    await run(["custom-agents", "register", "Not Valid!", "--command", "bin"]);
    expect(errors.join("")).toMatch(/slug/i);
    expect(process.exitCode).toBe(1);
  });
});
