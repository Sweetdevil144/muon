// Builds the PUBLISHABLE npm artifact for the muon CLI + TUI.
//
// @muon/cli and @muon/tui are workspace-private: their @muon/* deps are
// `file:` links that npm cannot install from the registry. This script bundles
// the ENTIRE @muon/* closure of each entry into one file with esbuild and
// emits release/ as a self-contained npm package (bins: `muon`, `muon-tui`)
// whose only dependencies are real registry packages (commander, zod,
// @modelcontextprotocol/sdk, @anthropic-ai/claude-agent-sdk — the SDK ships
// platform binaries it resolves relative to itself, so it must NEVER be
// bundled — plus ink and react for the TUI).
//
// Usage:  node scripts/bundle-release.mjs [--name muon-cli] [--version X.Y.Z]
// Output: apps/cli/release/  →  `cd release && npm publish --access public`
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const own = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
const name = argValue("--name", "muon-cli");
const version = argValue("--version", own.version);

const EXTERNALS = [
  "commander",
  "zod",
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
];
// The TUI's own registry deps. Kept external (registry-installable) rather
// than bundled: ink's yoga layout engine loads a wasm asset relative to the
// package, which does not survive single-file bundling.
const TUI_EXTERNALS = [...EXTERNALS, "ink", "react"];
const tuiRoot = join(cliRoot, "..", "tui");

const releaseDir = join(cliRoot, "release");
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// esbuild, resolved from THIS package first.
//
// It used to be taken only from apps/desktop's devDependencies — "rather than
// adding a second install" — which quietly made building the CLI release
// require the desktop's entire Electron dependency tree. That is fine in a
// full checkout and wrong for anyone who only wants the CLI, so it now
// declares its own and falls back to the desktop copy for older checkouts.
const esbuildCandidates = [
  join(cliRoot, "node_modules", ".bin", "esbuild"),
  join(cliRoot, "..", "..", "node_modules", ".bin", "esbuild"),
  join(cliRoot, "..", "desktop", "node_modules", ".bin", "esbuild"),
];
const esbuild = esbuildCandidates.find((candidate) => existsSync(candidate));
if (!esbuild) {
  throw new Error(
    `esbuild not found. Looked in:\n  ${esbuildCandidates.join("\n  ")}\n` +
      "Run `npm install` in apps/cli."
  );
}

// ESM output, `.mjs` entry: the @muon/* closure is ESM and reads
// `import.meta.url` (a CJS bundle leaves that undefined and dies at boot).
// src/index.ts carries its own shebang, which esbuild preserves at line 1.
execFileSync(
  esbuild,
  [
    join(cliRoot, "src", "index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--minify",
    `--outfile=${join(releaseDir, "muon.mjs")}`,
    ...EXTERNALS.map((pkg) => `--external:${pkg}`),
  ],
  { stdio: "inherit" }
);
chmodSync(join(releaseDir, "muon.mjs"), 0o755);

// Second entry: the TUI. Same ESM shape; its entry carries its own shebang.
execFileSync(
  esbuild,
  [
    join(tuiRoot, "src", "index.tsx"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--jsx=automatic",
    "--minify",
    `--outfile=${join(releaseDir, "muon-tui.mjs")}`,
    ...TUI_EXTERNALS.map((pkg) => `--external:${pkg}`),
  ],
  { stdio: "inherit" }
);
chmodSync(join(releaseDir, "muon-tui.mjs"), 0o755);

// Pin externals to the versions the workspace actually tested with. Direct
// node_modules probing, not require.resolve: modern exports maps block
// `<pkg>/package.json` subpath resolution (commander does), and an
// exports-mapped resolve can land on a nested dist/*/package.json with no
// version. The file: workspace layout hoists each dep into its owner.
const externalVersions = {};
const OWNER_DIRS = [
  cliRoot,
  tuiRoot,
  join(cliRoot, "..", "..", "packages", "client"),
  join(cliRoot, "..", "..", "packages", "adapters"),
  join(cliRoot, "..", "..", "packages", "protocol"),
  join(cliRoot, "..", ".."),
];
for (const pkg of TUI_EXTERNALS) {
  let manifest;
  for (const owner of OWNER_DIRS) {
    try {
      manifest = JSON.parse(
        readFileSync(join(owner, "node_modules", pkg, "package.json"), "utf8")
      );
      break;
    } catch {
      // try the next owner
    }
  }
  if (!manifest?.version) {
    throw new Error(`cannot resolve external dependency version for ${pkg}`);
  }
  externalVersions[pkg] = `^${manifest.version}`;
}

writeFileSync(
  join(releaseDir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version,
      description:
        "MUON — a local-first governed control plane for coding-agent CLIs (Claude Code, Codex, Cursor, OpenCode).",
      license: "SEE LICENSE IN LICENSE",
      bin: { muon: "muon.mjs", "muon-tui": "muon-tui.mjs" },
      files: ["muon.mjs", "muon-tui.mjs"],
      // A real check for this manifest: the seeded-harness-coverage
      // invariant requires every manifest that owns files to be verifiable.
      scripts: {
        test: "node muon.mjs --version && node --check muon-tui.mjs",
      },
      engines: { node: ">=20" },
      dependencies: externalVersions,
      homepage: "https://getmuon.com",
    },
    null,
    2
  )}\n`
);

console.log(
  `[bundle-release] wrote ${releaseDir} (${name}@${version}); publish with: cd apps/cli/release && npm publish --access public`
);
