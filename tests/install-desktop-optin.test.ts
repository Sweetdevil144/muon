/**
 * `curl | bash` installs the CLI, TUI and MCP server — and NOT the desktop app
 * unless asked.
 *
 * The asymmetry is the point and is easy to "tidy" back into symmetry by
 * someone reading only the ADR title, so it is pinned here. Installing the app
 * from a shell one-liner means downloading and mounting a ~671MB unsigned disk
 * image as a side effect of a command that reads as "install the CLI", on the
 * one platform that supports it, and ending with two copies of `muon` on the
 * machine — this one, maintained by `muon update`, and the app's own,
 * maintained by the in-app updater. The reverse direction still holds
 * unconditionally: the DMG always carries all three bins.
 *
 * These execute the REAL flag block sliced out of the shipped script rather
 * than a transcription of it, so the test cannot agree with a copy that has
 * drifted from what users actually run.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Root vitest runs from the repo root; read the script users actually get.
const SCRIPT = readFileSync(
  path.join(process.cwd(), "public/install.sh"),
  "utf8"
);

/** The shipped flag-parsing block, verbatim, with `fail` stubbed. */
function flagBlock(): string {
  const start = SCRIPT.indexOf("DO_CLI=1");
  expect(start, "flag block not found in install.sh").toBeGreaterThan(-1);
  const endMarker = 'fail "--no-desktop and --desktop-only together install nothing. Drop one."\nfi';
  const end = SCRIPT.indexOf(endMarker);
  expect(end, "flag guard not found in install.sh").toBeGreaterThan(start);
  return SCRIPT.slice(start, end + endMarker.length);
}

function parse(args: string[]): { cli: string; desktop: string; failed: boolean; stderr: string } {
  const script = [
    'fail() { printf "%s\\n" "$*" >&2; exit 3; }',
    flagBlock(),
    'printf "cli=%s desktop=%s\\n" "$DO_CLI" "$DO_DESKTOP"',
  ].join("\n");
  try {
    const out = execFileSync("bash", ["-c", script, "install.sh", ...args], {
      encoding: "utf8",
    });
    const m = out.match(/cli=(\d) desktop=(\d)/);
    return { cli: m![1], desktop: m![2], failed: false, stderr: "" };
  } catch (err) {
    const e = err as { stderr?: string };
    return { cli: "", desktop: "", failed: true, stderr: e.stderr ?? "" };
  }
}

describe("install.sh flags", () => {
  it("installs CLI/TUI/MCP and NOT the desktop app by default", () => {
    const r = parse([]);
    expect(r.cli).toBe("1");
    expect(r.desktop).toBe("0");
  });

  it("--desktop opts the app in", () => {
    expect(parse(["--desktop"])).toMatchObject({ cli: "1", desktop: "1" });
  });

  it("--no-desktop still works, because it is now what already happens", () => {
    // Someone's saved command line must not start failing on an unknown flag
    // just because the behaviour it asked for became the default.
    const r = parse(["--no-desktop"]);
    expect(r.failed).toBe(false);
    expect(r).toMatchObject({ cli: "1", desktop: "0" });
  });

  it("--desktop-only installs the app and skips the CLI half", () => {
    // It must turn the desktop ON, not merely turn the CLI off — with the app
    // now opt-in, inheriting the default would install nothing at all.
    expect(parse(["--desktop-only"])).toMatchObject({ cli: "0", desktop: "1" });
  });

  it("still refuses a combination that would install nothing", () => {
    const r = parse(["--desktop-only", "--no-desktop"]);
    expect(r.failed).toBe(true);
    expect(r.stderr).toContain("install nothing");
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    const r = parse(["--everything"]);
    expect(r.failed).toBe(true);
    expect(r.stderr).toContain("unknown flag");
    // The refusal must name the flag that now exists.
    expect(r.stderr).toContain("--desktop");
  });
});

