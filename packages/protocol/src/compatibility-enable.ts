import { z } from "zod";
import type { ImportedItem } from "./compatibility-import.js";
import { mcpServerConfigSchema, type McpServerConfig } from "./lane-profile.js";

/**
 * ADR-0038 slice 2 — ENABLE, the authority half.
 *
 * Slice 1 (`compatibility-import.ts`) reads a vendor's configuration and
 * inventories it. That is a read: it grants nothing, and the file deliberately
 * contains no function that could. This file is the other half, and it exists
 * only because the founder answered the ADR's two open questions on
 * 2026-08-09:
 *
 *   D7 — MCP SERVERS ONLY. Skills and hooks stay discover-only until an
 *        attestation story for them exists, because D2's diff over a thing
 *        MUON cannot attest is a description of a plan.
 *   D8 — an enabled server MAY reach an agent-dispatched lane, bound per
 *        lane, enabled only by a human, re-attested per run and DISABLED on
 *        drift.
 *
 * Everything here is pure: no filesystem, no database, no clock. The backend
 * owns those (`backend/src/lib/compatibility-enable.ts`); this module owns the
 * rules, so the CLI, the desktop and the backend cannot each hold a different
 * idea of what may be enabled or what an enable did.
 */

/**
 * ADR-0038 D7. A POSITIVE list of what may be enabled — never a subtraction.
 *
 * ADR-0022 rule 2 has broken this codebase four times, most recently when a
 * new tier silently became forbidden because a forbidden set was derived as
 * `SUPERSET − allowed`. The failure mode here would be worse and the opposite:
 * a new item kind — a skill, a hook, a plugin — arriving ENABLEABLE because
 * nobody wrote a subtraction for it. A kind is enableable iff it is written
 * down here, and adding one means bringing its attestation with it.
 */
export const ENABLEABLE_ITEM_KINDS = ["mcp_server"] as const;
export type EnableableItemKind = (typeof ENABLEABLE_ITEM_KINDS)[number];

/**
 * Why this kind cannot be enabled, or `null` when it can.
 *
 * Returns a SENTENCE rather than a boolean because every surface that refuses
 * has to say why (ADR-0033: a refusal explains itself), and a refusal composed
 * separately on three surfaces is three refusals that will drift.
 */
export function enableRefusalForKind(kind: string): string | null {
  if ((ENABLEABLE_ITEM_KINDS as readonly string[]).includes(kind)) return null;
  return (
    `MUON can enable MCP servers only (ADR-0038 D7). A ${kind || "(unnamed)"} ` +
    `can be discovered and listed, but not enabled: MUON cannot yet attest ` +
    `its effective state, so the before/after diff an enable must show would ` +
    `describe an intention rather than a verified change.`
  );
}

/** True only for a kind on the positive list. */
export function isEnableableKind(kind: string): kind is EnableableItemKind {
  return enableRefusalForKind(kind) === null;
}

/**
 * The shape of a D3 fingerprint, wherever it was computed.
 *
 * The COMPUTATION lives in `./compatibility-digest.js`, a Node-only subpath,
 * because it needs `node:crypto` and this module is aggregated into the
 * browser-safe protocol root (a lock enforces that, and it caught the first
 * version of this file). Splitting them is the same precedent `project-setup`
 * set: the renderer displays a digest, it never computes one.
 */
export const importDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "expected a sha256 import fingerprint");

/** ADR-0038 D3: enabled, or disabled BECAUSE the item changed underneath. */
export const enabledStateSchema = z.enum(["enabled", "disabled-drift"]);
export type EnabledState = z.infer<typeof enabledStateSchema>;

export const enabledItemSchema = z.object({
  kind: z.enum(ENABLEABLE_ITEM_KINDS),
  name: z.string().min(1).max(128),
  vendor: z.string().min(1).max(64),
  /** ADR-0038 D6/D8: bound to exactly one lane, never to the workspace. */
  laneKey: z.string().min(1).max(128),
  /** The digest at the moment a human approved THIS item. */
  enabledDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** The digest observed when re-attestation disabled it; absent while live. */
  driftDigest: z
    .union([z.string().regex(/^sha256:[a-f0-9]{64}$/), z.literal("absent")])
    .optional(),
  state: enabledStateSchema,
  /** Credentials MUON refused to carry, restated so no surface forgets. */
  secretsRefused: z.array(z.string().max(128)).max(96).default([]),
  enabledBy: z.string().min(1).max(256),
  enabledAt: z.string(),
});
export type EnabledItem = z.infer<typeof enabledItemSchema>;

/**
 * ADR-0038 D5 — the shape reaches the lane, the secrets never do.
 *
 * `env` is EMPTY, and that is the decision rather than an omission: copying an
 * env block — or reading the operator's environment at spawn time — makes MUON
 * a second place the user's secrets live, which nobody designed it to be.
 *
 * WHICH IS WHY AN ITEM THAT NEEDS ONE IS NOT ENABLED AT ALL. This docstring
 * used to say such a server "will start and fail to authenticate until the
 * human supplies it through the vendor's own path", and a review showed that
 * advice was never true: MUON hands the lane its OWN generated server config,
 * so the vendor's copy of those values is never consulted. Worse, a credential
 * in a url or an argument is REPLACED with a redaction marker, so the endpoint
 * it would dial does not exist. The backend refuses the enable outright
 * (`secretsRefused.length > 0`), which keeps the failure at the moment of
 * decision instead of the moment of use. This function therefore only ever
 * materializes an item that needs nothing.
 */
