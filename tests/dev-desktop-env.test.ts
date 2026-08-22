import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../scripts/dev-desktop.mjs";

// ADR-0052 — the desktop's identity gate and its GitHub device flow arm from
// MUON_GITHUB_CLIENT_ID. A packaged build bakes it; a dev run inherits it. This
// loader is what makes `npm run dev:desktop:fresh` behave the same in every
// terminal instead of only in the shell that happened to export it.

const dirs: string[] = [];
const tempEnv = (body: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-dev-env-"));
  dirs.push(dir);
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, body);
  return file;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("loads a quoted value and reports which keys it applied", () => {
    const env: Record<string, string> = {};
    const applied = loadRepoEnv(
      tempEnv('MUON_GITHUB_CLIENT_ID="Iv23liCu8aSpKt2ZU3jZ"\n'),
      env
    );
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv23liCu8aSpKt2ZU3jZ");
    expect(applied).toEqual(["MUON_GITHUB_CLIENT_ID"]);
  });

  it("never overwrites an explicit export, and does not report it as applied", () => {
    const env: Record<string, string> = { MUON_GITHUB_CLIENT_ID: "from-shell" };
    const applied = loadRepoEnv(tempEnv('MUON_GITHUB_CLIENT_ID="from-file"\n'), env);
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("from-shell");
    expect(applied).toEqual([]);
  });

  // An empty exported value is the shape a shell leaves behind after
  // `export FOO=`, and treating it as "already set" would make the file
  // unreachable for exactly the person who tried hardest to configure it.
  it("treats an empty exported value as unset", () => {
    const env: Record<string, string> = { MUON_GITHUB_CLIENT_ID: "" };
    loadRepoEnv(tempEnv('MUON_GITHUB_CLIENT_ID=Iv23liCu8aSpKt2ZU3jZ\n'), env);
    expect(env.MUON_GITHUB_CLIENT_ID).toBe("Iv23liCu8aSpKt2ZU3jZ");
  });

  it("skips comments, blanks, malformed lines and illegal key names", () => {
    const env: Record<string, string> = {};
    const applied = loadRepoEnv(
      tempEnv(
        [
          "# a comment",
          "",
          "no_equals_sign",
          "=leading-equals",
          "bad-key-name=1",
          "GOOD_KEY=value",
        ].join("\n")
      ),
      env
    );
    expect(applied).toEqual(["GOOD_KEY"]);
    expect(env.GOOD_KEY).toBe("value");
  });

  it("is a no-op when the file is absent", () => {
    const env: Record<string, string> = {};
    expect(loadRepoEnv(path.join(os.tmpdir(), "muon-absent-.env"), env)).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });
});
