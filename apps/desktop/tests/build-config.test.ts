import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hydrateBakedEnv,
  readBakedBuildConfig,
} from "../src/lib/build-config.js";
// @ts-expect-error — a plain .mjs packaging script with no type declarations. It
// is deliberately JS: it runs from npm scripts with no build step.
import { writeBuildConfig } from "../scripts/write-build-config.mjs";

// The packaged identity gate's one release requirement: a Finder-launched app
// has no shell env, so MUON_GITHUB_CLIENT_ID must ride the artifact itself.
// write-build-config.mjs bakes it at package time; build-config.ts reads it
// back at boot and hydrates process.env BEFORE gate policy is computed.

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "muon-build-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readBakedBuildConfig", () => {
  it("reads the baked client id from Resources when packaged", () => {
    const resources = tmp();
    writeFileSync(
      path.join(resources, "build-config.json"),
      JSON.stringify({ githubClientId: "Iv1.abcdef0123456789" })
    );
    expect(
      readBakedBuildConfig({ isPackaged: true, resourcesPath: resources })
    ).toEqual({ githubClientId: "Iv1.abcdef0123456789" });
  });

  it("never reads any file when unpackaged — dev stays env-only", () => {
    const resources = tmp();
    writeFileSync(
      path.join(resources, "build-config.json"),
      JSON.stringify({ githubClientId: "Iv1.should-not-be-read" })
    );
    expect(
      readBakedBuildConfig({ isPackaged: false, resourcesPath: resources })
    ).toEqual({});
  });

  it("an absent, malformed, or empty file is an unbaked build, not a crash", () => {
    const resources = tmp();
    expect(
      readBakedBuildConfig({ isPackaged: true, resourcesPath: resources })
    ).toEqual({});
    writeFileSync(path.join(resources, "build-config.json"), "{nope");
    expect(
      readBakedBuildConfig({ isPackaged: true, resourcesPath: resources })
    ).toEqual({});
    writeFileSync(
      path.join(resources, "build-config.json"),
      JSON.stringify({ githubClientId: "   " })
    );
    expect(
      readBakedBuildConfig({ isPackaged: true, resourcesPath: resources })
    ).toEqual({});
  });
});

describe("hydrateBakedEnv", () => {
  it("fills an empty env from the bake, and NEVER overrides an explicit one", () => {
    const env: NodeJS.ProcessEnv = {};
    hydrateBakedEnv(env, { githubClientId: "Iv1.baked" });
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv1.baked");

    const explicit: NodeJS.ProcessEnv = { MUON_GITHUB_CLIENT_ID: "Iv1.env" };
    hydrateBakedEnv(explicit, { githubClientId: "Iv1.baked" });
    expect(explicit.MUON_GITHUB_CLIENT_ID).toBe("Iv1.env");
  });
});

/**
 * ADR-0052 — THE PACKAGING HALF, AND THE HOLE IT USED TO HAVE.
 *
 * This script bakes `MUON_GITHUB_CLIENT_ID` into an artifact anybody can download
 * and unpack, and it did it with NO check at all — while the CLI bundler had
 * refused secret-shaped values for exactly that reason. `MUON_GITHUB_CLIENT_SECRET`
 * is seven characters away from `MUON_GITHUB_CLIENT_ID` in a release script nobody
 * reads twice, so the wrong variable would have shipped a credential inside the
 * `.dmg`. It now calls the CLI's guard (`apps/cli/scripts/lib/client-id-guard.mjs`,
 * a relative hop: both are build-time-only scripts run from this checkout, and
 * `apps/desktop` does not depend on `@muon/cli`).
 *
 * The script exports its bake step so these can drive the real function against a
 * temp `staged/` — the old shape here copied the script into a tmp app root, which
 * stopped working the moment the script had an import to resolve, and which never
 * proved the copy behaved like the original anyway.
 */
