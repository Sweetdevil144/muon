import {
  DEFAULT_MODEL_SENTINEL,
  VENDOR_IDS,
  VENDOR_REGISTRY,
  isDefaultModel,
  isVendorId,
  publicVendorIds,
  vendorLabel,
} from "@muon/protocol";

/** Re-export for renderer surfaces that cannot import `@muon/protocol` directly. */
export { DEFAULT_MODEL_SENTINEL, isDefaultModel };
import type {
  LaneCapabilities,
  LaneProfile,
  VendorId,
  VendorModelIdShape,
} from "@muon/protocol";
import type { SessionCapabilities } from "./session-driver.js";

/**
 * Vendor capability descriptor registry (ADR-0013 #52, v1).
 *
 * The SINGLE, declarative source of truth for "what can each vendor do, and how
 * does MUON invoke it", read by BOTH the dispatch seam (resolver → the existing
 * `profile-compiler` / `base-lane-adapter` / `run.ts` path) and every UI (the
 * TUI `/<action> [vendor]` flag palette + the desktop lane action menu). It does
 * NOT replace `profile-compiler.ts`; it *indexes* it and adds the non-flag
 * channels a compiler can't express (subcommand / prompt-prefix / session-slash).
 *
 * PURITY: this module imports only types plus the ADR-0022 vendor registry
 * (itself `zod` + literals with zero `node:` imports), so it bundles cleanly
 * into the Electron renderer and the ink TUI. No `node:` built-ins, no adapter
 * classes, no secrets, a descriptor describes *invocation*, never *auth*.
 *
 * INVARIANTS (ADR-0013 reviewer note, binding): the descriptor NEVER carries a
 * vendor token; the four invariant-breaking features (full-auto,
 * `--strict-mcp-config`, whole-prompt `--system-prompt`, cloud/remote) are
 * represented with an explicit `gate`, NOT a verbatim passthrough, the resolver
 * relocates enforcement to MUON's own boundary (S1 sandbox + operator
 * dispatch-gate + fail-closed `canUseTool`), and interactive NEVER receives a
 * permission bypass. Un-verified argv/behaviour is tagged `dogfood` so it
 * degrades safely if the live binary differs.
 */

/**
 * TODO 3.3 — `VendorKey` IS `VendorId`, not a second enum that happens to agree.
 *
 * This used to be a hand-written union that omitted `opencode`, so the fourth
 * managed lane had no descriptor row, no model policy, and therefore could not
 * appear in the model picker at all. The omission read as a POSITION in the
 * comments, but nothing enforced it: it was one literal a contributor had to
 * remember to extend, and forgetting was silent (ADR-0022 §1.2(a)).
 *
 * Aliasing the registry id closes that class of bug structurally — every
 * `Record<VendorKey, …>` below is now total over the registry, so a vendor
 * added to `VENDOR_IDS` fails `tsc` until it states its descriptor rather than
 * inheriting one by omission. It GRANTS nothing on its own: a descriptor row
 * with `actions: []` refuses every action, and the model-override gate reads
 * the registry catalogue directly (see `assertVendorHasModelCatalog`), not
 * membership in this type.
 */
export type VendorKey = VendorId;

/** Where an action is reachable, keyed to Lane/Session capabilities. */
export type InvocationMode = "one-shot" | "interactive" | "background";

/** How much MUON must do to honour parity for this action. */
export type ParityClass = "clean" | "needs-work" | "invariant-guarded";

/** Enforcement routing for an action (see the invariant guards below). */
export type GatePolicy =
  | "none"
  | "dispatch-gate" // operator-approved dispatch (full-auto one-shot; sandbox-bounded)
  | "egress-gate" // cloud/remote, opt-in only; withheld by default
  | "fail-closed-interpose" // interactive keeps `canUseTool`
  | "refuse" // never emitted (e.g. `--strict-mcp-config`)
  | "warn"; // allowed with a provenance warning (e.g. system-prompt)

/**
 * How MUON invokes an action for a given vendor. Every kind is plain,
 * serialisable data (so both the resolver and the UI read it); string values
 * may carry `{target}` / `{arg}` / `{args}` placeholders the resolver fills.
 */
export type InvocationChannel =
  | { kind: "profileField"; patch: Partial<LaneProfile> } // typed field → profile-compiler
  | { kind: "flag"; args: string[] } // raw argv → LaneProfile.extraArgs
  | { kind: "subcommand"; command?: string; argv: string[] } // OVERRIDE taskCommand
  | { kind: "promptPrefix"; text: string } // one-shot analog of a slash-command
  | { kind: "sessionSlash"; command: string } // literal slash into a live session
  | { kind: "mcp"; tool: string }; // v3, invoke via an MCP tool

export type VendorAction = {
  /** MUON-level verb, e.g. "plan" | "ultrareview" | "permission-mode". */
  id: string;
  /** Palette label. */
  label: string;
  /** The badge vendor. */
  vendor: VendorKey;
  /** How MUON invokes it for THIS vendor. */
  channel: InvocationChannel;
  /** Modes it is reachable in (keyed to LaneCapabilities + SessionCapabilities). */
  modes: InvocationMode[];
  /** Parity class. */
  parity: ParityClass;
  /** Gate policy. */
  gate: GatePolicy;
  /** The slash token that invokes it in the command bar (no leading slash). */
  command: string;
  /** Behaviour un-verified against the live binary, must degrade safely (⚠). */
  dogfood?: boolean;
  /** Withheld from the default surface (cloud/egress), surfaced only opt-in. */
  hidden?: boolean;
  /** Extra profile merged regardless of channel (e.g. codex plan → read-only sandbox). */
  extraPatch?: Partial<LaneProfile>;
  /** Short human note for the chip / tooltip. */
  note?: string;
  /** A free argument this action consumes (model name, effort level, review target…). */
  arg?: { name: string; required?: boolean };
  /** Allowed values for `arg` (rejects anything else, degrade, don't guess). */
  argValues?: string[];
};

/**
 * Per-vendor model policy (v1). `known` is a curated hint list, NOT a hard pin:
 * with `allowCustom:true` any non-guarded id passes (degrade, never guess), and
 * `known` only suppresses the "unverified model" warning for recognised ids.
 * With `allowCustom:false` an id outside `known` is refused. Model *ids* drift
 * per vendor bump (see ADR-0013 §version drift), so we never hard-pin them here.
 */
