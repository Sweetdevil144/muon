/**
 * ADR-0052 — the desktop adopts the machine's shared identity credential.
 *
 * Founder bug (2026-08-19): `muon login` verified the identity, registered the
 * install, wrote `github-identity.json` — and the desktop still demanded a
 * sign-in, because gate satisfaction reads only `settings.githubCredential`.
 * These tests pin the adoption decision: WHEN the shared credential carries
 * across, and — as importantly — when it must not.
 */
import { describe, expect, it } from "vitest";
import {
  adoptableSharedCredential,
  desktopCredentialFromShared,
} from "../src/lib/adopt-identity.js";
import type { IdentityCredentialRead } from "@muon/client/github-identity-gate";

const VALID_READ: IdentityCredentialRead = {
  ok: true,
  credential: {
    version: 1,
    github: { login: "operator", id: 42 },
    token: "gho_sharedtoken12345",
    grant: {
      token: "a".repeat(64),
      issuedAt: "2026-08-19T00:00:00.000Z",
      version: 1,
    },
    registered: { surface: "cli", version: "0.4.8" },
    createdAt: "2026-08-19T00:00:00.000Z",
  },
};

describe("desktopCredentialFromShared", () => {
  it("translates a valid shared credential into the desktop shape", () => {
    expect(desktopCredentialFromShared(VALID_READ)).toEqual({
      accessToken: "gho_sharedtoken12345",
      login: "operator",
    });
  });

  it("adopts nothing from an absent file", () => {
    expect(desktopCredentialFromShared({ ok: false, reason: "absent" })).toBeNull();
  });

  it("adopts nothing from an unreadable file — tampering is a sign-in-again case, not a trust case", () => {
    expect(
      desktopCredentialFromShared({
        ok: false,
        reason: "unreadable",
        detail: "install grant version 9 is not one this build accepts",
      })
    ).toBeNull();
  });
});

describe("adoptableSharedCredential", () => {
  it("adopts when the desktop has no credential and the shared file is valid", () => {
    const adopted = adoptableSharedCredential({
      hasSettingsCredential: false,
      read: () => VALID_READ,
    });
    expect(adopted).toEqual({
      accessToken: "gho_sharedtoken12345",
      login: "operator",
    });
  });

  it("never overwrites a credential the desktop already holds", () => {
    // A present credential wins even over a newer shared one: otherwise
    // `muon login` becomes a silent account switcher for a running app.
    let readCalls = 0;
    const adopted = adoptableSharedCredential({
      hasSettingsCredential: true,
      read: () => {
        readCalls += 1;
        return VALID_READ;
      },
    });
    expect(adopted).toBeNull();
    // The file is not even read — the steady signed-in state costs nothing.
    expect(readCalls).toBe(0);
  });

  it("adopts nothing when the shared file is absent", () => {
    expect(
      adoptableSharedCredential({
        hasSettingsCredential: false,
        read: () => ({ ok: false, reason: "absent" }),
      })
    ).toBeNull();
  });
});
