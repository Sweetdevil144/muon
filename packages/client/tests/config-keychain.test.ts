import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0017, resolveApiToken's Keychain precedence step, exercised with the
// `security` seam MOCKED so it is deterministic on every platform (no real
// keychain, no macOS gate). Pins: legacy lockfile token beats the Keychain
// (inertness), an empty lockfile falls through to the Keychain then env, and the
// AGENT token is UNTOUCHED (constraint #4).

const readOperatorToken = vi.fn<() => string | undefined>();
vi.mock("../src/keychain.js", () => ({
  isKeychainAvailable: () => false,
  storeOperatorToken: () => false,
  deleteOperatorToken: () => false,
  readOperatorToken: () => readOperatorToken(),
}));

// Import AFTER the mock is registered (vi.mock is hoisted, but keep it explicit).
const { resolveApiToken, resolveAgentToken } = await import("../src/config.js");
const { writeLockfile } = await import("../src/paths.js");

const ENV_KEYS = [
  "MUON_API_BASE",
  "NEXT_PUBLIC_MUON_API_BASE",
  "MUON_API_TOKEN",
  "MUON_AGENT_TOKEN",
  "MUON_DATA_DIR",
];
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), "muon-kc-cfg-"));
  process.env.MUON_DATA_DIR = dir;
  readOperatorToken.mockReset();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function lock(token: string): void {
  writeLockfile(
    {
      port: 51000,
      token,
      agentToken: "agenttok",
      pid: process.pid,
      dbPath: "/x",
      startedAt: "t",
    },
    dir
  );
}

describe("resolveApiToken, Keychain precedence (ADR-0017 §3)", () => {
  it("a NON-EMPTY lockfile token wins over the Keychain (legacy; step is inert)", () => {
    lock("legacytok");
    readOperatorToken.mockReturnValue("kctok");
    expect(resolveApiToken()).toBe("legacytok");
    // Short-circuited by ||: the Keychain is never even read.
    expect(readOperatorToken).not.toHaveBeenCalled();
  });

  it("an EMPTY lockfile token falls through to the Keychain (new custody path)", () => {
    lock("");
    readOperatorToken.mockReturnValue("kctok");
    expect(resolveApiToken()).toBe("kctok");
  });

  it("empty lockfile + no Keychain → MUON_API_TOKEN env → undefined", () => {
    lock("");
    readOperatorToken.mockReturnValue(undefined);
    expect(resolveApiToken()).toBeUndefined();
    process.env.MUON_API_TOKEN = "envtok";
    expect(resolveApiToken()).toBe("envtok");
  });

  it("an explicit flag still beats everything (unchanged)", () => {
    lock("");
    readOperatorToken.mockReturnValue("kctok");
    expect(resolveApiToken("flagtok")).toBe("flagtok");
    expect(readOperatorToken).not.toHaveBeenCalled();
  });
});

describe("resolveAgentToken, UNCHANGED by ADR-0017 (constraint #4)", () => {
  it("still round-trips via the lockfile even when the operator token moved to ''", () => {
    lock(""); // operator token custodied out-of-band
    readOperatorToken.mockReturnValue("kctok");
    expect(resolveAgentToken()).toBe("agenttok");
    // The agent path NEVER consults the Keychain.
    expect(readOperatorToken).not.toHaveBeenCalled();
  });
});

// A flag-supplied base must de-pair the local credential exactly as an env base
// does. `resolveApiBase` honoured `--api-base` while `resolveApiToken` did not,
// so `muon --api-base https://elsewhere …` sent the local brain's OPERATOR
// bearer — full govern authority — to whatever host was named.
describe("base/token pairing for a FLAG-supplied base", () => {
  it("never sends the lockfile operator token to a flag-supplied base", () => {
    expect(resolveApiToken(undefined, "https://elsewhere.example.com")).toBeUndefined();
  });

  it("never sends the lockfile agent token to a flag-supplied base either", () => {
    expect(resolveAgentToken(undefined, "https://elsewhere.example.com")).toBeUndefined();
  });
});

// In development the desktop's Electron `userData` is `@muon/desktop` while
// every other surface resolves `MUON`, so the CLI booted a SECOND brain and
// reported that profile's stale runner while the desktop's served the work.
// Discovery adopts a live sibling brain rather than starting a rival one.
describe("sibling-profile brain discovery", () => {
  it("is DISABLED when the operator pinned a profile explicitly", async () => {
    const { discoverLiveBrain } = await import("../src/paths.js");
    const previous = process.env.MUON_DATA_DIR;
    process.env.MUON_DATA_DIR = dir;
    try {
      // An explicit profile is the whole answer: no sibling is consulted, so a
      // dead/absent brain under it stays absent rather than silently adopting.
      const found = discoverLiveBrain("/nonexistent-muon-profile");
      expect(found).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MUON_DATA_DIR;
      else process.env.MUON_DATA_DIR = previous;
    }
  });

  it("reports its own profile as NOT adopted when a live brain is there", async () => {
    const { discoverLiveBrain } = await import("../src/paths.js");
    lock("owntok"); // a lockfile whose pid IS this process, so it reads live
    const found = discoverLiveBrain(dir);
    expect(found?.adopted).toBe(false);
    expect(found?.dataDir).toBe(dir);
  });
});
