/**
 * LIVE probe (not part of any suite): drives the SAME layers a vendor tab
 * click uses — resolveTerminalSpawn (host allowlist + env policy) → PtyHost →
 * createNodePtyDriver(real node-pty) — against the real vendor binary, in a
 * scratch cwd. Proves: interactive TUI banner renders, keystrokes reach it,
 * a resize reflows it, and close() kills the child. Run via esbuild bundle:
 *   node_modules/.bin/esbuild scripts/terminal-live-probe.ts --bundle \
 *     --platform=node --format=cjs --external:node-pty --outfile=/tmp/p.cjs
 *   node /tmp/p.cjs <cwd> <kind> [keystrokes]
 */
import { execSync } from "node:child_process";
import * as nodePty from "node-pty";
import { PtyHost } from "@muon/runner";
import { createNodePtyDriver } from "../src/lib/node-pty-driver.js";
import {
  resolveTerminalSpawn,
  TERMINAL_STRIPPED_ENV_VARS,
} from "../src/lib/terminal-spawn.js";

const cwd = process.argv[2];
const kind = process.argv[3] ?? "claude-code";
const keys = process.argv[4] ?? "hi muon";
if (!cwd) throw new Error("usage: probe <cwd> <kind> [keys]");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Drop OSC/CSI/charset escapes + control bytes so the banner reads as text. */
const strip = (raw: string) =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");

const host = new PtyHost((options) =>
  createNodePtyDriver(nodePty as never, options)
);
const spawn = resolveTerminalSpawn(kind, cwd, { cols: 110, rows: 32 });
console.log(
  `[probe] spawn file=${spawn.file} args=${JSON.stringify(spawn.args)} cwd=${spawn.cwd}`
);
// Read from the SAME constant the policy is built from. This line used to
// re-derive the check as `startsWith("MUON_") && endsWith("_TOKEN")`, which is
// the shape rule the policy no longer relies on — so the live probe would have
// reported "nothing forwarded" for a name like MUON_OPERATOR_TOKEN_KEYCHAIN.
const leaked = TERMINAL_STRIPPED_ENV_VARS.filter(
  (key) => key in (spawn.env ?? {})
);
console.log(
  `[probe] env policy: GITHUB_TOKEN forwarded=${"GITHUB_TOKEN" in (spawn.env ?? {})}, MUON control-plane names forwarded=${leaked.length === 0 ? "none" : leaked.join(",")}`
);

let buffer = "";
let exited: string | null = null;
host.open("probe", spawn);
host.attach("probe", {
  onData: (frame) => {
    buffer += frame.data;
    host.ack("probe", frame.seq);
  },
  onExit: (event) => {
    exited = `code=${event.exitCode} signal=${event.signal ?? "none"}`;
  },
});

function childPids(): number[] {
  const rows = execSync("ps -axo pid=,ppid=", { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const out: number[] = [];
  const walk = (parent: number) => {
    for (const [pid, ppid] of rows) {
      if (ppid === parent && pid) {
        out.push(pid!);
        walk(pid!);
      }
    }
  };
  walk(process.pid);
  return out;
}

async function main() {
  await sleep(9000);
  const banner = strip(buffer);
  console.log("[probe] ---- first-paint (cleaned, tail 1200) ----");
  console.log(banner.slice(-1200));
  console.log("[probe] ---- end first-paint ----");
  const pids = childPids();
  console.log(`[probe] child pids: ${pids.join(", ") || "(none)"}`);

  const beforeKeys = buffer.length;
  // Type like a human — TUI composers repaint per keystroke, and a paste-style
  // burst can coalesce into cursor-art that defeats a substring check.
  for (const char of keys) {
    host.write("probe", char);
    await sleep(80);
  }
  await sleep(2500);
  const afterKeys = strip(buffer.slice(beforeKeys)).replace(/\s+/g, "");
  const wanted = keys.replace(/\s+/g, "");
  console.log(
    `[probe] keystrokes: sent ${JSON.stringify(keys)}, echoed=${afterKeys.includes(wanted)} (+${buffer.length - beforeKeys} bytes)`
  );

  const beforeResize = buffer.length;
  host.resize("probe", 70, 20);
  await sleep(2500);
  console.log(
    `[probe] resize 110x32 -> 70x20: repaint bytes=+${buffer.length - beforeResize}`
  );

  host.close("probe");
  await sleep(1800);
  const survivors = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  console.log(
    `[probe] after close(): exited=${exited ?? "no exit event"} survivors=${survivors.join(", ") || "(none)"}`
  );
  process.exit(survivors.length === 0 ? 0 : 1);
}

void main();
