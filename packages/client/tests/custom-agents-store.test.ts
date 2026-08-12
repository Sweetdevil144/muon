import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UNGOVERNED_AUTHORITY, MAX_CUSTOM_AGENTS } from "@muon/protocol";
import {
  CUSTOM_AGENTS_FILE_NAME,
  CustomAgentStoreError,
  customAgentsFilePath,
  findCustomAgentById,
  listCustomAgents,
  readCustomAgents,
  registerCustomAgent,
  removeCustomAgent,
} from "../src/custom-agents-store.js";

// A throwaway data dir per test — never MUON's real resolveDataDir() — so this
// suite can never read or clobber an operator's actual registered agents.
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-custom-agents-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("readCustomAgents — degrade-safe on a missing/corrupt store", () => {
  it("returns [] when the file does not exist yet", () => {
    expect(readCustomAgents(dataDir)).toEqual([]);
  });

  it("returns [] for unparseable JSON, without throwing", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(customAgentsFilePath(dataDir), "{not json", "utf8");
    expect(() => readCustomAgents(dataDir)).not.toThrow();
    expect(readCustomAgents(dataDir)).toEqual([]);
  });

  it("returns [] when the file is valid JSON but not an array", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(customAgentsFilePath(dataDir), JSON.stringify({ foo: 1 }), "utf8");
    expect(readCustomAgents(dataDir)).toEqual([]);
  });

  it("drops a single tampered row without losing the good ones", () => {
    const good = registerCustomAgent(
      { slug: "good-agent", displayName: "Good Agent", command: "good-bin", args: [] },
      dataDir
    );
    const raw = JSON.parse(fs.readFileSync(customAgentsFilePath(dataDir), "utf8"));
    raw.push({ ...good, id: "custom:tampered", authority: { ...good.authority, dispatchable: true } });
    fs.writeFileSync(customAgentsFilePath(dataDir), JSON.stringify(raw), "utf8");

    const loaded = readCustomAgents(dataDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(good.id);
  });
});

describe("registerCustomAgent", () => {
  it("creates the data dir and writes a valid, ungoverned entry", () => {
    const entry = registerCustomAgent(
      {
        slug: "my-terminal-agent",
        displayName: "My Terminal Agent",
        command: "my-agent-bin",
        args: ["--flag", "value"],
      },
      dataDir
    );
    expect(entry.id).toBe("custom:my-terminal-agent");
    expect(entry.authority).toBe(UNGOVERNED_AUTHORITY);
    expect(fs.existsSync(customAgentsFilePath(dataDir))).toBe(true);
    expect(path.basename(customAgentsFilePath(dataDir))).toBe(CUSTOM_AGENTS_FILE_NAME);
    expect(listCustomAgents(dataDir)).toEqual([entry]);
  });

  it("persists 0600 file permissions (owner-only)", () => {
    registerCustomAgent(
      { slug: "perm-check", displayName: "Perm Check", command: "x", args: [] },
      dataDir
    );
    const mode = fs.statSync(customAgentsFilePath(dataDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses a duplicate slug with a typed CustomAgentStoreError", () => {
    registerCustomAgent(
      { slug: "dup", displayName: "First", command: "x", args: [] },
      dataDir
    );
    expect(() =>
      registerCustomAgent(
        { slug: "dup", displayName: "Second", command: "y", args: [] },
        dataDir
      )
    ).toThrow(CustomAgentStoreError);
    expect(listCustomAgents(dataDir)).toHaveLength(1);
  });

  it("refuses an invalid slug via the protocol schema (ZodError, not silently accepted)", () => {
    expect(() =>
      registerCustomAgent(
        { slug: "Not Valid!", displayName: "X", command: "x", args: [] },
        dataDir
      )
    ).toThrow();
    expect(listCustomAgents(dataDir)).toEqual([]);
  });

  it("enforces MAX_CUSTOM_AGENTS", () => {
    for (let i = 0; i < MAX_CUSTOM_AGENTS; i += 1) {
      registerCustomAgent(
        { slug: `agent-${i}`, displayName: `Agent ${i}`, command: "x", args: [] },
        dataDir
      );
    }
    expect(listCustomAgents(dataDir)).toHaveLength(MAX_CUSTOM_AGENTS);
    expect(() =>
      registerCustomAgent(
        { slug: "one-too-many", displayName: "X", command: "x", args: [] },
        dataDir
      )
    ).toThrow(CustomAgentStoreError);
    expect(listCustomAgents(dataDir)).toHaveLength(MAX_CUSTOM_AGENTS);
  });

  it("refuses to overwrite a corrupt registry during registration", () => {
    const filePath = customAgentsFilePath(dataDir);
    const original = "{not valid json\n";
    fs.writeFileSync(filePath, original, "utf8");
    expect(() =>
      registerCustomAgent(
        { slug: "new-agent", displayName: "New Agent", command: "x", args: [] },
        dataDir
      )
    ).toThrow(CustomAgentStoreError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  it("refuses to discard a tampered row while appending a valid one", () => {
    const good = registerCustomAgent(
      { slug: "good", displayName: "Good", command: "x", args: [] },
      dataDir
    );
    const filePath = customAgentsFilePath(dataDir);
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    rows.push({ ...good, authority: { ...good.authority, dispatchable: true } });
    const original = JSON.stringify(rows);
    fs.writeFileSync(filePath, original, "utf8");

    expect(() =>
      registerCustomAgent(
        { slug: "another", displayName: "Another", command: "x", args: [] },
        dataDir
      )
    ).toThrow(CustomAgentStoreError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });
});

describe("findCustomAgentById / removeCustomAgent", () => {
  it("finds a registered entry by id, and null for an unknown one", () => {
    const entry = registerCustomAgent(
      { slug: "findable", displayName: "Findable", command: "x", args: [] },
      dataDir
    );
    expect(findCustomAgentById(entry.id, dataDir)).toEqual(entry);
    expect(findCustomAgentById("custom:does-not-exist", dataDir)).toBeNull();
  });

  it("removes an entry and is idempotent (second remove returns false)", () => {
    const entry = registerCustomAgent(
      { slug: "removable", displayName: "Removable", command: "x", args: [] },
      dataDir
    );
    expect(removeCustomAgent(entry.id, dataDir)).toBe(true);
    expect(listCustomAgents(dataDir)).toEqual([]);
    expect(removeCustomAgent(entry.id, dataDir)).toBe(false);
  });

  it("removing one entry leaves the others intact", () => {
    const a = registerCustomAgent(
      { slug: "keep-a", displayName: "Keep A", command: "x", args: [] },
      dataDir
    );
    const b = registerCustomAgent(
      { slug: "remove-b", displayName: "Remove B", command: "x", args: [] },
      dataDir
    );
    expect(removeCustomAgent(b.id, dataDir)).toBe(true);
    expect(listCustomAgents(dataDir)).toEqual([a]);
  });

  it("refuses removal when the registry is corrupt, preserving its bytes", () => {
    const filePath = customAgentsFilePath(dataDir);
    const original = JSON.stringify({ unexpected: "shape" });
    fs.writeFileSync(filePath, original, "utf8");
    expect(() => removeCustomAgent("custom:any", dataDir)).toThrow(
      CustomAgentStoreError
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });
});
