#!/usr/bin/env node
//
// Documentation integrity check: every relative markdown link resolves, and
// every ```mermaid block actually parses.
//
// Both classes have bitten this repo silently. Two diagrams in docs/install.md
// shipped broken for an unknown period — mermaid 11 rejects an unquoted node
// label containing a double quote (`D[Gatekeeper blocks: "unidentified
// developer"]`), and the only symptom is an error box on GitHub, which nobody
// sees while editing. Dangling relative links are the same shape of problem: a
// doc reorganization moves a file and the referrer keeps pointing at nothing.
//
// Usage:
//   node scripts/check-docs.mjs            # every tracked + untracked *.md
//   node scripts/check-docs.mjs a.md b.md  # just these
//
// Link checking always runs. Mermaid parsing needs `mermaid` and `jsdom`, which
// are NOT root dependencies — install them (`npm i -D mermaid jsdom`) or run
// this from a directory that has them, and the mermaid half turns itself on.
// When they are absent the script says so and still checks links, rather than
// passing silently as though it had validated the diagrams.
//
// Exits non-zero on any failure, so it can gate CI.
//
// Verified 2026-07-25: 95 markdown files, 37 mermaid diagrams, 0 broken links —
// after fixing four diagrams that did not parse (two in docs/install.md from
// unquoted labels containing double quotes, and two where a `;` inside a
// sequenceDiagram Note was read as a statement separator).

import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const explicit = process.argv.slice(2);
// `-c` (tracked) AND `-o --exclude-standard` (untracked but not ignored).
//
// This used to be `git ls-files '*.md'`, which is tracked-only — so a doc that
// had never been `git add`ed was not checked AT ALL. That is precisely
// backwards: a brand-new file is the one most likely to carry a wrong link,
// and it was the one case the gate skipped. Found 2026-08-08 by writing an ADR
// with two ADR filenames that do not exist, watching `check:docs` report "no
// broken links", and only catching it by hand. Ignored files stay out
// (`--exclude-standard`), and a Set keeps a path from being checked twice.
const files = explicit.length
  ? explicit.map((f) => path.relative(ROOT, path.resolve(f)))
  : [
      ...new Set(
        execSync("git ls-files -co --exclude-standard '*.md'", {
          cwd: ROOT,
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean)
      ),
    ];

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.log(message);
};

// ── 1. Relative links ────────────────────────────────────────────────────────
//
// Only inline `[text](target)` links are checked. External URLs, pure anchors,
// and mailto: are skipped. A target inside a code span is ignored, because
// prose like `string[](≤10, each ≤300)` is not a link and would false-positive.

const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  // Blank out code spans and fenced blocks so their contents cannot look like links.
  const scrubbed = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));

  for (const match of scrubbed.matchAll(linkRe)) {
    const raw = match[1].trim();
    if (
      !raw ||
      /^(https?:|mailto:|#)/.test(raw) ||
      raw.startsWith("<") // autolink-ish, not a path
    ) {
      continue;
    }
    const target = raw.split("#")[0];
    if (!target) continue;
    // EXPORT TEMPLATES. `packaging/oss/*` is written to BE the OSS repo's root
    // — at its destination README.md sits beside LICENSE and
    // ADDITIONAL-GRANT.md — so its links are correct there and only look
    // broken here. Accepted if they resolve as a sibling OR at the repo root;
    // both are still checked, so a link that would 404 for the public still
    // fails the build.
    const bases = rel.startsWith("packaging/oss/")
      ? [path.dirname(abs), ROOT]
      : [path.dirname(abs)];
    const resolved = bases
      .map((b) => path.resolve(b, target))
      .find((candidate) => existsSync(candidate));
    if (!resolved) {
      fail(`BROKEN LINK  ${rel}  ->  ${raw}`);
      continue;
    }
    if (target.endsWith("/") && !statSync(resolved).isDirectory()) {
      fail(`NOT A DIR    ${rel}  ->  ${raw}`);
    }
  }
}

// ── 2. Mermaid blocks ────────────────────────────────────────────────────────
//
// mermaid needs a DOM even to parse, so jsdom is stood up first. Both are
// devDependencies already present in the root install; if either is missing we
// SKIP rather than fail, so this script stays usable in a lean checkout.

let mermaid = null;
try {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.Element = dom.window.Element;
  globalThis.DOMPurify = undefined;
  mermaid = (await import("mermaid")).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
} catch (error) {
  // LOUD, and non-zero. This used to print a friendly SKIP line and then report
  // "OK: N markdown files, 0 mermaid diagram(s)" — which reads as "all diagrams
  // valid" when in fact none were parsed. 12 files with broken diagrams passed
  // that way. A validator that cannot validate must fail, not reassure.
  console.error(
    `FAIL: mermaid could not be loaded (${error?.message ?? error}).\n` +
      `  Diagram validation did NOT run. Install it with:\n` +
      `    npm install --save-dev mermaid\n` +
      `  (Set CHECK_DOCS_ALLOW_NO_MERMAID=1 to downgrade this to a warning.)`
  );
  if (process.env.CHECK_DOCS_ALLOW_NO_MERMAID !== "1") {
    process.exit(1);
  }
}

let diagrams = 0;
if (mermaid) {
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let lines;
    try {
      lines = readFileSync(abs, "utf8").split("\n");
    } catch {
      continue;
    }
    let inBlock = false;
    let startLine = 0;
    let buffer = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!inBlock && line.trim() === "```mermaid") {
        inBlock = true;
        startLine = i + 2;
        buffer = [];
        continue;
      }
      if (inBlock && line.trim() === "```") {
        inBlock = false;
        diagrams += 1;
        try {
          await mermaid.parse(buffer.join("\n"));
        } catch (error) {
          fail(
            `BAD MERMAID  ${rel}:${startLine}\n             ${
              error?.message ?? error
            }`
          );
        }
        continue;
      }
      if (inBlock) buffer.push(line);
    }
  }
}

console.log(
  failures === 0
    ? `OK: ${files.length} markdown files, ${diagrams} mermaid diagram(s), no broken links`
    : `\n${failures} documentation failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