export type VendorModelPolicy = {
  known: string[];
  allowCustom: boolean;
  /**
   * TODO 3.4 — a declared FORM for this vendor's ids, projected from the
   * registry. Present-and-non-null means `validateModelForVendor` refuses a
   * malformed id BEFORE the `known`/`allowCustom` decision, which is what lets a
   * lane whose catalogue cannot be enumerated (opencode: the live list is the
   * operator's own authed providers) still take a per-dispatch override without
   * MUON pretending it verified membership.
   */
  idShape?: VendorModelIdShape | null;
};

export type VendorCapabilityDescriptor = {
  vendor: VendorKey;
  displayName: string;
  /** The enumerable surface. */
  actions: VendorAction[];
  /** Cross-ref to the coarse lane capabilities (lane-adapter.ts). */
  laneCapabilities: LaneCapabilities;
  /** Cross-ref to the live-session capabilities (session-driver.ts), if any. */
  sessionCapabilities?: SessionCapabilities;
  /** Per-vendor model validation policy (see `validateModelForVendor`). */
  models?: VendorModelPolicy;
};

// ── Lane / session capability cross-refs (mirror the adapter + driver values) ──
// Small, stable booleans, inlined to keep this module pure (importing the adapter
// classes would pull node built-ins into the renderer bundle).
const CLAUDE_LANE_CAPS: LaneCapabilities = {
  canStreamEvents: true,
  canInterrupt: true,
  canBackground: true,
  supportsApprovals: true,
  supportsWorktrees: true,
};
const CODEX_LANE_CAPS: LaneCapabilities = { ...CLAUDE_LANE_CAPS };
// Mirrors CursorAdapter.laneCapabilities: `--output-format stream-json` streams,
// `--print` runs unattended and is an ordinary interruptible child, MUON has no
// interpose on a Cursor approval, and MUON worktrees ride `--workspace` (not
// Cursor's ungoverned `-w/--worktree` under ~/.cursor/worktrees).
const CURSOR_LANE_CAPS: LaneCapabilities = {
  canStreamEvents: true,
  canInterrupt: true,
  canBackground: true,
  supportsApprovals: false,
  supportsWorktrees: true,
};
// Mirrors OpencodeAdapter.laneCapabilities verbatim: `--format json` streams,
// the run is an ordinary interruptible child, MUON has no interpose on an
// opencode permission prompt (permissions are config-only — there is no
// `--permissions` flag), and MUON worktrees are not wired for this lane, which
// is the capability-level half of why `implementer` is unreachable for it.
const OPENCODE_LANE_CAPS: LaneCapabilities = {
  canStreamEvents: true,
  canInterrupt: true,
  canBackground: true,
  supportsApprovals: false,
  supportsWorktrees: false,
};
// Mirrors ClaudeSessionDriver / CodexSessionDriver; cursor has no session driver.
const CLAUDE_SESSION_CAPS: SessionCapabilities = {
  canSend: false,
  canInterrupt: true,
  canResume: true,
};
const CODEX_SESSION_CAPS: SessionCapabilities = {
  canSend: true,
  canInterrupt: true,
  canResume: false,
};

/**
 * TODO 3.3 — ONE hand-maintained model catalogue, in the ADR-0022 registry.
 *
 * This module used to declare its own `CLAUDE_MODELS` / `CODEX_MODELS` /
 * `CURSOR_MODELS` / `FAKE_MODELS` alongside `VENDOR_REGISTRY[id].models`, two
 * hand-edited lists of the same fact that a vendor bump had to update twice.
 * They agreed only because a drift-lock kept catching them; a catalogue that is
 * correct because a test scolds you is a catalogue that is wrong between
 * commits.
 *
 * So the registry is the source and this is the projection. `null` there means
 * "MUON can verify nothing about an id for this lane" and projects to
 * `undefined` here, which `validateModelForVendor` reads as the degrade path
 * (accept any non-guarded id, with the argv-shape checks still applied) — the
 * same meaning absence has always had. `idShape` rides along so the form check
 * is available to every consumer of the descriptor, not just the route.
 *
 * The arrays are COPIED rather than aliased: the registry's are `readonly` and
 * this module's published `VendorModelPolicy` is not, and widening every
 * downstream consumer to `readonly` to save one module-load copy is a worse
 * trade than the copy.
 */
function registryModelPolicy(vendor: VendorId): VendorModelPolicy | undefined {
  const policy = VENDOR_REGISTRY[vendor].models;
  return policy
    ? {
        known: [...policy.known],
        allowCustom: policy.allowCustom,
        idShape: policy.idShape,
      }
    : undefined;
}

/**
 * The ONE implementation of every `VendorModelIdShape` (TODO 3.4).
 *
 * Kept here rather than in the registry so the form is reviewed as code once,
 * not re-expressed per vendor as a pattern. Assumes the caller has already
 * applied the categorical checks (non-empty, not guarded, not flag-shaped);
 * this answers only "is the id the right SHAPE for this lane".
 */
export function modelIdMatchesShape(
  shape: VendorModelIdShape,
  model: string
): boolean {
  switch (shape) {
    case "provider-qualified": {
      // `provider/model`, and the model half may itself be slash-qualified
      // (`openrouter/qwen/qwen3-coder`), so this is "≥2 segments, none empty"
      // — NOT "exactly one slash", which would refuse ids the vendor's own
      // `models` command prints (3167 of models.dev's 5911 ids are multi-segment,
      // though none of the 121 authed on the author's machine are, so the
      // looseness is justified globally and unexercised locally).
      //
      // `\p{C}\p{Z}` rather than `\s`, which covers neither NUL nor a zero-width
      // space: `anthropic/\u0000x` used to pass the form and then throw
      // ERR_INVALID_ARG_VALUE at `spawn`, and a zero-width space produces two
      // ids that render identically. Neither was INTRODUCED here (both reach
      // claude/codex today via `allowCustom`), but the stated rule is "no
      // whitespace" and this is the function that should mean it.
      if (/[\p{C}\p{Z}]/u.test(model)) return false;
      const segments = model.split("/");
      if (segments.length < 2 || segments.some((s) => s.length === 0)) {
        return false;
      }
      // A model id is not a PATH. `../../etc/passwd` satisfies every rule above
      // — four non-empty segments, no whitespace — and calling that "well
      // formed" would make the form check theatre. Nothing downstream currently
      // resolves a model value as a path (there is no shell on the route to
      // opencode argv, so these are inert single tokens), so this is defence in
      // depth rather than a live fix: the vendor could add a `--model ./file.json`
      // affordance tomorrow without telling MUON.
      if (segments.some((s) => s === "." || s === "..")) return false;
      return !/^[~$]/.test(model);
    }
  }
}

