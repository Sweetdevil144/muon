#!/usr/bin/env node
/**
 * TODO 7.1 — static gate: secret-handling error paths must go through an
 * approved redaction chokepoint. Fails CI when a scanned file logs
 * `error.message` / `String(error)` without a known scrubber on the same line
 * (or the previous line for multi-line calls).
 *
 * Deliberately narrow: catch the class of "console.error(error.message)" bugs,
 * not every string interpolation in the tree.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = [
  "apps/cli/src",
  "apps/desktop/src",
  "backend/src",
  "packages/runner/src",
];

const APPROVED = [
  "redactForLog",
  "redactSecrets",
  "redactedTail",
  "safeLine",
  "boundedProviderFailure",
  "sanitizeVendorErrorMessage",
  "classifyVendorFailure",
  "terminalSafe",
  // CLI: printError itself calls redactForLog — callers may pass raw messages.
  "printError",
];

// Direct console / logger sinks that still take raw Error text. `printError` is
// NOT risky: apps/cli/src/lib/output.ts is the chokepoint.
const RISKY =
  /(?:console\.(?:error|warn)|\.log\.error)\s*\([^)]*(?:error\.message|String\s*\(\s*error)|(?:console\.(?:error|warn))\s*\(\s*error\s*[,)]/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

function isApproved(window) {
  return APPROVED.some((name) => window.includes(name));
}

const findings = [];
for (const root of SCAN_ROOTS) {
  const abs = path.join(ROOT, root);
  for (const file of walk(abs)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!RISKY.test(line)) continue;
      // Allow multi-line: check this line + previous + next for a scrubber.
      const window = [lines[i - 1], line, lines[i + 1]].join("\n");
      if (isApproved(window)) continue;
      // The chokepoint definition itself, and this scanner, are exempt.
      if (file.includes("build-handoff-packet.ts")) continue;
      if (file.includes("scan-secrets.mjs")) continue;
      findings.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (findings.length > 0) {
  console.error("scan-secrets: unredacted error logging detected:\n");
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    "\nWrap the value with redactForLog() (or another approved scrubber)."
  );
  process.exit(1);
}

console.log("scan-secrets: ok");
