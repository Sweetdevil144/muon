import {
  chmodSync,
  mkdtempSync,
  readFileSync,
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
  trySaveSettings,
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

/**
 * A SETTINGS WRITE THAT FAILS MUST NOT KILL A RUNNING APP.
 *
 * `saveSettings` is synchronous (`writeFileSync` + `chmodSync`), and one of its
 * callers is a background one: `applyBrainCoords`, reached from the brain
 * supervisor's `onChange` inside a `void`ed async call. An unwritable
 * settings.json (ENOSPC, a root-owned file) therefore left the main process with
 * an unhandled rejection — and this app installs no `unhandledRejection`
 * handler, so it exited, taking the window and every runner-hosted vendor
 * session with it.
 *
 * The strict writer STAYS strict: its other callers are humans pressing Save in
 * Settings, and an invoke that rejects is how the renderer tells them the save
 * did not happen. The non-fatal projection is a second, explicitly named
 * function, so choosing it is a decision at the call site.
 */
describe("a background persist reports failure instead of dying", () => {
  /** A directory path that cannot exist: its parent is a FILE (ENOTDIR). */
  function unwritableDir(): string {
    const parent = freshDir();
    const file = path.join(parent, "not-a-directory");
    writeFileSync(file, "");
    return path.join(file, "profile");
  }

  it("saveSettings still THROWS, so a human-initiated save can report failure", () => {
    expect(() =>
      saveSettings(unwritableDir(), { ...DEFAULT_SETTINGS })
    ).toThrow();
  });

  it("trySaveSettings reports the reason and returns false, and never throws", () => {
    const reasons: string[] = [];
    const ok = trySaveSettings(
      unwritableDir(),
      { ...DEFAULT_SETTINGS },
      (reason) => reasons.push(reason)
    );
    expect(ok).toBe(false);
    // Reported, not silent: a persist nobody can see failing is how a settings
    // file quietly stops tracking reality.
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/ENOTDIR|ENOENT|EROFS|EACCES/);
  });

  it("trySaveSettings writes exactly what the strict writer writes on success", () => {
    const d = freshDir();
    const onError = (reason: string): never => {
      throw new Error(`unexpected persist failure: ${reason}`);
    };
    expect(
      trySaveSettings(d, { ...DEFAULT_SETTINGS, apiToken: "user-tok" }, onError)
    ).toBe(true);
    expect(loadSettings(d).apiToken).toBe("user-tok");
    expect(statSync(path.join(d, "settings.json")).mode & 0o777).toBe(0o600);
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

/**
 * THE STALE-apiBase BUG, AT ITS SEED.
 *
 * The embedded brain's port is chosen at runtime and republished in the lockfile
 * on every boot. Persisting the ADOPTED base wrote a coordinate that was already
 * expiring, and `loadSettings` then handed it back as if it were a decision. An
 * EXPLICIT base — the human typed it — is a decision and does persist.
 */
describe("base-url hygiene", () => {
  const adopted = {
    ...DEFAULT_SETTINGS,
    apiBase: "http://127.0.0.1:10777",
    apiBaseExplicit: false,
  };

  it("persistableSettings drops a runtime-adopted apiBase", () => {
    expect(persistableSettings(adopted, undefined)).not.toHaveProperty(
      "apiBase"
    );
  });

  it("persistableSettings keeps an EXPLICIT apiBase", () => {
    const durable = persistableSettings(
      { ...adopted, apiBase: "http://brain.internal:4000", apiBaseExplicit: true },
      undefined
    );
    expect(durable.apiBase).toBe("http://brain.internal:4000");
    expect(durable.apiBaseExplicit).toBe(true);
  });

  it("an adopted base is not on disk, and boot falls back to the default", () => {
    const d = freshDir();
    saveSettings(d, persistableSettings(adopted, undefined));
    expect(readFileSync(path.join(d, "settings.json"), "utf8")).not.toContain(
      "10777"
    );
    // loadSettings fills the gap from DEFAULT_SETTINGS, and the boot sequence
    // re-adopts the live port from the lockfile — which is the only place that
    // number is ever true.
    expect(loadSettings(d).apiBase).toBe(DEFAULT_SETTINGS.apiBase);
    rmSync(d, { recursive: true, force: true });
  });

  it("an explicit base round-trips, opt-out flag and all", () => {
    const d = freshDir();
    saveSettings(
      d,
      persistableSettings(
        { ...adopted, apiBase: "http://brain.internal:4000", apiBaseExplicit: true },
        undefined
      )
    );
    const loaded = loadSettings(d);
    expect(loaded.apiBase).toBe("http://brain.internal:4000");
    expect(loaded.apiBaseExplicit).toBe(true);
    rmSync(d, { recursive: true, force: true });
  });

  it("clearing apiBaseExplicit reaches disk, so the opt-out cannot come back", () => {
    // applyBrainCoords sets `apiBaseExplicit: false` and now persists it: the
    // embedded brain moving IS the newer instruction, and the old code left the
    // stale `true` on disk for the next launch to restore.
    const d = freshDir();
    saveSettings(d, {
      ...DEFAULT_SETTINGS,
      apiBase: "http://brain.internal:4000",
      apiBaseExplicit: true,
    });
    saveSettings(d, persistableSettings(adopted, undefined));
    const loaded = loadSettings(d);
    expect(loaded.apiBaseExplicit).toBe(false);
    expect(loaded.apiBase).toBe(DEFAULT_SETTINGS.apiBase);
    rmSync(d, { recursive: true, force: true });
  });
});