/** The human-facing name of a shape, for a refusal an operator has to act on. */
function modelShapeDescription(shape: VendorModelIdShape): string {
  switch (shape) {
    case "provider-qualified":
      return "'provider/model'";
  }
}

/**
 * WAVE D: projected from the ADR-0022 registry, not a hand-written copy. The
 * `Record<VendorKey, …>` shape is unchanged, so every consumer still indexes it
 * the same way — the only thing that changed is where the strings come from.
 */
export const VENDOR_LABELS: Record<VendorKey, string> = {
  "claude-code": vendorLabel("claude-code"),
  codex: vendorLabel("codex"),
  cursor: vendorLabel("cursor"),
  opencode: vendorLabel("opencode"),
  fake: vendorLabel("fake"),
};

/** Short badge text per vendor (colour is a per-UI concern). */
export const VENDOR_BADGE: Record<VendorKey, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  fake: "fake",
};

// ─────────────────────────── the v1 registry ────────────────────────────────
//
// v1 surfaces the zero/low-plumbing, high-value actions (everything already
// expressible as a LaneProfile patch, a fixed flag, or the one new `ultrareview`
// subcommand override) and GUARDS the four invariant-breakers. v2/v3 (per
// ADR-0013 §Phasing) add prompt-prefix/session-slash breadth, native subagents,
// hooks provenance, the cursor session driver, and ACP-lane descriptors.

const claudeActions: VendorAction[] = [
  {
    id: "model",
    label: "Set model",
    vendor: "claude-code",
    channel: { kind: "profileField", patch: { model: "{arg}" } },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "model",
    arg: { name: "model", required: true },
  },
  {
    id: "effort",
    label: "Reasoning effort",
    vendor: "claude-code",
    channel: { kind: "flag", args: ["--effort", "{arg}"] },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "effort",
    arg: { name: "level", required: true },
    dogfood: true,
    note: "not yet verified against the installed binary",
  },
  {
    id: "permission-mode",
    label: "Permission mode",
    vendor: "claude-code",
    channel: { kind: "profileField", patch: { permissionMode: "{arg}" as never } },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "permission-mode",
    arg: { name: "mode", required: true },
    argValues: ["strict", "default", "auto-edits"],
  },
  {
    id: "sandbox",
    label: "Sandbox mode",
    vendor: "claude-code",
    channel: { kind: "profileField", patch: { sandbox: "{arg}" as never } },
    modes: ["one-shot"],
    parity: "needs-work",
    gate: "none",
    command: "sandbox",
    arg: { name: "mode", required: true },
    argValues: ["read-only", "workspace-write", "full-access"],
    note: "claude has no native sandbox; MUON's OS sandbox is the boundary",
  },
  {
    id: "plan",
    label: "Plan mode",
    vendor: "claude-code",
    channel: { kind: "flag", args: ["--permission-mode", "plan"] },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "plan",
  },
  {
    id: "ultrareview",
    label: "Deep review (ultrareview)",
    vendor: "claude-code",
    channel: { kind: "subcommand", command: "claude", argv: ["ultrareview", "{target}", "--json"] },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "ultrareview",
    arg: { name: "target" },
    dogfood: true,
    note: "re-verified on each vendor version bump",
  },
  {
    id: "resume",
    label: "Resume last session",
    vendor: "claude-code",
    channel: { kind: "flag", args: ["--continue"] },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "resume",
  },
  // ── invariant-guarded ──────────────────────────────────────────────────────
  {
    id: "full-auto",
    label: "Full-auto (bypass prompts)",
    vendor: "claude-code",
    channel: { kind: "profileField", patch: { permissionMode: "full-auto" } },
    modes: ["one-shot", "interactive"],
    parity: "invariant-guarded",
    gate: "dispatch-gate",
    command: "full-auto",
    note: "One-shot runs need approval and stay sandboxed; interactive bypass is unavailable.",
  },
  {
    id: "strict-mcp-config",
    label: "Strict MCP config",
    vendor: "claude-code",
    channel: { kind: "flag", args: [] },
    modes: ["one-shot", "interactive"],
    parity: "invariant-guarded",
    gate: "refuse",
    command: "strict-mcp-config",
    note: "Blocked because MUON's control-plane tools must stay connected.",
  },
  {
    id: "system-prompt",
    label: "Append system prompt",
    vendor: "claude-code",
    channel: { kind: "flag", args: ["--append-system-prompt", "{args}"] },
    modes: ["one-shot"],
    parity: "invariant-guarded",
    gate: "warn",
    command: "system-prompt",
    arg: { name: "text", required: true },
    note: "append only, whole-prompt --system-prompt (strips provenance) is withheld",
  },
  {
    id: "cloud",
    label: "Cloud / remote offload",
    vendor: "claude-code",
    channel: { kind: "flag", args: ["--cloud"] },
    modes: ["one-shot"],
    parity: "invariant-guarded",
    gate: "egress-gate",
    command: "cloud",
    hidden: true,
    note: "leaves this machine, hidden unless the operator opts into egress",
  },
];

