/**
 * Durable approval grants, listed where they are minted.
 *
 * ADR-0056 D8 states the failure mode plainly: "a grant that resolves something
 * invisibly is the failure mode". The desktop is where a human clicks
 * "Approve, always in this chat" (review-gate.tsx), so it is where they must be
 * able to see what that decision is still spending and take it back. Until this
 * panel existed the routes and the CLI carried the whole obligation, which made
 * the only kill switch for a button-minted grant a terminal command.
 *
 * The list is deliberately literal about what a grant binds to — the exact
 * tool, action class, target, payload digest and chat (D2/D3) — because the
 * whole point of `always` is that it is a sentence about ONE action, not about
 * an agent. A row that read "always allow the reviewer" would be describing a
 * different, more dangerous feature than the one that shipped.
 */
import { useCallback, useEffect, useState } from "react";
import type { ApprovalGrant } from "@muon/client";

/** A grant is spendable only while unrevoked AND unexpired — the same two
 *  conditions the redeem route matches on, so this label can never claim a
 *  grant is live when the server would refuse it. */
export function grantIsLive(grant: ApprovalGrant, now: number): boolean {
  if (grant.revokedAt) return false;
  return new Date(grant.expiresAt).getTime() > now;
}

export function grantStatusLabel(grant: ApprovalGrant, now: number): string {
  if (grant.revokedAt) return "revoked";
  return new Date(grant.expiresAt).getTime() > now ? "live" : "expired";
}

/** "in 4h" / "in 6d" / "expired" — never a bare timestamp, which nobody can
 *  read as urgency. */
export function expiryLabel(grant: ApprovalGrant, now: number): string {
  const ms = new Date(grant.expiresAt).getTime() - now;
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export function ApprovalGrantsPanel(props: {
  listGrants: (filter?: { activeOnly?: boolean }) => Promise<ApprovalGrant[]>;
  revokeGrant: (grantId: string) => Promise<ApprovalGrant>;
  /** Injected in tests; production reads the wall clock. */
  now?: () => number;
}) {
  const [grants, setGrants] = useState<ApprovalGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const readNow = props.now ?? (() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setGrants(await props.listGrants({ activeOnly: !showAll }));
    } catch (err) {
      // A grants panel that fails silently is the same invisibility D8 is
      // about, so the error is shown rather than swallowed into an empty list.
      setError(err instanceof Error ? err.message : String(err));
      setGrants([]);
    }
  }, [props.listGrants, showAll]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (grant: ApprovalGrant) => {
    setBusyId(grant.id);
    try {
      setError(null);
      await props.revokeGrant(grant.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const now = readNow();

  return (
    <section className="side-section" id="settings-grants">
      <header className="grants-head">
        <h3>Durable approvals</h3>
        <div className="grants-head-actions">
          <button
            type="button"
            className="ghost-btn"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Live only" : "Show all"}
          </button>
          <button type="button" className="ghost-btn" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <p className="grants-note">
        Each of these is one exact action you already approved with “always”, in
        one chat. None of them approves an agent, a tool in general, or anything
        outside the chat it was minted in.
      </p>

      {error ? (
        <p className="grants-error" role="alert">
          {error}
        </p>
      ) : null}

      {grants === null ? (
        <p className="grants-empty">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="grants-empty">
          {showAll
            ? "No grants have ever been minted in this workspace."
            : "No live grants. One exists only after you choose “always” on an approval."}
        </p>
      ) : (
        <ul className="grants-list">
          {grants.map((grant) => {
            const live = grantIsLive(grant, now);
            const status = grantStatusLabel(grant, now);
            return (
              <li key={grant.id} className={`grants-row${live ? "" : " inert"}`}>
                <div className="grants-row-head">
                  <span className="grants-tool">{grant.toolName}</span>
                  <span className={`grants-status ${status}`}>{status}</span>
                  <span className="grants-class">{grant.actionClass}</span>
                </div>
                <div className="grants-target">
                  {grant.resolvedTarget ?? "this exact payload"}
                </div>
                <div className="grants-meta">
                  <span>chat {grant.taskId}</span>
                  <span>digest {grant.payloadDigest.slice(0, 12)}…</span>
                  <span>
                    used {grant.useCount}
                    {grant.useCount === 1 ? " time" : " times"}
                  </span>
                  <span>
                    {live
                      ? expiryLabel(grant, now)
                      : grant.revokedAt
                        ? "no longer spendable"
                        : "lapsed"}
                  </span>
                </div>
                {live ? (
                  <button
                    type="button"
                    className="grants-revoke"
                    disabled={busyId === grant.id}
                    onClick={() => void revoke(grant)}
                  >
                    {busyId === grant.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
