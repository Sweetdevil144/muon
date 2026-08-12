import { readFile } from "node:fs/promises";

/**
 * The CLI's own version, from the nearest owning package.json.
 *
 * Candidate walk instead of one fixed hop because the entry's position
 * differs per artifact: the dev/dist layout resolves two levels up
 * (dist/commands/*.js → apps/cli/package.json), while the published bundle is
 * a single muon.mjs with its manifest BESIDE it. A fixed `../../` walked the
 * npm install into node_modules/package.json — absent, so `muon version`
 * failed on exactly the artifact users install. Also the single source for
 * `--version`, which used to be a hardcoded literal one release bump away
 * from disagreeing with `muon version`.
 */
export async function readCliVersion(importMetaUrl: string): Promise<string> {
  for (const hop of ["./package.json", "../package.json", "../../package.json"]) {
    try {
      const manifest = JSON.parse(
        await readFile(new URL(hop, importMetaUrl), "utf8")
      ) as { name?: unknown; version?: unknown; bin?: unknown };
      // Only OUR manifest counts — the walk must never read a stray
      // node_modules/package.json and report someone else's version. "Ours"
      // is name-agnostic (the published name is a founder choice): any
      // manifest whose bin table exposes `muon`, plus the workspace name.
      const name = typeof manifest.name === "string" ? manifest.name : "";
      const bin = manifest.bin;
      const ours =
        name.startsWith("@muon") ||
        name === "muon-cli" ||
        (typeof bin === "object" && bin !== null && "muon" in bin);
      if (
        ours &&
        typeof manifest.version === "string" &&
        manifest.version.trim()
      ) {
        return manifest.version;
      }
    } catch {
      // try the next hop
    }
  }
  throw new Error("CLI package version is unavailable.");
}