const codexActions: VendorAction[] = [
  {
    id: "model",
    label: "Set model",
    vendor: "codex",
    channel: { kind: "profileField", patch: { model: "{arg}" } },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "model",
    arg: { name: "model", required: true },
  },
  {
    id: "effort",
    label: "Reasoning effort",
    vendor: "codex",
    channel: {
      kind: "profileField",
      patch: { rawConfig: { model_reasoning_effort: "{arg}" } },
    },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "effort",
    arg: { name: "level", required: true },
  },
  {
    id: "verbosity",
    label: "Output verbosity",
    vendor: "codex",
    channel: {
      kind: "profileField",
      patch: { rawConfig: { model_verbosity: "{arg}" } },
    },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "verbosity",
    arg: { name: "level", required: true },
  },
  {
    id: "permission-mode",
    label: "Approval mode",
    vendor: "codex",
    channel: { kind: "profileField", patch: { permissionMode: "{arg}" as never } },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "permission-mode",
    arg: { name: "mode", required: true },
    argValues: ["strict", "default", "auto-edits"],
  },
  {
    id: "sandbox",
    label: "Sandbox mode",
    vendor: "codex",
    channel: { kind: "profileField", patch: { sandbox: "{arg}" as never } },
    modes: ["one-shot", "interactive"],
    parity: "clean",
    gate: "none",
    command: "sandbox",
    arg: { name: "mode", required: true },
    argValues: ["read-only", "workspace-write", "full-access"],
  },
  {
    id: "plan",
    label: "Plan mode",
    vendor: "codex",
    channel: { kind: "promptPrefix", text: "/plan" },
    extraPatch: { sandbox: "read-only" },
    modes: ["one-shot"],
    parity: "needs-work",
    gate: "none",
    command: "plan",
    dogfood: true,
    note: "/plan slash fidelity in exec mode un-verified; pairs with read-only sandbox",
  },
  {
    id: "review",
    label: "Review working tree",
    vendor: "codex",
    channel: { kind: "sessionSlash", command: "/review" },
    modes: ["interactive"],
    parity: "needs-work",
    gate: "fail-closed-interpose",
    command: "review",
    dogfood: true,
    note: "interactive-only /review via the app-server session",
  },
  {
    id: "resume",
    label: "Resume last session",
    vendor: "codex",
    channel: { kind: "subcommand", command: "codex", argv: ["resume", "--last"] },
    modes: ["one-shot"],
    parity: "needs-work",
    gate: "none",
    command: "resume",
    dogfood: true,
  },
  // ── invariant-guarded ──────────────────────────────────────────────────────
  {
    id: "full-auto",
    label: "Full-auto (never ask)",
    vendor: "codex",
    channel: { kind: "profileField", patch: { permissionMode: "full-auto" } },
    modes: ["one-shot", "interactive"],
    parity: "invariant-guarded",
    gate: "dispatch-gate",
    command: "full-auto",
    note: "One-shot runs need approval and stay sandboxed; interactive bypass is unavailable.",
  },
];

const cursorActions: VendorAction[] = [
  {
    id: "model",
    label: "Set model",
    vendor: "cursor",
    channel: { kind: "profileField", patch: { model: "{arg}" } },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "model",
    arg: { name: "model", required: true },
  },
  {
    id: "sandbox",
    label: "Sandbox mode",
    vendor: "cursor",
    channel: { kind: "profileField", patch: { sandbox: "{arg}" as never } },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "sandbox",
    arg: { name: "mode", required: true },
    argValues: ["workspace-write", "full-access"],
    note: "read-only degrades (cursor supports enabled/disabled only)",
  },
  {
    id: "plan",
    label: "Plan mode",
    vendor: "cursor",
    channel: { kind: "flag", args: ["--mode", "plan"] },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "plan",
    dogfood: true,
  },
  {
    id: "review",
    label: "Review (ask)",
    vendor: "cursor",
    channel: { kind: "promptPrefix", text: "review the working tree and report issues" },
    modes: ["one-shot"],
    parity: "needs-work",
    gate: "none",
    command: "review",
    dogfood: true,
    note: "no native /review, synthesised as a prompt prefix (no cursor session driver)",
  },
  {
    id: "resume",
    label: "Resume last session",
    vendor: "cursor",
    channel: { kind: "flag", args: ["--resume"] },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "resume",
  },
  // ── invariant-guarded ──────────────────────────────────────────────────────
  {
    id: "full-auto",
    label: "Full-auto (--force)",
    vendor: "cursor",
    channel: { kind: "profileField", patch: { permissionMode: "full-auto" } },
    modes: ["one-shot"],
    parity: "invariant-guarded",
    gate: "dispatch-gate",
    command: "full-auto",
    note: "One-shot only; requires approval and stays inside MUON's sandbox.",
  },
  {
    id: "cloud",
    label: "Cloud handoff (&)",
    vendor: "cursor",
    channel: { kind: "flag", args: ["--cloud"] },
    modes: ["one-shot"],
    parity: "invariant-guarded",
    gate: "egress-gate",
    command: "cloud",
    hidden: true,
    note: "leaves this machine, hidden unless the operator opts into egress",
  },
];

// Dev/test-only descriptor. Only surfaced when the caller opts in (fake vendor
// seam, MUON_FAKE_VENDOR=1), never shown in a production menu.
const fakeActions: VendorAction[] = [
  {
    id: "model",
    label: "Set model",
    vendor: "fake",
    channel: { kind: "profileField", patch: { model: "{arg}" } },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "model",
    arg: { name: "model", required: true },
  },
  {
    id: "ultrareview",
    label: "Deep review (ultrareview)",
    vendor: "fake",
    channel: { kind: "subcommand", argv: ["ultrareview", "{target}", "--json"] },
    modes: ["one-shot"],
    parity: "clean",
    gate: "none",
    command: "ultrareview",
    arg: { name: "target" },
  },
];

/**
 * Deliberately empty — see the `opencode` descriptor below. Declared as a named
 * const rather than an inline `[]` so that adding the lane's first action is a
 * one-line edit here, next to the note explaining what earning one requires.
 */
const opencodeActions: VendorAction[] = [];

