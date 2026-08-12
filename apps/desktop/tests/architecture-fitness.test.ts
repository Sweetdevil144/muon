import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P11 — architecture-fitness: every write to the governed control surfaces
 * from CLI / TUI / Desktop must go through `MuonApiClient`. A ninth raw
 * `fetch("/api/approvals"|dispatch|fleet|workflow-runs/.../apply")` is how the
 * TUI reject and `{...spread}` widening bugs landed; behavioural tests cannot
 * see a new call site.
 *
 * Technique: source-as-text walk (same class as quickstart-optin.test.ts).
 */

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(DESKTOP_ROOT, "../..");
const SURFACE_SRC = [
  join(DESKTOP_ROOT, "../cli/src"),
  join(DESKTOP_ROOT, "../tui/src"),
  join(DESKTOP_ROOT, "src"),
];

/** Paths that may still talk HTTP without MuonApiClient. */
const ALLOWLIST = [
  // Unauthenticated brain adoption probe — never a governed write.
  "apps/desktop/src/lib/brain.ts",
];

const FORBIDDEN =
  /fetch\s*\(\s*[`'"][^`'"]*\/api\/(approvals|dispatch|fleet|workflow-runs\/[^`'"]*\/apply)/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "tests" ||
      entry.endsWith(".test.ts") ||
      entry.endsWith(".test.tsx")
    ) {
      continue;
    }
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("P11 architecture-fitness: governed writes use MuonApiClient", () => {
  it("renderer runtime imports avoid Node aggregate package barrels", () => {
    const rendererRoot = join(DESKTOP_ROOT, "src/renderer");
    const offenders: string[] = [];
    for (const file of walkTsFiles(rendererRoot)) {
      const source = readFileSync(file, "utf8");
      const imports = source.matchAll(/(?:^|\n)import\s+([\s\S]*?);/g);
      for (const match of imports) {
        const statement = match[1]!;
        if (
          /from\s+["']@muon\/(?:client|core)["']/.test(statement) &&
          !statement.trimStart().startsWith("type ")
        ) {
          offenders.push(relative(REPO_ROOT, file).replace(/\\/g, "/"));
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("no surface issues a raw fetch to approvals/dispatch/fleet/workflow apply", () => {
    const offenders: string[] = [];
    for (const root of SURFACE_SRC) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        if (ALLOWLIST.some((a) => rel.endsWith(a))) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        if (FORBIDDEN.test(source)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("MuonApiClient construction sites stay in the known factory set", () => {
    const sites: string[] = [];
    for (const root of SURFACE_SRC) {
      for (const file of walkTsFiles(root)) {
        const source = readFileSync(file, "utf8");
        if (!/new\s+MuonApiClient\s*\(/.test(source)) {
          continue;
        }
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        sites.push(rel);
      }
    }
    // Production factories only — tests live under */tests and are skipped above.
    expect(sites.sort()).toEqual(
      [
        "apps/cli/src/commands/runner.ts",
        "apps/cli/src/index.ts",
        "apps/desktop/src/main.ts",
        "apps/desktop/src/runner-entry.ts",
        "apps/tui/src/index.tsx",
    // The ADR-0046 shell's preview entry — the third TUI entry, constructing
    // the client exactly as the other two do (startup-resolved base + token).
    "apps/tui/src/shell/index.ts",
        // ADR-0042: the new desk's entry mirrors the classic TUI bootstrap
        // (same brain resolution, same client factory) until retirement.
        "apps/tui/src/next/index.tsx",
      ].sort()
    );
  });

  it("desktop brain health probe stays the only allowlisted raw fetch", () => {
    const brain = readFileSync(join(DESKTOP_ROOT, "src/lib/brain.ts"), "utf8");
    expect(brain).toMatch(/\$\{base\}\/health|\/health/);
    expect(brain).not.toMatch(/\/api\/(approvals|dispatch|fleet)/);
  });
});