describe("what the script says it does", () => {
  it("documents the desktop half as opt-in, not as a default", () => {
    expect(SCRIPT).toContain("ONLY when --desktop is passed");
    expect(SCRIPT).not.toContain("On macOS (unless --no-desktop)");
  });

  it("still installs all three bins in the CLI half", () => {
    for (const bin of ["muon", "muon-tui", "muon-mcp"]) {
      expect(SCRIPT).toContain(bin);
    }
  });
});

/**
 * The bash mirror of `hostSchemeRefusal` (@muon/client/download-host) — the
 * guard that gates the URL fed to `npm install -g`, whose lifecycle scripts
 * execute. The TypeScript half of the rule is tested in
 * apps/cli/tests/desktop-update.test.ts; the two copies the docstring pairs
 * as mirrors must carry symmetric protection (cubic pass-5 #2).
 */
describe("install.sh download-host https guard", () => {
  /** The shipped host block + guard, verbatim. The slice INCLUDES the real
   *  `fail()` definition (install.sh defines it between the assignment and
   *  the guard), which shadows the prepended stub — so refusals here exit 1
   *  with the production message. The stub only covers a future slice where
   *  the helpers move below the guard (cubic pass-6 #4). */
  function hostBlock(): string {
    const start = SCRIPT.indexOf('DOWNLOAD_HOST=');
    expect(start, "host assignment not found in install.sh").toBeGreaterThan(-1);
    const endMarker = "esac";
    const end = SCRIPT.indexOf(endMarker, start);
    expect(end, "https guard not found in install.sh").toBeGreaterThan(start);
    return SCRIPT.slice(start, end + endMarker.length);
  }

  function probe(host?: string): { failed: boolean; stderr: string; resolved: string } {
    const script = [
      'fail() { printf "%s\\n" "$*" >&2; exit 3; }',
      hostBlock(),
      'printf "host=%s\\n" "$DOWNLOAD_HOST"',
    ].join("\n");
    // A developer's exported MUON_DOWNLOAD_HOST must not leak into the
    // no-argument case (cubic pass-6 #2): "accepts the default" has to test
    // THE DEFAULT, deterministically, on every machine.
    const { MUON_DOWNLOAD_HOST: _ambient, ...cleanEnv } = process.env;
    try {
      const out = execFileSync("bash", ["-c", script, "install.sh"], {
        encoding: "utf8",
        env: { ...cleanEnv, ...(host ? { MUON_DOWNLOAD_HOST: host } : {}) },
      });
      const m = out.match(/host=(\S+)/);
      return { failed: false, stderr: "", resolved: m?.[1] ?? "" };
    } catch (err) {
      const e = err as { stderr?: string };
      return { failed: true, stderr: e.stderr ?? "", resolved: "" };
    }
  }

  it("refuses a plaintext MUON_DOWNLOAD_HOST before anything is fetched", () => {
    const r = probe("http://attacker.example");
    expect(r.failed).toBe(true);
    expect(r.stderr).toContain("not https");
  });

  it("refuses a non-URL host the same way", () => {
    expect(probe("ftp://x").failed).toBe(true);
    expect(probe("download.getmuon.com").failed).toBe(true);
  });

  it("accepts the default — and resolves it to the canonical host", () => {
    const r = probe();
    expect(r.failed).toBe(false);
    expect(r.resolved).toBe("https://download.getmuon.com");
  });

  it("accepts an https override", () => {
    const r = probe("https://staging.example.com");
    expect(r.failed).toBe(false);
    expect(r.resolved).toBe("https://staging.example.com");
  });

  it("the guard sits AFTER fail() is defined — a refusal must print, not die on a missing function", () => {
    // Line-anchored: a bare indexOf("fail() {") is satisfied by
    // `desktop_fail() {` too (cubic pass-6 #3).
    const failDef = SCRIPT.search(/^fail\(\) \{/m);
    const guard = SCRIPT.indexOf('case "$DOWNLOAD_HOST" in');
    expect(failDef).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(failDef);
  });
});
