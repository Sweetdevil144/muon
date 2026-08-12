import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiBase, resolveApiToken } from "../src/config.js";
import { writeLockfile } from "../src/paths.js";

// Locks review finding F1: an explicit target (flag/env) must ALWAYS beat the
// auto-discovered local-brain lockfile, and a dead-pid lockfile must be ignored.

const ENV_KEYS = [
  "MUON_API_BASE",
  "NEXT_PUBLIC_MUON_API_BASE",
  "MUON_API_TOKEN",
  "MUON_DATA_DIR",
];
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), "muon-cfg-"));
  process.env.MUON_DATA_DIR = dir;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function liveLock(port: number, token: string): void {
  writeLockfile(
    { port, token, pid: process.pid, dbPath: "/x", startedAt: "t" },
    dir
  );
}

describe("resolveApiBase precedence", () => {
  it("falls back to the default when nothing is configured", () => {
    expect(resolveApiBase()).toBe("http://localhost:4000");
  });

  it("auto-targets a live local-brain lockfile over the default", () => {
    liveLock(51000, "tok");
    expect(resolveApiBase()).toBe("http://127.0.0.1:51000");
  });

  it("F1: explicit MUON_API_BASE env beats the lockfile", () => {
    liveLock(51000, "tok");
    process.env.MUON_API_BASE = "https://remote.example.com";
    expect(resolveApiBase()).toBe("https://remote.example.com");
  });

  it("the --api-base flag beats env and the lockfile", () => {
    liveLock(51000, "tok");
    process.env.MUON_API_BASE = "https://remote.example.com";
    expect(resolveApiBase("https://flag.example.com/")).toBe(
      "https://flag.example.com"
    );
  });

  it("ignores a lockfile whose brain process is dead", () => {
    writeLockfile(
      { port: 51000, token: "tok", pid: 999999, dbPath: "/x", startedAt: "t" },
      dir
    );
    expect(resolveApiBase()).toBe("http://localhost:4000");
  });
});

describe("resolveApiToken pairing", () => {
  it("uses the live lockfile token when auto-targeting the local brain", () => {
    liveLock(51000, "localtok");
    expect(resolveApiToken()).toBe("localtok");
  });

  it("F1: never sends the local lockfile token to an explicit remote base", () => {
    liveLock(51000, "localtok");
    process.env.MUON_API_BASE = "https://remote.example.com";
    expect(resolveApiToken()).toBeUndefined();
  });

  it("uses MUON_API_TOKEN env alongside an explicit base", () => {
    process.env.MUON_API_BASE = "https://remote.example.com";
    process.env.MUON_API_TOKEN = "remotetok";
    expect(resolveApiToken()).toBe("remotetok");
  });
});
