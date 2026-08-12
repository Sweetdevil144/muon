import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as ptySpawn } from "node-pty";

/**
 * THE SMOKE TEST THAT RUNS THE COMPILED ENTRY.
 *
 * `npm run tui:shell` shipped with TWO stacked startup crashes — an ESM
 * interop failure (`@xterm/headless` has no exports map, so Node cannot see
 * `Terminal` as a named export of its UMD bundle) and a TDZ ReferenceError —
 * while every suite stayed green and every typecheck passed. Vitest's
 * vite-node does its own CJS interop, TypeScript does not flag a TDZ behind a
 * closure, and the stale dist happened to still run. Three layers of green,
 * one dead binary.
 *
 * So this test builds and then runs THE REAL THING: plain `node` on the
 * compiled entry, under a real pty, against an unreachable brain. It must
 * draw its frame and quit cleanly on `q`. Slow (one tsc build) and worth it —
 * it is the only test in the repo that can catch this class.
 */

const TUI_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(TUI_ROOT, "dist/shell/index.js");

beforeAll(() => {
  execSync("npm run build", { cwd: TUI_ROOT, stdio: "ignore" });
}, 180_000);

describe("the compiled shell entry", () => {
  it("starts, draws the frame, and quits on q — no startup crash", async () => {
    expect(existsSync(ENTRY)).toBe(true);
    const child = ptySpawn(process.execPath, [ENTRY], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: TUI_ROOT,
      env: {
        ...process.env,
        // An explicit unreachable base: the entry must render its frame (with
        // "brain unreachable" honesty) rather than crash or spawn a brain.
        MUON_API_BASE: "http://127.0.0.1:9",
        MUON_API_TOKEN: "smoke-test-token",
        // AND AN ISOLATED DATA DIR. Without it this test read the REAL one,
        // so anyone who had actually used the desk — the founder, or a probe
        // run minutes earlier — left an ADR-0047 corpse behind, the entry
        // correctly restored it, and the test failed on a frame that was not
        // the frame under test. A hermetic assertion cannot depend on whether
        // the machine has run the product.
        MUON_DATA_DIR: mkdtempSync(path.join(tmpdir(), "muon-smoke-")),
      },
    });

    let out = "";
    // ANSWER THE CAPABILITY QUERY, as a modern terminal does. A bare node-pty
    // stays silent, so the engine falls back to legacy mode — which is
    // exactly why this smoke test could not see the P0 where every chord was
    // dead in Ghostty. From here on it boots the way a founder's terminal
    // boots.
    let answeredQuery = false;
    child.onData((data) => {
      out += data;
      if (!answeredQuery && data.includes("[?u")) {
        answeredQuery = true;
        child.write(`${String.fromCodePoint(0x1b)}[?7u${String.fromCodePoint(0x1b)}[?62;22;52c`);
      }
    });

    const exited = new Promise<number>((resolve) => {
      child.onExit(({ exitCode }) => resolve(exitCode));
    });

    // FIRST PAINT IS THE SPAWN PICKER. An empty centre with a placeholder was
    // a P0 the founder hit; the desk now opens on the choice that starts real
    // work, so the picker (or the footer) is the marker.
    const drew = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (out.includes("open a terminal") || out.includes("ctrl+q quit"))
          return resolve(true);
        // 40s, not 20s: this file runs a full `tsc` build in beforeAll AND
        // the rest of the suite spawns many real ptys concurrently, so under
        // load the compiled entry's first paint arrives late. It passed in
        // isolation and flaked in the full run — a budget, not a hang.
        if (Date.now() - start > 40_000) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
    expect(
      drew,
      `frame never drew; output was:\n${out.slice(0, 800)}`
    ).toBe(true);

    // A startup crash would have printed a stack; the frame drew instead.
    expect(out).not.toContain("ReferenceError");
    expect(out).not.toContain("SyntaxError");

    // ctrl+q AS A KITTY TERMINAL SENDS IT. The legacy byte would pass even
    // with the normalizer removed; this encoding is the one that was dead.
    child.write(`${String.fromCodePoint(0x1b)}[113;5u`);
    const code = await Promise.race([
      exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 10_000)),
    ]);
    expect(code, "q at the cockpit must quit cleanly").toBe(0);
  }, 90_000);

  it("a HOSTILE snapshot renders at startup without killing the desk", async () => {
    // Both of this bundle's live failures, in one test against the COMPILED
    // entry: the corpse must be VISIBLE at first paint (syncCentre was never
    // called before start, so F7 was 'PRESENT' against a done-when it did not
    // meet), and a within-bounds file of 200k newlines must not blow the
    // render stack (it did, uncaught, leaving the terminal in the alt screen).
    const dataDir = mkdtempSync(path.join(tmpdir(), "muon-smoke-"));
    try {
      writeFileSync(
        path.join(dataDir, "tui-terminal-snapshot.json"),
        JSON.stringify({
          version: 1,
          capturedAt: 0,
          entries: [
            {
              id: "shell-1",
              kind: "shell",
              ordinal: 1,
              label: "Terminal",
              text: "RESTORED-CORPSE-MARKER" + "\n".repeat(200_000),
              cols: 80,
              rows: 24,
            },
          ],
        }),
        { mode: 0o600 }
      );
      const child = ptySpawn(process.execPath, [ENTRY], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: TUI_ROOT,
        env: {
          ...process.env,
          MUON_DATA_DIR: dataDir,
          MUON_API_BASE: "http://127.0.0.1:9",
          MUON_API_TOKEN: "smoke-test-token",
        },
      });
      let out = "";
      child.onData((data) => {
        out += data;
      });
      let exitCode: number | null = null;
      child.onExit(({ exitCode: code }) => {
        exitCode = code;
      });

      const drew = await new Promise<boolean>((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (out.includes("RESTORED-CORPSE-MARKER")) return resolve(true);
          // 40s, not 20s: this file runs a full `tsc` build in beforeAll AND
        // the rest of the suite spawns many real ptys concurrently, so under
        // load the compiled entry's first paint arrives late. It passed in
        // isolation and flaked in the full run — a budget, not a hang.
        if (Date.now() - start > 40_000) return resolve(false);
          setTimeout(tick, 100);
        };
        tick();
      });
      expect(
        drew,
        `the corpse must render at STARTUP; output was:\n${out.slice(0, 600)}`
      ).toBe(true);
      expect(out).not.toContain("RangeError");
      expect(out).not.toContain("Maximum call stack");
      expect(exitCode, "the desk must still be alive").toBe(null);
      child.write("q");
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
