// Builds the PUBLISHABLE npm artifact for the muon CLI + TUI + MCP server.
//
// @muon/cli, @muon/tui and @muon/mcp are workspace-private: their @muon/* deps
// are `file:` links that npm cannot install from the registry. This script
// bundles the ENTIRE @muon/* closure of each entry into one file with esbuild
// and emits release/ as a self-contained npm package (bins: `muon`,
// `muon-tui`, `muon-mcp`) whose only dependencies are real registry packages
// (commander, zod, @modelcontextprotocol/sdk, @anthropic-ai/claude-agent-sdk —
// the SDK ships platform binaries it resolves relative to itself, so it must
// NEVER be bundled — plus ink and react for the TUI).
//
// Usage:  node scripts/bundle-release.mjs [--name muon-cli] [--version X.Y.Z]
// Output: apps/cli/release/  →  `cd release && npm publish --access public`
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBakedClientId } from "./lib/client-id-guard.mjs";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const own = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
const name = argValue("--name", "muon-cli");
const version = argValue("--version", own.version);

// ADR-0052 — THE BAKE IS CHECKED FIRST, before anything is built or deleted.
//
// This manifest is PUBLISHED. `MUON_GITHUB_CLIENT_ID` and
// `MUON_GITHUB_CLIENT_SECRET` are seven characters apart, and whatever was in the
// variable used to go straight into a world-readable `release/package.json` and
// the npm tarball with no check at all — permanently, in a version that cannot be
// unpublished after 72 hours. See scripts/lib/client-id-guard.mjs for the policy
// and why it lives in its own module.
//
// Placed HERE rather than beside the manifest write for one reason: the `rmSync`
// below destroys the operator's existing `release/`. A guard that refuses after
// that has already cost them the artifact they had.
const clientIdCheck = checkBakedClientId(process.env.MUON_GITHUB_CLIENT_ID);
if (!clientIdCheck.ok) {
  // THROW. A refusal here costs a release; the alternative costs a credential.
  throw new Error(
    `[bundle-release] refusing to bake a client id: ${clientIdCheck.reason}`
  );
}
if (clientIdCheck.warning) {
  console.warn(`[bundle-release] ${clientIdCheck.warning}`);
}

const EXTERNALS = [
  "commander",
  "zod",
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
];
// The TUI's own registry deps. node-pty is a NATIVE module (prebuilt
// binaries + a spawn-helper) that cannot survive single-file bundling —
// external, installed from the registry. (ink/react left with the Ink
// desks — ADR-0087 D4.)
const TUI_EXTERNALS = [...EXTERNALS, "node-pty"];
const tuiRoot = join(cliRoot, "..", "tui");
const mcpRoot = join(cliRoot, "..", "..", "packages", "mcp");

// The published manifest's own `npm test`. A backtick template, so the inner
// single and double quotes are literal and the command is readable — an
// escaped one-line string was, and it made the check unreadable and untestable.
//
// `muon-mcp.mjs` is IMPORTED, not parse-checked and not run. Both rejected
// alternatives are measured, not guessed:
//  - `node muon-mcp.mjs` starts a stdio server and hands a handshake to an
//    `npm test` that speaks no JSON-RPC.
//  - `node --check` is syntax only, and the two failures that actually shipped
//    were both TOP-LEVEL RUNTIME throws (an inlined native addon's `require`,
//    an unresolvable `gitnexus`). It passed on a bundle that could not boot.
// Importing evaluates the whole module graph and starts nothing: the
// `isDirectRun` guard reads `process.argv[1]`, which `node -e` leaves unset.
const MANIFEST_TEST = [
  "node muon.mjs --version",
  "node --check muon-tui.mjs",
  `node -e "import('./muon-mcp.mjs').then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })"`,
].join(" && ");

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

