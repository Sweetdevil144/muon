import {
  describeDrift,
  enabledItemSchema,
  diffServerNames,
  enableRefusalForKind,
  materializeEnabledServer,
  type AttestationDrift,
  type CapabilityDiff,
  type EnabledItem,
  type ImportedItem,
  type LaneAttestation,
  type McpServerConfig,
} from "@muon/protocol";
import { importItemDigest } from "@muon/protocol/compatibility-digest";
import { MUON_MCP_SERVER_NAME } from "@muon/core";
import { Prisma } from "@prisma/client";
import type { ImportedCapability } from "@prisma/client";
import { prisma } from "./db.js";
import {
  discoverCompatibilityInventory,
  type CompatibilityInventory,
} from "./compatibility-discovery.js";

/**
 * ADR-0038 slice 2 — the authority half of compatibility import.
 *
 * Slice 1 reads the human's vendor configuration and inventories it. This file
 * turns ONE of those items into a capability ONE lane holds, and then spends
 * the rest of its life trying to take it away again:
 *
 *   enable  — a human names an item and a lane. MUON re-reads the vendor
 *             config, fingerprints what it ACTUALLY finds, stores the shape,
 *             and returns a before/after diff computed from attested state on
 *             both sides (D2).
 *   attest  — before every governed run. Re-reads, recomputes, and DISABLES
 *             anything whose fingerprint moved (D3). Not a warning.
 *   disable — a human takes it back. One row, one lane.
 *
 * Two properties are structural rather than enforced by review:
 *
 *  - There is no bulk verb. No `enableAll`, no vendor-wide enable, no
 *    workspace scope. D6/D8: a lane's imported set is built by listing what it
 *    holds, and a new import lands in ZERO lanes until someone puts it in one.
 *  - Nothing here reads the caller's claim about an item's shape. The only
 *    inputs are a lane, a vendor and a NAME; the shape always comes from
 *    re-reading the vendor's own file. An enable that trusted a request body
 *    would let a caller approve a server whose config says something else.
 */

/** ADR-0038 D3 states, mirrored from the protocol's `enabledStateSchema`. */
const STATE_ENABLED = "enabled";
const STATE_DISABLED_DRIFT = "disabled-drift";

/** The one kind slice 2 may enable (D7). Kept as a constant for the query. */
const KIND_MCP_SERVER = "mcp_server";

export class CompatibilityEnableError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "CompatibilityEnableError";
    this.statusCode = statusCode;
  }
}

/**
 * ONE sentence for the name collision, whichever layer catches it.
 *
 * The advisory check catches the ordinary case and can name the vendor that
 * holds it; the unique index catches the concurrent one and cannot, so it
 * says "another vendor". Both explain the same rule and the same remedy —
 * ADR-0033, and the reason this is a function rather than two string literals.
 */
function nameCollision(
  laneKey: string,
  name: string,
  holder: string,
  wanted: string
): CompatibilityEnableError {
  return new CompatibilityEnableError(
    409,
    `Lane "${laneKey}" already has a server named "${name}", imported from ${holder}. A lane's MCP server map is keyed by name, so it can hold only one — disable ${holder}'s "${name}" first if you want ${wanted}'s instead.`
  );
}

/** Prisma's unique-constraint code, the only one this path can provoke. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * The stored row, taken FROM PRISMA rather than re-declared beside it.
 *
 * It used to be a hand-written shadow of the model, and every read was cast
 * through `as StoredRow[]`. An adversarial review named the cost: a schema
 * change could drift from this authority boundary — including the fields that
 * decide WHICH third-party server a lane runs — with nothing to catch it. The
 * generated type means a column that moves breaks the compile here.
 */
type StoredRow = ImportedCapability;


function secretsOf(row: StoredRow): string[] {
  return Array.isArray(row.secretsRefused)
    ? row.secretsRefused.filter((value): value is string => typeof value === "string")
    : [];
}

