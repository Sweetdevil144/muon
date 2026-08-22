export type Lane = "you" | "MUON" | "Claude Code" | "Codex" | "Cursor" | "OpenCode";

export type AgentLane = "Claude Code" | "Codex" | "Cursor" | "OpenCode";

export type Phase = "plan" | "dispatch" | "coordinate" | "evidence";

export type Beat = {
  readonly n: number;
  readonly t: number;
  readonly lane: Lane;
  readonly tool: string | null;
  readonly text: string;
  readonly sub?: string;
  readonly phase: Phase;
};

export type MemoryTrust = "confirmed" | "unconfirmed" | "corroborated" | "superseded" | "rejected";

export type MemoryKind = "decision" | "constraint" | "convention" | "attempt" | "question";

export type MemoryNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly label: string;
  readonly claim: string;
  readonly kind: MemoryKind;
  readonly proposedBy: string;
  readonly coordinate: string;
  readonly trust: MemoryTrust;
  readonly expires?: boolean;
  readonly appearsAt?: number;
  readonly provenance: readonly string[];
  readonly briefLine?: string;
};

export type Decision = "approved" | "rejected";

export type MemoryDecision = "confirmed" | "rejected";

export type LaneState = {
  readonly lane: AgentLane;
  readonly role: string;
  readonly subtitle: string;
  readonly active: boolean;
  readonly status: string;
  readonly tone: string;
};

export type Frame = {
  readonly tMs: number;
  readonly beats: readonly Beat[];
  readonly lanes: readonly LaneState[];
  readonly halted: boolean;
  readonly landDisabled: boolean;
  readonly degraded: boolean;
  readonly reviewBlind: boolean;
  readonly memoryPulseId: string | null;
};
