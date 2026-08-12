import { z } from "zod";
import { vendorIdSchema } from "./vendor.js";

const RAW_CREDENTIAL_VALUE =
  /(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[0-9A-Za-z_-]{12,}/i;
const CREDENTIAL_FAMILY_MARKER =
  /(?:^|[_.:/-])(?:bearer|gh[oprsu]|github_pat|gitlab_pat|glpat|gnx|hf|npm|pk_live|pypi|rk_(?:live|test)|sk|xox[baprs])(?=$|[_.:/-])/i;

const isCredentialShaped = (value: string) =>
  RAW_CREDENTIAL_VALUE.test(value) ||
  CREDENTIAL_FAMILY_MARKER.test(value);

const boundedSafeName = (pattern: RegExp, label: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(pattern, `${label} contains unsupported characters`)
    .refine((value) => !isCredentialShaped(value), {
      message: `${label} must not be credential-shaped`,
    });

export const capabilityPostureSchema = z.enum([
  "governed",
  "compatibility-import",
]);
export type CapabilityPosture = z.infer<typeof capabilityPostureSchema>;

export const capabilitySourceSchema = z.enum([
  "muon",
  "user",
  "project",
  "plugin",
  "account",
  "team",
]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export const capabilityAuthoritySchema = z.enum([
  "context",
  "agent-write",
  "control",
  "code-intelligence",
]);
export type CapabilityAuthority = z.infer<typeof capabilityAuthoritySchema>;

export const capabilityPropagationSchema = z.enum([
  "none",
  "explicit-children",
  "descendants",
]);
export type CapabilityPropagation = z.infer<
  typeof capabilityPropagationSchema
>;

export const capabilityAuthenticationOwnerSchema = z.enum([
  "muon-agent-token",
  "vendor-owned",
  "none",
]);
export type CapabilityAuthenticationOwner = z.infer<
  typeof capabilityAuthenticationOwnerSchema
>;

export const capabilityAuthenticationStateSchema = z.enum([
  "yes",
  "no",
  "unknown",
]);
export type CapabilityAuthenticationState = z.infer<
  typeof capabilityAuthenticationStateSchema
>;

export const capabilityHermeticitySchema = z.enum([
  "hermetic",
  "non-hermetic",
  "unknown",
]);
export type CapabilityHermeticity = z.infer<
  typeof capabilityHermeticitySchema
>;

/**
 * WAVE E: the ADR-0019 attestation's vendor is now the registry enum, closing
 * the last of the three ADR-0022 §5-A7 known divergences (it named the original
 * trio, so the ids MISSING from it simply changed with the vendor set).
 *
 * Widening this enum GRANTS NOTHING. An attestation is bound to its own
 * manifest's vendor and `finalizeCapabilityAttestation` throws on a mismatch, so
 * naming a vendor here only makes an attestation for that vendor expressible —
 * the manifest, not this schema, decides whose attestation it is.
 */
export const capabilityVendorSchema = vendorIdSchema;
export type CapabilityVendor = z.infer<typeof capabilityVendorSchema>;

export const capabilityVendorVersionSchema = boundedSafeName(
  /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/,
  "vendor version",
  64,
);

export const capabilityVendorVersionRangeSchema = z
  .object({
    exact: capabilityVendorVersionSchema.optional(),
    minInclusive: capabilityVendorVersionSchema.optional(),
    maxExclusive: capabilityVendorVersionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasRange = Boolean(value.minInclusive || value.maxExclusive);
    if (value.exact && hasRange) {
      ctx.addIssue({
        code: "custom",
        message: "exact version cannot be combined with a range",
      });
    }
    if (!value.exact && !hasRange) {
      ctx.addIssue({
        code: "custom",
        message: "an exact version or version range is required",
      });
    }
  });
export type CapabilityVendorVersionRange = z.infer<
  typeof capabilityVendorVersionRangeSchema
>;

export const capabilityFingerprintSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected a sha256 evidence fingerprint");
export type CapabilityFingerprint = z.infer<
  typeof capabilityFingerprintSchema
>;

export const capabilityPrincipalIdSchema = z
  .string()
  .regex(
    /^principal:[a-f0-9]{16,64}$/,
    "expected an opaque principal fingerprint",
  );

export const capabilityLogicalIdSchema = boundedSafeName(
  /^[a-z][a-z0-9._-]*$/,
  "capability logical id",
  64,
);

export const capabilityToolNameSchema = boundedSafeName(
  /^[A-Za-z][A-Za-z0-9_.:/-]*$/,
  "capability tool name",
  128,
);

const muonRecordIdSchema = z.string().max(64).cuid();
const observedAtSchema = z.string().max(64).datetime({ offset: true });

const uniqueNames = (
  values: readonly string[],
  ctx: z.RefinementCtx,
  label: string,
) => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate ${label}`,
      });
    }
    seen.add(value);
  }
};

export const capabilityPrincipalSchema = z
  .object({
    principalId: capabilityPrincipalIdSchema,
    parentId: capabilityPrincipalIdSchema.optional(),
    depth: z.number().int().min(0).max(16),
    maxDepth: z.number().int().min(0).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.depth > value.maxDepth) {
      ctx.addIssue({
        code: "custom",
        path: ["depth"],
        message: "depth cannot exceed maxDepth",
      });
    }
    if (value.parentId === value.principalId) {
      ctx.addIssue({
        code: "custom",
        path: ["parentId"],
        message: "a principal cannot be its own parent",
      });
    }
  });
export type CapabilityPrincipal = z.infer<typeof capabilityPrincipalSchema>;

export const capabilityServerManifestSchema = z
  .object({
    logicalId: capabilityLogicalIdSchema,
    expectedIdentity: capabilityFingerprintSchema,
    source: capabilitySourceSchema,
    authority: capabilityAuthoritySchema,
    required: z.boolean(),
    enabledTools: z.array(capabilityToolNameSchema).max(256).default([]),
    disabledTools: z.array(capabilityToolNameSchema).max(256).default([]),
    propagate: capabilityPropagationSchema,
    authentication: capabilityAuthenticationOwnerSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    uniqueNames(value.enabledTools, ctx, "enabled tool");
    uniqueNames(value.disabledTools, ctx, "disabled tool");

    const disabled = new Set(value.disabledTools);
    if (value.enabledTools.some((tool) => disabled.has(tool))) {
      ctx.addIssue({
        code: "custom",
        message: "a tool cannot be both enabled and disabled",
      });
    }
  });
export type CapabilityServerManifest = z.infer<
  typeof capabilityServerManifestSchema
>;

export const capabilityManifestSchema = z
  .object({
    version: z.literal(1),
    taskId: muonRecordIdSchema,
    jobId: muonRecordIdSchema.optional(),
    workspaceFingerprint: capabilityFingerprintSchema,
    mode: capabilityPostureSchema,
    vendor: capabilityVendorSchema,
    vendorVersionRange: capabilityVendorVersionRangeSchema,
    principals: z.array(capabilityPrincipalSchema).min(1).max(128),
    servers: z.array(capabilityServerManifestSchema).max(128).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    uniqueNames(
      value.principals.map((principal) => principal.principalId),
      ctx,
      "principalId",
    );
    uniqueNames(
      value.servers.map((server) => server.logicalId),
      ctx,
      "logicalId",
    );

    const principals = new Map(
      value.principals.map((principal) => [
        principal.principalId,
        principal,
      ]),
    );
    const roots = value.principals.filter((principal) => principal.depth === 0);
    if (roots.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "a capability manifest requires exactly one root principal",
      });
    }

    for (const principal of value.principals) {
      if (principal.depth === 0 && principal.parentId) {
        ctx.addIssue({
          code: "custom",
          message: "root principal cannot declare a parent",
        });
      }
      if (principal.depth > 0 && !principal.parentId) {
        ctx.addIssue({
          code: "custom",
          message: "non-root principal requires a parent",
        });
      }
      if (!principal.parentId) continue;

      const parent = principals.get(principal.parentId);
      if (!parent) {
        ctx.addIssue({
          code: "custom",
          message: "parentId is not in this manifest",
        });
        continue;
      }
      if (principal.depth !== parent.depth + 1) {
        ctx.addIssue({
          code: "custom",
          message: "child depth must equal parent depth + 1",
        });
      }
      if (principal.maxDepth > parent.maxDepth) {
        ctx.addIssue({
          code: "custom",
          message: "child maxDepth cannot exceed parent maxDepth",
        });
      }
    }

    for (const principal of value.principals) {
      const seen = new Set<string>();
      let current: CapabilityPrincipal | undefined = principal;
      while (current?.parentId) {
        if (seen.has(current.principalId)) {
          ctx.addIssue({
            code: "custom",
            message: "principal lineage cannot contain a cycle",
          });
          break;
        }
        seen.add(current.principalId);
        current = principals.get(current.parentId);
      }
    }
  });
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

export const capabilityObservedServerSchema = z
  .object({
    logicalId: capabilityLogicalIdSchema,
    observedIdentity: capabilityFingerprintSchema,
    source: capabilitySourceSchema,
    connected: z.boolean(),
    authenticated: capabilityAuthenticationStateSchema,
    tools: z.array(capabilityToolNameSchema).max(256).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    uniqueNames(value.tools, ctx, "observed tool");
  });
export type CapabilityObservedServer = z.infer<
  typeof capabilityObservedServerSchema
>;

const validateObservedServers = (
  value: {
    servers: CapabilityObservedServer[];
    missingRequired?: string[];
    unexpected?: string[];
  },
  ctx: z.RefinementCtx,
) => {
  if (value.missingRequired) {
    uniqueNames(value.missingRequired, ctx, "missing required capability");
  }
  if (value.unexpected) {
    uniqueNames(value.unexpected, ctx, "unexpected capability");
  }

  const logicalIds = new Set<string>();
  const identities = new Set<string>();
  for (const server of value.servers) {
    if (logicalIds.has(server.logicalId)) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate observed server logicalId",
      });
    }
    logicalIds.add(server.logicalId);

    if (identities.has(server.observedIdentity)) {
      ctx.addIssue({
        code: "custom",
        message: "duplicate observed server identity",
      });
    }
    identities.add(server.observedIdentity);
  }
};

const capabilityAttestationObservationShape = {
  vendor: capabilityVendorSchema,
  vendorVersion: capabilityVendorVersionSchema,
  observedAt: observedAtSchema,
  servers: z.array(capabilityObservedServerSchema).max(128).default([]),
};

export const capabilityAttestationObservationSchema = z
  .object(capabilityAttestationObservationShape)
  .strict()
  .superRefine(validateObservedServers);
export type CapabilityAttestationObservation = z.infer<
  typeof capabilityAttestationObservationSchema
>;

export const capabilityAttestationWireSchema = z
  .object({
    manifestVersion: z.literal(1),
    manifestFingerprint: capabilityFingerprintSchema,
    taskId: muonRecordIdSchema,
    jobId: muonRecordIdSchema.optional(),
    workspaceFingerprint: capabilityFingerprintSchema,
    ...capabilityAttestationObservationShape,
    missingRequired: z.array(capabilityLogicalIdSchema).max(128).default([]),
    unexpected: z.array(capabilityLogicalIdSchema).max(128).default([]),
    hermeticity: capabilityHermeticitySchema,
    stateFingerprint: capabilityFingerprintSchema,
    fingerprint: capabilityFingerprintSchema,
  })
  .strict()
  .superRefine(validateObservedServers);
export type UnverifiedCapabilityAttestation = z.infer<
  typeof capabilityAttestationWireSchema
>;

export const capabilityRunEnvelopeWireSchema = z
  .object({
    manifest: capabilityManifestSchema,
    attestation: capabilityAttestationWireSchema.optional(),
  })
  .strict();
export type UnverifiedCapabilityRunEnvelope = z.infer<
  typeof capabilityRunEnvelopeWireSchema
>;

declare const verifiedCapabilityAttestationBrand: unique symbol;
declare const verifiedCapabilityRunEnvelopeBrand: unique symbol;

export type VerifiedCapabilityAttestation =
  UnverifiedCapabilityAttestation & {
    readonly [verifiedCapabilityAttestationBrand]: true;
  };

export type VerifiedCapabilityRunEnvelope = {
  manifest: CapabilityManifest;
  attestation?: VerifiedCapabilityAttestation;
  readonly [verifiedCapabilityRunEnvelopeBrand]: true;
};

export type CapabilityHasher = (
  canonicalEvidence: string,
) => CapabilityFingerprint | string;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const sorted = <T>(values: readonly T[], by: (value: T) => string) =>
  [...values].sort((left, right) => compareText(by(left), by(right)));

const canonicalManifest = (manifest: CapabilityManifest) => ({
  ...manifest,
  principals: sorted(
    manifest.principals,
    (principal) => principal.principalId,
  ),
  servers: sorted(manifest.servers, (server) => server.logicalId).map(
    (server) => ({
      ...server,
      enabledTools: [...server.enabledTools].sort(compareText),
      disabledTools: [...server.disabledTools].sort(compareText),
    }),
  ),
});

const canonicalServers = (servers: CapabilityObservedServer[]) =>
  sorted(
    servers,
    (server) => `${server.logicalId}:${server.observedIdentity}`,
  ).map((server) => ({
    ...server,
    tools: [...server.tools].sort(compareText),
  }));

const hashCanonical = (
  hasher: CapabilityHasher,
  evidence: unknown,
): CapabilityFingerprint =>
  capabilityFingerprintSchema.parse(hasher(JSON.stringify(evidence)));

export const fingerprintCapabilityManifest = (
  input: z.input<typeof capabilityManifestSchema>,
  hasher: CapabilityHasher,
): CapabilityFingerprint => {
  const manifest = capabilityManifestSchema.parse(input);
  return hashCanonical(hasher, canonicalManifest(manifest));
};

const compareVersionTokens = (left: string, right: string) => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? 1 : -1;
  }
  return compareText(left.toLowerCase(), right.toLowerCase());
};

const compareVendorVersions = (left: string, right: string) => {
  const leftParts = left.split(/[.+_-]/).filter(Boolean);
  const rightParts = right.split(/[.+_-]/).filter(Boolean);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const compared = compareVersionTokens(leftPart, rightPart);
    if (compared !== 0) return compared;
  }
  return 0;
};

const versionIsSupported = (
  observed: string,
  range: CapabilityVendorVersionRange,
) => {
  if (range.exact) return observed === range.exact;
  if (
    range.minInclusive &&
    compareVendorVersions(observed, range.minInclusive) < 0
  ) {
    return false;
  }
  if (
    range.maxExclusive &&
    compareVendorVersions(observed, range.maxExclusive) >= 0
  ) {
    return false;
  }
  return true;
};

type CapabilityAssessment = {
  missingRequired: string[];
  unexpected: string[];
  hermeticity: CapabilityHermeticity;
};

const assessObservation = (
  manifest: CapabilityManifest,
  observation: CapabilityAttestationObservation,
): CapabilityAssessment => {
  const expectedById = new Map(
    manifest.servers.map((server) => [server.logicalId, server]),
  );
  const observedById = new Map(
    observation.servers.map((server) => [server.logicalId, server]),
  );
  const missingRequired = new Set<string>();
  const unexpected = new Set<string>();
  let hasUnknownAuthentication = false;

  for (const observed of observation.servers) {
    const expected = expectedById.get(observed.logicalId);
    if (!expected) {
      unexpected.add(observed.logicalId);
      continue;
    }

    const identityMatches =
      observed.observedIdentity === expected.expectedIdentity;
    const sourceMatches = observed.source === expected.source;
    const observedTools = new Set(observed.tools);
    const enabledToolsPresent = expected.enabledTools.every((tool) =>
      observedTools.has(tool),
    );
    const enabledTools = new Set(expected.enabledTools);
    const disabledTools = new Set(expected.disabledTools);
    const hasUnexpectedTool = observed.tools.some(
      (tool) => !enabledTools.has(tool) || disabledTools.has(tool),
    );
    const authenticationSatisfied =
      expected.authentication === "none" || observed.authenticated === "yes";

    if (!identityMatches || !sourceMatches || hasUnexpectedTool) {
      unexpected.add(observed.logicalId);
    }

    if (
      expected.required &&
      (!observed.connected ||
        !identityMatches ||
        !sourceMatches ||
        !enabledToolsPresent ||
        !authenticationSatisfied)
    ) {
      missingRequired.add(expected.logicalId);
    }

    if (
      expected.authentication !== "none" &&
      observed.authenticated === "unknown"
    ) {
      hasUnknownAuthentication = true;
    }
  }

  for (const expected of manifest.servers) {
    if (expected.required && !observedById.has(expected.logicalId)) {
      missingRequired.add(expected.logicalId);
    }
  }

  const missing = [...missingRequired].sort(compareText);
  const extras = [...unexpected].sort(compareText);
  const hermeticity: CapabilityHermeticity =
    manifest.mode === "compatibility-import" ||
    missing.length > 0 ||
    extras.length > 0
      ? "non-hermetic"
      : hasUnknownAuthentication
        ? "unknown"
        : "hermetic";

  return {
    missingRequired: missing,
    unexpected: extras,
    hermeticity,
  };
};

const attestationStateEvidence = (
  attestation: Omit<
    UnverifiedCapabilityAttestation,
    "observedAt" | "stateFingerprint" | "fingerprint"
  >,
) => ({
  manifestVersion: attestation.manifestVersion,
  manifestFingerprint: attestation.manifestFingerprint,
  taskId: attestation.taskId,
  jobId: attestation.jobId,
  workspaceFingerprint: attestation.workspaceFingerprint,
  vendor: attestation.vendor,
  vendorVersion: attestation.vendorVersion,
  servers: canonicalServers(attestation.servers),
  missingRequired: [...attestation.missingRequired].sort(compareText),
  unexpected: [...attestation.unexpected].sort(compareText),
  hermeticity: attestation.hermeticity,
});

const fingerprintCapabilityState = (
  attestation: Omit<
    UnverifiedCapabilityAttestation,
    "observedAt" | "stateFingerprint" | "fingerprint"
  >,
  hasher: CapabilityHasher,
): CapabilityFingerprint =>
  hashCanonical(hasher, attestationStateEvidence(attestation));

const fingerprintCapabilityIntegrity = (
  attestation: Omit<UnverifiedCapabilityAttestation, "fingerprint">,
  hasher: CapabilityHasher,
): CapabilityFingerprint =>
  hashCanonical(hasher, {
    state: attestationStateEvidence(attestation),
    observedAt: attestation.observedAt,
    stateFingerprint: attestation.stateFingerprint,
  });

const sameStrings = (left: string[], right: string[]) =>
  JSON.stringify([...left].sort(compareText)) ===
  JSON.stringify([...right].sort(compareText));

export const finalizeCapabilityAttestation = (
  manifestInput: z.input<typeof capabilityManifestSchema>,
  observationInput: z.input<typeof capabilityAttestationObservationSchema>,
  hasher: CapabilityHasher,
): VerifiedCapabilityAttestation => {
  const manifest = capabilityManifestSchema.parse(manifestInput);
  const observation =
    capabilityAttestationObservationSchema.parse(observationInput);
  if (observation.vendor !== manifest.vendor) {
    throw new Error("observed vendor does not match manifest vendor");
  }
  if (!versionIsSupported(observation.vendorVersion, manifest.vendorVersionRange)) {
    throw new Error("observed vendor version is outside the manifest range");
  }

  const assessment = assessObservation(manifest, observation);
  const bound = {
    manifestVersion: manifest.version,
    manifestFingerprint: fingerprintCapabilityManifest(manifest, hasher),
    taskId: manifest.taskId,
    jobId: manifest.jobId,
    workspaceFingerprint: manifest.workspaceFingerprint,
    ...observation,
    ...assessment,
  };
  const stateFingerprint = fingerprintCapabilityState(bound, hasher);
  const attestation = capabilityAttestationWireSchema.parse({
    ...bound,
    stateFingerprint,
    fingerprint: fingerprintCapabilityIntegrity(
      {
        ...bound,
        stateFingerprint,
      },
      hasher,
    ),
  });
  return verifyCapabilityAttestation(attestation, manifest, hasher);
};

export const verifyCapabilityAttestation = (
  input: z.input<typeof capabilityAttestationWireSchema>,
  manifestInput: z.input<typeof capabilityManifestSchema>,
  hasher: CapabilityHasher,
): VerifiedCapabilityAttestation => {
  const manifest = capabilityManifestSchema.parse(manifestInput);
  const attestation = capabilityAttestationWireSchema.parse(input);
  const manifestFingerprint = fingerprintCapabilityManifest(manifest, hasher);

  if (
    attestation.manifestVersion !== manifest.version ||
    attestation.manifestFingerprint !== manifestFingerprint ||
    attestation.taskId !== manifest.taskId ||
    attestation.jobId !== manifest.jobId ||
    attestation.workspaceFingerprint !== manifest.workspaceFingerprint ||
    attestation.vendor !== manifest.vendor
  ) {
    throw new Error("attestation is not bound to this manifest");
  }
  if (!versionIsSupported(attestation.vendorVersion, manifest.vendorVersionRange)) {
    throw new Error("observed vendor version is outside the manifest range");
  }

  const observation = capabilityAttestationObservationSchema.parse({
    vendor: attestation.vendor,
    vendorVersion: attestation.vendorVersion,
    observedAt: attestation.observedAt,
    servers: attestation.servers,
  });
  const assessment = assessObservation(manifest, observation);
  if (
    !sameStrings(attestation.missingRequired, assessment.missingRequired) ||
    !sameStrings(attestation.unexpected, assessment.unexpected) ||
    attestation.hermeticity !== assessment.hermeticity
  ) {
    throw new Error("attestation policy assessment does not match manifest");
  }

  const {
    observedAt,
    stateFingerprint,
    fingerprint,
    ...boundWithoutFingerprints
  } = attestation;
  const expectedState = fingerprintCapabilityState(
    boundWithoutFingerprints,
    hasher,
  );
  if (stateFingerprint !== expectedState) {
    throw new Error("state fingerprint does not match attestation body");
  }

  const expectedIntegrity = fingerprintCapabilityIntegrity(
    {
      ...boundWithoutFingerprints,
      observedAt,
      stateFingerprint,
    },
    hasher,
  );
  if (fingerprint !== expectedIntegrity) {
    throw new Error("fingerprint does not match attestation body");
  }

  return attestation as VerifiedCapabilityAttestation;
};

export const verifyCapabilityRunEnvelope = (
  input: z.input<typeof capabilityRunEnvelopeWireSchema>,
  hasher: CapabilityHasher,
): VerifiedCapabilityRunEnvelope => {
  const envelope = capabilityRunEnvelopeWireSchema.parse(input);
  return {
    manifest: envelope.manifest,
    ...(envelope.attestation
      ? {
          attestation: verifyCapabilityAttestation(
            envelope.attestation,
            envelope.manifest,
            hasher,
          ),
        }
      : {}),
  } as VerifiedCapabilityRunEnvelope;
};
