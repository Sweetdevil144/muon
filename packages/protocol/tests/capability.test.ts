import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  capabilityAttestationObservationSchema,
  capabilityAttestationWireSchema,
  capabilityManifestSchema,
  capabilityRunEnvelopeWireSchema,
  finalizeCapabilityAttestation,
  fingerprintCapabilityManifest,
  verifyCapabilityAttestation,
  verifyCapabilityRunEnvelope,
  type CapabilityHasher,
  type VerifiedCapabilityAttestation,
  type VerifiedCapabilityRunEnvelope,
} from "../src/capability.js";
import { laneProfileSchema } from "../src/lane-profile.js";

const taskId = "clx123456000008l5d7d1abcd";
const jobId = "clx123456000018l5d7d1abce";
const otherTaskId = "clx123456000028l5d7d1abcf";
const workspaceFingerprint = `sha256:${"a".repeat(64)}`;
const otherWorkspaceFingerprint = `sha256:${"9".repeat(64)}`;
const contextIdentity = `sha256:${"b".repeat(64)}`;
const controlIdentity = `sha256:${"c".repeat(64)}`;
const principalId = `principal:${"d".repeat(16)}`;
const childPrincipalId = `principal:${"e".repeat(16)}`;

const sha256: CapabilityHasher = (canonical) =>
  `sha256:${createHash("sha256").update(canonical).digest("hex")}`;

function manifestInput(): z.output<typeof capabilityManifestSchema> {
  return {
    version: 1,
    taskId,
    jobId,
    workspaceFingerprint,
    mode: "governed",
    vendor: "codex",
    vendorVersionRange: {
      minInclusive: "0.90.0",
      maxExclusive: "1.0.0",
    },
    principals: [
      {
        principalId,
        depth: 0,
        maxDepth: 1,
      },
    ],
    servers: [
      {
        logicalId: "muon_context",
        expectedIdentity: contextIdentity,
        source: "muon",
        authority: "context",
        required: true,
        enabledTools: ["memory_preedit", "task_context"],
        disabledTools: [],
        propagate: "explicit-children",
        authentication: "muon-agent-token",
      },
    ],
  };
}

function observationInput(): z.output<
  typeof capabilityAttestationObservationSchema
> {
  return {
    vendor: "codex",
    vendorVersion: "0.99.0",
    observedAt: "2026-07-14T12:00:00.000Z",
    servers: [
      {
        logicalId: "muon_context",
        observedIdentity: contextIdentity,
        source: "muon",
        connected: true,
        authenticated: "yes",
        tools: ["task_context", "memory_preedit"],
      },
    ],
  };
}