export const VENDOR_CAPABILITY_DESCRIPTORS: Record<VendorKey, VendorCapabilityDescriptor> = {
  "claude-code": {
    vendor: "claude-code",
    displayName: VENDOR_LABELS["claude-code"],
    actions: claudeActions,
    laneCapabilities: CLAUDE_LANE_CAPS,
    sessionCapabilities: CLAUDE_SESSION_CAPS,
    models: registryModelPolicy("claude-code"),
  },
  codex: {
    vendor: "codex",
    displayName: VENDOR_LABELS.codex,
    actions: codexActions,
    laneCapabilities: CODEX_LANE_CAPS,
    sessionCapabilities: CODEX_SESSION_CAPS,
    models: registryModelPolicy("codex"),
  },
  cursor: {
    vendor: "cursor",
    displayName: VENDOR_LABELS.cursor,
    actions: cursorActions,
    laneCapabilities: CURSOR_LANE_CAPS,
    // No cursor session driver (matrix): no live steer/approval callback.
    models: registryModelPolicy("cursor"),
  },
  /**
   * TODO 3.3 — opencode has a descriptor ROW; it does not yet have ACTIONS.
   *
   * The row exists so the lane is enumerable and total over the registry (see
   * `VendorKey`). The empty action set is the same refusal the missing row used
   * to express, only now it is a statement instead of an omission:
   * `resolveVendorAction` answers "OpenCode has no 'plan' action" for every id,
   * and `buildVendorActionMenu` contributes nothing for it. ADR-0022 G10 gates
   * full-auto on a vendor-native action set, so an EMPTY set keeps that gate
   * exactly as closed as absence did.
   *
   * TODO 3.4 — `models` is no longer `null`, and the two facts stayed separate.
   * The lane now carries `known: []` + `idShape: "provider-qualified"`, so the
   * per-dispatch override is ADMITTED (form verified, membership honestly not)
   * while `actions` stays EMPTY, which is what G10's full-auto gate reads. The
   * catalogue lift granted this lane no new authority — only a validated field.
   */
  opencode: {
    vendor: "opencode",
    displayName: VENDOR_LABELS.opencode,
    actions: opencodeActions,
    laneCapabilities: OPENCODE_LANE_CAPS,
    // No opencode session driver: `serve` is a network listener with its own
    // auth model, and a scout has nothing to steer (ADR-0022 G7/G8).
    models: registryModelPolicy("opencode"),
  },
  fake: {
    vendor: "fake",
    displayName: VENDOR_LABELS.fake,
    actions: fakeActions,
    laneCapabilities: CLAUDE_LANE_CAPS,
    models: registryModelPolicy("fake"),
  },
};

/**
 * Registry order, not `Object.keys` order — the descriptor table is total over
 * `VendorId` now, so the enumeration may as well be the registry's own.
 */
export const VENDOR_KEYS = [...VENDOR_IDS];

/**
 * Non-fake vendors, the production surface — a projection of the registry's
 * `visibility` column rather than a fourth hand-written vendor list.
 */
export const PUBLIC_VENDOR_KEYS: VendorKey[] = [...publicVendorIds()];

/** Every slash token that maps to a vendor action (for the command grammar). */
export const VENDOR_ACTION_COMMAND_TOKENS: ReadonlySet<string> = new Set(
  VENDOR_KEYS.flatMap((key) =>
    VENDOR_CAPABILITY_DESCRIPTORS[key].actions.map((action) => action.command)
  )
);

/** Friendly vendor aliases → the canonical lane key ("claude" → "claude-code"). */
const VENDOR_ALIASES: Record<string, VendorKey> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  fake: "fake",
};

/** Resolve a user-typed vendor token (bare or `[bracketed]`) to a lane key. */
export function normalizeVendorAlias(token: string | undefined): VendorKey | undefined {
  if (!token) return undefined;
  const cleaned = token.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return VENDOR_ALIASES[cleaned];
}

/** Is `token` a vendor-action slash token (without leading slash)? */
export function isVendorActionCommand(token: string): boolean {
  return VENDOR_ACTION_COMMAND_TOKENS.has(token.toLowerCase());
}

// ───────────────────────────── the resolver ─────────────────────────────────

export type ResolveContext = {
  /** Trailing args after `/action [vendor]`. */
  args?: string[];
  /** Primary target (defaults to args[0]), e.g. the ultrareview target. */
  target?: string;
  /** The mode this dispatch runs in (drives the interactive full-auto guard). */
  mode?: InvocationMode;
  /** Operator has opted into egress for this run (unlocks cloud/remote). */
  egressOptIn?: boolean;
};

export type ResolvedVendorAction = {
  supported: boolean;
  reason?: string;
  action?: VendorAction;
  /** Patch merged into the LaneProfile before `compileProfileForLane`. */
  profilePatch?: Partial<LaneProfile>;
  /** Overrides `BaseLaneAdapter.taskCommand` for this run (subcommand channel). */
  argvOverride?: { command?: string; args: string[] };
  /** Prepended to the brief before dispatch (promptPrefix channel). */
  briefPrefix?: string;
  /** Sent into a live session via `SessionHandle.send` (sessionSlash channel). */
  sessionSend?: string;
  gate: GatePolicy;
  parity: ParityClass;
  warnings: string[];
  /** True when the action is permitted but its raw bypass is refused/re-routed. */
  refused?: boolean;
  /** True when a bypass was withheld (interactive full-auto → default). */
  downgraded?: boolean;
};

function substituteString(value: string, ctx: ResolveContext): string {
  const target = ctx.target ?? ctx.args?.[0] ?? "";
  const firstArg = ctx.args?.[0] ?? "";
  const allArgs = (ctx.args ?? []).join(" ");
  return value
    .replace(/\{target\}/g, target)
    .replace(/\{args\}/g, allArgs)
    .replace(/\{arg\}/g, firstArg);
}

/** Deep placeholder substitution over arrays / objects / strings. */
function substitute<T>(value: T, ctx: ResolveContext): T {
  if (typeof value === "string") {
    return substituteString(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, ctx)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substitute(v, ctx),
      ])
    ) as unknown as T;
  }
  return value;
}

export function getVendorAction(
  vendor: VendorKey,
  actionId: string
): VendorAction | undefined {
  return VENDOR_CAPABILITY_DESCRIPTORS[vendor]?.actions.find(
    (action) => action.id === actionId || action.command === actionId
  );
}

/**
 * INVARIANT GUARD, strip any raw flag that would defeat a MUON boundary from a
 * user-supplied argv/extraArgs list. `--strict-mcp-config` is removed unless
 * the caller explicitly marks the leading exact bare flag in this segment as
 * compiler-owned (the governed-brain MCP server must never be user-evictable).
 * In interactive mode a permission bypass flag is removed too (the
 * `canUseTool` interpose stays).
 */
