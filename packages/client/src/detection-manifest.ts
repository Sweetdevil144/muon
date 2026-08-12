/**
 * ADR-0039's vendor detection manifest, on a BROWSER-SAFE subpath.
 *
 * The canonical module is `@muon/protocol/detection-manifest` — that is where
 * the schema, the bounds, and the compiled fallback patterns live. This file
 * exists for the same reason `refusal.ts` and `crew-liveness.ts` do: the
 * desktop renderer can reach neither alternative. `@muon/protocol` is not a
 * desktop dependency and does not resolve for the renderer bundle, and the
 * `@muon/client` barrel drags index → paths → `node:fs`, which esbuild cannot
 * bundle for a browser target.
 *
 * Re-export only. A second copy of the pattern list is precisely the drift
 * this feature exists to end — there is one manifest, in protocol, and every
 * surface reads from it.
 */

export {
  BUNDLED_DETECTION_MANIFEST,
  DETECTION_MANIFEST_LIMITS,
  DETECTION_MANIFEST_VERSION,
  detectionManifestSchema,
  detectionPatternsFor,
  matchesPermissionPrompt,
  readDetectionManifest,
  vendorDetectionSchema,
} from "@muon/protocol/detection-manifest";

export type {
  DetectionManifest,
  ManifestLoadResult,
  VendorDetection,
} from "@muon/protocol/detection-manifest";
