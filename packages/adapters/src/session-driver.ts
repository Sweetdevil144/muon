import type { LaneEvent, LaneProfile } from "@muon/protocol";

/**
 * Decision returned by MUON's approval bridge when an agent session asks to
 * run a tool that is not pre-approved. Mirrors the Claude Agent SDK
 * `canUseTool` contract and Codex app-server approval responses.
 */
export type ApprovalDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export type SessionApprovalRequest = {
  toolName: string;
  input: unknown;
  taskId: string;
  laneKey: string;
};

/** Bridges vendor approval callbacks into MUON's approvals inbox. */
export type ApprovalBridge = (
  request: SessionApprovalRequest
) => Promise<ApprovalDecision>;

export type SessionStartInput = {
  taskId: string;
  brief: string;
  cwd?: string;
  profile?: LaneProfile;
  resumeVendorSessionId?: string;
  /** Authority/lifecycle fence checked immediately before vendor launch. */
  signal?: AbortSignal;
};

export type SessionHandlers = {
  onEvent: (event: LaneEvent) => void;
  onApprovalRequest: ApprovalBridge;
  /**
   * Fired once, the moment the vendor session/thread id is known (may be
   * mid-stream). Lets the caller persist the resume handle at FIRST knowledge
   * instead of session end, so a mid-run kill does not lose it (P0.1 Slice A).
   */
  onVendorSessionId?: (vendorSessionId: string) => void;
  /**
   * Live view of the vendor's OWN stderr, chunk by chunk, for a driver that
   * owns such a stream. `SessionResult` arrives far too late for a caller that
   * must reason about a session WHILE it runs (the runner's liveness watchdog):
   * a provider that rejects on quota/billing can take minutes to answer, and its
   * warnings on stderr are the only vendor-side evidence available inside the
   * watchdog window. Optional, and raw — bounding and redaction belong to the
   * consumer that surfaces it (same contract as `LaneCommandInput.onDiagnostic`).
   */
  onDiagnostic?: (chunk: string) => void;
};

export type SessionResult = {
  exitCode: number;
  output: string;
};

export interface SessionHandle {
  vendorSessionId?: string;
  /** Send a follow-up user message into the running session. */
  send(message: string): Promise<void>;
  interrupt(): Promise<void>;
  /** Resolves when the session ends. */
  wait(): Promise<SessionResult>;
}

export type SessionCapabilities = {
  canSend: boolean;
  canInterrupt: boolean;
  canResume: boolean;
};

export interface LaneSessionDriver {
  readonly laneKey: string;
  readonly capabilities: SessionCapabilities;
  /**
   * True ONLY when this driver actually feeds `onDiagnostic` from the vendor's
   * own stderr. Absent/false means MUON observes no stderr on this driver's
   * sessions — a stall report must then say exactly that, instead of claiming
   * the vendor was silent on a stream nobody listened to. Optional so the
   * conservative (honest) answer is every driver's default.
   */
  readonly forwardsVendorStderr?: boolean;
  start(input: SessionStartInput, handlers: SessionHandlers): Promise<SessionHandle>;
}

export function makeSessionEvent(
  laneKey: string,
  taskId: string,
  kind: LaneEvent["kind"],
  message: string,
  metadata: Record<string, unknown> = {}
): LaneEvent {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    laneId: laneKey,
    taskId,
    kind,
    message,
    timestamp: new Date().toISOString(),
    metadata,
  };
}
