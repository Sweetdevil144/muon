import { afterAll, describe, expect, it } from "vitest";
import {
  deleteOperatorToken,
  isKeychainAvailable,
  readOperatorToken,
  storeOperatorToken,
} from "../src/keychain.js";

// ADR-0017 R1, the Keychain seam. The REAL `security` round-trip is macOS-only,
// so it is gated with describe.skipIf; the degrade-safety assertions run on every
// platform (they must NEVER throw and must degrade to a falsy result off macOS).

const onDarwin = process.platform === "darwin";
// A throwaway service name unique to this run so we never touch MUON's real
// `dev.muonlabs.muon`/`operator` item, and cleanup can't collide across runs.
const SERVICE = `dev.muonlabs.muon.test-${process.pid}-${Date.now()}`;
const ACCOUNT = "operator-test";
const OPTS = { service: SERVICE, account: ACCOUNT };

describe.skipIf(!onDarwin)("keychain round-trip (macOS, real security)", () => {
  afterAll(() => {
    // Best-effort cleanup even if an assertion above failed mid-way.
    deleteOperatorToken(OPTS);
  });

  it("store → read → delete a real generic-password item", () => {
    const token = "a1b2c3".repeat(10); // 60-char hex-ish, no newlines
    expect(isKeychainAvailable()).toBe(true);

    expect(storeOperatorToken(token, OPTS)).toBe(true);
    expect(readOperatorToken(OPTS)).toBe(token);

    // -U upsert: a second store with a new value replaces it (idempotent boots).
    const token2 = "ff00".repeat(16);
    expect(storeOperatorToken(token2, OPTS)).toBe(true);
    expect(readOperatorToken(OPTS)).toBe(token2);

    expect(deleteOperatorToken(OPTS)).toBe(true);
    // After delete, a read degrades to undefined (not a throw).
    expect(readOperatorToken(OPTS)).toBeUndefined();
  });
});

describe("keychain degrade-safety (all platforms)", () => {
  it("isKeychainAvailable reflects the platform, never throws", () => {
    expect(isKeychainAvailable()).toBe(onDarwin);
  });

  it("reading an ABSENT item degrades to undefined, never throws", () => {
    expect(
      readOperatorToken({ service: "muon.no.such.item.xyz", account: "nobody" })
    ).toBeUndefined();
  });

  it("storing an empty token is a no-op false (nothing to custody)", () => {
    expect(storeOperatorToken("", OPTS)).toBe(false);
  });

  it("delete of an absent item is best-effort, never throws", () => {
    // On macOS this returns false (no such item); off macOS it short-circuits false.
    expect(
      deleteOperatorToken({ service: "muon.no.such.item.xyz", account: "nobody" })
    ).toBe(false);
  });
});