export function materializeEnabledServer(item: ImportedItem): McpServerConfig {
  return mcpServerConfigSchema.parse({
    name: item.name,
    ...(item.shape.command ? { command: item.shape.command } : {}),
    args: item.shape.args,
    ...(item.shape.url ? { url: item.shape.url } : {}),
    env: {},
  });
}

export const capabilityDiffSchema = z.object({
  /** Server names reachable by the lane BEFORE, from attested state. */
  before: z.array(z.string()),
  /** …and after. */
  after: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type CapabilityDiff = z.infer<typeof capabilityDiffSchema>;

/**
 * ADR-0038 D2 — the diff is a statement about state MUON verified.
 *
 * Both sides are lists the caller ATTESTED (re-read the vendor config,
 * recomputed each digest), never the enable request's own claim about what it
 * will add. An importer that renders its intent as the diff is describing a
 * plan: if the vendor resolves the item differently, the human approved a
 * description that was never true.
 *
 * Note the honest limit, stated here because a doc that overclaims is worse
 * than one that is silent: what MUON attests is the item's SHAPE as read from
 * the vendor's configuration. It does not enumerate the server's TOOLS, which
 * would mean executing a third-party binary at enable time. A server that
 * registers nine tools where its config names two is therefore outside what
 * this diff can see, and D3's per-run re-attestation is what bounds the
 * consequence: the shape it was approved as is the shape it must still be.
 */
export function diffServerNames(
  before: readonly string[],
  after: readonly string[]
): CapabilityDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return capabilityDiffSchema.parse({
    before: [...before].sort(),
    after: [...after].sort(),
    added: [...after].filter((name) => !beforeSet.has(name)).sort(),
    removed: [...before].filter((name) => !afterSet.has(name)).sort(),
  });
}

export const enableRequestSchema = z.object({
  /**
   * The item is named, never described. ADR-0038 D2: the backend re-reads the
   * vendor configuration and computes the shape itself, so a caller cannot
   * enable a server whose config says one thing by sending another.
   */
  vendor: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
});
export type EnableRequest = z.infer<typeof enableRequestSchema>;

export const enableResultSchema = z.object({
  item: enabledItemSchema,
  diff: capabilityDiffSchema,
  /**
   * Env variable NAMES the item declares that MUON will NOT pass to the lane.
   *
   * Reachable, unlike the `credentialsStillNeeded` field this replaces —
   * that one could only ever be empty because enable refuses a
   * credential-bearing item outright. This one fires whenever an item
   * declares any env at all, because MUON imports NAMES only (D5) and
   * materializes `env: {}`. The server still launches; it launches without
   * those variables, and a human who is not told that debugs the wrong thing.
   */
  envNotCarried: z.array(z.string()),
});
export type EnableResult = z.infer<typeof enableResultSchema>;

/**
 * One item that re-attestation DISABLED, and the evidence for it.
 *
 * ADR-0038 D3 is deliberately harsher than its neighbours: a fingerprint that
 * changed underneath a human's approval is the supply-chain shape MUON exists
 * to refuse, and a warning about it is a notification that it already
 * happened. So this is a record of a disable, not of a warning.
 */
export const attestationDriftSchema = z.object({
  name: z.string(),
  vendor: z.string(),
  approvedDigest: z.string(),
  /** "absent" when the item is no longer in the vendor's configuration. */
  observedDigest: z.string(),
  reason: z.string(),
});
export type AttestationDrift = z.infer<typeof attestationDriftSchema>;

export const laneAttestationSchema = z.object({
  laneKey: z.string(),
  /** The servers this lane may use RIGHT NOW, after drift was removed. */
  servers: z.array(mcpServerConfigSchema),
  disabled: z.array(attestationDriftSchema),
});
export type LaneAttestation = z.infer<typeof laneAttestationSchema>;

/**
 * Why an item drifted, in the words a human reads on every surface.
 *
 * Split by cause because the two are different facts and a human answers them
 * differently: a server that VANISHED from the config is usually the user's
 * own edit, while one whose shape changed is the case worth stopping for.
 */
export function describeDrift(drift: AttestationDrift): string {
  return drift.observedDigest === "absent"
    ? `${drift.name} (${drift.vendor}) is no longer in ${drift.vendor}'s configuration, so MUON disabled it for this lane.`
    : `${drift.name} (${drift.vendor}) is not the server that was approved — its shape changed — so MUON disabled it for this lane. Re-enable it to approve the new shape.`;
}

/**
 * What a human is shown about one enabled item. States no risk score and no
 * recommendation, for the reason `describeImportedItem` gives: a surface that
 * says "this one looks fine" is one an importer learns to trust instead of
 * reading.
 */
export function describeEnabledItem(item: EnabledItem): string {
  const secrets =
    item.secretsRefused.length > 0
      ? ` Needs ${item.secretsRefused.length} credential(s) MUON does not carry (${item.secretsRefused.join(", ")}).`
      : "";
  return item.state === "enabled"
    ? `${item.name} (from ${item.vendor}) — enabled for lane ${item.laneKey} by ${item.enabledBy}.${secrets}`
    : `${item.name} (from ${item.vendor}) — DISABLED for lane ${item.laneKey}: the item changed after it was approved.${secrets}`;
}
