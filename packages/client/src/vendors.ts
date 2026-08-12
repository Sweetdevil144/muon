/**
 * The ADR-0022 vendor registry, re-exported for the app surfaces.
 *
 * A PURE RE-EXPORT and nothing else. `apps/desktop` deliberately does NOT
 * depend on `@muon/protocol` — an explicit architectural decision recorded at
 * `apps/desktop/src/shared/ipc.ts:410` and
 * `apps/desktop/src/lib/crew-topology.ts:48` — and `apps/tui` does not declare
 * it either. Both already depend on `@muon/client`, and `@muon/client` already
 * depends on `@muon/protocol`, so this subpath reaches every consumer group
 * WITHOUT creating a package edge or breaking the desktop's standing rule. The
 * renderer already bundles protocol transitively through
 * `@muon/client/onboarding`, so nothing new enters the bundle either.
 *
 * Renderer-safe by construction: protocol's vendor module is `zod` + literals
 * with zero `node:` imports.
 *
 * Do not add anything here. A projection, a label map, or a default belongs in
 * the registry itself; a second copy on this side is exactly the drift ADR-0022
 * exists to remove. The named list below is deliberate rather than
 * `export * from "@muon/protocol"`, which would republish the whole protocol
 * barrel through a subpath that promises only the vendor surface.
 */

export {
  DEFAULT_COORDINATOR_PREFERENCE,
  VENDOR_IDS,
  VENDOR_REGISTRY,
  VENDOR_ROUTING_POLICY,
  coordinatorPreference,
  coordinatorVendorIds,
  defaultCoordinatorVendor,
  delegatableVendorIds,
  dispatchableVendorIds,
  evaluatorVendorIds,
  fleetVendorIds,
  isVendorId,
  plannerVendorIds,
  publicVendorIds,
  sessionCapability,
  terminalTakeoverVendorIds,
  vendorEntry,
  vendorIconKey,
  vendorIdSchema,
  vendorLabel,
  vendorRoleCeiling,
  vendorRoutingBrief,
  vendorRoutingLines,
  vendorShortLabel,
  vendorSupportsInteractive,
  vendorsWhere,
} from "@muon/protocol";

export type {
  VendorCompilerKind,
  VendorConnectKind,
  VendorEntry,
  VendorExecutionMode,
  VendorId,
  VendorSessionDriverKind,
} from "@muon/protocol";
