import { MUON_MCP_SERVER_NAME } from "@muon/core";
import { emptyLaneProfile } from "@muon/protocol";
import type { LaneProfile, McpServerConfig } from "@muon/protocol";

/**
 * ADR-0038 D8 — where an imported MCP server is allowed to land, and where it
 * is not.
 *
 * The founder decided on 2026-08-09 that an enabled server MAY reach an
 * agent-dispatched lane. This file is the narrow gate that answers WHICH
 * dispatched lane, and it says: a plain worker, and nothing else.
 *
 * The two exclusions are not caution, they are the ADR:
 *
 *  - A DELEGATE inherits nothing it was not explicitly given (D6). The runner
 *    already withholds the whole lane profile from a delegate; withholding
 *    imported items too is the same sentence, not an extra one.
 *  - An ORCHESTRATOR spawns children, and ADR-0019 §2.6 — quoted in D6 —
 *    says that where narrowing cannot be OBSERVED, MUON assumes inheritance
 *    and keeps imported items out of parents that spawn children. An
 *    orchestrator's children are spawned through the vendor's own machinery;
 *    MUON cannot watch a server config being narrowed on the way down, so it
 *    does not hand one to the parent.
 *
 * That leaves the worker: the thing that actually does the task, in one lane,
 * with the tools a human named for that lane. Which is the case D8 was
 * answered for.
 */
export function laneMayReceiveImports(
  capabilityMode: "worker" | "delegate" | "orchestrator"
): boolean {
  // A POSITIVE test (ADR-0022 rule 2). Written as `!== "delegate" && !==
  // "orchestrator"` a fourth capability mode would arrive INSIDE the grant
  // without anyone deciding that, which is the exact failure this repo has now
  // paid for four times.
  return capabilityMode === "worker";
}

export type ImportedServerRejection = {
  readonly name: string;
  readonly reason: string;
};

/**
 * Fold a lane's attested imported servers into the profile it will run with.
 *
 * Refuses two collisions, both of which would be silent otherwise:
 *
 *  1. MUON'S OWN SERVER NAME. An imported server called `muon` would sit in
 *     the same `mcpServers` map as MUON's governed MCP and — depending on the
 *     vendor's merge order — could REPLACE it. That is an imported,
 *     human-approved-but-third-party binary answering the tool calls MUON's
 *     entire governance model assumes it answers itself. Refused here even
 *     though enable also refuses it, because this is the boundary that must
 *     hold: the enable check protects the store, this one protects the run.
 *  2. A NAME THE OPERATOR ALREADY AUTHORED in the lane profile. The stored
 *     profile is operator-authored configuration that a human wrote for this
 *     lane specifically; an import silently shadowing it would change what a
 *     named server IS, without any diff saying so. The profile wins and the
 *     import is reported.
 *
 * Rejections are RETURNED, never swallowed: a server that a human enabled and
 * that then did not reach the lane is a fact they have to be told, or the
 * feature lies about what it did.
 */
export function mergeImportedServers(
  profile: LaneProfile | undefined,
  imported: readonly McpServerConfig[]
): { profile: LaneProfile | undefined; rejected: ImportedServerRejection[] } {
  if (imported.length === 0) return { profile, rejected: [] };
  if (!profile) {
    // NO PROFILE, BUT APPROVED IMPORTS — a contradiction, handled rather than
    // trusted.
    //
    // In production this cannot happen: `resolveImportedServers` returns
    // before the merge for a delegate or an orchestrator, and an eligible
    // worker always has a profile (`applyHarnessToProfile` merges over an
    // absent one and always returns a `LaneProfile`). An adversarial review
    // read this branch as live and called it a silently-dropped enable, which
    // it was not — but the branch DID drop them, and "the state is impossible
    // so the wrong answer is fine" is how an impossible state becomes a bug
    // report. Build from an empty profile instead: if a human approved these
    // servers for this lane, losing them silently is the worst available
    // outcome, and eligibility is already enforced upstream.
    return {
      profile: { ...emptyLaneProfile, mcpServers: [...imported] },
      rejected: [],
    };
  }

  const rejected: ImportedServerRejection[] = [];
  const taken = new Set(profile.mcpServers.map((server) => server.name));
  const accepted: McpServerConfig[] = [];

  for (const server of imported) {
    if (server.name === MUON_MCP_SERVER_NAME) {
      rejected.push({
        name: server.name,
        reason: `"${MUON_MCP_SERVER_NAME}" is MUON's own governed MCP server. An imported server may not take that name.`,
      });
      continue;
    }
    if (taken.has(server.name)) {
      rejected.push({
        name: server.name,
        reason: `the lane profile already defines a server named "${server.name}"; the operator-authored one is used and the import was not applied.`,
      });
      continue;
    }
    taken.add(server.name);
    accepted.push(server);
  }

  return {
    profile:
      accepted.length === 0
        ? profile
        : { ...profile, mcpServers: [...profile.mcpServers, ...accepted] },
    rejected,
  };
}