export function sanitizeGuardedArgs(
  args: string[],
  opts: {
    interactive?: boolean;
    allowLeadingCompilerOwnedStrictMcpConfig?: boolean;
  } = {}
): { args: string[]; removed: string[] } {
  const removed: string[] = [];
  const bypassFlags = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-skip-permissions",
    "--yolo",
  ];
  // Match both the bare flag and its `=`-joined form (`--yolo=1`), which yargs/
  // commander accept, exact-string matching would let the `=` form slip past.
  const guardMatch = (arg: string, flag: string): boolean =>
    arg === flag || arg.startsWith(`${flag}=`);
  const out: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (
      index === 0 &&
      arg === "--strict-mcp-config" &&
      opts.allowLeadingCompilerOwnedStrictMcpConfig
    ) {
      out.push(arg);
      continue;
    }
    if (guardMatch(arg, "--strict-mcp-config")) {
      removed.push(arg);
      continue;
    }
    if (opts.interactive && bypassFlags.some((flag) => guardMatch(arg, flag))) {
      removed.push(arg);
      continue;
    }
    out.push(arg);
  }
  return { args: out, removed };
}

/**
 * The CATEGORICAL half of model validation: a value is argv-safe when it is
 * neither a guarded value nor flag-shaped. `validateModelForVendor` layers the
 * per-vendor `known`/`allowCustom` policy on top; this is what a lane applies
 * when it puts the model on argv ITSELF (the Codex OSS runtime's `-m`) rather
 * than routing it through the profile compiler, so both paths fail closed on
 * exactly the same rule.
 */
export function isArgvSafeModelValue(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    return false;
  }
  return sanitizeGuardedArgs([trimmed], { interactive: true }).removed.length === 0;
}

export type ModelValidationResult = {
  /** True when the model is safe to pass to the vendor. */
  ok: boolean;
  /** Fail-closed rejection reason (present only when `ok` is false). */
  reason?: string;
  /** Non-blocking degrade warning (unknown id under `allowCustom`). */
  warning?: string;
};

/**
 * The model-validation backbone (S5). Fail-closed: an invalid model NEVER
 * silently passes through to the vendor argv, the caller (route / agent-tier /
 * compiler) must refuse it. Pure, no network, no spawn.
 *
 * Order matters — the specific security rejections fire before the generic
 * flag-shape net so the reason is precise:
 *   1. empty / whitespace-only  → refuse.
 *   2. guarded value (`--strict-mcp-config`, a permission bypass, …) → refuse.
 *   3. any other flag-shaped value (leading `-`) → refuse (a model is a value,
 *      never an argv flag).
 *   4. declared `idShape` and the id does not match it → refuse (TODO 3.4).
 *   5. known id → accept, no warning.
 *   6. unknown id + `allowCustom` → accept WITH a warning (degrade, never guess,
 *      never hard-pin an id).
 *   7. unknown id + `!allowCustom` → refuse.
 * A vendor with no declared `models` policy accepts any non-guarded id (the
 * checks 1–3 still apply), so a new vendor degrades safely rather than blocks.
 *
 * Step 4 sits BEFORE membership on purpose: it is the check that makes an
 * unenumerable catalogue (`known: []`, opencode) meaningfully validated rather
 * than waved through, and putting it after `known` would let a registry typo in
 * `known` mask the form.
 */
/**
 * TODO 3.5 — does this vendor have a MODEL control worth rendering?
 *
 * True when the registry declares a catalogue object (including the empty-
 * `known` + `idShape` form that opencode uses). False when `models: null`
 * (nothing about an id is checkable) — the control vanishes rather than
 * greying out. Distinct from "has a non-empty dropdown list"; that is what
 * the crew-tab `known.length > 0` predicate asks.
 */
export function vendorSupportsModelControl(vendor: string): boolean {
  return isVendorId(vendor) && VENDOR_REGISTRY[vendor].models !== null;
}

/**
 * TODO 3.5 — does this vendor have an EFFORT / reasoning-level control?
 *
 * Driven by the descriptor's `effort` action, not by a boolean flag: a vendor
 * without a channel cannot honour the choice, so the control must vanish.
 */
export function vendorSupportsEffortControl(vendor: string): boolean {
  if (!isVendorId(vendor)) return false;
  return (VENDOR_CAPABILITY_DESCRIPTORS[vendor]?.actions ?? []).some(
    (action) => action.id === "effort"
  );
}

export function validateModelForVendor(
  vendor: VendorKey,
  model: string
): ModelValidationResult {
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "model must not be empty" };
  }
  // TODO 3.6: the Default sentinel is a MUON control value, not a vendor id.
  // Accept it here so the dispatch route does not 400; compilers and the route
  // both strip it to "no model flag" before anything reaches argv.
  if (isDefaultModel(trimmed)) {
    return { ok: true };
  }
  // The categorical guarded-flag net (also catches interactive bypass flags).
  // Fires before the leading-`-` check so a guarded value gets its own reason
  // and can never be echoed back as a passable id.
  if (sanitizeGuardedArgs([trimmed], { interactive: true }).removed.length > 0) {
    return {
      ok: false,
      reason: "model is a guarded value and cannot be passed to the vendor",
    };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, reason: "model must not look like a flag" };
  }

  const policy = VENDOR_CAPABILITY_DESCRIPTORS[vendor]?.models;
  const vendorLabel = VENDOR_LABELS[vendor] ?? vendor;
  // No declared policy → accept any non-guarded id (degrade, never guess).
  if (!policy) {
    return { ok: true };
  }
  // Step 3.5 (TODO 3.4): a declared FORM is checked before membership, so a
  // vendor with an unenumerable catalogue still refuses a malformed id instead
  // of forwarding it to fail opaquely at the vendor.
  if (policy.idShape && !modelIdMatchesShape(policy.idShape, trimmed)) {
    return {
      ok: false,
      reason: `'${trimmed}' is not a valid ${vendorLabel} model id: expected ${modelShapeDescription(policy.idShape)}`,
    };
  }
  if (policy.known.includes(trimmed)) {
    return { ok: true };
  }
  if (policy.allowCustom) {
    // Two different unknowns, and conflating them is what made the old message
    // wrong for opencode. An EMPTY `known` means MUON never claimed to enumerate
    // this lane, so "not a known model" would blame the operator for MUON's
    // silence; the id passed every check MUON has, and the residual risk is
    // membership in THIS operator's provider set.
    const warning =
      policy.known.length === 0 && policy.idShape
        ? `MUON verifies only the ${modelShapeDescription(policy.idShape)} form for ${vendorLabel}; '${trimmed}' must be a model your configured providers actually offer`
        : `'${trimmed}' is not a known ${vendorLabel} model; passing it through unverified`;
    return { ok: true, warning };
  }
  return {
    ok: false,
    reason: `'${trimmed}' is not a known ${vendorLabel} model (known: ${policy.known.join(", ")})`,
  };
}

