import { z } from "zod";

/** ADR-0028's distinct, operator-minted capability tier. */
export const ATTACHED_COORDINATOR_CAPABILITY_MODE =
  "attached-coordinator" as const;

/**
 * Short renewable lease. The independent horizon is deliberately larger than
 * one TTL but smaller than two: a corrupted far-future timestamp is never
 * accepted as an irrevocable grant.
 */
export const ATTACHED_COORDINATOR_LEASE_TTL_MS = 120_000;
export const ATTACHED_COORDINATOR_HEARTBEAT_MS = 30_000;
export const ATTACHED_COORDINATOR_LEASE_HORIZON_MS = 150_000;
export const ATTACHED_COORDINATOR_SWEEP_MS = 15_000;

/**
 * ADR-0049 — the window between a MINT and the FIRST heartbeat.
 *
 * Both constants above assume a heartbeat is already flowing. Between the mint
 * and the first one there is, by construction, none — and that is exactly the
 * window a human spends restarting the terminal the attach told them to
 * restart. Governed by the steady-state 120s, the printed remedy expired
 * before it could be used and the operator looped: measured 2026-08-11, a
 * reboot produced `-32000` and nothing else.
 *
 * Ten minutes is sized for quitting and reopening a terminal application, not
 * for comfort. It applies ONLY to a file that declares itself un-heartbeated
 * (`bootstrap: true`), and the first heartbeat replaces it with the ordinary
 * TTL — so a terminal that dies is still reaped within one lease period.
 */
export const ATTACHED_COORDINATOR_BOOTSTRAP_TTL_MS = 600_000;
/** The forged-timestamp guard, at the bootstrap width. Same shape as the
 *  steady-state horizon: larger than one TTL, smaller than two. */
export const ATTACHED_COORDINATOR_BOOTSTRAP_HORIZON_MS = 660_000;

export const attachedCoordinatorCapabilityFileSchema = z
  .object({
    version: z.literal(1),
    apiBase: z.string().url(),
    apiToken: z.string().min(32).max(512),
    jobId: z.string().min(1),
    delegationToken: z.string().min(32).max(512),
    chatId: z.string().min(1),
    chatTaskId: z.string().min(1),
    workspacePath: z.string().min(1),
    vendor: z.string().min(1),
    expiresAt: z.string().datetime(),
    /**
     * P0-2 identity binding: the OPERATOR's verified GitHub login at attach
     * time (from the brain's device-flow connection). Audit metadata, not
     * authority — the bearer above is the credential; this names the human it
     * was minted for. Optional: an attach on a brain with no GitHub identity
     * (dev, or the gate disabled) writes no login, and old files stay valid.
     */
    operatorGitHubLogin: z.string().min(1).max(200).optional(),
    /**
     * ADR-0049: this lease has NEVER heartbeated, so it is bounded by the
     * bootstrap horizon rather than the steady-state one.
     *
     * A file may only widen its own horizon by SAYING so, and only until the
     * first heartbeat rewrites it away. Optional, so a file written by an
     * older build parses unchanged and stays bounded at 150s — absent is the
     * NARROW case, which is the direction an omission must fail in.
     */
    bootstrap: z.literal(true).optional(),
  })
  .strict();

export type AttachedCoordinatorCapabilityFile = z.infer<
  typeof attachedCoordinatorCapabilityFileSchema
>;
