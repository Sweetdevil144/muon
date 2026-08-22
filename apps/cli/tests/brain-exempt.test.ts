import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  BRAIN_EXEMPT_COMMANDS,
  MCP_SUBCOMMANDS_NEEDING_BRAIN,
  commandNeedsBrain,
} from "../src/lib/brain-exempt.js";

// The hook that consumes this ends in a spawn and a process.exit, so the
// decision is tested here against a real commander tree rather than asserted
// about in a comment. Every case below is a command someone actually types.

const tree = (...names: readonly string[]): Command => {
  const root = new Command("muon");
  let cmd = root;
  for (const name of names) {
    const child = new Command(name);
    cmd.addCommand(child);
    cmd = child;
  }
  return cmd;
};

describe("commandNeedsBrain", () => {
  it("spawns a brain for ordinary governed work", () => {
    for (const path of [
      ["chat"],
      ["dispatch", "status"],
      ["approve", "list"],
      ["memory", "recall"],
      ["ship"],
      ["wrap"],
    ]) {
      expect(commandNeedsBrain(tree(...path))).toBe(true);
    }
  });

  it("never spawns one for a command that only touches local state", () => {
    for (const name of BRAIN_EXEMPT_COMMANDS) {
      expect(commandNeedsBrain(tree(name))).toBe(false);
    }
  });

  // The regression this file exists for: both were documented client-free and
  // both booted a brain anyway. `docs` reads markdown in process; `uninstall`
  // removes the CLI and stops a brain rather than starting one.
  it("keeps docs and uninstall brain-free, including subcommands", () => {
    expect(commandNeedsBrain(tree("docs", "query"))).toBe(false);
    expect(commandNeedsBrain(tree("docs", "status"))).toBe(false);
    expect(commandNeedsBrain(tree("docs", "impact"))).toBe(false);
    expect(commandNeedsBrain(tree("uninstall"))).toBe(false);
  });

  it("exempts a subcommand through its parent", () => {
    expect(commandNeedsBrain(tree("graph", "reindex"))).toBe(false);
    expect(commandNeedsBrain(tree("custom-agents", "register"))).toBe(false);
  });

  // ADR-0028: attach mints a real dispatch job and detach revokes one, so those
  // two need a brain. status/probe must NOT spawn one — they report whether a
  // brain is running, and spawning first would change the answer.
  it("splits the mcp family exactly at attach/detach", () => {
    for (const sub of MCP_SUBCOMMANDS_NEEDING_BRAIN) {
      expect(commandNeedsBrain(tree("mcp", sub))).toBe(true);
    }
    for (const sub of ["status", "probe", "install", "uninstall"]) {
      expect(commandNeedsBrain(tree("mcp", sub))).toBe(false);
    }
  });

  it("is a positive set — a new command needs a brain until it says otherwise", () => {
    expect(commandNeedsBrain(tree("some-future-command"))).toBe(true);
    expect(BRAIN_EXEMPT_COMMANDS.has("chat")).toBe(false);
  });
});