/**
 * Turn an Action (+ user args) into inputs the CURRENT dispatch path already
 * accepts. Pure and deterministic, no network, no spawn. The four
 * invariant-guarded features are re-routed here, never passed verbatim.
 */
export function resolveVendorAction(
  vendor: VendorKey,
  actionId: string,
  ctx: ResolveContext = {}
): ResolvedVendorAction {
  if (vendor === "cursor") {
    // The REFUSAL is still right — MUON models no vendor-native actions for
    // Cursor — but the reason must not claim Cursor is undispatchable. Since
    // ADR-0020 it IS a managed lane for read-only roles; only its vendor-native
    // action surface is unmodelled. A stale reason string here is user-visible
    // and would contradict what the crew view shows.
    return {
      supported: false,
      reason:
        "MUON models no vendor-native actions for Cursor. Its managed lane runs read-only review roles through the standard dispatch path; there is no Cursor action set to resolve.",
      gate: "none",
      parity: "needs-work",
      warnings: [],
    };
  }
  const action = getVendorAction(vendor, actionId);
  if (!action) {
    return {
      supported: false,
      reason: `${VENDOR_LABELS[vendor] ?? vendor} has no '${actionId}' action`,
      gate: "none",
      parity: "clean",
      warnings: [],
    };
  }

  const mode: InvocationMode = ctx.mode ?? "one-shot";
  const warnings: string[] = [];

  // Readiness by MODE: never offer an action the lane can't honour in this mode.
  if (!action.modes.includes(mode)) {
    return {
      supported: false,
      reason: `'${action.id}' is not available in ${mode} mode for ${VENDOR_LABELS[vendor]}`,
      action,
      gate: action.gate,
      parity: action.parity,
      warnings,
    };
  }

  // Cloud / remote: withheld unless the operator explicitly opts into egress.
  if (action.gate === "egress-gate" && !ctx.egressOptIn) {
    return {
      supported: false,
      reason: "egress gate: cloud/remote leaves this machine, opt in to enable",
      action,
      gate: action.gate,
      parity: action.parity,
      warnings,
    };
  }

  // Required / constrained argument validation, degrade, never guess.
  const providedArg = ctx.args?.[0];
  if (action.arg?.required && !providedArg) {
    return {
      supported: false,
      reason: `'${action.id}' needs a ${action.arg.name}`,
      action,
      gate: action.gate,
      parity: action.parity,
      warnings,
    };
  }
  if (action.argValues && providedArg && !action.argValues.includes(providedArg)) {
    return {
      supported: false,
      reason: `${action.arg?.name ?? "argument"} must be one of: ${action.argValues.join(", ")}`,
      action,
      gate: action.gate,
      parity: action.parity,
      warnings,
    };
  }

  const result: ResolvedVendorAction = {
    supported: true,
    action,
    gate: action.gate,
    parity: action.parity,
    warnings,
  };

  // ── GUARD: --strict-mcp-config → refuse (control plane is non-evictable) ──
  if (action.gate === "refuse") {
    result.refused = true;
    warnings.push(
      "Blocked: MUON's control-plane tools stay connected."
    );
    // No patch / argv / prefix is emitted, the flag can never reach the vendor.
    return result;
  }

  const extra = action.extraPatch ? substitute(action.extraPatch, ctx) : undefined;

  switch (action.channel.kind) {
    case "profileField": {
      let patch = substitute(action.channel.patch, ctx);
      // ── GUARD: full-auto in interactive → withhold the bypass ──────────────
      if (action.id === "full-auto" && mode === "interactive") {
        patch = { ...patch, permissionMode: "default" };
        result.downgraded = true;
        warnings.push(
          "full-auto withheld in interactive, canUseTool still interposes; permission mode forced to default"
        );
      } else if (action.gate === "dispatch-gate") {
        warnings.push(
          "full-auto: bounded by the OS sandbox + no-egress and filed at an operator dispatch-gate"
        );
      }
      result.profilePatch = extra ? { ...extra, ...patch } : patch;
      break;
    }
    case "flag": {
      const sanitized = sanitizeGuardedArgs(substitute(action.channel.args, ctx), {
        interactive: mode === "interactive",
      });
      if (sanitized.removed.length > 0) {
        warnings.push(`stripped guarded flag(s): ${sanitized.removed.join(" ")}`);
      }
      const patch: Partial<LaneProfile> = { extraArgs: sanitized.args };
      result.profilePatch = extra ? { ...extra, ...patch } : patch;
      if (action.gate === "warn") {
        warnings.push(action.note ?? "provenance: review before dispatch");
      }
      break;
    }
    case "subcommand": {
      // A subcommand fills `{target}`/`{arg}`/`{args}` from raw user input into
      // STANDALONE argv tokens (unlike `flag`, where user values land in value
      // positions). GUARD: a review target is a path/ref, never a flag, reject
      // any user-filled token that begins with `-`, so a guarded flag
      // (`--strict-mcp-config`, `--dangerously-skip-permissions`, `--yolo`, …)
      // cannot smuggle past its own gate through this channel's target slot.
      const filled = action.channel.argv.map((token) => ({
        value: substituteString(token, ctx),
        fromUser: /\{(?:target|arg|args)\}/.test(token),
      }));
      const injected = filled.find((f) => f.fromUser && f.value.startsWith("-"));
      if (injected) {
        return {
          supported: false,
          reason: `'${action.id}' ${action.arg?.name ?? "argument"} must be a path/ref, not a flag ('${injected.value}')`,
          action,
          gate: action.gate,
          parity: action.parity,
          warnings,
        };
      }
      // Backstop on EVERY channel (not just `flag`): strip guarded flags even if a
      // template ever carried one. `sanitizeGuardedArgs` is the categorical net.
      const sanitized = sanitizeGuardedArgs(
        filled.map((f) => f.value).filter((token) => token.length > 0),
        { interactive: mode === "interactive" }
      );
      if (sanitized.removed.length > 0) {
        warnings.push(`stripped guarded flag(s): ${sanitized.removed.join(" ")}`);
      }
      result.argvOverride = { command: action.channel.command, args: sanitized.args };
      if (extra) result.profilePatch = extra;
      break;
    }
    case "promptPrefix": {
      result.briefPrefix = substituteString(action.channel.text, ctx);
      if (extra) result.profilePatch = extra;
      if (action.dogfood) {
        warnings.push("prompt-prefix channel, slash fidelity un-verified (preview)");
      }
      break;
    }
    case "sessionSlash": {
      // Only reachable when the vendor has a live session that accepts sends.
      const caps = VENDOR_CAPABILITY_DESCRIPTORS[vendor].sessionCapabilities;
      if (!caps?.canSend) {
        return {
          supported: false,
          reason: `${VENDOR_LABELS[vendor]} cannot send into a live session (no session driver / canSend:false)`,
          action,
          gate: action.gate,
          parity: action.parity,
          warnings,
        };
      }
      result.sessionSend = substituteString(action.channel.command, ctx);
      if (extra) result.profilePatch = extra;
      break;
    }
    case "mcp": {
      return {
        supported: false,
        reason: "mcp channel is deferred to v3",
        action,
        gate: action.gate,
        parity: action.parity,
        warnings,
      };
    }
  }

  return result;
}

