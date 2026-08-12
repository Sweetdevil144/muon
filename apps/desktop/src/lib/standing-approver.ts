import type { MuonApiClient } from "@muon/client";

// The desktop side of the standing-approver lease.
//
// Full Auto's auto-approver is a LIVE process: it resolves every incoming
// pending approval through the same operator PATCH a human click uses. Nothing
// downstream could learn that, so a coordinator session — which has no
// interactive operator of its own — refused every un-preauthorized tool even
// with every gate deliberately switched off ("FULL AUTO — SAFETY GATES OFF" on
// screen, `Bash` denied).
//
// This publishes the fact for exactly as long as it stays true. It is a
// heartbeat, not a flag: a `fullAuto: true` persisted by a desktop that then
// crashed must never leave a coordinator ungated, so the grant is renewed each
// poll cycle and lapses on its own (server-side TTL) the moment the renewals
// stop. Turning Full Auto OFF releases it immediately rather than waiting for
// the TTL, so revocation is a poll interval, never a restart.

/** The two calls a lease holder needs. Narrowed by NAME so nothing else on the
 *  operator client is reachable from here (and so tests can pass a stub). */
type StandingApproverClient = Pick<
  MuonApiClient,
  "renewStandingApproverLease" | "releaseStandingApproverLease"
>;

export type StandingApproverLeaseHolder = {
  /**
   * One heartbeat. Renews while standing consent is live and the brain answered
   * this cycle; releases as soon as either stops being true.
   */
  reconcile(input: { fullAuto: boolean; online: boolean }): Promise<void>;
  /** Give up the watch NOW (toggle off, quitting). Idempotent, never throws. */
  release(): Promise<void>;
  /** Whether this holder believes it currently holds the lease (diagnostics). */
  held(): boolean;
};

export function createStandingApproverLeaseHolder(
  client: StandingApproverClient,
  log: (line: string) => void
): StandingApproverLeaseHolder {
  // What WE believe we published. Only used to avoid a pointless DELETE on every
  // cycle while Full Auto is off; it is never treated as the grant itself — the
  // brain's lease is, and it expires whether or not this flag is accurate.
  let held = false;

  const release = async (): Promise<void> => {
    if (!held) return;
    try {
      await client.releaseStandingApproverLease();
      held = false;
    } catch (error) {
      // Deliberately keep `held` true so the next cycle retries. Even if every
      // retry fails, the lease still lapses on its own within the server TTL —
      // an un-renewed lease is a revoked lease.
      log(
        `[full-auto] standing-approver lease release failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  return {
    held: () => held,
    release,
    reconcile: async ({ fullAuto, online }) => {
      // Stated positively: a renewal is published only while standing consent is
      // ON and this cycle actually reached the brain. Anything else — consent
      // off, brain offline, a failed renewal — leaves the lease to expire, which
      // is the fail-closed direction.
      if (!fullAuto) {
        await release();
        return;
      }
      if (!online) return;
      try {
        await client.renewStandingApproverLease();
        held = true;
      } catch (error) {
        log(
          `[full-auto] standing-approver lease renewal failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
  };
}
