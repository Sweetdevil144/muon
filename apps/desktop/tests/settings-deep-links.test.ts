import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  persistableSettings,
  saveSettings,
  toRendererSettings,
} from "../src/lib/settings.js";

const dir = mkdtempSync(path.join(tmpdir(), "muon-desktop-"));

/** A fresh, isolated data dir so per-test file modes don't collide. */
function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "muon-desktop-"));
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("settings", () => {
  it("falls back to defaults when no file exists", () => {
    expect(loadSettings(path.join(dir, "missing"))).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips saved settings and merges defaults", () => {
    saveSettings(dir, {
      ...DEFAULT_SETTINGS,
      apiBase: "https://backend-production-9b7a.up.railway.app",
      apiToken: "tok",
    });
    const loaded = loadSettings(dir);
    expect(loaded.apiBase).toContain("railway.app");
    expect(loaded.apiToken).toBe("tok");
    expect(loaded.pollIntervalMs).toBe(DEFAULT_SETTINGS.pollIntervalMs);
  });

  it("writes settings.json private (0600), never world-readable", () => {
    const d = freshDir();
    saveSettings(d, { ...DEFAULT_SETTINGS, apiToken: "user-tok" });
    const mode = statSync(path.join(d, "settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(d, { recursive: true, force: true });
  });

  it("tightens a pre-existing 0644 settings.json to 0600", () => {
    const d = freshDir();
    const file = path.join(d, "settings.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);

    saveSettings(d, { ...DEFAULT_SETTINGS, apiToken: "user-tok" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    rmSync(d, { recursive: true, force: true });
  });

  it("persists validated presets with the rest of desktop settings", () => {
    const d = freshDir();
    saveSettings(d, {
      ...DEFAULT_SETTINGS,
      presets: [
        {
          id: "review",
          name: "Review",
          vendor: "codex",
          model: "gpt-5-codex",
          effort: "high",
          permission: "strict",
        },
      ],
    });

    expect(loadSettings(d).presets).toEqual([
      {
        id: "review",
        name: "Review",
        vendor: "codex",
        model: "gpt-5-codex",
        effort: "high",
        permission: "strict",
      },
    ]);
    rmSync(d, { recursive: true, force: true });
  });

  it("fails closed on authority-bearing or malformed preset fields", () => {
    const d = freshDir();
    writeFileSync(
      path.join(d, "settings.json"),
      JSON.stringify({
        presets: [
          {
            id: "unsafe",
            name: "Unsafe",
            vendor: "claude-code",
            model: "opus",
            effort: "high",
            permission: "full-auto",
            allowedTools: ["*"],
            apiToken: "must-not-survive",
          },
        ],
      })
    );

    expect(loadSettings(d).presets).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("token hygiene", () => {
  // The embedded flow's operator + agent tokens are re-minted each boot from
  // the 0600 lockfile; only a user-supplied token is durable.
  const embedded = {
    ...DEFAULT_SETTINGS,
    apiToken: "embedded-operator-token",
    agentToken: "embedded-agent-token",
  };

  it("persistableSettings strips embedded + agent tokens (embedded boot)", () => {
    const durable = persistableSettings(embedded, undefined);
    expect(durable.apiToken).toBeUndefined();
    expect(durable.agentToken).toBeUndefined();
  });

  it("persistableSettings keeps ONLY the user-supplied operator token", () => {
    const durable = persistableSettings(embedded, "user-supplied");
    expect(durable.apiToken).toBe("user-supplied");
    expect(durable.agentToken).toBeUndefined();
  });

  it("does not write an embedded/agent token to disk (embedded boot)", () => {
    const d = freshDir();
    saveSettings(d, persistableSettings(embedded, undefined));
    const raw = statSync(path.join(d, "settings.json")); // exists
    expect(raw.isFile()).toBe(true);
    const loaded = loadSettings(d);
    expect(loaded.apiToken).toBeUndefined();
    expect(loaded.agentToken).toBeUndefined();
    // Embedded still resolves at runtime from the lockfile-derived `settings`,
    // not from disk, unchanged and unaffected by what we persist.
    expect(embedded.apiToken).toBe("embedded-operator-token");
    rmSync(d, { recursive: true, force: true });
  });

  it("round-trips a user-supplied token at 0600 (manual/hosted flow)", () => {
    const d = freshDir();
    saveSettings(d, persistableSettings(embedded, "user-supplied"));
    expect(statSync(path.join(d, "settings.json")).mode & 0o777).toBe(0o600);
    const loaded = loadSettings(d);
    expect(loaded.apiToken).toBe("user-supplied");
    expect(loaded.agentToken).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });

  it("toRendererSettings never exposes a raw token, only a boolean", () => {
    const withUser = toRendererSettings(embedded, "user-supplied");
    expect(withUser).not.toHaveProperty("apiToken");
    expect(withUser).not.toHaveProperty("agentToken");
    expect(Object.values(withUser)).not.toContain("embedded-operator-token");
    expect(withUser.apiTokenSet).toBe(true);
    expect(withUser.presets).toEqual(embedded.presets);

    const embeddedOnly = toRendererSettings(embedded, undefined);
    expect(embeddedOnly).not.toHaveProperty("apiToken");
    expect(embeddedOnly.apiTokenSet).toBe(false);
  });

  it("persists the explicit GitHub device credential at 0600 but never projects it to renderer settings", () => {
    const d = freshDir();
    const withGitHub = {
      ...embedded,
      githubCredential: {
        accessToken: "test-private-access-token",
        expiresAt: "2026-07-21T20:00:00.000Z",
        refreshToken: "test-private-refresh-token",
        refreshExpiresAt: "2027-01-21T12:00:00.000Z",
        login: "operator",
      },
    };
    saveSettings(d, persistableSettings(withGitHub, undefined));
    expect(statSync(path.join(d, "settings.json")).mode & 0o777).toBe(0o600);
    expect(loadSettings(d).githubCredential).toEqual(
      withGitHub.githubCredential
    );

    const renderer = toRendererSettings(withGitHub, undefined);
    const serialized = JSON.stringify(renderer);
    expect(renderer).not.toHaveProperty("githubCredential");
    expect(serialized).not.toContain("test-private-access-token");
    expect(serialized).not.toContain("test-private-refresh-token");
    rmSync(d, { recursive: true, force: true });
  });
});
