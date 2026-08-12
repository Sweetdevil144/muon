import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hydrateBakedEnv,
  readBakedBuildConfig,
} from "../src/lib/build-config.js";

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

describe("write-build-config.mjs (the packaging half, run for real)", () => {
  it("writes staged/build-config.json from the packager's env — and an honest empty object without it", () => {
    // The script derives staged/ from its own location; run a COPY in a tmp
    // app root so the real staged/ is never touched.
    const appRoot = tmp();
    mkdirSync(path.join(appRoot, "scripts"), { recursive: true });
    const script = path.join(appRoot, "scripts", "write-build-config.mjs");
    writeFileSync(
      script,
      readFileSync(
        path.join(__dirname, "..", "scripts", "write-build-config.mjs")
      )
    );

    execFileSync(process.execPath, [script], {
      env: { ...process.env, MUON_GITHUB_CLIENT_ID: "Iv1.from-packager" },
    });
    expect(
      JSON.parse(
        readFileSync(path.join(appRoot, "staged", "build-config.json"), "utf8")
      )
    ).toEqual({ githubClientId: "Iv1.from-packager" });

    execFileSync(process.execPath, [script], {
      env: { ...process.env, MUON_GITHUB_CLIENT_ID: "" },
    });
    expect(
      JSON.parse(
        readFileSync(path.join(appRoot, "staged", "build-config.json"), "utf8")
      )
    ).toEqual({});
  });
});
