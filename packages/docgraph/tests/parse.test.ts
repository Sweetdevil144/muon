import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flattenLinkSyntax, parseMarkdown, topLevelRawSum } from "../src/parse.js";
import { exclusionFor } from "../src/corpus.js";
import { REPO_ROOT } from "./real-corpus.js";

// T1–T5: the AST → section mapping, asserted on real bytes rather than on a
// function having been called. Every claim here is what a line scanner gets
// wrong, and each one shifts every line number downstream when it breaks.


const FENCE = "```";

function corpusFiles(): string[] {
  const stdout = execFileSync(
    "git",
    ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--full-name", "--", "*.md"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return [...new Set(stdout.split("\0").filter(Boolean))]
    .filter((relPath) => exclusionFor(relPath) === null)
    .sort();
}

describe("T1 — the offset invariant", () => {
  it("Σ top-level raw === source length on EVERY file of this repository's corpus", () => {
    // THE CANARY. `marked` carries no line or column, so every line number this
    // package reports is derived from this sum. A dependency bump that changes
    // tokenization must fail HERE, loudly, instead of shifting every answer.
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(100);
    const violations: string[] = [];
    for (const relPath of files) {
      const raw = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const { sum, length } = topLevelRawSum(raw);
      if (sum !== length) {
        violations.push(`${relPath}: Σraw=${sum} length=${length}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("holds for CRLF and for a file with no trailing newline", () => {
    for (const source of ["# A\r\n\r\nBody\r\n", "# A\n\nBody", "", "\n\n\n"]) {
      const { sum, length } = topLevelRawSum(source);
      expect(sum).toBe(length);
    }
  });

  it("never throws on any file of this repository's corpus", () => {
    for (const relPath of corpusFiles()) {
      expect(() =>
        parseMarkdown(relPath, readFileSync(path.join(REPO_ROOT, relPath), "utf8"))
      ).not.toThrow();
    }
  });
});

describe("T2 — no phantom sections", () => {
  const source = [
    "# Real",
    "",
    `${FENCE}md`,
    "# Not A Heading",
    "## Nor This One",
    `${FENCE}`,
    "",
    "Tail prose.",
    "",
  ].join("\n");

  it("a heading-shaped line inside a fence produces NO section", () => {
    const doc = parseMarkdown("f.md", source);
    expect(doc.sections.map((section) => section.heading)).toEqual([null, "Real"]);
  });

  it("the fenced bytes belong to the ENCLOSING section's content hash", () => {
    const doc = parseMarkdown("f.md", source);
    const real = doc.sections[1];
    // Change a byte INSIDE the fence; only the enclosing section's hash moves.
    const edited = parseMarkdown("f.md", source.replace("# Not A Heading", "# Not A Header"));
    expect(edited.sections[1].contentHash).not.toBe(real.contentHash);
    expect(edited.sections).toHaveLength(2);
  });

  it("records the fence as a section ATTRIBUTE with its language", () => {
    const doc = parseMarkdown("f.md", source);
    expect(doc.sections[1].fences).toHaveLength(1);
    expect(doc.sections[1].fences[0].lang).toBe("md");
    expect(doc.sections[1].fences[0].startLine).toBe(3);
    expect(doc.sections[1].fences[0].endLine).toBe(6);
  });

  it("does not mine a fence body for links or code spans", () => {
    const doc = parseMarkdown(
      "f.md",
      ["# Real", "", `${FENCE}ts`, "import x from `src/fake.ts`;", "[l](other.md)", `${FENCE}`, ""].join("\n")
    );
    expect(doc.sections[1].codeSpans).toEqual([]);
    expect(doc.sections[1].links).toEqual([]);
  });
});

describe("T3 — section identity", () => {
  const source = [
    "# Title",
    "",
    "## Repeated",
    "a",
    "",
    "## Other",
    "b",
    "",
    "## Repeated",
    "c",
    "",
    "## Repeated",
    "d",
    "",
  ].join("\n");

  it("duplicate headings get -1, -2 in DOCUMENT ORDER; the first keeps the bare slug", () => {
    const doc = parseMarkdown("d.md", source);
    expect(doc.sections.map((section) => section.id)).toEqual([
      "d.md#",
      "d.md#title",
      "d.md#repeated",
      "d.md#other",
      "d.md#repeated-1",
      "d.md#repeated-2",
    ]);
  });

  it("slugs the RENDERED heading, so inline markdown does not leak into the id", () => {
    const doc = parseMarkdown("d.md", "# `code` and **bold** and a (paren)\n\nbody\n");
    expect(doc.sections[1].anchor).toBe("code-and-bold-and-a-paren");
  });

  it("an existing #anchor link resolves onto a real section id", () => {
    const target = parseMarkdown("docs/adr/0002-b.md", source);
    // The id IS the anchor slug, which is what makes doc→section edges free.
    expect(target.sections.map((section) => section.id)).toContain(
      "docs/adr/0002-b.md#other"
    );
  });
});

describe("T4 — the breadcrumb", () => {
  it("headingPath is exactly the ancestor stack, then the heading itself", () => {
    const doc = parseMarkdown(
      "b.md",
      ["# One", "", "## Two", "", "### Three", "", "body", ""].join("\n")
    );
    const three = doc.sections.find((section) => section.heading === "Three");
    expect(three?.headingPath).toEqual(["One", "Two", "Three"]);
    expect(three?.depth).toBe(3);
  });

  it("a SKIPPED level does not invent a phantom parent", () => {
    const doc = parseMarkdown(
      "b.md",
      ["# One", "", "### Three", "", "body", ""].join("\n")
    );
    const three = doc.sections.find((section) => section.heading === "Three");
    expect(three?.headingPath).toEqual(["One", "Three"]);
  });

  it("a heading that RETURNS to a shallower depth pops the stack", () => {
    const doc = parseMarkdown(
      "b.md",
      ["# One", "", "## Two", "", "### Three", "", "## Four", "", "body", ""].join("\n")
    );
    const four = doc.sections.find((section) => section.heading === "Four");
    expect(four?.headingPath).toEqual(["One", "Four"]);
  });
});

describe("T5 — the preamble, and the byte partition", () => {
  it("bytes before the first heading land in the `#` section", () => {
    const doc = parseMarkdown("p.md", "Intro line.\n\n# Title\n\nBody.\n");
    expect(doc.sections[0].id).toBe("p.md#");
    expect(doc.sections[0].depth).toBe(0);
    expect(doc.sections[0].startLine).toBe(1);
    expect(doc.sections[0].endLine).toBe(2);
  });

  it("a document opening on its own heading gets an EMPTY preamble, marked as empty", () => {
    const doc = parseMarkdown("p.md", "# Title\n\nBody.\n");
    expect(doc.sections[0].bytes).toBe(0);
    // endLine < startLine is the honest encoding of an empty range.
    expect(doc.sections[0].endLine).toBe(doc.sections[0].startLine - 1);
  });

  it("Σ section.bytes === file.bytes — no byte unreachable, none double-counted", () => {
    for (const relPath of corpusFiles()) {
      const raw = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const doc = parseMarkdown(relPath, raw);
      const total = doc.sections.reduce((sum, section) => sum + section.bytes, 0);
      // Measured against the NORMALIZED source, which is what the sections slice.
      expect([relPath, total]).toEqual([
        relPath,
        Buffer.byteLength(raw.replace(/\r\n|\r/g, "\n"), "utf8"),
      ]);
    }
  });

  it("line ranges are contiguous and ascending across a document", () => {
    const doc = parseMarkdown(
      "c.md",
      ["Intro", "", "# One", "", "## Two", "", "text", "", "## Three", "", "text", ""].join("\n")
    );
    const nonEmpty = doc.sections.filter((section) => section.bytes > 0);
    for (let i = 1; i < nonEmpty.length; i += 1) {
      expect(nonEmpty[i].startLine).toBe(nonEmpty[i - 1].endLine + 1);
    }
  });
});

// The BM25 body's link flattening. The pattern this replaced was quadratic, so
// ONE pathological document could hang a whole index build; these assert both
// halves of the fix — the output did not move, and the cost did.

/** The regex `flattenLinkSyntax` replaced, kept HERE as the equivalence oracle. */
const QUADRATIC = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const oldFlatten = (text: string): string => text.replace(QUADRATIC, "$1 $2");

describe("link flattening is linear, and byte-identical to the pattern it replaced", () => {
  it("flattens `[text](target)` and drops a title", () => {
    expect(flattenLinkSyntax("see [the note](../design/note.md) now")).toBe(
      "see the note ../design/note.md now"
    );
    expect(flattenLinkSyntax('[a](b.md "Title")')).toBe("a b.md");
    expect(flattenLinkSyntax("[](x.md)")).toBe(" x.md");
  });

  it("leaves unbalanced and non-link brackets exactly as they were", () => {
    for (const text of [
      "[[[[",
      "[not a link]",
      "[a] (b)",
      "[a](  )",
      "[a](b c)",
      '[a](b "unterminated)',
      "]([",
      "[a[b](c)",
    ]) {
      expect([text, flattenLinkSyntax(text)]).toEqual([text, oldFlatten(text)]);
    }
  });

  it("agrees with the old pattern on EVERY file of this repository's corpus", () => {
    // The output feeds BM25 term statistics, so a divergence would silently
    // re-rank every query. Compared on real bytes, after the same backtick pass
    // `bodyText` applies.
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(100);
    const divergent: string[] = [];
    for (const relPath of files) {
      const text = readFileSync(path.join(REPO_ROOT, relPath), "utf8").replace(/`+/g, " ");
      if (flattenLinkSyntax(text) !== oldFlatten(text)) {
        divergent.push(relPath);
      }
    }
    expect(divergent).toEqual([]);
  });

  it("agrees with the old pattern across 20,000 seeded fuzz strings", () => {
    // The corpus only holds WELL-FORMED links; the fuzz covers the shapes a
    // pathological document actually carries.
    let seed = 424_242;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = [...'[]()"\' \n\tab.-/'];
    for (let trial = 0; trial < 20_000; trial += 1) {
      let text = "";
      const length = 1 + Math.floor(next() * 40);
      for (let i = 0; i < length; i += 1) {
        text += alphabet[Math.floor(next() * alphabet.length)];
      }
      if (flattenLinkSyntax(text) !== oldFlatten(text)) {
        // Reported with the input, so a failure is debuggable rather than a count.
        expect([text, flattenLinkSyntax(text)]).toEqual([text, oldFlatten(text)]);
      }
    }
  });

  it("parses a PATHOLOGICAL document inside a hard time bound", () => {
    // 200,000 unbalanced brackets. MEASURED on this machine: 41.6 s under the old
    // pattern, 0.04 ms here (`marked` itself needs ~10 ms for the same input, so
    // the bound below is about the flattener, not the lexer). The ceiling is set
    // two orders of magnitude above the real cost so a loaded machine cannot make
    // it flake, and still three orders below the quadratic behaviour it fences.
    const pathological = `# Pathological\n\n${"[".repeat(200_000)}\n`;
    const started = performance.now();
    const doc = parseMarkdown("p.md", pathological);
    const elapsed = performance.now() - started;
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[1].text).toContain("[[[");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("stays linear as the pathological input grows", () => {
    // The SHAPE OF THE CURVE, which a single ceiling cannot assert: across a 4x
    // input, linear cost multiplies by ~4 and quadratic by ~16. The bound is 8x —
    // twice the real growth, half the quadratic one. Each size is the CHEAPEST of
    // three runs, because contention can only ever make a sample slower, and a
    // ratio of two noisy samples is what would otherwise flake.
    const cost = (count: number): number => {
      const text = "[a](b".repeat(count);
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        flattenLinkSyntax(text);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    cost(5_000); // warm the JIT so the first sample is not the slow one
    const small = cost(20_000);
    const large = cost(80_000);
    expect(large).toBeLessThan(small * 8);
  });
});

describe("collection walks tables and list items", () => {
  it("finds links and code spans inside a table's header and rows", () => {
    const doc = parseMarkdown(
      "t.md",
      [
        "# T",
        "",
        "| Concern | Where |",
        "|---|---|",
        "| Parsing | `scripts/check-docs.mjs:72` |",
        "| Index | [the note](../design/note.md) |",
        "",
      ].join("\n")
    );
    expect(doc.sections[1].codeSpans).toContain("scripts/check-docs.mjs:72");
    expect(doc.sections[1].links.map((link) => link.href)).toContain("../design/note.md");
  });

  it("locates a fence nested inside a list item by its opening line", () => {
    const doc = parseMarkdown(
      "l.md",
      ["# L", "", "1. Run it:", "", "   " + FENCE + "bash", "   npm test", "   " + FENCE, "", ""].join("\n")
    );
    expect(doc.sections[1].fences).toHaveLength(1);
    expect(doc.sections[1].fences[0].lang).toBe("bash");
    expect(doc.sections[1].fences[0].startLine).toBe(5);
  });
});
