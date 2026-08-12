import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryCompactionResult,
  MemoryExpirySweepResult,
  MemoryTtlPolicy,
  RevertExpiredBatchResult,
} from "@muon/client";
import type { MemoryGovernanceState } from "../shared/ipc.js";

/**
 * Memory GOVERNANCE on the desk (surface-parity audit item 6).
 *
 * The desk showed notes and their lifecycle status; every control over that
 * lifecycle — the TTL, the expiry sweep, its reversal, compaction — was
 * CLI-only. So the surface where an operator reads memory was the surface
 * where they could not decide what memory keeps.
 *
 * THE POSTURE, which the whole panel is shaped around:
 *
 *  - NOTHING BULK RUNS UNPREVIEWED. Sweep and compaction both take a dry run
 *    first, and the apply button stays disabled until one has been seen. In a
 *    terminal `--dry-run` is a flag a careful operator types; on a button it
 *    has to be the only way in, because a click is cheaper than a command and
 *    the counts are the only thing that says how much this is about to touch.
 *  - A PREVIEW GOES STALE. Editing the bound, or a policy change underneath,
 *    invalidates it — the apply falls back to disabled rather than executing
 *    against numbers the operator never saw.
 *  - SWEEP HIDES, COMPACTION DOES NOT COME BACK. A sweep is a soft tombstone
 *    and its batch is reversible in one click. Compaction is not reversible,
 *    and the copy says so at the button, not in a footnote.
 */
