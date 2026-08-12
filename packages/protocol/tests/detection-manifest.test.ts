import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_DETECTION_MANIFEST,
  DETECTION_MANIFEST_LIMITS,
  DETECTION_MANIFEST_VERSION,
  detectionPatternsFor,
  matchesPermissionPrompt,
  readDetectionManifest,
  vendorDetectionSchema,
  VENDOR_REGISTRY,
  type DetectionManifest,
} from "../src/index.js";

// ADR-0039. A manifest describes what a vendor's output LOOKS LIKE. It may
// never describe what a vendor may DO, and it may never contain anything
// executable. Both are load-bearing, and both are asserted structurally here
// rather than left to review.

function manifest(over: Partial<DetectionManifest> = {}): unknown {
  return { version: DETECTION_MANIFEST_VERSION, vendors: {}, ...over };
}

describe("ADR-0039 D1 — a manifest describes, it never permits", () => {
  it("REFUSES a manifest that carries an authority field, rather than ignoring it", () => {
    // Silently dropping `authority` would let a file look like it was granting
    // something while MUON pretended otherwise. Refusing says plainly that
    // this is not a place authority lives.
    for (const smuggled of [
      { authority: { delegatable: true } },
      { launch: { argv: ["--dangerously-skip-permissions"] } },
      { supportedRoles: ["implementer"] },
      { permissionMode: "never_confirm" },
    ]) {
      const result = readDetectionManifest(manifest(smuggled as never));
      expect(result.source, JSON.stringify(smuggled)).toBe("bundled");
      expect(result.refused).toBeDefined();
    }
  });

  it("REFUSES an authority field smuggled INSIDE a vendor entry", () => {
    // The review's finding 4, and the bounded-surface-completeness pattern
    // again: only the OUTER object was `.strict()`, so this parsed cleanly and
    // silently dropped `authority` — verbatim the outcome the outer comment
    // says must never happen. A bounded surface has to constrain every level.
    const result = readDetectionManifest({
      version: 1,
      vendors: {
        "*": {
          permissionPrompts: ["(y/n)"],
          authority: { delegatable: true },
          launch: { argv: ["--some-dangerous-flag"] },
        },
      },
    });
    expect(result.source).toBe("bundled");
    expect(result.refused).toBeDefined();
  });

  it("shares no field name with the registry's authority surface — DERIVED", () => {
    // Structural for real this time. The previous version hardcoded
    // `new Set(["permissionPrompts"])`, so adding `authority` to the vendor
    // schema left it passing — ADR-0039's claim that a smuggled field "would
    // have to fail that test first" was false. Derive from the schema instead,
    // and check EVERY vendor rather than the first.
    const detectionFields = Object.keys(vendorDetectionSchema.shape);
    expect(detectionFields.length).toBeGreaterThan(0);
    for (const entry of Object.values(VENDOR_REGISTRY)) {
      const authorityFields = new Set(Object.keys(entry.authority));
      for (const field of detectionFields) {
        expect(authorityFields.has(field), field).toBe(false);
      }
    }
  });

  it("exports nothing that could launch, grant, or approve", () => {
    return import("../src/detection-manifest.js").then((module) => {
      const suspicious = Object.keys(module).filter((name) =>
        /launch|spawn|grant|approve|permit|authorize|exec/i.test(name)
      );
      expect(suspicious).toEqual([]);
    });
  });
});

