import { z } from "zod";
import type { AgentRole } from "./agent-role.js";

export const laneCapabilitySchema = z.object({
  canStreamEvents: z.boolean(),
  canInterrupt: z.boolean(),
  canBackground: z.boolean(),
  supportsApprovals: z.boolean(),
  supportsWorktrees: z.boolean(),
});

export type LaneCapabilities = z.infer<typeof laneCapabilitySchema>;

export const laneHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);
export type LaneHealthStatus = z.infer<typeof laneHealthStatusSchema>;

export const laneHealthSchema = z.object({
  status: laneHealthStatusSchema,
  details: z.array(z.string()),
});

export type LaneHealth = z.infer<typeof laneHealthSchema>;

export type LaneSessionInput = {
  taskId: string;
  goal: string;
  branch?: string;
};

export type LaneTaskSubmission = {
  taskId: string;
  brief: string;
};

export interface LaneAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly role: "peer" | "worker";
  /**
   * Crew roles this lane may hold (VISION §2). REQUIRED, and stated positively:
   * there is no "unset" that means "unconstrained". An EMPTY array is the
   * meaningful "holds no role at all" (a readiness-only integration).
   *
   * It used to be optional, and three of the four surfaces that read it treated
   * absence as "every role" — so an adapter that forgot one field was admitted
   * to `orchestrator` and `implementer` (ADR-0022 §1.2(b), closed in Wave C1).
   * OpenCode is the case that makes it visible: it streams, backgrounds and can
   * be interrupted, so the capability checks alone would admit it to `reviewer`,
   * `qa`, `architect` and `docs`. This field is the ENTIRE boundary that keeps
   * it to `scout`.
   *
   * This is a CEILING, not a grant: listing a role here lets the engine consider
   * the lane for it; the role's own narrowing still applies at launch.
   */
  readonly supportedRoles: readonly AgentRole[];
  /**
   * The adapter's own opinion of how well it fits each role, 0..1. Vendors know
   * their strengths better than a table in core does, so the affinity lives with
   * the adapter. Missing roles fall back to a capability-derived default.
   */
  readonly roleAffinity?: Partial<Record<AgentRole, number>>;
  health(): Promise<LaneHealth>;
  capabilities(): Promise<LaneCapabilities>;
  startSession(input: LaneSessionInput): Promise<{ sessionId: string }>;
  resumeSession(sessionId: string): Promise<{ sessionId: string }>;
  submitTask(input: LaneTaskSubmission): Promise<void>;
  interrupt(taskId: string): Promise<void>;
}
