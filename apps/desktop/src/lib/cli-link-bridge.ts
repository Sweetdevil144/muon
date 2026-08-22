/**
 * Main-process side of Settings -> Command Line Tools: the ONLY place this
 * feature touches a real filesystem. Mirrors mcp-bridge.ts's shape — pure
 * decision logic lives in cli-link.ts, this module supplies (and lets a test
 * replace) the IO, so the decision is provable without a real
 * `~/.local/bin` or a real .app bundle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLI_BIN_NAMES,
  cliEntryFile,
  cliResourcesDir,
  defaultCliBinDir,
  planLink,
  planUnlink,
  readLinkStatus,
  resolveAppBundlePath,
  type CliBinName,
  type CliLinkBinStatus,
  type ExistingBin,
} from "./cli-link.js";

export type CliLinkEntryResult =
  | { bin: CliBinName; targetPath: string; action: "written"; detail: "created" | "updated" }
  | { bin: CliBinName; targetPath: string; action: "already-linked" }
  | { bin: CliBinName; targetPath: string; action: "refused"; reason: string };

export type CliUnlinkEntryResult =
  | { bin: CliBinName; targetPath: string; action: "removed" }
  | { bin: CliBinName; targetPath: string; action: "absent" }
  | { bin: CliBinName; targetPath: string; action: "skipped"; reason: string };

export type CliLinkResult =
  | { kind: "unavailable"; reason: string }
  | { kind: "done"; binDir: string; entries: readonly CliLinkEntryResult[] };

export type CliUnlinkResult =
  | { kind: "unavailable"; reason: string }
  | { kind: "done"; binDir: string; entries: readonly CliUnlinkEntryResult[] };

export type CliLinkStatusReport =
  | { kind: "unavailable"; reason: string }
  | { kind: "ok"; binDir: string; bundlePath: string; entries: readonly CliLinkBinStatus[] };

export type CliLinkIo = {
  binDir: string;
  /** Absolute .app bundle root, or null when there is nothing to link
   *  against (an unpackaged/dev run). */
  bundlePath: string | null;
  /** Whether THIS build actually staged the three CLI entries — false for
   *  an app packaged before stage-cli.mjs shipped, or a dev `dir` build that
   *  skipped it. Checked as data, never assumed from `bundlePath` alone. */
  cliResourcesAvailable: boolean;
  readExisting: () => Record<CliBinName, ExistingBin>;
  writeShim: (targetPath: string, content: string) => void;
  removeShim: (targetPath: string) => void;
};

/**
 * The real IO. `isPackaged`/`resourcesPath` are Electron's own
 * `app.isPackaged`/`process.resourcesPath` — passed in rather than imported,
 * so this module (like mcp-bridge.ts's `defaultVendorIo`) never touches
 * `electron` itself and stays importable from a plain vitest run.
 */
