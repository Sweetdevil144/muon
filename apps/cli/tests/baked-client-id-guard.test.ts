import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs release script with no type declarations. The
// guard is deliberately JS: it runs inside `bundle-release.mjs`, which has no
// build step and must work from a bare checkout.
import { checkBakedClientId } from "../scripts/lib/client-id-guard.mjs";

/**
 * ADR-0052 — the client id is baked into TWO PUBLIC ARTIFACTS.
 *
 * `bundle-release.mjs` writes `process.env.MUON_GITHUB_CLIENT_ID` into
 * `release/package.json`, which goes to npm and into the tarball;
 * `apps/desktop/scripts/write-build-config.mjs` writes the same variable into
 * `staged/build-config.json`, which electron-builder lands inside the `.dmg`. A
 * GitHub App client id is a public identifier and belongs in both; a client
 * SECRET or an access token does not — and `MUON_GITHUB_CLIENT_SECRET` is seven
 * characters away from `MUON_GITHUB_CLIENT_ID` in a release script. The CLI
 * closed that hole; the desktop script baked the variable with no check at all,
 * so the artifact anybody can download and unpack still had it.
 *
 * These are BEHAVIOURAL tests of the guard, not a regex over its source: a
 * source-shape assertion would pass on a guard refactored into something that
 * returns `ok` for everything. The DESKTOP bundler's own half of this — that it
 * calls the guard, refuses the same shapes, and writes nothing when it does —
 * lives with that script, in `apps/desktop/tests/build-config.test.ts`.
 */

const check = checkBakedClientId as (
  raw: string | undefined
) =>
  | { ok: true; clientId: string; warning?: string }
  | { ok: false; reason: string };

describe("checkBakedClientId — a credential must never reach the manifest", () => {
  it("refuses every GitHub ACCESS TOKEN family, and names the prefix", () => {
    const tokens = {
      "ghp_": `ghp_${"A".repeat(36)}`,
      "gho_": `gho_${"B".repeat(36)}`,
      "ghu_": `ghu_${"C".repeat(36)}`,
      "ghs_": `ghs_${"D".repeat(36)}`,
      "ghr_": `ghr_${"E".repeat(36)}`,
      github_pat_: `github_pat_${"F".repeat(22)}`,
    };
    for (const [prefix, value] of Object.entries(tokens)) {
      const result = check(value);
      expect(result.ok, `${prefix} must be refused`).toBe(false);
      if (result.ok) continue;
      // The message has to say WHAT it is, or the operator will assume the guard
      // is being fussy about length and work around it.
      expect(result.reason, prefix).toContain(prefix);
      expect(result.reason, prefix).toContain("ACCESS TOKEN");
      // And that it would have been PUBLISHED — the consequence is the part that
      // makes an operator revoke rather than retry.
      expect(result.reason, prefix).toContain("published");
      expect(result.reason, prefix).toContain("Revoke it");
    }
  });

  it("refuses the 40-hex GitHub App client SECRET — the exact wrong-variable mistake", () => {
    const result = check("0123456789abcdef0123456789abcdef01234567");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("client SECRET");
    expect(result.reason).toContain("wrong variable");
  });

  it("refuses whitespace and trailing newlines rather than trimming them", () => {
    // `MUON_GITHUB_CLIENT_ID=$(cat id.txt)` is the accident. Trimming it would
    // bake a value the operator never actually looked at.
    for (const value of [
      "Iv1.0123456789abcdef\n",
      " Iv1.0123456789abcdef",
      "Iv1.0123 456789abcdef",
      "Iv1.0123456789abcdef\t",
    ]) {
      const result = check(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.reason).toContain("whitespace");
    }
  });

  it("refuses control characters", () => {
    // Built, not pasted: a raw control byte here made this whole file
    // unsearchable (`grep` calls it binary), so the guard it covers stopped
    // being findable by anything but a path.
    const result = check(`Iv1.0123456789ab${String.fromCharCode(0)}ef`);
    expect(result.ok).toBe(false);
  });

  it("refuses overlong and too-short values", () => {
    for (const value of ["Iv1.", "abc", "z".repeat(65), "z".repeat(400)]) {
      const result = check(value);
      expect(result.ok, value.slice(0, 12)).toBe(false);
    }
  });

  it("refuses characters no client id uses", () => {
    for (const value of ["Iv1.abcdef1234567890;rm -rf /", "id@example.com!!"]) {
      const result = check(value);
      expect(result.ok, value).toBe(false);
    }
  });
});

