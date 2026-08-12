#!/usr/bin/env node
// `npm run keys` — the key doctor, on the real terminal.
//
// A separate entry rather than a desk surface, deliberately: it has to own raw
// stdin and negotiate the keyboard protocol itself, and doing that INSIDE the
// running desk would mean measuring the desk's own input handling rather than
// the terminal's. The TUI settings pane will link to it; it cannot host it.
import { describeReport, parseWaitFlag, runKeysDoctor } from "./keys-doctor.js";

const json = process.argv.includes("--json");
const wait = parseWaitFlag(process.argv.slice(2));
if (wait.error) {
  process.stderr.write(`${wait.error}\n`);
  process.exit(2);
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    "muon keys doctor needs a real terminal — run it directly, not through a pipe.\n"
  );
  process.exit(2);
}

const report = await runKeysDoctor({
  stdin: process.stdin,
  stdout: process.stdout,
  perKeyMs: wait.perKeyMs,
});

process.stdout.write("\r\n");
process.stdout.write(
  json ? `${JSON.stringify(report, null, 2)}\n` : `${describeReport(report)}\n`
);
process.exit(report.verdicts.some((v) => v.outcome !== "works") ? 1 : 0);