/**
 * A stored row as the shared `EnabledItem` every surface renders.
 *
 * `laneKey` rather than `laneId`: the id is MUON's internal handle and means
 * nothing to a human reading a refusal, while the key is what they typed.
 */
function toEnabledItem(row: StoredRow, laneKey: string): EnabledItem {
  // AN UNKNOWN STORED STATE IS REFUSED, NOT REINTERPRETED.
  //
  // This used to map anything that was not `enabled` to `disabled-drift`, so a
  // state introduced by a later migration — or a hand-edited row — would have
  // been silently re-described as a supply-chain disable, complete with a
  // reason it never had. A persistence-to-domain boundary that COERCES is a
  // boundary that lies on the one input it exists to check.
  if (row.state !== STATE_ENABLED && row.state !== STATE_DISABLED_DRIFT) {
    // 409, not 500. A 500 is masked by the framework ("Unexpected server
    // error") — correct for an internal fault, wrong here, because this is an
    // ACTIONABLE conflict between what the store holds and what MUON can
    // represent, and the operator reading it is the person who can resolve it.
    throw new CompatibilityEnableError(
      409,
      `Lane "${laneKey}" holds ${row.vendor}'s "${row.itemName}" in an unrecognised state ("${row.state}"). MUON will not guess what that means about a capability; the row needs a migration or a human.`
    );
  }
  // PARSED, not cast. The projection used to be hand-built and asserted with
  // `as EnabledItem`, so only the state and the string-array membership were
  // ever checked — a malformed digest, an oversized principal or a bad
  // timestamp escaped this boundary and became a response-parsing failure
  // somewhere downstream, where nobody can tell what went wrong. The schema is
  // the boundary; failing it is a controlled conflict with a sentence.
  const parsed = enabledItemSchema.safeParse({
    kind: KIND_MCP_SERVER,
    name: row.itemName,
    vendor: row.vendor,
    laneKey,
    enabledDigest: row.enabledDigest,
    ...(row.driftDigest ? { driftDigest: row.driftDigest } : {}),
    state: row.state === STATE_ENABLED ? "enabled" : "disabled-drift",
    secretsRefused: secretsOf(row),
    enabledBy: row.enabledBy,
    enabledAt: row.enabledAt.toISOString(),
  });
  if (!parsed.success) {
    throw new CompatibilityEnableError(
      409,
      `Lane "${laneKey}" holds a stored capability row MUON cannot read back (${row.vendor}'s "${row.itemName}"): ${parsed.error.issues[0]?.message ?? "it does not match the record shape"}. The row needs a migration or a human.`
    );
  }
  return parsed.data;
}

async function requireLane(laneKey: string): Promise<{ id: string; key: string }> {
  const lane = await prisma.lane.findUnique({ where: { key: laneKey } });
  if (!lane) {
    throw new CompatibilityEnableError(
      404,
      `No lane named "${laneKey}". An imported server is bound to one named lane (ADR-0038 D6), so there is nothing to bind it to.`
    );
  }
  return { id: lane.id, key: lane.key };
}

/**
 * Find ONE item in the live inventory, by vendor and name.
 *
 * Deliberately re-reads the configuration on every call rather than trusting
 * anything stored: this is the "attested state" half of D2, and a cached
 * inventory would make the diff a statement about the past.
 */
function findLiveItem(
  inventory: CompatibilityInventory,
  vendor: string,
  name: string
): ImportedItem | undefined {
  return inventory.items.find(
    (item) => item.provenance.vendor === vendor && item.name === name
  );
}

/** The server names a lane can reach right now, from its stored rows. */
function enabledNames(rows: readonly StoredRow[]): string[] {
  return rows
    .filter((row) => row.state === STATE_ENABLED)
    .map((row) => row.itemName);
}