describe("checkBakedClientId — a legitimate release still ships", () => {
  it("accepts every client-id shape GitHub has issued, with NO warning", () => {
    for (const value of [
      "Iv1.0123456789abcdef", // GitHub App
      // GitHub App (newer), 20 characters — `Iv23li` + 14. THE SHAPE THE REAL App
      // uses, and the one this guard warned about: the pattern was pinned at
      // exactly 16 trailing characters, so the correct client id of the App the
      // whole gate is built on came back "does not match any GitHub client-id
      // shape this guard knows". A warning on every correct release is a warning
      // an operator has learned to ignore by the time it means something.
      "Iv23liAbCdEfGhIjKlMn",
      "Iv23liAbCdEf0123456789", // GitHub App (newer), 22 — the older length
      "Ov23liAbCdEf01234567", // OAuth app (newer)
      "0123456789abcdef0123", // OAuth app (classic, 20 hex)
    ]) {
      const result = check(value);
      expect(result.ok, value).toBe(true);
      if (!result.ok) continue;
      expect(result.clientId).toBe(value);
      // SILENT is the assertion. `ok: true` was already true for the real id —
      // it passed WITH the warning, which is the defect.
      expect(result.warning, value).toBeUndefined();
    }
  });

  it("widening the App shape refused nothing — every credential shape still fails", () => {
    // The range that fixed the false alarm spans 20–28 characters, so this pins
    // that nothing walked in behind it. None of these is blocked by the shape
    // list in the first place: the refusals above it are.
    for (const value of [
      `gho_${"B".repeat(36)}`,
      "0123456789abcdef0123456789abcdef01234567", // 40-hex App client SECRET
      `Iv23li${"A".repeat(23)}`, // 29 — past the range, and still safe-charset
      "Iv23liAbCdEfGhIjKl", // 18 — short of the range
    ]) {
      const result = check(value);
      if (value.startsWith("Iv23li")) {
        // Out of the KNOWN range is not a refusal — it is the documented
        // pass-with-warning, because GitHub has changed this length before.
        expect(result.ok, value).toBe(true);
        if (result.ok) expect(result.warning, value).toBeTruthy();
        continue;
      }
      expect(result.ok, value).toBe(false);
    }
  });

  it("EMPTY is fine — an ungated release is a supported outcome", () => {
    // ADR-0052 Decision 2: a distributed build with no client id degrades
    // UNGATED and logs the release defect. Refusing here would fail a build for
    // a state the ADR explicitly allows.
    for (const value of ["", "   ", undefined]) {
      const result = check(value);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.clientId).toBe("");
    }
  });

  it("an UNRECOGNISED but safe shape passes with a loud warning, not a refusal", () => {
    // GitHub has changed this format twice. Blocking a legitimate release over a
    // format change is the worse failure — but it must not be silent.
    const result = check("Xy9.some-future-format_01");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain("does not match any GitHub client-id shape");
    expect(result.warning).toContain("WILL be baked");
  });
});

/**
 * WIRING EXCEPTION — the CLI bundler is asserted about as TEXT, and cannot be
 * anything else: `bundle-release.mjs` `rm -rf`s the operator's `release/` at
 * import time, so importing it to drive it would destroy the thing under test.
 * The desktop bundler's half IS behavioural, in `apps/desktop/tests/build-config.test.ts`,
 * precisely because that script was restructured to be importable. Doing the same
 * to this one would let these three become behaviour tests too.
 */
describe("the bundler actually uses the guard, and uses it FIRST", () => {
  const script = fs.readFileSync(
    path.join(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
      "scripts",
      "bundle-release.mjs"
    ),
    "utf8"
  );

  it("refuses before it destroys the operator's existing release/", () => {
    // Ordering is the behaviour: a guard that throws AFTER `rmSync(releaseDir)`
    // has already cost the operator the artifact they had.
    const guardAt = script.indexOf("checkBakedClientId(process.env.MUON_GITHUB_CLIENT_ID)");
    const rmAt = script.indexOf("rmSync(releaseDir");
    expect(guardAt).toBeGreaterThan(-1);
    expect(rmAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(rmAt);
  });

  it("throws on a refusal rather than warning and continuing", () => {
    const guarded = script.slice(
      script.indexOf("const clientIdCheck ="),
      script.indexOf("const releaseDir")
    );
    expect(guarded).toContain("if (!clientIdCheck.ok)");
    expect(guarded).toContain("throw new Error(");
  });

  it("bakes only the value the guard returned, never the raw env", () => {
    // The one way this guard gets defeated: reading the environment a second
    // time at the manifest write.
    const manifest = script.slice(script.indexOf("writeFileSync("));
    expect(manifest).not.toContain("process.env.MUON_GITHUB_CLIENT_ID");
    expect(manifest).toContain("muonGitHubClientId: bakedClientId");
  });
});