// Second entry: the TUI — the shell desk, the ONE desk (ADR-0087 D4).
// Same ESM shape; its entry carries its own shebang.
execFileSync(
  esbuild,
  [
    join(tuiRoot, "src", "shell", "index.ts"),
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

// The desk's vendored terminal layer (pi-tui) carries OPTIONAL native
// helpers (Darwin modifier detection); its loader walks candidates and the
// second is `native/...` BESIDE the running entry. Absent, the load degrades
// silently to "no modifier held" — a silent capability loss the degrade-
// stated rule forbids shipping on purpose — so the prebuilds ride beside
// `muon-tui.mjs` and the manifest `files` list names the directory.
cpSync(
  join(tuiRoot, "src", "vendor", "pi-tui", "native", "darwin", "prebuilds"),
  join(releaseDir, "native", "darwin", "prebuilds"),
  { recursive: true }
);

// Third entry: `muon-mcp`, the stdio MCP server every vendor CLI spawns.
//
// IT USED TO BE MISSING, and the hole was invisible from a dev checkout. A
// tarball-installed user had no `muon-mcp` anywhere, so `muon mcp install`
// refused with `muonMcpUnresolvedRefusal` — whose copy tells them to "install
// the MUON CLI package (which ships both the 'muon' and 'muon-mcp' bins)",
// which was the package they had just installed. It only ever resolved on a
// machine with a dev-checkout symlink on PATH.
//
// Same EXTERNALS as the CLI, not the TUI's: the @muon/* closure of
// packages/mcp reaches no registry package beyond @modelcontextprotocol/sdk
// (gitnexus is invoked as a subprocess binary, and the PostHog wrapper was
// removed with MCP telemetry). packages/mcp/src/index.ts carries its own
// shebang, and its `isDirectRun` guard matches an argv[1] ending in
// `muon-mcp` — which is the npm bin name, so the installed link starts the
// server while `import`ing the file still does not.
execFileSync(
  esbuild,
  [
    join(mcpRoot, "src", "index.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--minify",
    `--outfile=${join(releaseDir, "muon-mcp.mjs")}`,
    ...EXTERNALS.map((pkg) => `--external:${pkg}`),
  ],
  { stdio: "inherit" }
);
chmodSync(join(releaseDir, "muon-mcp.mjs"), 0o755);

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
  // Last, so it never changes which version the CLI/TUI entries already pin —
  // it only supplies @modelcontextprotocol/sdk in a checkout where apps/cli
  // does not own a copy.
  mcpRoot,
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

// THE CODE GRAPH SHIPS WITH THE INSTALL (founder, 2026-08-19). `gitnexus` is
// spawned as a subprocess binary, never imported, so it is not an esbuild
// external — but every installed surface resolves it from the install's own
// node_modules: `resolveGitNexus` (CLI) and `resolveBundledGitNexusCli`
// (muon-mcp) both `require.resolve("gitnexus/package.json")` relative to the
// installed entry. Without this dependency NO installed channel had a code
// graph at all: the desktop showed "GitNexus CLI not found", RE-INDEX refused,
// and every muon-mcp code-graph tool refused per call.
//
// It ships as an OPTIONAL dependency, deliberately: gitnexus carries native
// parsers (tree-sitter × 12 grammars) and an ONNX runtime, and a machine
// whose toolchain cannot build one of them must still get a working MUON —
// `optionalDependencies` materializes the package wherever it CAN install and
// lets `npm install -g` succeed where it cannot, which is exactly the
// fail-open posture the resolvers already assume (absence is a legible
// per-call refusal, never a broken install).
//
// Pinned EXACT to the version the workspace tested with (packages/mcp pins it
// the same way): a caret here would let a fresh install resolve a newer
// gitnexus than any test in this repository has ever run against.
let gitnexusManifest;
try {
  gitnexusManifest = JSON.parse(
    readFileSync(
      join(mcpRoot, "node_modules", "gitnexus", "package.json"),
      "utf8"
    )
  );
} catch {
  // readFileSync throws BEFORE any shape check can run — this is the actual
  // missing-install case the message describes.
  throw new Error(
    "cannot resolve the gitnexus version from packages/mcp — run npm install there first"
  );
}
if (!gitnexusManifest?.version) {
  throw new Error("packages/mcp's gitnexus manifest names no version");
}

// ADR-0052 — THE DISTRIBUTED BAKE.
//
// The identity gate arms on a build/deployment property, never on a literal in
// source. This manifest is that property: `muonDistributed: true` is written
// only here, so an artifact somebody INSTALLED carries it and a dev checkout or
// `npm link` never can. `readDistributionBake` (@muon/client) reads it back
// from the manifest sitting beside muon.mjs.
//
// The client id rides along from the release environment because the CLI runs
// the device flow through a brain it spawns itself; a GitHub App client id is a
// public identifier, not a secret. Absent, the release still publishes — and
// degrades UNGATED at runtime while logging the release defect, because a gate
// whose door does not exist must not lock.
// Already validated at the top of this script, before anything was deleted.
const bakedClientId = clientIdCheck.clientId;
if (!bakedClientId) {
  console.warn(
    "[bundle-release] MUON_GITHUB_CLIENT_ID is unset — this artifact will run UNGATED (ADR-0052 degrade-ungated rule). Set it to ship a gated release."
  );
}

// The licence the manifest points at, copied from the repository root so the
// published artifact carries its own terms.
copyFileSync(join(cliRoot, "..", "..", "LICENSE"), join(releaseDir, "LICENSE"));

writeFileSync(
  join(releaseDir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version,
      muonDistributed: true,
      ...(bakedClientId ? { muonGitHubClientId: bakedClientId } : {}),
      description:
        "MUON — a local-first governed control plane for coding-agent CLIs (Claude Code, Codex, Cursor, OpenCode).",
      license: "SEE LICENSE IN LICENSE",
      bin: {
        muon: "muon.mjs",
        "muon-tui": "muon-tui.mjs",
        // ADR-0052 arms off THIS manifest: `readDistributionBake` walks up
        // from the running entry, and `muon-mcp.mjs` sits beside it. Shipping
        // the bin is therefore also what arms the MCP half of the gate.
        "muon-mcp": "muon-mcp.mjs",
      },
      // LICENSE is SHIPPED, not merely named. The manifest says
      // `SEE LICENSE IN LICENSE`, and npm publishes exactly `files` — so
      // without this the tarball pointed at a document it did not contain, and
      // every install carried a licence claim nobody could read.
      files: ["muon.mjs", "muon-tui.mjs", "muon-mcp.mjs", "native", "LICENSE"],
      // A real check for this manifest: the seeded-harness-coverage
      // invariant requires every manifest that owns files to be verifiable.
      // See MANIFEST_TEST for why each bin is checked the way it is.
      scripts: { test: MANIFEST_TEST },
      engines: { node: ">=20" },
      dependencies: externalVersions,
      // Optional so a toolchain-less machine still installs MUON — see the
      // resolution note above `gitnexusManifest`. Exact pin.
      optionalDependencies: { gitnexus: gitnexusManifest.version },
      homepage: "https://getmuon.com",
    },
    null,
    2
  )}\n`
);

console.log(
  `[bundle-release] wrote ${releaseDir} (${name}@${version}); publish with: cd apps/cli/release && npm publish --access public`
);