// ─────────────────────────── the UI view model ──────────────────────────────

export type VendorReadinessLike = {
  vendor: string;
  installed: boolean;
  authenticated: boolean;
};

export type VendorActionMenuItem = {
  actionId: string;
  vendor: VendorKey;
  vendorLabel: string;
  badge: string;
  command: string;
  label: string;
  parity: ParityClass;
  gate: GatePolicy;
  dogfood: boolean;
  /** Compact chip text (parity/gate) for the palette. */
  chip: string;
  /** True when offerable in the given mode + readiness. */
  ready: boolean;
  note?: string;
};

/** Compact parity/gate chip label, shared by the TUI + desktop. */
export function actionChip(action: VendorAction): string {
  let base: string;
  switch (action.gate) {
    case "refuse":
      base = "blocked";
      break;
    case "egress-gate":
      base = "needs egress approval";
      break;
    case "dispatch-gate":
      base = "needs approval";
      break;
    case "warn":
      base = "review";
      break;
    case "fail-closed-interpose":
      base = "needs approval";
      break;
    default:
      base =
        action.parity === "clean"
          ? "available"
          : action.parity === "needs-work"
            ? "limited"
            : "needs approval";
  }
  return action.dogfood ? `${base} ⚠` : base;
}

export type VendorActionMenuOptions = {
  /** Vendor readiness, when provided, only ready vendors' actions are offered. */
  readiness?: VendorReadinessLike[] | null;
  /** Mode filter, only actions reachable in this mode are offered. */
  mode?: InvocationMode;
  /** Restrict to a single vendor. */
  vendor?: VendorKey;
  /** Restrict to a single action id / command token. */
  actionId?: string;
  /** Include `hidden` (cloud/egress) actions. */
  includeHidden?: boolean;
  /** Include the dev/test `fake` vendor. */
  includeFake?: boolean;
};

function vendorReady(
  vendor: VendorKey,
  readiness: VendorReadinessLike[] | null | undefined
): boolean {
  // Degrade, never block: a null probe leaves actions offerable.
  if (readiness == null) return true;
  const entry = readiness.find((item) => item.vendor === vendor);
  return Boolean(entry && entry.installed && entry.authenticated);
}

/**
 * Build the readiness- and mode-aware flag menu the TUI palette and the desktop
 * lane menu both render, the single shared truth (like the P2b onboarding / P6
 * preedit-view view-models). Only offers an action a lane can actually honour.
 */
export function buildVendorActionMenu(
  opts: VendorActionMenuOptions = {}
): VendorActionMenuItem[] {
  const mode = opts.mode ?? "one-shot";
  const vendors = opts.vendor ? [opts.vendor] : VENDOR_KEYS;
  const items: VendorActionMenuItem[] = [];

  for (const vendor of vendors) {
    if (vendor === "fake" && !opts.includeFake) continue;
    const descriptor = VENDOR_CAPABILITY_DESCRIPTORS[vendor];
    if (!descriptor) continue;
    const ready = vendorReady(vendor, opts.readiness);

    for (const action of descriptor.actions) {
      if (action.hidden && !opts.includeHidden) continue;
      if (opts.actionId && action.id !== opts.actionId && action.command !== opts.actionId) {
        continue;
      }
      if (!action.modes.includes(mode)) continue;
      // sessionSlash actions are only reachable where the vendor can send.
      if (
        action.channel.kind === "sessionSlash" &&
        !descriptor.sessionCapabilities?.canSend
      ) {
        continue;
      }

      items.push({
        actionId: action.id,
        vendor,
        vendorLabel: descriptor.displayName,
        badge: VENDOR_BADGE[vendor],
        command: action.command,
        label: action.label,
        parity: action.parity,
        gate: action.gate,
        dogfood: Boolean(action.dogfood),
        chip: actionChip(action),
        ready,
        note: action.note,
      });
    }
  }

  return items;
}

/** Merge a resolver profile patch onto a base LaneProfile (arrays append). */
export function mergeProfilePatch(
  base: LaneProfile,
  patch: Partial<LaneProfile> | undefined
): LaneProfile {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    // APPEND (not replace): the base profile carries the injected governed-brain
    // MCP server, which must never be evictable. A patch may add servers; it can
    // never drop the brain by replacing the array wholesale.
    mcpServers: [...base.mcpServers, ...(patch.mcpServers ?? [])],
    contextFiles: [...base.contextFiles, ...(patch.contextFiles ?? [])],
    addDirs: [...base.addDirs, ...(patch.addDirs ?? [])],
    allowedTools: [...base.allowedTools, ...(patch.allowedTools ?? [])],
    deniedTools: [...base.deniedTools, ...(patch.deniedTools ?? [])],
    extraArgs: [...base.extraArgs, ...(patch.extraArgs ?? [])],
    env: { ...base.env, ...(patch.env ?? {}) },
    rawConfig: { ...base.rawConfig, ...(patch.rawConfig ?? {}) },
  };
}