/**
 * ADR-0038 D1/D2/D7/D8 — a human enables ONE item for ONE lane.
 *
 * The sequence is attest → apply → re-attest → diff, and every step reads the
 * vendor's configuration rather than the request:
 *
 *  1. read the live inventory and locate the named item; refuse if it is not
 *     there, or if its kind is not on D7's positive list;
 *  2. record what the lane could reach BEFORE, from stored state;
 *  3. write the row, bound to this lane, with the digest of what was just
 *     read;
 *  4. re-read the lane's state and diff the two.
 *
 * A diff that cannot be computed is never rendered as "no change" — the
 * refusals above throw first.
 */
export async function enableImportedItem(input: {
  laneKey: string;
  vendor: string;
  name: string;
  principal: string;
  inventory?: CompatibilityInventory;
}): Promise<{
  item: EnabledItem;
  diff: CapabilityDiff;
  envNotCarried: string[];
}> {
  const lane = await requireLane(input.laneKey);
  const inventory = input.inventory ?? discoverCompatibilityInventory();
  const live = findLiveItem(inventory, input.vendor, input.name);

  if (!live) {
    // Distinguish "not in the config" from "unreadable": the second is a fact
    // the human can act on, and collapsing them is how an import surface tells
    // someone their server does not exist when MUON simply could not parse it.
    const unreadable = inventory.unreadable.find(
      (entry) => entry.vendor === input.vendor && entry.name === input.name
    );
    throw new CompatibilityEnableError(
      404,
      unreadable
        ? `MUON found "${input.name}" in ${input.vendor}'s configuration but could not read it: ${unreadable.reason}. It cannot be enabled until MUON can say what it launches.`
        : `${input.vendor} has no MCP server named "${input.name}" in the configuration MUON reads. Nothing was enabled.`
    );
  }

  const kindRefusal = enableRefusalForKind(live.kind);
  if (kindRefusal) throw new CompatibilityEnableError(400, kindRefusal);

  // EXACTLY ONE OF command OR url, checked HERE rather than at launch.
  //
  // `materializeEnabledServer` parses through a schema that requires it, so an
  // item carrying both — or neither — was accepted at discovery, enabled with
  // a success message, and then threw on every attestation afterwards. The
  // lane started WITHOUT the import it had been told it had, which is the
  // fail-open shape: an approval that silently does not apply.
  if (Boolean(live.shape.command) === Boolean(live.shape.url)) {
    throw new CompatibilityEnableError(
      400,
      `"${live.name}" declares ${
        live.shape.command ? "BOTH a command and a url" : "neither a command nor a url"
      }, so MUON cannot say what it would launch. It is refused here rather than enabled into a lane where every run would drop it silently.`
    );
  }

  if (live.secretsRefused.length > 0) {
    // A SERVER MUON CANNOT MAKE WORK IS NOT ENABLED, AND IS SAID SO.
    //
    // ADR-0038 D5 keeps credentials vendor-owned: MUON imports the item's
    // SHAPE and refuses its secrets. What the shape then looks like is the
    // part this refusal exists for — a review traced it end to end and every
    // case is broken, not merely incomplete:
    //
    //   env    materializes as `env: {}`, and MUON passes its OWN generated
    //          server config to the vendor, so the vendor's copy is never
    //          consulted — the process launches without the variable.
    //   url    a credential in the path, query or userinfo is REPLACED with
    //          `***`, so the endpoint it would dial does not exist.
    //   args   a credential-bearing argument is replaced the same way.
    //
    // So the previous behaviour enabled it, told the human "supply them
    // through the vendor's own configuration", and produced a lane holding a
    // server that could never authenticate — advice that was not true and a
    // capability that was not real. Refusing is the honest outcome until MUON
    // has a credential story, and it keeps the failure at the moment of
    // decision rather than at the moment of use.
    throw new CompatibilityEnableError(
      400,
      `"${live.name}" needs ${live.secretsRefused.length} credential(s) MUON deliberately does not carry (${live.secretsRefused.join(", ")}). MUON hands the lane its OWN generated server config, so ${input.vendor}'s copy of those values is never consulted and the server could not authenticate — it is refused rather than enabled into a lane where it would silently fail. Servers that need no credentials can be enabled today.`
    );
  }

  if (live.name === MUON_MCP_SERVER_NAME) {
    // MUON'S OWN NAME IS NOT AVAILABLE. An imported server called `muon` would
    // share a key with MUON's governed MCP in the vendor's server map, and
    // depending on that vendor's merge order could REPLACE it — a third-party
    // binary answering the tool calls MUON's entire governance model assumes
    // it answers itself. Refused here so it never enters the store, and
    // refused again where the run is assembled, because that is the boundary
    // that actually has to hold.
    throw new CompatibilityEnableError(
      400,
      `"${MUON_MCP_SERVER_NAME}" is the name of MUON's own governed MCP server. An imported server cannot be enabled under it, because it would sit in the same server map and could replace the one MUON governs through. Rename it in ${input.vendor}'s configuration to import it.`
    );
  }

  return prisma.$transaction(
    async (tx) => enableWithin(tx, lane, live, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/**
 * The read → write → read that produces the human's diff, INSIDE one
 * serializable transaction.
 *
 * An adversarial review found what three separate operations allowed: another
 * operator's concurrent enable or disable landing between the `before` read
 * and the `after` read, so this approval's receipt claimed it had added or
 * removed a capability it never touched. A receipt whose diff is not about the
 * decision it describes is worse than no diff — it is evidence pointing at the
 * wrong human.
 */
async function enableWithin(
  tx: Pick<typeof prisma, "importedCapability">,
  lane: { id: string; key: string },
  live: ImportedItem,
  input: { laneKey: string; vendor: string; principal: string }
): Promise<{
  item: EnabledItem;
  diff: CapabilityDiff;
  envNotCarried: string[];
}> {
  const existing = (await tx.importedCapability.findMany({
    where: { laneId: lane.id },
  }));

  // ONE SERVER PER NAME, PER LANE — refused here, where a human can see it.
  //
  // The store's key is (lane, vendor, kind, name), which correctly lets two
  // VENDORS each define a `linear`. What it does not change is the runtime:
  // an MCP server map is keyed by NAME, so a lane can hold exactly one server
  // called `linear` no matter how many vendors offer one. An adversarial
  // review found what that meant end to end — both rows enable, the diff is
  // name-only so it cannot tell them apart, attestation had no ordering, and
  // the runner takes the first match. Which endpoint actually launched was
  // database-order dependent, and could differ from what the human's diff
  // said they were approving.
  //
  // So the collision is refused at the point of decision rather than resolved
  // by luck at spawn. The message names the vendor that already holds it,
  // because "disable that one first" is the whole remedy.
  // ADVISORY, and the unique index is the fence. A check-then-upsert is not
  // atomic — an adversarial review found two concurrent enables from different
  // vendors both passing this — so the constraint decides and this exists to
  // make the refusal readable when it fires the ordinary way.
  const nameHolder = existing.find(
    (row) => row.itemName === live.name && row.vendor !== input.vendor
  );
  if (nameHolder) {
    throw nameCollision(input.laneKey, live.name, nameHolder.vendor, input.vendor);
  }

  const before = enabledNames(existing);

  const digest = importItemDigest(live);

  // CREATE-THEN-GUARDED-UPDATE, not an upsert.
  //
  // An adversarial review found what a plain upsert allowed: this reads the
  // lane's rows, then writes. If another operator disables `linear` and
  // enables a DIFFERENT vendor's `linear` in between, the upsert takes its
  // UPDATE path and overwrites that newer decision's vendor, digest and shape
  // — launching a server the latest human decision did not approve, and
  // bypassing the collision refusal entirely.
  //
  // So the update is GUARDED on the vendor. Zero rows updated means the name
  // is held by someone else now, which IS the collision, refused with the same
  // sentence the advisory check gives.
  try {
    await tx.importedCapability.create({
      data: {
        laneId: lane.id,
        vendor: input.vendor,
        itemKind: live.kind,
        itemName: live.name,
        enabledDigest: digest,
        shape: live.shape as unknown as Prisma.InputJsonValue,
        secretsRefused: live.secretsRefused as unknown as Prisma.InputJsonValue,
        state: STATE_ENABLED,
        enabledBy: input.principal,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // RE-ENABLING IS RE-APPROVING. A row that drift disabled comes back only
    // with the digest of what is there NOW, and its drift evidence is cleared
    // — otherwise the next attestation would compare today's shape against a
    // fingerprint the human never saw.
    const updated = await tx.importedCapability.updateMany({
      where: {
        laneId: lane.id,
        itemKind: live.kind,
        itemName: live.name,
        // THE GUARD: only the vendor that already holds this name may
        // re-approve it.
        vendor: input.vendor,
      },
      data: {
        enabledDigest: digest,
        shape: live.shape as unknown as Prisma.InputJsonValue,
        secretsRefused: live.secretsRefused as unknown as Prisma.InputJsonValue,
        state: STATE_ENABLED,
        driftDigest: null,
        driftReason: null,
        disabledAt: null,
        enabledBy: input.principal,
      },
    });
    if (updated.count === 0) {
      throw nameCollision(input.laneKey, live.name, "another vendor", input.vendor);
    }
  }

  const rows = (await tx.importedCapability.findMany({
    where: { laneId: lane.id },
  }));
  const row = rows.find(
    (candidate) =>
      candidate.vendor === input.vendor && candidate.itemName === live.name
  )!;

  return {
    item: toEnabledItem(row, lane.key),
    diff: diffServerNames(before, enabledNames(rows)),
    // Names only, because names are all MUON imported (D5). Said out loud so
    // a human debugging a server that starts but misbehaves knows why.
    envNotCarried: live.shape.envKeys,
  };
}

/** A human takes it back. One row, one lane, and the diff that proves it. */
export async function disableImportedItem(input: {
  laneKey: string;
  vendor: string;
  name: string;
}): Promise<{ diff: CapabilityDiff }> {
  const lane = await requireLane(input.laneKey);
  // ONE TRANSACTION, for the same reason enable has one: the before-read, the
  // delete and the after-read are three operations, so another operator's
  // concurrent decision could appear in a diff that claims to describe THIS
  // one — an authority receipt pointing at the wrong human.
  return prisma.$transaction(
    async (tx) => disableWithin(tx, lane, input),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

async function disableWithin(
  tx: Pick<typeof prisma, "importedCapability">,
  lane: { id: string; key: string },
  input: { laneKey: string; vendor: string; name: string }
): Promise<{ diff: CapabilityDiff }> {
  const before = enabledNames(
    (await tx.importedCapability.findMany({
      where: { laneId: lane.id },
    }))
  );

  const deleted = await tx.importedCapability.deleteMany({
    where: {
      laneId: lane.id,
      vendor: input.vendor,
      itemKind: KIND_MCP_SERVER,
      itemName: input.name,
    },
  });
  if (deleted.count === 0) {
    throw new CompatibilityEnableError(
      404,
      `Lane "${input.laneKey}" does not have ${input.vendor}'s "${input.name}" enabled, so there was nothing to disable.`
    );
  }

  const after = enabledNames(
    (await tx.importedCapability.findMany({
      where: { laneId: lane.id },
    }))
  );
  return { diff: diffServerNames(before, after) };
}

/** Everything a lane holds, live and disabled alike. Read-only. */
export async function listLaneImports(laneKey: string): Promise<EnabledItem[]> {
  const lane = await requireLane(laneKey);
  const rows = (await prisma.importedCapability.findMany({
    where: { laneId: lane.id },
    orderBy: [{ vendor: "asc" }, { itemName: "asc" }],
  }));
  return rows.map((row) => toEnabledItem(row, lane.key));
}

/**
 * ADR-0038 D3 — re-attest before a governed run, and DISABLE what moved.
 *
 * This is the clause that pays for D8's width. An agent-dispatched lane runs
 * unattended, so the human who approved an item is not present when a
 * third-party server updates underneath them. A warning would be a
 * notification that it already happened; this disables the row, records both
 * fingerprints, and lets the run proceed WITHOUT it.
 *
 * Two shapes of drift, both disabling:
 *   - the item is gone from the vendor's configuration → `observed: "absent"`;
 *   - the item is there and its fingerprint differs → the new digest.
 *
 * Disabling is not deletion. The row stays, marked, with both digests, so
 * re-enabling is one informed human action (`enableImportedItem` re-approves
 * against today's shape).
 */
export async function attestLaneImports(
  laneKey: string,
  inventory: CompatibilityInventory = discoverCompatibilityInventory()
): Promise<LaneAttestation> {
  const lane = await requireLane(laneKey);
  // ORDERED. `mergeImportedServers` resolves a name collision by taking the
  // first, so an unordered read makes "which server ran" a property of the
  // database's mood. Enable now refuses cross-vendor name collisions outright,
  // and this makes the remaining order deterministic anyway — a reproducible
  // run is worth more than the row-order it happened to have.
  const rows = (await prisma.importedCapability.findMany({
    where: { laneId: lane.id, state: STATE_ENABLED },
    orderBy: [{ vendor: "asc" }, { itemName: "asc" }],
  }));

  const servers: McpServerConfig[] = [];
  const disabled: AttestationDrift[] = [];

  for (const row of rows) {
    const live = findLiveItem(inventory, row.vendor, row.itemName);
    const observed = live ? importItemDigest(live) : "absent";
    if (observed === row.enabledDigest && live) {
      // Materialize from what was just READ, not from the stored shape: the
      // two agree by definition when the digest matches, and reading the live
      // one keeps the stored copy from ever being the thing that runs.
      servers.push(materializeEnabledServer(live));
      continue;
    }

    const drift: AttestationDrift = {
      name: row.itemName,
      vendor: row.vendor,
      approvedDigest: row.enabledDigest,
      observedDigest: observed,
      reason: "",
    };
    drift.reason = describeDrift(drift);

    // A GUARDED update, not a write by id.
    //
    // An adversarial review found the race: this reads the enabled rows, then
    // writes each drifting one. A HUMAN can re-enable that server against its
    // current fingerprint in between — and an unguarded write by id would then
    // stamp `disabled-drift` over an approval that was given AFTER the
    // observation it is based on, silently revoking a decision the human had
    // just made and pointing at evidence that was already stale.
    //
    // The guard is the same shape the resume claim uses: update only while the
    // row still says what this attestation read. Count 0 means someone got
    // there first with better information, so this observation is DISCARDED —
    // and, because it was never applied, it is not reported as a disable
    // either. Reporting a disable that did not happen is the same lie in the
    // other direction.
    const disabledNow = await prisma.importedCapability.updateMany({
      where: {
        id: row.id,
        state: STATE_ENABLED,
        enabledDigest: row.enabledDigest,
      },
      data: {
        state: STATE_DISABLED_DRIFT,
        driftDigest: observed,
        driftReason: drift.reason,
        disabledAt: new Date(),
      },
    });
    if (disabledNow.count === 1) {
      disabled.push(drift);
    } else {
      // Re-approved underneath us. The server this attestation was about is
      // not the server the lane now holds, so this pass says nothing about
      // it — the NEXT run re-attests against the new fingerprint, which is
      // the only honest thing to compare against.
      continue;
    }
  }

  return { laneKey: lane.key, servers, disabled };
}
