import { describe, expect, it, vi } from "vitest";
import { createStandingApproverLeaseHolder } from "../src/lib/standing-approver.js";

// The desktop half of the Full Auto fix: the heartbeat that tells the runner an
// operator-tier decider is watching the approval inbox. What these lock down is
// the REVOCATION side — the claim must stop the moment the thing it describes
// stops, without waiting for a restart, and must never be renewed on a cycle
// that did not actually reach the brain.

function holder(
  overrides: {
    renew?: () => Promise<unknown>;
    release?: () => Promise<unknown>;
  } = {}
) {
  const renewStandingApproverLease = vi.fn(
    overrides.renew ??
      (async () => ({
        active: true as const,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }))
  );
  const releaseStandingApproverLease = vi.fn(
    overrides.release ?? (async () => ({ active: false as const }))
  );
  const lines: string[] = [];
  const lease = createStandingApproverLeaseHolder(
    {
      renewStandingApproverLease,
      releaseStandingApproverLease,
    } as never,
    (line) => lines.push(line)
  );
  return { lease, renewStandingApproverLease, releaseStandingApproverLease, lines };
}

describe("standing-approver lease holder", () => {
  it("renews on every cycle while Full Auto is ON and the brain answered", async () => {
    const { lease, renewStandingApproverLease } = holder();

    await lease.reconcile({ fullAuto: true, online: true });
    await lease.reconcile({ fullAuto: true, online: true });

    expect(renewStandingApproverLease).toHaveBeenCalledTimes(2);
    expect(lease.held()).toBe(true);
  });

  it("does NOT renew on a cycle that could not reach the brain — the lease lapses instead", async () => {
    // Fail-closed direction: an unreachable brain is not evidence that anyone is
    // still watching, and an un-renewed lease revokes itself.
    const { lease, renewStandingApproverLease, releaseStandingApproverLease } =
      holder();

    await lease.reconcile({ fullAuto: true, online: false });

    expect(renewStandingApproverLease).not.toHaveBeenCalled();
    expect(releaseStandingApproverLease).not.toHaveBeenCalled();
    expect(lease.held()).toBe(false);
  });

  it("Full Auto OFF releases the held lease ONCE, then stays quiet", async () => {
    const { lease, releaseStandingApproverLease } = holder();
    await lease.reconcile({ fullAuto: true, online: true });

    await lease.reconcile({ fullAuto: false, online: true });
    await lease.reconcile({ fullAuto: false, online: true });
    await lease.reconcile({ fullAuto: false, online: true });

    expect(releaseStandingApproverLease).toHaveBeenCalledTimes(1);
    expect(lease.held()).toBe(false);
  });

  it("never releases a lease it does not hold (Full Auto off from launch is inert)", async () => {
    const { lease, releaseStandingApproverLease } = holder();

    await lease.reconcile({ fullAuto: false, online: true });
    await lease.release();

    expect(releaseStandingApproverLease).not.toHaveBeenCalled();
  });

  it("a failed renewal is logged, never thrown, and simply lets the lease expire", async () => {
    const { lease, lines } = holder({
      renew: async () => {
        throw new Error("control offline");
      },
    });

    await expect(
      lease.reconcile({ fullAuto: true, online: true })
    ).resolves.toBeUndefined();
    expect(lease.held()).toBe(false);
    expect(lines[0]).toContain("standing-approver lease renewal failed");
  });

  it("a failed release stays HELD so the next cycle retries it", async () => {
    // Giving up here would leave the desktop believing it had revoked something
    // it had not. The server TTL is the backstop, the retry is the fast path.
    let fail = true;
    const { lease, releaseStandingApproverLease, lines } = holder({
      release: async () => {
        if (fail) throw new Error("control offline");
        return { active: false as const };
      },
    });
    await lease.reconcile({ fullAuto: true, online: true });

    await lease.reconcile({ fullAuto: false, online: true });
    expect(lease.held()).toBe(true);
    expect(lines[0]).toContain("standing-approver lease release failed");

    fail = false;
    await lease.reconcile({ fullAuto: false, online: true });
    expect(lease.held()).toBe(false);
    expect(releaseStandingApproverLease).toHaveBeenCalledTimes(2);
  });

  it("an explicit release (toggle off, quitting) revokes immediately, not on the next poll", async () => {
    const { lease, releaseStandingApproverLease } = holder();
    await lease.reconcile({ fullAuto: true, online: true });

    await lease.release();

    expect(releaseStandingApproverLease).toHaveBeenCalledTimes(1);
    expect(lease.held()).toBe(false);
  });
});