export function MemoryGovernancePanel(props: {
  /** Injected so tests drive it without a window bridge. */
  load?: () => Promise<MemoryGovernanceState>;
  saveTtl?: (policy: MemoryTtlPolicy) => Promise<MemoryTtlPolicy>;
  saveMining?: (enabled: boolean) => Promise<boolean>;
  saveRetention?: (days: number) => Promise<number>;
  sweep?: (input: {
    dryRun: boolean;
    maxForget: number;
    previewDigest?: string;
  }) => Promise<MemoryExpirySweepResult>;
  compact?: (input: {
    dryRun: boolean;
    maxForget: number;
    previewDigest?: string;
  }) => Promise<MemoryCompactionResult>;
  revert?: (batchId: string) => Promise<RevertExpiredBatchResult>;
}) {
  const [state, setState] = useState<MemoryGovernanceState | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [days, setDays] = useState("");
  const [ceiling, setCeiling] = useState<"low" | "medium">("low");
  const [retention, setRetention] = useState("");
  const [maxForget, setMaxForget] = useState("50");
  const [sweepPreview, setSweepPreview] =
    useState<MemoryExpirySweepResult | null>(null);
  const [sweepApplied, setSweepApplied] =
    useState<MemoryExpirySweepResult | null>(null);
  const [compactPreview, setCompactPreview] =
    useState<MemoryCompactionResult | null>(null);
  const [compactApplied, setCompactApplied] =
    useState<MemoryCompactionResult | null>(null);
  const [reverted, setReverted] = useState<RevertExpiredBatchResult | null>(
    null
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = props.load;
  /**
   * Resolve one bridge call, or REFUSE.
   *
   * This used to return undefined and every caller bailed out — so on a
   * preload missing one method the operator clicked "Expire 12 notes" and
   * absolutely nothing happened: no sweep, no error, no busy state settling
   * into anything. A control that does nothing silently is worse than one
   * that is not there, because the operator believes the work was done.
   */
  const bridge = <T,>(
    injected: T | undefined,
    name: keyof NonNullable<typeof window.muon>
  ): T => {
    if (injected) return injected;
    const fn = window.muon?.[name];
    if (typeof fn !== "function") {
      throw new Error(
        `This build of MUON cannot ${String(name)} — the desktop bridge is older than this panel. Use the muon CLI for it.`
      );
    }
    return (fn as unknown as { bind: (thisArg: unknown) => T }).bind(
      window.muon
    );
  };

  const read = useCallback(() => {
    // Mount-time, not click-time: an absent bridge here is handled by the
    // `supported` guard below, which renders nothing at all.
    const fn = load ?? window.muon?.memoryGovernance?.bind(window.muon);
    if (typeof fn !== "function") return;
    (fn as () => Promise<MemoryGovernanceState>)()
      .then((result) => {
        if (!alive.current) return;
        setState(result);
        setUnavailable(null);
        if (result.ttl) {
          setDays(String(result.ttl.days));
          setCeiling(result.ttl.trustCeiling);
        }
        setRetention(String(result.compactionRetentionDays));
      })
      .catch((cause) => {
        if (!alive.current) return;
        // An unreadable policy is NOT "no policy" — an operator who reads
        // "nothing expires" from a failed read has been told the opposite of
        // what may be true.
        setState(null);
        setUnavailable(
          cause instanceof Error
            ? cause.message
            : "The memory policy could not be read."
        );
      });
  }, [load]);

  useEffect(() => read(), [read]);

  const supported =
    typeof (load ?? window.muon?.memoryGovernance) === "function";
  if (!supported) return null;

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setSaved(null);
    try {
      await work();
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : `${label} failed.`);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const forgetBound = () => {
    const parsed = Number(maxForget.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) return null;
    return parsed;
  };

  /** Any change that makes an existing preview describe a different run. */
  const invalidatePreviews = () => {
    setSweepPreview(null);
    setCompactPreview(null);
  };

  return (
    <section className="memory-governance" aria-label="Memory governance">
      <header className="memory-governance-head">
        <strong>Lifecycle</strong>
        <span>
          How long memory lives, what gets mined, and when soft tombstones or
          compaction run. Nothing bulk runs unpreviewed.
        </span>
      </header>
      {unavailable ? (
        <p className="memory-governance-error">
          {unavailable} — nothing here is showing a policy, because showing a
          default would be a guess. `muon memory ttl` reads it from the CLI.
        </p>
      ) : null}

      <div className="memory-governance-block">
        <h4>Retention</h4>
        <p className="memory-governance-note">
          {!state
            ? "Reading…"
            : state.ttl === null
              ? // The flat TTL is not merely unused here, it is the wrong
                // question — and its endpoints refuse. Show the policy that IS
                // in force rather than an inert control.
                "Lifetimes are set PER KIND, so there is no single TTL in force."
              : state.ttl.days === 0
                ? "Expiry is OFF: no note auto-expires."
                : `Unconfirmed agent memory at or below ${state.ttl.trustCeiling} trust hides after ${state.ttl.days} day(s).`}{" "}
          Confirming a note clears its expiry; human-authored and high-trust
          notes never expire at all.
        </p>
        {state?.daysByKind ? (
          <ul className="memory-governance-kinds">
            {Object.entries(state.daysByKind).map(([kind, days]) => (
              <li key={kind}>
                <span>{kind}</span>
                <span>{days === 0 ? "never expires" : `${days} day(s)`}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div
          className="memory-governance-controls"
          // Hidden rather than disabled when a kind table is live: a greyed
          // TTL field invites the question "why can't I edit this", and the
          // sentence above already answers it.
          hidden={state !== null && state.ttl === null}
        >
          <label>
            Days
            <input
              aria-label="Retention days"
              value={days}
              inputMode="numeric"
              onChange={(event) => setDays(event.target.value)}
            />
          </label>
          <label>
            Trust ceiling
            <select
              aria-label="Trust ceiling"
              value={ceiling}
              onChange={(event) =>
                setCeiling(event.target.value as "low" | "medium")
              }
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
            </select>
          </label>
          <button
            disabled={busy !== null}
            onClick={() =>
              void run("Saving retention", async () => {
                const parsed = Number(days.trim());
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3_650) {
                  throw new Error(
                    "Days must be a whole number from 0 to 3650. 0 disables expiry."
                  );
                }
                const fn = props.saveTtl ?? bridge(undefined, "setMemoryTtl");
                const next = await (
                  fn as (p: MemoryTtlPolicy) => Promise<MemoryTtlPolicy>
                )({ days: parsed, trustCeiling: ceiling });
                if (!alive.current) return;
                setState((prior) => (prior ? { ...prior, ttl: next } : prior));
                setSaved("Retention saved.");
                // A new TTL changes what a sweep would touch.
                invalidatePreviews();
              })
            }
          >
            Save
          </button>
        </div>
      </div>

      <div className="memory-governance-block">
        <h4>Mining</h4>
        <p className="memory-governance-note">
          {state
            ? state.memoryMining
              ? "MUON mines memory out of finished runs. What it proposes is UNCONFIRMED until a human vouches for it — mining fills the inbox, it never fills the gate."
              : "Mining is OFF: finished runs propose nothing, and memory grows only from what someone writes deliberately."
            : "Reading…"}
        </p>
        <div className="memory-governance-controls">
          <label className="memory-governance-toggle">
            <input
              type="checkbox"
              aria-label="Mine memory from finished runs"
              checked={state?.memoryMining ?? false}
              disabled={busy !== null || state === null}
              onChange={(event) => {
                const next = event.target.checked;
                void run("Saving mining", async () => {
                const fn = props.saveMining ?? bridge(undefined, "setMemoryMining");
                  const stored = await (fn as (e: boolean) => Promise<boolean>)(
                    next
                  );
                  if (!alive.current) return;
                  // The STORED value, not the click: a rejected write must not
                  // leave a toggle claiming a posture the brain does not hold.
                  setState((prior) =>
                    prior ? { ...prior, memoryMining: stored } : prior
                  );
                  setSaved("Mining setting saved.");
                });
              }}
            />
            Mine memory from finished runs
          </label>
        </div>
      </div>

      {state ? (
        <div className="memory-governance-block">
          <h4>Lifetimes by kind</h4>
          <p className="memory-governance-note">
            {state.lifecycleSource === "kind_table"
              ? "Kind-dependent lifetimes are ACTIVE; the flat TTL above is the fallback for kinds the table does not name."
              : "One flat TTL is in force for every kind. A kind-dependent table is available and recommended."}{" "}
            Activating or changing that table requires the exact digest of a
            dry run, so it is applied from `muon memory lifecycle-policy` —
            this desk shows which posture is live rather than offering a
            half-control that could apply a table nobody previewed.
          </p>
        </div>
      ) : null}

      <div className="memory-governance-block">
        <h4>Expiry sweep</h4>
        <p className="memory-governance-note">
          Materializes the soft tombstone for notes already past their
          deadline. It HIDES; it never deletes, and the whole batch reverts in
          one click.
        </p>
        <div className="memory-governance-controls">
          <label>
            At most
            <input
              aria-label="Maximum notes per run"
              value={maxForget}
              inputMode="numeric"
              onChange={(event) => {
                setMaxForget(event.target.value);
                // The bound is part of what a preview measured.
                invalidatePreviews();
              }}
            />
          </label>
          <button
            disabled={busy !== null}
            onClick={() =>
              void run("Previewing sweep", async () => {
                const bound = forgetBound();
                if (bound === null) {
                  throw new Error(
                    "The per-run bound must be a whole number from 1 to 500."
                  );
                }
                const fn = props.sweep ?? bridge(undefined, "sweepExpiredMemory");
                const result = await (
                  fn as (i: {
                    dryRun: boolean;
                    maxForget: number;
                  }) => Promise<MemoryExpirySweepResult>
                )({ dryRun: true, maxForget: bound });
                if (!alive.current) return;
                setSweepPreview(result);
                setSweepApplied(null);
              })
            }
          >
            Preview
          </button>
          <button
            className="memory-governance-apply"
            // Never runnable without a preview the operator has seen.
            disabled={busy !== null || sweepPreview === null}
            onClick={() =>
              void run("Sweeping", async () => {
                const bound = forgetBound();
                if (bound === null) return;
                const fn = props.sweep ?? bridge(undefined, "sweepExpiredMemory");
                const result = await (
                  fn as (i: {
                    dryRun: boolean;
                    maxForget: number;
                    previewDigest?: string;
                  }) => Promise<MemoryExpirySweepResult>
                )({
                  dryRun: false,
                  maxForget: bound,
                  // The apply is bound to the preview on screen. Invalidating
                  // on local edits only ever covered THIS window; a policy
                  // changed from the CLI, or a second desk, moved the
                  // candidate set silently. Now the brain refuses.
                  ...(sweepPreview?.previewDigest
                    ? { previewDigest: sweepPreview.previewDigest }
                    : {}),
                });
                if (!alive.current) return;
                setSweepApplied(result);
                setSweepPreview(null);
                setReverted(null);
              })
            }
          >
            {sweepPreview
              ? `Expire ${sweepPreview.expired} note${sweepPreview.expired === 1 ? "" : "s"}`
              : "Expire (preview first)"}
          </button>
        </div>
        {sweepPreview ? (
          <p className="memory-governance-result">
            {sweepPreview.skipped
              ? "Skipped: the retention policy is unreadable, so this would expire nothing."
              : `Would hide ${sweepPreview.expired} of ${sweepPreview.scanned} scanned note(s).`}
          </p>
        ) : null}
        {sweepApplied ? (
          <p className="memory-governance-result">
            Hid {sweepApplied.expired} of {sweepApplied.scanned} scanned
            note(s).
            {sweepApplied.batchId ? (
              <button
                className="memory-governance-revert"
                disabled={busy !== null}
                onClick={() =>
                  void run("Reverting", async () => {
                const fn = props.revert ?? bridge(undefined, "revertExpiredMemoryBatch");
                    const result = await (
                      fn as (b: string) => Promise<RevertExpiredBatchResult>
                    )(sweepApplied.batchId!);
                    if (!alive.current) return;
                    setReverted(result);
                    setSweepApplied(null);
                  })
                }
              >
                Revert this batch
              </button>
            ) : (
              // No batch id = no handle to reverse it by. Say so rather than
              // offering a button that cannot work.
              <em> This run has no batch id, so it cannot be reverted here.</em>
            )}
          </p>
        ) : null}
        {reverted ? (
          <p className="memory-governance-result">
            Restored {reverted.reverted} note(s) from batch {reverted.batchId}.
          </p>
        ) : null}
      </div>

      <div className="memory-governance-block">
        <h4>Compaction</h4>
        <p className="memory-governance-note">
          Tombstones superseded note versions older than the retention window.
          Unlike a sweep, a compaction batch CANNOT be reverted.
        </p>
        <div className="memory-governance-controls">
          <label>
            Keep days
            <input
              aria-label="Compaction retention days"
              value={retention}
              inputMode="numeric"
              onChange={(event) => {
                setRetention(event.target.value);
                invalidatePreviews();
              }}
            />
          </label>
          <button
            disabled={busy !== null}
            onClick={() =>
              void run("Saving retention window", async () => {
                const parsed = Number(retention.trim());
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_650) {
                  throw new Error(
                    "The retention window must be a whole number of days from 1 to 3650."
                  );
                }
                const fn = props.saveRetention ?? bridge(undefined, "setMemoryCompactionRetentionDays");
                const next = await (fn as (d: number) => Promise<number>)(
                  parsed
                );
                if (!alive.current) return;
                setState((prior) =>
                  prior ? { ...prior, compactionRetentionDays: next } : prior
                );
                setSaved("Retention window saved.");
              })
            }
          >
            Save
          </button>
          <button
            disabled={busy !== null}
            onClick={() =>
              void run("Previewing compaction", async () => {
                const bound = forgetBound();
                if (bound === null) {
                  throw new Error(
                    "The per-run bound must be a whole number from 1 to 500."
                  );
                }
                const fn = props.compact ?? bridge(undefined, "compactMemory");
                const result = await (
                  fn as (i: {
                    dryRun: boolean;
                    maxForget: number;
                  }) => Promise<MemoryCompactionResult>
                )({ dryRun: true, maxForget: bound });
                if (!alive.current) return;
                setCompactPreview(result);
                setCompactApplied(null);
              })
            }
          >
            Preview
          </button>
          <button
            className="memory-governance-apply danger"
            disabled={busy !== null || compactPreview === null}
            onClick={() =>
              void run("Compacting", async () => {
                const bound = forgetBound();
                if (bound === null) return;
                const fn = props.compact ?? bridge(undefined, "compactMemory");
                const result = await (
                  fn as (i: {
                    dryRun: boolean;
                    maxForget: number;
                    previewDigest?: string;
                  }) => Promise<MemoryCompactionResult>
                )({
                  dryRun: false,
                  maxForget: bound,
                  ...(compactPreview?.previewDigest
                    ? { previewDigest: compactPreview.previewDigest }
                    : {}),
                });
                if (!alive.current) return;
                setCompactApplied(result);
                setCompactPreview(null);
              })
            }
          >
            {compactPreview
              ? `Compact ${compactPreview.tombstoned} version${compactPreview.tombstoned === 1 ? "" : "s"} — not reversible`
              : "Compact (preview first)"}
          </button>
        </div>
        {compactPreview ? (
          <p className="memory-governance-result">
            Would tombstone {compactPreview.tombstoned} of{" "}
            {compactPreview.scanned} scanned version(s), older than{" "}
            {compactPreview.retentionDays} day(s).
          </p>
        ) : null}
        {compactApplied ? (
          <p className="memory-governance-result">
            Tombstoned {compactApplied.tombstoned} of {compactApplied.scanned}{" "}
            scanned version(s). This batch cannot be reverted.
          </p>
        ) : null}
      </div>

      {error ? <p className="memory-governance-error">{error}</p> : null}
      {saved ? <p className="memory-governance-saved">{saved}</p> : null}
      {busy ? <p className="memory-governance-note">{busy}…</p> : null}
    </section>
  );
}
