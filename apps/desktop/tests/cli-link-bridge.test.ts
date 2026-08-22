import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCliLink,
  applyCliUnlink,
  defaultCliLinkIo,
  readCliLinkStatus,
} from "../src/lib/cli-link-bridge.js";
import { CLI_BIN_NAMES, isMuonOwnedShim } from "../src/lib/cli-link.js";

/**
 * Settings -> Command Line Tools, main-process IO. Real filesystem, but
 * entirely inside a fresh mkdtemp — never the operator's own `~/.local/bin`
 * or a real `/Applications`, same safety shape `mcp-bridge.test.ts` uses for
 * `~/.claude`/`~/.codex`/etc.
 */

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** A fake packaged app: <root>/MUON.app/Contents/Resources/cli/{...}.mjs */
function fakeBundle(root: string, stageCli = true): { resourcesPath: string; bundlePath: string } {
  const bundlePath = path.join(root, "MUON.app");
  const resourcesPath = path.join(bundlePath, "Contents", "Resources");
  const cliDir = path.join(resourcesPath, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  if (stageCli) {
    for (const bin of CLI_BIN_NAMES) {
      fs.writeFileSync(path.join(cliDir, `${bin}.mjs`), "#!/usr/bin/env node\n", { mode: 0o755 });
    }
  }
  return { resourcesPath, bundlePath };
}

describe("defaultCliLinkIo — availability", () => {
  it("is unavailable when not packaged (dev/source run)", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: false, home });
    expect(readCliLinkStatus(io)).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("source checkout"),
    });
  });

  it("is unavailable when packaged but the build staged no CLI", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"), /* stageCli */ false);
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    const status = readCliLinkStatus(io);
    expect(status.kind).toBe("unavailable");
    if (status.kind === "unavailable") {
      expect(status.reason).toContain("no staged CLI");
    }
  });

  it("is available when packaged with a fully staged CLI", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath, bundlePath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    const status = readCliLinkStatus(io);
    expect(status).toEqual({
      kind: "ok",
      binDir: path.join(home, ".local", "bin"),
      bundlePath,
      entries: CLI_BIN_NAMES.map((bin) => ({
        bin,
        targetPath: path.join(home, ".local", "bin", bin),
        state: "absent",
      })),
    });
  });
});

describe("applyCliLink — writes real shims", () => {
  it("creates three executable shims at ~/.local/bin, each carrying the marker and execing the right entry", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath, bundlePath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });

    const result = applyCliLink(io);
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.entries).toHaveLength(3);
    for (const entry of result.entries) {
      expect(entry.action).toBe("written");
    }

    const binDir = path.join(home, ".local", "bin");
    for (const bin of CLI_BIN_NAMES) {
      const target = path.join(binDir, bin);
      const content = fs.readFileSync(target, "utf8");
      expect(isMuonOwnedShim(content)).toBe(true);
      expect(content).toContain(bundlePath);
      expect(content).toContain(`cli/${bin}.mjs`);
      // Executable.
      const mode = fs.statSync(target).mode & 0o777;
      expect(mode & 0o100).toBe(0o100);
    }
  });

  it("is idempotent: a second link with nothing changed reports already-linked and rewrites nothing", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    applyCliLink(io);
    const target = path.join(home, ".local", "bin", "muon");
    const before = fs.statSync(target).mtimeMs;

    const second = applyCliLink(io);
    expect(second.kind).toBe("done");
    if (second.kind === "done") {
      for (const entry of second.entries) expect(entry.action).toBe("already-linked");
    }
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  it("refuses to overwrite a foreign binary at the target path (a tarball install), leaves it byte-for-byte, and still links the other two", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const foreignContent = "#!/usr/bin/env node\n// npm-installed muon-cli\n";
    fs.writeFileSync(path.join(binDir, "muon"), foreignContent, { mode: 0o755 });

    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    const result = applyCliLink(io);
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;

    const muonEntry = result.entries.find((e) => e.bin === "muon")!;
    expect(muonEntry.action).toBe("refused");
    expect(fs.readFileSync(path.join(binDir, "muon"), "utf8")).toBe(foreignContent);

    expect(result.entries.find((e) => e.bin === "muon-tui")!.action).toBe("written");
    expect(fs.existsSync(path.join(binDir, "muon-tui"))).toBe(true);
  });

  it("re-links (updates) a MUON-owned shim after the app moved", () => {
    const home = tempDir("muon-cli-link-home-");
    const oldApp = tempDir("muon-cli-link-app-old-");
    const { resourcesPath: oldResources } = fakeBundle(oldApp);
    const io1 = defaultCliLinkIo({ resourcesPath: oldResources, isPackaged: true, home });
    applyCliLink(io1);

    const newApp = tempDir("muon-cli-link-app-new-");
    const { resourcesPath: newResources, bundlePath: newBundle } = fakeBundle(newApp);
    const io2 = defaultCliLinkIo({ resourcesPath: newResources, isPackaged: true, home });
    const result = applyCliLink(io2);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      for (const entry of result.entries) {
        expect(entry.action).toBe("written");
        if (entry.action === "written") expect(entry.detail).toBe("updated");
      }
    }
    const content = fs.readFileSync(path.join(home, ".local", "bin", "muon"), "utf8");
    expect(content).toContain(newBundle);
  });
});

describe("applyCliUnlink — undo", () => {
  it("removes exactly what link wrote", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    applyCliLink(io);

    const result = applyCliUnlink(io);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      for (const entry of result.entries) expect(entry.action).toBe("removed");
    }
    for (const bin of CLI_BIN_NAMES) {
      expect(fs.existsSync(path.join(home, ".local", "bin", bin))).toBe(false);
    }
  });

  it("leaves a foreign file in place and reports it skipped", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "muon-mcp"), "not muon's", { mode: 0o755 });

    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    const result = applyCliUnlink(io);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.entries.find((e) => e.bin === "muon-mcp")!.action).toBe("skipped");
    }
    expect(fs.readFileSync(path.join(binDir, "muon-mcp"), "utf8")).toBe("not muon's");
  });

  it("works even when the CURRENT build has no staged CLI (unlink is not gated on availability)", () => {
    const home = tempDir("muon-cli-link-home-");
    const oldApp = tempDir("muon-cli-link-app-old-");
    const { resourcesPath: oldResources } = fakeBundle(oldApp);
    applyCliLink(defaultCliLinkIo({ resourcesPath: oldResources, isPackaged: true, home }));

    const { resourcesPath: barePath } = fakeBundle(tempDir("muon-cli-link-app-bare-"), false);
    const bareIo = defaultCliLinkIo({ resourcesPath: barePath, isPackaged: true, home });
    expect(readCliLinkStatus(bareIo).kind).toBe("unavailable");

    const result = applyCliUnlink(bareIo);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      for (const entry of result.entries) expect(entry.action).toBe("removed");
    }
  });

  it("is a clean no-op (all absent) when nothing was ever linked", () => {
    const home = tempDir("muon-cli-link-home-");
    const { resourcesPath } = fakeBundle(tempDir("muon-cli-link-app-"));
    const io = defaultCliLinkIo({ resourcesPath, isPackaged: true, home });
    const result = applyCliUnlink(io);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      for (const entry of result.entries) expect(entry.action).toBe("absent");
    }
  });
});