/**
 * THE WHOLE IMPORTED-CAPABILITY LIFECYCLE FOR ONE RUN, in one place.
 *
 * This lived inline in `executeJob`, which an adversarial review called out
 * for the right reason: an attestation RPC, two shapes of ledger event, a
 * failure policy and a merge had been added to a function that is already the
 * central launch orchestrator, coupling a small state machine to the largest
 * flow in the runner and making it testable only through a full dispatch.
 *
 * WHAT IT DECIDES, and none of it is new:
 *
 *  - eligibility (`laneMayReceiveImports`) — a plain worker, never a delegate
 *    or an orchestrator;
 *  - attestation — the backend re-reads the vendor config, recomputes each
 *    fingerprint, and DISABLES what moved (ADR-0038 D3). Each disable is
 *    recorded, because a server a human enabled and that then vanished is a
 *    fact they have to be told;
 *  - failure — a failed attestation yields NOTHING, never the stored set. That
 *    direction is fail-closed (fewer capabilities, not more), and it is still
 *    recorded rather than swallowed;
 *  - merge — names MUON's own server and the operator's own servers keep, with
 *    every refusal reported.
 *
 * A KNOWN WINDOW, accepted with its reason rather than left silent. An
 * operator can `disable` an import between this attestation and the spawn, and
 * nothing re-validates in between, so a just-revoked server can still launch
 * for that one run. That is the same posture the rest of MUON's governance
 * takes: authority decisions bound what STARTS, they do not reach into a
 * launch already in flight (ADR-0036 D2 makes the identical call for a cost
 * cap, for the identical reason — intervening mid-launch strands partial,
 * unverified work). The window is one launch long and the next run re-attests.
 * If that ever stops being acceptable, the fix is the existing interrupt path,
 * not a tighter read here.
 */
export async function resolveImportedServers(input: {
  readonly attest: (laneKey: string) => Promise<{
    servers: readonly McpServerConfig[];
    disabled: readonly {
      name: string;
      vendor: string;
      reason: string;
      approvedDigest: string;
      observedDigest: string;
    }[];
  }>;
  readonly record: (event: {
    message: string;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
  readonly laneKey: string;
  readonly capabilityMode: "worker" | "delegate" | "orchestrator";
  readonly profile: LaneProfile | undefined;
}): Promise<LaneProfile | undefined> {
  if (!laneMayReceiveImports(input.capabilityMode)) return input.profile;

  let servers: readonly McpServerConfig[] = [];
  try {
    const attestation = await input.attest(input.laneKey);
    servers = attestation.servers;
    // CONCURRENTLY, because these are independent best-effort audit writes
    // sitting directly in front of the vendor launch. Awaiting them one at a
    // time added a network round trip per drifted import to the time before a
    // human sees anything happen — a latency cost paid for records that are
    // explicitly non-authoritative.
    await Promise.allSettled(
      attestation.disabled.map((drift) =>
        input.record({
          message: `imported MCP server disabled: ${drift.reason}`,
          metadata: {
            importedCapability: "disabled-drift",
            server: drift.name,
            vendor: drift.vendor,
            approvedDigest: drift.approvedDigest,
            observedDigest: drift.observedDigest,
          },
        })
      )
    );
  } catch (error) {
    await input
      .record({
        message:
          "imported MCP servers could not be attested; this run has none of them",
        metadata: {
          importedCapability: "attestation-failed",
          reason: String(error),
        },
      })
      .catch(() => undefined);
  }

  const merged = mergeImportedServers(input.profile, servers);
  // Concurrently, for the same reason as the drift writes above.
  await Promise.allSettled(
    merged.rejected.map((rejection) =>
      input.record({
        message: `imported MCP server not applied: ${rejection.reason}`,
        metadata: {
          importedCapability: "rejected",
          server: rejection.name,
        },
      })
    )
  );
  return merged.profile;
}