export function defaultCliLinkIo(input: {
  resourcesPath: string;
  isPackaged: boolean;
  home?: string;
}): CliLinkIo {
  const home = input.home ?? os.homedir();
  const binDir = defaultCliBinDir(home);
  const bundlePath = input.isPackaged ? resolveAppBundlePath(input.resourcesPath) : null;
  const cliDir = bundlePath ? cliResourcesDir(bundlePath) : null;
  const cliResourcesAvailable = Boolean(
    cliDir &&
      CLI_BIN_NAMES.every((bin) => fs.existsSync(path.join(cliDir, cliEntryFile(bin))))
  );
  return {
    binDir,
    bundlePath,
    cliResourcesAvailable,
    readExisting: () => readExistingBins(binDir),
    writeShim: (targetPath, content) => {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
      // Random-suffixed temp name + rename: the same shape
      // mcp-vendor-config.ts's writeJsonPreservingMode uses, for the same
      // reason — a partial write must never leave a broken half-shim
      // sitting on PATH, and a predictable temp name is a planted-symlink
      // hazard in a shared bin dir.
      const tmp = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.muon.tmp`;
      fs.writeFileSync(tmp, content, { mode: 0o755 });
      fs.renameSync(tmp, targetPath);
    },
    removeShim: (targetPath) => {
      fs.rmSync(targetPath, { force: true });
    },
  };
}

function readExistingBins(binDir: string): Record<CliBinName, ExistingBin> {
  const result = {} as Record<CliBinName, ExistingBin>;
  for (const bin of CLI_BIN_NAMES) {
    const target = path.join(binDir, bin);
    if (!fs.existsSync(target)) {
      result[bin] = { exists: false };
      continue;
    }
    try {
      // Follows one level of symlink, same as exec would. Anything that is
      // not a plain file (a directory, a symlink to one, a broken link) is
      // "exists" with no content — planLink/planUnlink treat that as NOT
      // ours, which is the safe default for an ownership check.
      const stat = fs.statSync(target);
      result[bin] = stat.isFile()
        ? { exists: true, content: fs.readFileSync(target, "utf8") }
        : { exists: true };
    } catch {
      result[bin] = { exists: true };
    }
  }
  return result;
}

function unavailableReason(io: CliLinkIo): string | null {
  if (!io.bundlePath) {
    return "MUON is running from a source checkout, not a packaged app — there is no bundled CLI to link. Use `npm run cli:build && npm link --prefix apps/cli` instead (docs/install.md).";
  }
  if (!io.cliResourcesAvailable) {
    return `This build has no staged CLI at ${cliResourcesDir(io.bundlePath)}. Reinstall the latest MUON.app from https://getmuon.com/download.`;
  }
  return null;
}

/** Read-only: never writes. Safe to call every time Settings renders. */
export function readCliLinkStatus(io: CliLinkIo): CliLinkStatusReport {
  const reason = unavailableReason(io);
  if (reason) return { kind: "unavailable", reason };
  const entries = readLinkStatus({
    binDir: io.binDir,
    bundlePath: io.bundlePath as string,
    existing: io.readExisting(),
  });
  return { kind: "ok", binDir: io.binDir, bundlePath: io.bundlePath as string, entries };
}

/** Operator-initiated. Writes only what `planLink` decided to write. */
export function applyCliLink(io: CliLinkIo): CliLinkResult {
  const reason = unavailableReason(io);
  if (reason) return { kind: "unavailable", reason };
  const plan = planLink({
    binDir: io.binDir,
    bundlePath: io.bundlePath as string,
    existing: io.readExisting(),
  });
  const entries: CliLinkEntryResult[] = plan.entries.map((entry) => {
    if (entry.action === "write") {
      io.writeShim(entry.targetPath, entry.content);
      return {
        bin: entry.bin,
        targetPath: entry.targetPath,
        action: "written",
        detail: entry.reason === "absent" ? "created" : "updated",
      };
    }
    if (entry.action === "already-linked") {
      return { bin: entry.bin, targetPath: entry.targetPath, action: "already-linked" };
    }
    return {
      bin: entry.bin,
      targetPath: entry.targetPath,
      action: "refused",
      reason: entry.reason,
    };
  });
  return { kind: "done", binDir: io.binDir, entries };
}

/**
 * Operator-initiated undo. Deliberately NOT gated by `unavailableReason` —
 * removing a shim MUON recognizes as its own must keep working even from a
 * build with no staged CLI (e.g. after an update that dropped it), or the
 * one control that could clean up a stale link would itself refuse.
 */
export function applyCliUnlink(io: CliLinkIo): CliUnlinkResult {
  const plan = planUnlink({ binDir: io.binDir, existing: io.readExisting() });
  const entries: CliUnlinkEntryResult[] = plan.entries.map((entry) => {
    if (entry.action === "remove") {
      io.removeShim(entry.targetPath);
      return { bin: entry.bin, targetPath: entry.targetPath, action: "removed" };
    }
    if (entry.action === "absent") {
      return { bin: entry.bin, targetPath: entry.targetPath, action: "absent" };
    }
    return {
      bin: entry.bin,
      targetPath: entry.targetPath,
      action: "skipped",
      reason: entry.reason,
    };
  });
  return { kind: "done", binDir: io.binDir, entries };
}