describe("capability manifest", () => {
  it("accepts a governed manifest and preserves exact authority classes", () => {
    const parsed = capabilityManifestSchema.parse(manifestInput());

    expect(parsed.servers).toEqual([
      expect.objectContaining({
        logicalId: "muon_context",
        authority: "context",
        authentication: "muon-agent-token",
        propagate: "explicit-children",
      }),
    ]);
    expect(parsed.vendor).toBe("codex");
    expect(parsed.vendorVersionRange).toEqual({
      minInclusive: "0.90.0",
      maxExclusive: "1.0.0",
    });
  });

  it("rejects an ambiguous exact and ranged vendor version contract", () => {
    const input = manifestInput();
    input.vendorVersionRange = {
      ...input.vendorVersionRange,
      exact: "0.99.0",
    };

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /exact version cannot be combined with a range/,
    );
  });

  it("rejects duplicate logical server identities", () => {
    const input = manifestInput();
    input.servers.push({
      ...input.servers[0],
      authority: "control",
    });

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /duplicate logicalId/,
    );
  });

  it("rejects a principal depth beyond its declared budget", () => {
    const input = manifestInput();
    input.principals[0].depth = 2;

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /depth cannot exceed maxDepth/,
    );
  });

  it("rejects cyclic or false principal lineage", () => {
    const input = manifestInput();
    input.principals = [
      {
        principalId,
        parentId: childPrincipalId,
        depth: 0,
        maxDepth: 2,
      },
      {
        principalId: childPrincipalId,
        parentId: principalId,
        depth: 1,
        maxDepth: 2,
      },
    ];

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /root principal cannot declare a parent/,
    );
    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /principal lineage cannot contain a cycle/,
    );
  });

  it("requires non-root principals to follow the parent depth and budget", () => {
    const input = manifestInput();
    input.principals.push({
      principalId: childPrincipalId,
      parentId: principalId,
      depth: 2,
      maxDepth: 2,
    });

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /child depth must equal parent depth \+ 1/,
    );
  });

  it("rejects contradictory enabled and disabled tool policy", () => {
    const input = manifestInput();
    input.servers[0].disabledTools = ["memory_preedit"];

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /tool cannot be both enabled and disabled/,
    );
  });

  it("rejects unknown credential fields without echoing their values", () => {
    const sentinel = "sk-muon-capability-sentinel";

    const result = capabilityManifestSchema.safeParse({
      ...manifestInput(),
      credentialValue: sentinel,
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain(sentinel);
  });

  it("rejects raw identity text instead of accepting it as an evidence fingerprint", () => {
    const input = manifestInput();
    input.servers[0].expectedIdentity = "sk-muon-capability-sentinel";

    expect(() => capabilityManifestSchema.parse(input)).toThrow();
  });

  it("rejects credential markers embedded inside a defined identifier", () => {
    const input = manifestInput();
    input.servers[0].enabledTools = ["mcp/github_pat_secretvalue"];

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /must not be credential-shaped/,
    );
  });

  it.each([
    "mcp/AKIAIOSFODNN7EXAMPLE",
    "mcp/AIzaSyA1234567890abcdefgh",
  ])("rejects a realistic embedded credential value: %s", (credential) => {
    const input = manifestInput();
    input.servers[0].enabledTools = [credential];

    expect(() => capabilityManifestSchema.parse(input)).toThrow(
      /must not be credential-shaped/,
    );
  });

  it("uses a transient run envelope instead of persisting task state in a lane profile", () => {
    expect(
      laneProfileSchema.parse({
        capabilityManifest: manifestInput(),
      }),
    ).not.toHaveProperty("capabilityManifest");

    expect(
      capabilityRunEnvelopeWireSchema.parse({
        manifest: manifestInput(),
      }).manifest,
    ).toEqual(capabilityManifestSchema.parse(manifestInput()));
  });

  it("bounds persisted task identifiers before hashing", () => {
    expect(() =>
      capabilityManifestSchema.parse({
        ...manifestInput(),
        taskId: `c${"a".repeat(200_000)}`,
      }),
    ).toThrow();
  });
});

