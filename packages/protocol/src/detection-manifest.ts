import { z } from "zod";

/**
 * ADR-0039 — versioned, hot-reloadable vendor DETECTION data (feature #13).
 *
 * The problem: MUON's human-tab permission dot was eight regexes compiled into
 * the desktop app. A vendor rewording its confirmation prompt — which vendors
 * do, without notice — silently stopped the dot until someone shipped a MUON
 * release. That is the "regex-rot class".
 *
 * Two things this file is careful about, both decided in ADR-0039:
 *
 * D1 — a manifest describes what a vendor's OUTPUT LOOKS LIKE. It may never
 * describe what a vendor may DO. `VENDOR_REGISTRY` stays the single authority
 * source and stays compiled; nothing here feeds it. The schema below is closed
 * and every field is a detection field, so a future attempt to smuggle an
 * authority key in has to get past the drift-lock in the tests first.
 *
 * D2 — patterns are case-insensitive LITERALS matched with `includes()`, not
 * regexes. A hot-reloadable regex matched against untrusted vendor output is a
 * backtracking DoS vector aimed at MUON's own render path. "Kills the
 * regex-rot class" is best served by killing the regexes.
 */

/** Bumped only for a BREAKING schema change. See `readDetectionManifest`. */
export const DETECTION_MANIFEST_VERSION = 1;

/** ADR-0039 D4. A manifest is untrusted input; every dimension is capped. */
export const DETECTION_MANIFEST_LIMITS = {
  vendors: 32,
  patternsPerVendor: 64,
  patternLength: 200,
  vendorIdLength: 64,
} as const;

const patternSchema = z
  .string()
  .min(2)
  .max(DETECTION_MANIFEST_LIMITS.patternLength);

export const vendorDetectionSchema = z
  .object({
  /**
   * Literal, case-insensitive substrings that mean "this vendor just asked the
   * human something". DISPLAY ONLY (D5): the sole consumer is a pane-status
   * dot. Nothing derived from this can answer a prompt or move a gate because
   * there is no writer — the value reaches `PaneDisplayStatus` and stops. (An
   * earlier version of this comment cited ADR-0025 §2 for that; §2 is about why
   * a DISPATCHED CHILD cannot be your terminal, which is a different direction
   * and does not support the claim. The claim holds by construction, so it is
   * stated as construction.)
   */
  permissionPrompts: z
    .array(patternSchema)
    .max(DETECTION_MANIFEST_LIMITS.patternsPerVendor)
    .default([]),
  })
  // CLOSED, for the same reason the outer object is (D1) — and this is where
  // an earlier revision left the surface open. Only the OUTER object had
  // `.strict()`, so `{vendors: {"*": {permissionPrompts: [...],
  // authority: {delegatable: true}}}}` parsed CLEANLY and silently dropped
  // `authority`: verbatim the outcome the outer comment says must never
  // happen. A bounded surface has to constrain every level, not its top one.
  .strict();
export type VendorDetection = z.infer<typeof vendorDetectionSchema>;

export const detectionManifestSchema = z
  .object({
    version: z.number().int().min(1),
    vendors: z
      .record(
        z.string().min(1).max(DETECTION_MANIFEST_LIMITS.vendorIdLength),
        vendorDetectionSchema
      )
      .refine(
        (value) => Object.keys(value).length <= DETECTION_MANIFEST_LIMITS.vendors,
        { message: "too many vendors" }
      ),
  })
  // CLOSED on purpose (D1). An unknown key is a REFUSAL, not something to
  // ignore: silently dropping `authority` from a manifest that tried to set it
  // would let a file look like it was granting something while MUON pretended
  // otherwise. Refusing says plainly that this is not a place authority lives.
  .strict();
export type DetectionManifest = z.infer<typeof detectionManifestSchema>;

/**
 * The compiled fallback — byte-for-byte the behaviour MUON shipped before this
 * feature, so a missing or unreadable manifest degrades to exactly today.
 *
 * These seventeen literals are the eight previous regexes expanded. Each
 * alternation became its own entry, which reads better than the regex did and
 * cannot backtrack.
 */