describe("ADR-0039 D2 — literals, never regexes", () => {
  it("treats a pattern as a literal, so regex syntax matches only itself", () => {
    // If patterns were compiled as regexes, `.*` would match everything and a
    // single careless entry would pin every tab to `permission`.
    expect(matchesPermissionPrompt("ordinary build output", [".*"])).toBe(false);
    expect(matchesPermissionPrompt("literally .* here", [".*"])).toBe(true);
  });

  it("compiles no pattern into a regex, so nothing can backtrack", async () => {
    // Source-level, and deliberately so. The obvious test — run `(a+)+$`
    // against 60k of 'a' and assert it finishes — was written first and then
    // replaced: under the mutation it does not FAIL, it HANGS, because a
    // synchronous regex cannot be interrupted from JS. A hanging test burns a
    // CI job's whole timeout and reports nothing useful, which is a worse
    // outcome than the bug it was guarding.
    //
    // (The hang is real, and it is the evidence for D2: this exact mutation
    // was run locally and never terminated.)
    const source = await readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "src",
        "detection-manifest.ts"
      ),
      "utf8"
    );
    const matcher = source.slice(source.indexOf("export function matchesPermissionPrompt"));
    expect(matcher).not.toMatch(/new RegExp|\.match\(|\.test\(/);
    expect(matcher).toContain("includes(");
  });

  it("scans a large input in linear time", () => {
    // Complements the source check with a behavioural one that CANNOT hang:
    // no pathological pattern, just a big haystack and a literal needle.
    const haystack = `${"a".repeat(200_000)}b`;
    const started = performance.now();
    expect(matchesPermissionPrompt(haystack, ["grant access"])).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("matches case-insensitively, because vendors are inconsistent", () => {
    expect(matchesPermissionPrompt("Do You Want To Proceed?", ["do you want to proceed"])).toBe(
      true
    );
    expect(matchesPermissionPrompt("GRANT ACCESS", ["grant access"])).toBe(true);
  });

  it("never matches on an empty pattern or empty output", () => {
    // An empty entry that matched everything would pin every tab at once.
    expect(matchesPermissionPrompt("anything at all", [""])).toBe(false);
    expect(matchesPermissionPrompt("anything at all", ["   "])).toBe(false);
    expect(matchesPermissionPrompt("", ["grant access"])).toBe(false);
  });
});

describe("the bundled manifest reproduces the behaviour it replaced", () => {
  // These are the strings the eight compiled regexes matched. If this feature
  // changed what the dot does, that is a regression, not a feature.
  const PREVIOUSLY_MATCHED = [
    "Continue? (y/n)",
    "Continue? [Y/N]",
    "Do you want to proceed?",
    "Do you want to continue?",
    "Do you want to allow this?",
    "Do you want to make this edit?",
    "Press Enter to continue",
    "Do you trust the files in this folder?",
    "Do you trust the authors of these files?",
    "Do you trust the workspace?",
    "Allow this action?",
    "Allow this command?",
    "Allow this tool?",
    "Allow this change?",
    "Grant access to the directory?",
    'Type "yes" to confirm',
    "Type 'yes' to confirm",
  ];

  it("still matches every prompt the regexes matched", () => {
    const patterns = detectionPatternsFor(BUNDLED_DETECTION_MANIFEST, null);
    for (const line of PREVIOUSLY_MATCHED) {
      expect(matchesPermissionPrompt(line, patterns), line).toBe(true);
    }
  });

  it("still ignores ordinary output", () => {
    const patterns = detectionPatternsFor(BUNDLED_DETECTION_MANIFEST, null);
    for (const line of [
      "npm test",
      "  ✓ 42 passed",
      "Compiling packages/protocol...",
      "warning: unused variable",
      "yes",
    ]) {
      expect(matchesPermissionPrompt(line, patterns), line).toBe(false);
    }
  });
});

describe("ADR-0039 D3 — an unreadable manifest falls back, whole", () => {
  it("uses the bundled patterns when there is no local manifest at all", () => {
    for (const empty of [undefined, null]) {
      const result = readDetectionManifest(empty);
      expect(result.source).toBe("bundled");
      // No candidate was offered, so there is nothing to report as refused.
      expect(result.refused).toBeUndefined();
    }
  });

  it("distinguishes 'no override' from 'override rejected'", () => {
    // A refusal nobody can see is indistinguishable from a file that was never
    // there, and the user would have no idea their edit did nothing.
    expect(readDetectionManifest(undefined).refused).toBeUndefined();
    expect(readDetectionManifest({ nonsense: true }).refused).toBeDefined();
  });

  it("refuses a NEWER major version rather than best-effort parsing it", () => {
    const result = readDetectionManifest(
      manifest({ version: DETECTION_MANIFEST_VERSION + 1 })
    );
    expect(result.source).toBe("bundled");
    expect(result.refused).toMatch(/newer than this MUON build/);
  });

  it("refuses rather than truncating a manifest over its bounds", () => {
    // Truncation would leave MUON matching a pattern set the file does not
    // describe, with no way for the user to learn which entries were dropped.
    const tooMany = readDetectionManifest(
      manifest({
        vendors: {
          "*": {
            permissionPrompts: Array.from(
              { length: DETECTION_MANIFEST_LIMITS.patternsPerVendor + 1 },
              (_, i) => `pattern ${i}`
            ),
          },
        },
      } as never)
    );
    expect(tooMany.source).toBe("bundled");
    expect(tooMany.refused).toBeDefined();

    const tooLong = readDetectionManifest(
      manifest({
        vendors: {
          "*": {
            permissionPrompts: [
              "x".repeat(DETECTION_MANIFEST_LIMITS.patternLength + 1),
            ],
          },
        },
      } as never)
    );
    expect(tooLong.source).toBe("bundled");
    expect(tooLong.refused).toBeDefined();
  });

  it("refuses a manifest with too many vendors", () => {
    const vendors: Record<string, { permissionPrompts: string[] }> = {};
    for (let n = 0; n <= DETECTION_MANIFEST_LIMITS.vendors; n += 1) {
      vendors[`vendor-${n}`] = { permissionPrompts: ["ok"] };
    }
    expect(readDetectionManifest(manifest({ vendors } as never)).source).toBe(
      "bundled"
    );
  });

  it("accepts a well-formed local manifest", () => {
    const result = readDetectionManifest(
      manifest({
        vendors: { "*": { permissionPrompts: ["ready for your answer"] } },
      } as never)
    );
    expect(result.source).toBe("local");
    expect(result.refused).toBeUndefined();
    expect(
      matchesPermissionPrompt(
        "ready for your answer",
        detectionPatternsFor(result.manifest, null)
      )
    ).toBe(true);
  });
});

describe("per-vendor entries REPLACE the wildcard", () => {
  const withVendor = readDetectionManifest(
    manifest({
      vendors: {
        "*": { permissionPrompts: ["(y/n)"] },
        codex: { permissionPrompts: ["codex asks:"] },
      },
    } as never)
  ).manifest;

  it("gives a named vendor only its own patterns", () => {
    // D3: a per-pattern merge would leave a user unable to REMOVE a bundled
    // pattern that had started false-positiving — the likeliest reason to edit
    // the file at all.
    expect(detectionPatternsFor(withVendor, "codex")).toEqual(["codex asks:"]);
    expect(matchesPermissionPrompt("Continue? (y/n)", detectionPatternsFor(withVendor, "codex"))).toBe(
      false
    );
  });

  it("falls to the wildcard for a vendor with no entry", () => {
    expect(detectionPatternsFor(withVendor, "claude")).toEqual(["(y/n)"]);
    expect(detectionPatternsFor(withVendor, null)).toEqual(["(y/n)"]);
  });

  it("does not reach the prototype chain for an exotic vendor id", () => {
    // The review's finding 7. `vendors` on the BUNDLED manifest is a plain
    // object literal, so a bare index for "constructor" returned a prototype
    // member and the caller crashed on `.permissionPrompts.some`. A vendor id
    // is a runtime string that includes custom-agent slugs — reachable input.
    for (const exotic of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(
        detectionPatternsFor(BUNDLED_DETECTION_MANIFEST, exotic),
        exotic
      ).toEqual(BUNDLED_DETECTION_MANIFEST.vendors["*"]!.permissionPrompts);
      expect(() =>
        matchesPermissionPrompt(
          "Continue? (y/n)",
          detectionPatternsFor(BUNDLED_DETECTION_MANIFEST, exotic)
        )
      ).not.toThrow();
    }
  });

  it("returns nothing, rather than everything, when neither exists", () => {
    const bare = readDetectionManifest(manifest({ vendors: {} })).manifest;
    expect(detectionPatternsFor(bare, "codex")).toEqual([]);
    expect(matchesPermissionPrompt("Continue? (y/n)", detectionPatternsFor(bare, "codex"))).toBe(
      false
    );
  });
});