describe("capability evidence fingerprints", () => {
  it("keeps a stable state hash but changes full integrity when observation time changes", () => {
    const first = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );
    const second = finalizeCapabilityAttestation(
      manifestInput(),
      {
        ...observationInput(),
        observedAt: "2026-07-14T13:00:00.000Z",
      },
      sha256,
    );

    expect(first.stateFingerprint).toBe(second.stateFingerprint);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("changes state and integrity when the effective tool inventory changes", () => {
    const first = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );
    const second = finalizeCapabilityAttestation(
      manifestInput(),
      {
        ...observationInput(),
        servers: [
          {
            ...observationInput().servers[0],
            tools: ["memory_preedit", "task_context", "dispatch"],
          },
        ],
      },
      sha256,
    );

    expect(first.stateFingerprint).not.toBe(second.stateFingerprint);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("derives missing required capabilities and non-hermetic posture", () => {
    const attestation = finalizeCapabilityAttestation(
      manifestInput(),
      {
        ...observationInput(),
        servers: [],
      },
      sha256,
    );

    expect(attestation.missingRequired).toEqual(["muon_context"]);
    expect(attestation.unexpected).toEqual([]);
    expect(attestation.hermeticity).toBe("non-hermetic");
  });

  it("derives identity and tool-policy drift instead of trusting vendor claims", () => {
    const attestation = finalizeCapabilityAttestation(
      manifestInput(),
      {
        ...observationInput(),
        servers: [
          {
            ...observationInput().servers[0],
            observedIdentity: controlIdentity,
            tools: ["dispatch"],
          },
        ],
      },
      sha256,
    );

    expect(attestation.missingRequired).toEqual(["muon_context"]);
    expect(attestation.unexpected).toEqual(["muon_context"]);
    expect(attestation.hermeticity).toBe("non-hermetic");
  });

  it("rejects an observed vendor version outside the manifest contract", () => {
    expect(() =>
      finalizeCapabilityAttestation(
        manifestInput(),
        {
          ...observationInput(),
          vendorVersion: "2.0.0",
        },
        sha256,
      ),
    ).toThrow(/observed vendor version is outside the manifest range/);
  });

  it("rejects duplicate observed server identities", () => {
    const input = observationInput();
    input.servers.push({
      ...input.servers[0],
      tools: ["dispatch"],
    });

    expect(() => capabilityAttestationObservationSchema.parse(input)).toThrow(
      /duplicate observed server logicalId/,
    );
  });

  it("finalizes and verifies an attestation bound to its manifest", () => {
    const finalized = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );

    expect(
      verifyCapabilityAttestation(finalized, manifestInput(), sha256),
    ).toEqual(finalized);
    expect(finalized.manifestFingerprint).toBe(
      fingerprintCapabilityManifest(manifestInput(), sha256),
    );
    expectTypeOf(finalized).toMatchTypeOf<VerifiedCapabilityAttestation>();
  });

  it("keeps wire-parsed evidence unverified until the verifier binds it", () => {
    const finalized = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );
    const wire = capabilityAttestationWireSchema.parse(finalized);
    const verified = verifyCapabilityAttestation(
      wire,
      manifestInput(),
      sha256,
    );

    expectTypeOf(wire).not.toMatchTypeOf<VerifiedCapabilityAttestation>();
    expectTypeOf(verified).toMatchTypeOf<VerifiedCapabilityAttestation>();
  });

  it("rejects a format-valid fingerprint that does not match the attestation body", () => {
    const finalized = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );

    expect(() =>
      verifyCapabilityAttestation(
        {
          ...finalized,
          fingerprint: `sha256:${"f".repeat(64)}`,
        },
        manifestInput(),
        sha256,
      ),
    ).toThrow(/fingerprint does not match attestation body/);
  });

  it("rejects rebinding an attestation to another task or workspace", () => {
    const finalized = finalizeCapabilityAttestation(
      manifestInput(),
      observationInput(),
      sha256,
    );
    const reboundManifest = {
      ...manifestInput(),
      taskId: otherTaskId,
      workspaceFingerprint: otherWorkspaceFingerprint,
    };

    expect(() =>
      verifyCapabilityAttestation(finalized, reboundManifest, sha256),
    ).toThrow(/attestation is not bound to this manifest/);
  });

  it("produces the same manifest fingerprint for semantically reordered tools", () => {
    const first = manifestInput();
    const second = manifestInput();
    second.servers[0].enabledTools = ["task_context", "memory_preedit"];

    expect(fingerprintCapabilityManifest(first, sha256)).toBe(
      fingerprintCapabilityManifest(second, sha256),
    );
  });

  it("verifies a complete transient run envelope", () => {
    const manifest = manifestInput();
    const attestation = finalizeCapabilityAttestation(
      manifest,
      observationInput(),
      sha256,
    );

    expect(
      verifyCapabilityRunEnvelope({ manifest, attestation }, sha256),
    ).toEqual({ manifest, attestation });
    expectTypeOf(
      verifyCapabilityRunEnvelope({ manifest, attestation }, sha256),
    ).toMatchTypeOf<VerifiedCapabilityRunEnvelope>();
  });

  it("bounds observation timestamps before hashing", () => {
    expect(() =>
      finalizeCapabilityAttestation(
        manifestInput(),
        {
          ...observationInput(),
          observedAt: `${"2".repeat(200_000)}Z`,
        },
        sha256,
      ),
    ).toThrow();
  });
});