export const BUNDLED_DETECTION_MANIFEST: DetectionManifest = {
  version: DETECTION_MANIFEST_VERSION,
  vendors: {
    // Applied to every vendor. A vendor-specific entry REPLACES this one for
    // that vendor (D3), rather than adding to it.
    "*": {
      permissionPrompts: [
        "(y/n)",
        "[y/n]",
        "do you want to proceed",
        "do you want to continue",
        "do you want to allow",
        "do you want to make this edit",
        "press enter to continue",
        "do you trust the files",
        "do you trust the authors",
        "do you trust the workspace",
        "allow this action",
        "allow this command",
        "allow this tool",
        "allow this change",
        "grant access",
        'type "yes" to confirm',
        "type 'yes' to confirm",
      ],
    },
  },
};

export type ManifestLoadResult = {
  readonly manifest: DetectionManifest;
  /**
   * Which layer actually supplied the data. `bundled` after any refusal, so a
   * caller can tell "the user has no override" from "the user's override was
   * rejected" by reading `refused` alongside it.
   */
  readonly source: "local" | "bundled";
  /**
   * Why a candidate manifest was not used. Present ONLY when one was offered
   * and refused — absent when there simply was no local layer. A refusal that
   * nobody can see is indistinguishable from a file that was never there.
   */
  readonly refused?: string;
};

/**
 * ADR-0039 D3. Read a candidate manifest, or fall back to the compiled one.
 *
 * Never partially applied: a manifest is used whole or not at all. Truncating
 * an over-bound one would leave MUON matching a pattern set the file does not
 * describe, with no way for the user to learn which entries were dropped.
 */
export function readDetectionManifest(candidate: unknown): ManifestLoadResult {
  if (candidate === undefined || candidate === null) {
    return { manifest: BUNDLED_DETECTION_MANIFEST, source: "bundled" };
  }
  const parsed = detectionManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      manifest: BUNDLED_DETECTION_MANIFEST,
      source: "bundled",
      refused: `manifest does not fit MUON's detection schema${
        first ? ` (${first.path.join(".") || "root"}: ${first.message})` : ""
      }; using the built-in patterns`,
    };
  }
  // A NEWER major is refused rather than best-effort parsed. Fail-closed here
  // means the compiled data, which is a real behaviour and not a fabrication.
  if (parsed.data.version > DETECTION_MANIFEST_VERSION) {
    return {
      manifest: BUNDLED_DETECTION_MANIFEST,
      source: "bundled",
      refused: `manifest version ${parsed.data.version} is newer than this MUON build understands (${DETECTION_MANIFEST_VERSION}); using the built-in patterns`,
    };
  }
  return { manifest: parsed.data, source: "local" };
}

/**
 * The patterns in force for one vendor.
 *
 * Per-vendor entries REPLACE the wildcard rather than extending it (D3): a
 * per-pattern merge would leave a user unable to REMOVE a bundled pattern that
 * had started false-positiving, which is the likeliest reason to edit the file.
 */
export function detectionPatternsFor(
  manifest: DetectionManifest,
  vendorId: string | null | undefined
): readonly string[] {
  // `Object.hasOwn`, not a bare index: `BUNDLED_DETECTION_MANIFEST.vendors` is
  // a plain object literal, so `vendors["constructor"]` (or "toString",
  // "__proto__", …) returned a prototype member and the caller crashed on
  // `.permissionPrompts.some`. A vendor id is a runtime string that includes
  // custom-agent slugs, so this is reachable input, not a theoretical one.
  const specific =
    vendorId && Object.hasOwn(manifest.vendors, vendorId)
      ? manifest.vendors[vendorId]
      : undefined;
  if (specific) return specific.permissionPrompts ?? [];
  return Object.hasOwn(manifest.vendors, "*")
    ? (manifest.vendors["*"]?.permissionPrompts ?? [])
    : [];
}

/**
 * Does this output tail look like the vendor is waiting on the human?
 *
 * `includes()` over case-folded literals — no regex, so no backtracking on an
 * untrusted byte stream (D2). DISPLAY ONLY: a false positive draws a dot over
 * ordinary output, a false negative leaves the dot at `working`, and neither
 * can approve anything (D5).
 */
export function matchesPermissionPrompt(
  recentOutput: string,
  patterns: readonly string[] | undefined
): boolean {
  if (recentOutput === "" || !patterns) return false;
  const haystack = recentOutput.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    return needle !== "" && haystack.includes(needle);
  });
}