describe("write-build-config.mjs — the packaging half, run for real", () => {
  const nowhere = () => undefined;

  it("writes staged/build-config.json from the packager's env — and an honest empty object without it", () => {
    const stagedDir = path.join(tmp(), "staged");
    const baked = writeBuildConfig({
      env: { MUON_GITHUB_CLIENT_ID: "Iv1.from-packager" },
      stagedDir,
      log: nowhere,
      warn: nowhere,
    });
    expect(JSON.parse(readFileSync(baked.target, "utf8"))).toEqual({
      githubClientId: "Iv1.from-packager",
    });

    // An empty env still writes the file, so a missing id is a visible, diffable
    // fact of the artifact rather than a missing file that could be anything.
    const empty = writeBuildConfig({
      env: {},
      stagedDir,
      log: nowhere,
      warn: nowhere,
    });
    expect(JSON.parse(readFileSync(empty.target, "utf8"))).toEqual({});
  });

  it("REFUSES a client SECRET, and writes nothing at all", () => {
    // The wrong-variable mistake, which is the whole reason the guard exists.
    // Refused before `staged/` is even created: a build refusal must not cost the
    // operator the directory they already had.
    const stagedDir = path.join(tmp(), "staged");
    expect(() =>
      writeBuildConfig({
        env: {
          MUON_GITHUB_CLIENT_ID: "0123456789abcdef0123456789abcdef01234567",
        },
        stagedDir,
        log: nowhere,
        warn: nowhere,
      })
    ).toThrow(/client SECRET/);
    expect(existsSync(stagedDir)).toBe(false);
  });

  it("REFUSES every GitHub access-token family, in the guard's own words", () => {
    for (const value of [
      `ghp_${"A".repeat(36)}`,
      `gho_${"B".repeat(36)}`,
      `ghu_${"C".repeat(36)}`,
      `ghs_${"D".repeat(36)}`,
      `ghr_${"E".repeat(36)}`,
      `github_pat_${"F".repeat(22)}`,
    ]) {
      const stagedDir = path.join(tmp(), "staged");
      let thrown: unknown;
      try {
        writeBuildConfig({
          env: { MUON_GITHUB_CLIENT_ID: value },
          stagedDir,
          log: nowhere,
          warn: nowhere,
        });
      } catch (error) {
        thrown = error;
      }
      const message = thrown instanceof Error ? thrown.message : "";
      // The guard's message, not a second one written here, so the desktop and
      // the CLI tell an operator the same thing about the same value.
      expect(message, value.slice(0, 12)).toContain("ACCESS TOKEN");
      expect(message, value.slice(0, 12)).toContain("Revoke it");
      expect(existsSync(stagedDir), value.slice(0, 12)).toBe(false);
    }
  });

  it("REFUSES whitespace, control characters and impossible lengths", () => {
    for (const value of [
      "Iv1.0123456789abcdef\n",
      `Iv1.0123456789ab${String.fromCharCode(0)}ef`,
      "abc",
      "z".repeat(65),
    ]) {
      const stagedDir = path.join(tmp(), "staged");
      expect(
        () =>
          writeBuildConfig({
            env: { MUON_GITHUB_CLIENT_ID: value },
            stagedDir,
            log: nowhere,
            warn: nowhere,
          }),
        JSON.stringify(value)
      ).toThrow(/MUON_GITHUB_CLIENT_ID/);
      expect(existsSync(stagedDir), JSON.stringify(value)).toBe(false);
    }
  });

  it("passes an unrecognised-but-safe id through with the guard's loud warning", () => {
    // GitHub has changed this format twice; blocking a legitimate release over a
    // format change is the worse failure — but it must not be silent.
    const stagedDir = path.join(tmp(), "staged");
    const warnings: string[] = [];
    const baked = writeBuildConfig({
      env: { MUON_GITHUB_CLIENT_ID: "Xy9.some-future-format_01" },
      stagedDir,
      log: nowhere,
      warn: (message) => warnings.push(message),
    });
    expect(baked.clientId).toBe("Xy9.some-future-format_01");
    expect(warnings.join("")).toContain("does not match any GitHub client-id shape");
  });

  it("bakes the value the GUARD returned, never the environment read twice", () => {
    // The one way this guard gets defeated: reading `process.env` again at the
    // write. `process.env` holds a secret here and the injected env holds a real
    // id, so a second read either throws or bakes the secret.
    const stagedDir = path.join(tmp(), "staged");
    const original = process.env.MUON_GITHUB_CLIENT_ID;
    process.env.MUON_GITHUB_CLIENT_ID =
      "0123456789abcdef0123456789abcdef01234567";
    try {
      const baked = writeBuildConfig({
        env: { MUON_GITHUB_CLIENT_ID: "Iv1.from-packager" },
        stagedDir,
        log: nowhere,
        warn: nowhere,
      });
      expect(JSON.parse(readFileSync(baked.target, "utf8"))).toEqual({
        githubClientId: "Iv1.from-packager",
      });
    } finally {
      if (original === undefined) delete process.env.MUON_GITHUB_CLIENT_ID;
      else process.env.MUON_GITHUB_CLIENT_ID = original;
    }
  });

  it("still runs itself when npm invokes it — the refusal path proves the wiring", () => {
    // The script now exports its work and guards its top-level run, so `npm run
    // package` silently writing nothing is a live regression risk. This drives the
    // REAL file at its REAL path (which is also the only way to prove the relative
    // hop into apps/cli resolves), and does it on the REFUSAL path — the one that
    // writes nothing, so the operator's actual staged/ is never touched.
    const script = path.join(
      __dirname,
      "..",
      "scripts",
      "write-build-config.mjs"
    );
    let status: number | undefined;
    let stderr = "";
    try {
      execFileSync(process.execPath, [script], {
        env: {
          ...process.env,
          MUON_GITHUB_CLIENT_ID: "0123456789abcdef0123456789abcdef01234567",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      status = 0;
    } catch (error) {
      const failure = error as { status?: number; stderr?: Buffer };
      status = failure.status;
      stderr = failure.stderr?.toString() ?? "";
    }
    // Non-zero, so a packaging run cannot continue past a refused value.
    expect(status).not.toBe(0);
    expect(stderr).toContain("client SECRET");
    // The reason, not a stack trace: this is a refusal an operator has to act on.
    expect(stderr).not.toContain("at writeBuildConfig");
  });
});
