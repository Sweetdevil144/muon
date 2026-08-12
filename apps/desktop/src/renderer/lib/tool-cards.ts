/**
 * Renderer-side projection of MUON's flat activity ledger into discrete,
 * self-contained tool cards.
 *
 * The activity line is the spine, so this module is a *parser*, not an
 * inventor: every title it renders is derived from a line MUON actually
 * emitted, and the exact wire name always travels with the card so a friendly
 * title can never overstate what ran.
 *
 * A line may now also carry `detail` — the bounded, redacted args and result
 * tail the adapter captured for that exact call. That payload is UNTRUSTED
 * agent/vendor text: it is bounded again here, it never becomes a title or a
 * claim in MUON's own voice, and the card body renders it as data only after a
 * human expands it.
 *
 * Three collapses happen here, in order:
 *  1. `X started` + `X completed` become ONE card (a tool call is one entity).
 *  2. Adjacent identical cards merge into one card with a repeat count, so a
 *     197-call `ToolSearch` storm is a single row instead of 394.
 *  3. Failures and governance denials keep their own status so the transcript
 *     can give them a distinct, always-open treatment instead of burying them.
 *
 * Everything degrades: an unparseable line becomes a plain note card carrying
 * its own text verbatim, so an old persisted chat can never blank the turn.
 */

export type ToolCardStatus =
  | "pending"
  | "ok"
  | "failed"
  | "denied"
  | "note";

export type ToolCardIcon =
  | "terminal"
  | "graph"
  | "brain"
  | "file"
  | "edit"
  | "crew"
  | "gate"
  | "step";

/**
 * Bounded, redacted record of what one tool call did. Structural mirror of the
 * `StreamChunkDetail` wire shape, tolerant of older projections that lack it.
 * UNTRUSTED: agent/vendor-authored, never MUON's own copy.
 */
export type ToolCardDetail = {
  args?: string;
  argsTruncated?: boolean;
  result?: string;
  resultTruncated?: boolean;
};

export type ToolCard = {
  /** Stable across a live turn so an expanded card stays expanded. */
  key: string;
  /** Human-readable intent. Never more specific than the wire line. */
  title: string;
  /** Exact wire tool name, when the line named one. Provenance, not decoration. */
  tool?: string;
  /** Short honest argument/echo summary for the header (Cursor's `cd, 2+`). */
  summary?: string;
  status: ToolCardStatus;
  /** How many identical adjacent calls this one card stands for. */
  repeat: number;
  /** Why it failed / was denied — surfaced on the card face, not hidden. */
  reason?: string;
  /** Governance provenance (approved/denied by MUON), when the ledger said so. */
  governance?: string;
  /** Bounded raw lines this card was built from; the expand target. */
  detail: string[];
  /** True when `detail` was clipped, so the UI can say so honestly. */
  detailTruncated: boolean;
  /**
   * What the tool was CALLED with, as the ledger recorded it. UNTRUSTED.
   * Absent for every call made before MUON captured this, so a card without it
   * renders exactly as it did before.
   */
  args?: string;
  /** The recorded args were clipped; the card says so rather than implying all. */
  argsTruncated?: boolean;
  /** What the tool RETURNED (tail-kept — errors live at the end). UNTRUSTED. */
  output?: string;
  /** The recorded output was clipped (leading output dropped). */
  outputTruncated?: boolean;
  icon: ToolCardIcon;
  live: boolean;
  needsAttention: boolean;
};

/**
 * Structural input: assignable from `TranscriptActivity` but tolerant of older
 * persisted projections that lack the newer fields.
 */
export type ToolActivityInput = {
  text: string;
  count?: number;
  needsAttention?: boolean;
  live?: boolean;
  /** The bounded/redacted detail the ledger recorded for this exact line. */
  detail?: ToolCardDetail;
};

export type BuildToolCardsOptions = {
  /**
   * First activity line → full raw status text. The transcript projection
   * concises each status to its first line; when the renderer still holds the
   * untruncated text it becomes the card's "output on expand".
   */
  rawByLine?: ReadonlyMap<string, string>;
};

const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_CHARS = 8000;
const MAX_LINE_CHARS = 2000;
const MAX_TITLE_CHARS = 96;
const MAX_SUMMARY_CHARS = 64;
const MAX_REASON_CHARS = 400;
// Render-side backstop on the captured detail. The wire is already bounded at
// the adapter, the recorder, and the write route; this is the last one, so a
// hostile or out-of-date payload still cannot put unbounded text in the DOM.
const MAX_ARGS_CHARS = 2048;
const MAX_OUTPUT_CHARS = 8192;

/** MCP servers MUON ships; anything else keeps its raw server name. */
const SERVER_LABELS: Record<string, string> = {
  muon: "MUON brain",
  gitnexus: "Code graph",
};

/** Purpose of well-known vendor tools. Unknown tools keep their wire name. */
const BUILTIN_TITLES: Record<string, string> = {
  bash: "Ran a shell command",
  bashoutput: "Read command output",
  killshell: "Stopped a shell",
  read: "Read a file",
  write: "Wrote a file",
  edit: "Edited a file",
  multiedit: "Edited a file",
  apply_patch: "Applied a patch",
  applypatch: "Applied a patch",
  glob: "Found files by name",
  grep: "Searched file contents",
  toolsearch: "Loaded tool schemas",
  task: "Dispatched a subagent",
  agent: "Dispatched a subagent",
  webfetch: "Fetched a web page",
  websearch: "Searched the web",
  todowrite: "Updated the task list",
  notebookedit: "Edited a notebook",
  "codex command": "Ran a Codex command",
  "codex file change": "Codex changed files",
  "codex native sub-agent": "Codex ran a native sub-agent",
};

const MILESTONE_TITLES: Record<string, string> = {
  "contract.failed": "Dispatch contract failed",
  "contract.retry": "Dispatch contract retried",
  "contract.crew": "Crew contract verified",
  "contract.single": "Dispatch contract",
  "task.started": "Session started",
  "task.completed": "Session completed",
  "task.blocked": "Blocked",
  "task.progress": "Progress",
  "approval.requested": "Approval requested",
  "approval.resolved": "Approval resolved",
  "gate.opened": "Gate opened",
  "gate.closed": "Gate closed",
};

/**
 * Subjects that read like `<x> started` but are session lifecycle, not tools.
 * Keeping them out of the tool grammar stops "Claude session" from ever being
 * presented to a human as a tool call.
 */
const NON_TOOL_SUBJECTS = new Set([
  "claude session",
  "claude turn",
  "codex session",
  "codex turn",
  "cursor session",
  "cursor turn",
  "codex capability preflight",
  "the session",
  "muon",
  "session",
]);

const MILESTONE_RE = /^\[([a-z][a-z0-9._-]*)\]\s+([\s\S]*)$/i;
const LIFECYCLE_RE =
  /^(.+?)\s+(started|completed|failed|denied|approved|is still working|approval failed closed)$/;
const ARGS_RE = /^([^\s(]+)\(([^)]{0,160})\)$/;
const GOVERNANCE_DENIAL_RE = /^MUON(?:\s+policy)?\s+denied[:\s]\s*(.*)$/i;
const APPROVAL_REQUEST_RE = /^session tool request:\s*(.+)$/i;
const FAILURE_MILESTONE_RE = /(?:^|\.)(?:failed|blocked|error|denied)$/i;

const DENIED_BY_MUON = "Denied by MUON governance";
const APPROVED_BY_MUON = "Approved by MUON governance";

type LifecyclePhase =
  | "started"
  | "completed"
  | "failed"
  | "denied"
  | "approved"
  | "progress";

type ParsedLine =
  | {
      kind: "lifecycle";
      tool: string;
      args?: string;
      phase: LifecyclePhase;
      reason?: string;
    }
  | {
      kind: "notice";
      milestone?: string;
      body: string;
      status: ToolCardStatus;
      tool?: string;
      reason?: string;
    };

type WorkingCard = ToolCard & {
  pendingCount: number;
  /** Folded into a later denial card; filtered before render. */
  absorbed?: boolean;
};

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Mirrors the transcript projection's first-line/180-char concision so a card
 * can look its full raw text back up. Drift here only costs the richer expand
 * body — it can never blank or corrupt a card.
 */
export function conciseKey(text: string, max = 180): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1)}…`;
}

function isToolSubject(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (/[:;,]$/.test(trimmed)) return false;
  if (NON_TOOL_SUBJECTS.has(trimmed.toLowerCase())) return false;
  if (trimmed.split(/\s+/).length > 4) return false;
  return /^[A-Za-z0-9_]/.test(trimmed);
}

/** Split `mcp__server__tool` and Codex's `server.tool` into its coordinates. */
function mcpParts(tool: string): { server: string; name: string } | undefined {
  const prefixed = /^mcp__([A-Za-z0-9_.-]+)__(.+)$/.exec(tool);
  if (prefixed?.[1] && prefixed[2]) {
    return { server: prefixed[1], name: prefixed[2] };
  }
  const dotted = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(tool);
  if (dotted?.[1] && dotted[2] && SERVER_LABELS[dotted[1].toLowerCase()]) {
    return { server: dotted[1], name: dotted[2] };
  }
  return undefined;
}

/**
 * What a MUON MCP tool is *for*. This is the "shared brain + code
 * understanding" vocabulary the product sells, applied to the tool that
 * actually ran — the exact wire name still rides on the card beside it.
 */
function muonFamily(name: string): { label: string; icon: ToolCardIcon } {
  const lower = name.toLowerCase();
  if (
    /^(code_(query|context|impact)|repo_map|flow_scope|data_boundaries|review_diff|preflight_edit|shape_check)$/.test(
      lower
    )
  ) {
    return { label: "Code graph", icon: "graph" };
  }
  if (/^memory_/.test(lower)) return { label: "Shared memory", icon: "brain" };
  if (
    /^(dispatch|delegate|dispatch_status|interrupt|steer|set_fleet|fleet_status|assign_roles|crew_roles|peer_inbox|peer_message|read_stream|handoff_read)$/.test(
      lower
    )
  ) {
    return { label: "Crew", icon: "crew" };
  }
  if (
    /^(check_approval|ship|raise_budget|budget_status|capability_preflight)$/.test(
      lower
    )
  ) {
    return { label: "Governance", icon: "gate" };
  }
  return { label: "MUON", icon: "brain" };
}

/**
 * Describe a tool by intent. Every branch bottoms out in the wire name, so a
 * title can restate what ran but never claim more than the ledger said.
 */
function describeTool(tool: string): { title: string; icon: ToolCardIcon } {
  const parts = mcpParts(tool);
  if (parts) {
    const server = parts.server.toLowerCase();
    const family =
      server === "muon"
        ? muonFamily(parts.name)
        : server === "gitnexus"
          ? { label: "Code graph", icon: "graph" as ToolCardIcon }
          : {
              label: SERVER_LABELS[server] ?? parts.server,
              icon: "graph" as ToolCardIcon,
            };
    return {
      title: clamp(`${family.label} · ${parts.name}`, MAX_TITLE_CHARS),
      icon: family.icon,
    };
  }

  const lower = tool.trim().toLowerCase();
  const known = BUILTIN_TITLES[lower];
  const title = known ?? clamp(tool, MAX_TITLE_CHARS);
  if (/^(bash|bashoutput|killshell)$/.test(lower) || lower.includes("command")) {
    return { title, icon: "terminal" };
  }
  if (
    /^(edit|multiedit|write|apply_?patch)$/.test(lower) ||
    lower.includes("file change")
  ) {
    return { title, icon: "edit" };
  }
  if (/^(read|grep|glob|toolsearch|webfetch|websearch|notebookedit)$/.test(lower)) {
    return { title, icon: "file" };
  }
  if (/^(task|agent)$/.test(lower) || /sub-?agent|dispatch|delegate|crew/.test(lower)) {
    return { title, icon: "crew" };
  }
  return { title, icon: "step" };
}

/** Title a tool by intent. Falls back to the wire name — never past it. */
export function toolTitle(tool: string): string {
  return describeTool(tool).title;
}

export function toolIcon(
  tool: string | undefined,
  status: ToolCardStatus
): ToolCardIcon {
  if (status === "denied") return "gate";
  if (!tool) return "step";
  return describeTool(tool).icon;
}

function parseLine(text: string): ParsedLine {
  const raw = text.trim();
  const milestone = MILESTONE_RE.exec(raw);
  if (milestone?.[1]) {
    const kind = milestone[1].toLowerCase();
    const body = (milestone[2] ?? "").trim();
    const denial = GOVERNANCE_DENIAL_RE.exec(body);
    if (denial) {
      return {
        kind: "notice",
        milestone: kind,
        body,
        status: "denied",
        reason: clamp(denial[1] || body, MAX_REASON_CHARS),
      };
    }
    const approval = APPROVAL_REQUEST_RE.exec(body);
    if (approval?.[1] && isToolSubject(approval[1])) {
      return {
        kind: "notice",
        milestone: kind,
        body,
        status: "note",
        tool: approval[1].trim(),
      };
    }
    const failed = FAILURE_MILESTONE_RE.test(kind);
    return {
      kind: "notice",
      milestone: kind,
      body,
      status: failed ? "failed" : "note",
      ...(failed ? { reason: clamp(body, MAX_REASON_CHARS) } : {}),
    };
  }

  const governance = GOVERNANCE_DENIAL_RE.exec(raw);
  if (governance) {
    return {
      kind: "notice",
      body: raw,
      status: "denied",
      reason: clamp(governance[1] || raw, MAX_REASON_CHARS),
    };
  }

  const lifecycle = LIFECYCLE_RE.exec(raw);
  if (lifecycle?.[1] && lifecycle[2] && isToolSubject(lifecycle[1])) {
    const subject = lifecycle[1].trim();
    const args = ARGS_RE.exec(subject);
    const tool = args?.[1] ?? subject;
    const suffix = lifecycle[2];
    const phase: LifecyclePhase =
      suffix === "is still working"
        ? "progress"
        : suffix === "approval failed closed"
          ? "denied"
          : (suffix as LifecyclePhase);
    return {
      kind: "lifecycle",
      tool,
      ...(args?.[2] ? { args: clamp(args[2], MAX_SUMMARY_CHARS) } : {}),
      phase,
      ...(suffix === "approval failed closed"
        ? {
            reason:
              "MUON's approval bridge failed closed, so the call was refused.",
          }
        : {}),
    };
  }

  return { kind: "notice", body: raw, status: "note" };
}

function rawLines(
  activityText: string,
  rawByLine: ReadonlyMap<string, string> | undefined
): string[] {
  const raw = rawByLine?.get(activityText);
  const source = raw && raw.trim() ? raw : activityText;
  return source.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function boundDetail(lines: readonly string[]): {
  detail: string[];
  truncated: boolean;
} {
  const bounded: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (bounded.length >= MAX_DETAIL_LINES || chars >= MAX_DETAIL_CHARS) {
      return { detail: bounded, truncated: true };
    }
    const clipped =
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
    bounded.push(clipped);
    chars += clipped.length;
  }
  return { detail: bounded, truncated: bounded.length < lines.length };
}

/**
 * Bound the ledger's captured detail one last time, at the DOM boundary. Keeps
 * the tail of an over-long output for the same reason the adapter does: the end
 * is where the error is. Clipping is reported, never silent.
 */
function boundCaptured(
  detail: ToolCardDetail | undefined
): Pick<ToolCard, "args" | "argsTruncated" | "output" | "outputTruncated"> {
  if (!detail) return {};
  const rawArgs = typeof detail.args === "string" ? detail.args.trim() : "";
  const rawOutput =
    typeof detail.result === "string" ? detail.result.trim() : "";
  const argsClipped = rawArgs.length > MAX_ARGS_CHARS;
  const outputClipped = rawOutput.length > MAX_OUTPUT_CHARS;
  const args = argsClipped
    ? `${rawArgs.slice(0, MAX_ARGS_CHARS - 1)}…`
    : rawArgs;
  const output = outputClipped
    ? `…${rawOutput.slice(-(MAX_OUTPUT_CHARS - 1))}`
    : rawOutput;
  return {
    ...(args
      ? {
          args,
          ...(argsClipped || detail.argsTruncated === true
            ? { argsTruncated: true }
            : {}),
        }
      : {}),
    ...(output
      ? {
          output,
          ...(outputClipped || detail.resultTruncated === true
            ? { outputTruncated: true }
            : {}),
        }
      : {}),
  };
}

/**
 * Once a card carries the real call and its real output, the raw ledger lines
 * it was built from are usually just `Bash started` / `Bash completed` — the
 * card's own face, restated. Drop exactly those echoes so the expanded body is
 * the call and its result, not three boxes where two say the same thing. Any
 * line that says MORE than the lifecycle echo is kept: it is provenance.
 */
function withoutLifecycleEcho(card: WorkingCard): string[] {
  if (card.args === undefined && card.output === undefined) return card.detail;
  if (!card.tool) return card.detail;
  return card.detail.filter((line) => {
    const parsed = parseLine(line);
    return !(parsed.kind === "lifecycle" && parsed.tool === card.tool);
  });
}

/** Merge captured detail into a card without ever overwriting what it holds. */
function applyCaptured(target: WorkingCard, detail: ToolCardDetail | undefined) {
  const captured = boundCaptured(detail);
  if (captured.args !== undefined && target.args === undefined) {
    target.args = captured.args;
    if (captured.argsTruncated) target.argsTruncated = true;
    // The header summary is the args, honestly clamped — Cursor's `cd, 2+`.
    // Collapsed to ONE line: the header is a single row, and a multi-line
    // argument must not break its layout. The panel below keeps the newlines.
    target.summary ??= clamp(
      captured.args.replace(/\s+/g, " "),
      MAX_SUMMARY_CHARS
    );
  }
  if (captured.output !== undefined && target.output === undefined) {
    target.output = captured.output;
    if (captured.outputTruncated) target.outputTruncated = true;
  }
}

function statusForPhase(phase: LifecyclePhase): ToolCardStatus {
  if (phase === "started" || phase === "progress") return "pending";
  if (phase === "failed") return "failed";
  if (phase === "denied") return "denied";
  return "ok";
}

function signature(card: WorkingCard): string {
  return [
    card.title,
    card.tool ?? "",
    card.status,
    card.summary ?? "",
    card.reason ?? "",
    card.governance ?? "",
    card.icon,
    // Two calls that ran different commands, or returned different output,
    // are two calls. Without these, merging would show one call's result
    // under a repeat count that stands for another's — a quiet lie.
    card.args ?? "",
    card.output ?? "",
  ].join("\u0000");
}

type NewCardInput = {
  title: string;
  status: ToolCardStatus;
  repeat: number;
  detail: string[];
  detailTruncated: boolean;
  live: boolean;
  needsAttention: boolean;
  icon: ToolCardIcon;
  pendingCount: number;
  tool?: string;
  summary?: string;
  reason?: string;
  governance?: string;
};

function newCard(input: NewCardInput): WorkingCard {
  return {
    key: "",
    title: input.title,
    status: input.status,
    repeat: input.repeat,
    detail: input.detail,
    detailTruncated: input.detailTruncated,
    live: input.live,
    needsAttention: input.needsAttention,
    icon: input.icon,
    pendingCount: input.pendingCount,
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.governance ? { governance: input.governance } : {}),
  };
}

/**
 * A policy denial is emitted as `[task.blocked] MUON policy denied: …` right
 * before the vendor-level `<tool> denied` line. They are one governance event,
 * so fold the reason into the tool card and retire the orphan notice — a denial
 * must read as "denied by MUON governance, because X", never as two rows.
 * Marks rather than splices so the pending-card indices stay valid.
 */
function absorbGovernanceReason(cards: WorkingCard[]): string | undefined {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const candidate = cards[index];
    if (!candidate || candidate.absorbed) continue;
    if (candidate.status !== "denied" || candidate.tool || !candidate.reason) {
      return undefined;
    }
    candidate.absorbed = true;
    return candidate.reason;
  }
  return undefined;
}

function appendDetail(target: WorkingCard, extra: readonly string[]): void {
  const { detail, truncated } = boundDetail([...target.detail, ...extra]);
  target.detail = detail;
  target.detailTruncated = target.detailTruncated || truncated;
}

/**
 * Pair `started`/`completed`, collapse adjacent repeats, and keep failures and
 * governance denials as first-class, visually separable cards.
 */
export function buildToolCards(
  activities: readonly ToolActivityInput[],
  options: BuildToolCardsOptions = {}
): ToolCard[] {
  const cards: WorkingCard[] = [];
  /** tool → indices of cards still awaiting a resolution, oldest first. */
  const open = new Map<string, number[]>();

  const openIndex = (tool: string): number | undefined => {
    const stack = open.get(tool);
    if (!stack || stack.length === 0) return undefined;
    return stack[0];
  };
  const closeIndex = (tool: string) => {
    const stack = open.get(tool);
    if (!stack) return;
    stack.shift();
    if (stack.length === 0) open.delete(tool);
  };
  const trackOpen = (tool: string) => {
    const stack = open.get(tool) ?? [];
    stack.push(cards.length - 1);
    open.set(tool, stack);
  };

  for (const activity of activities) {
    if (typeof activity?.text !== "string" || !activity.text.trim()) continue;
    const count = Math.max(1, Math.trunc(activity.count ?? 1));
    const live = activity.live === true;
    const flagged = activity.needsAttention === true;
    const parsed = parseLine(activity.text);
    const { detail, truncated } = boundDetail(
      rawLines(activity.text, options.rawByLine)
    );

    if (parsed.kind === "notice") {
      const status: ToolCardStatus =
        parsed.status === "note" && flagged ? "failed" : parsed.status;
      const problem = status === "failed" || status === "denied";
      const title = parsed.milestone
        ? (MILESTONE_TITLES[parsed.milestone] ??
          clamp(parsed.milestone, MAX_TITLE_CHARS))
        : clamp(parsed.body, MAX_TITLE_CHARS);
      // A single-line notice already fully printed on its own face (as the
      // title, or as the reason) needs no second copy of itself in the expand
      // body. Only drop it when the face is verbatim — a clamped title or a
      // clamped reason still owes the reader the untruncated line.
      const selfDescribing =
        detail.length <= 1 &&
        (parsed.reason === parsed.body ||
          (parsed.milestone === undefined && title === parsed.body));
      cards.push(
        newCard({
          title: title || "Activity",
          status,
          repeat: count,
          detail: selfDescribing ? [] : detail,
          detailTruncated: selfDescribing ? false : truncated,
          live,
          needsAttention: flagged || problem,
          icon: problem ? "gate" : toolIcon(parsed.tool, status),
          pendingCount: 0,
          ...(parsed.tool ? { tool: parsed.tool } : {}),
          ...(parsed.milestone && !problem
            ? { summary: clamp(parsed.body, MAX_SUMMARY_CHARS) }
            : {}),
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          ...(status === "denied" ? { governance: DENIED_BY_MUON } : {}),
        })
      );
      applyCaptured(cards[cards.length - 1]!, activity.detail);
      continue;
    }

    const title = toolTitle(parsed.tool);
    const icon = toolIcon(parsed.tool, statusForPhase(parsed.phase));

    if (parsed.phase === "started" || parsed.phase === "progress") {
      const existing =
        parsed.phase === "progress" ? openIndex(parsed.tool) : undefined;
      const target = existing === undefined ? undefined : cards[existing];
      if (target) {
        target.live ||= live;
        applyCaptured(target, activity.detail);
        continue;
      }
      cards.push(
        newCard({
          title,
          tool: parsed.tool,
          status: "pending",
          repeat: count,
          detail,
          detailTruncated: truncated,
          live,
          needsAttention: flagged,
          icon,
          pendingCount: count,
          ...(parsed.args ? { summary: parsed.args } : {}),
        })
      );
      applyCaptured(cards[cards.length - 1]!, activity.detail);
      trackOpen(parsed.tool);
      continue;
    }

    if (parsed.phase === "approved") {
      const index = openIndex(parsed.tool);
      const target = index === undefined ? undefined : cards[index];
      if (target) {
        target.governance = APPROVED_BY_MUON;
        target.live ||= live;
        applyCaptured(target, activity.detail);
        continue;
      }
      cards.push(
        newCard({
          title,
          tool: parsed.tool,
          status: "note",
          repeat: count,
          detail,
          detailTruncated: truncated,
          live,
          needsAttention: flagged,
          icon,
          pendingCount: 0,
          governance: APPROVED_BY_MUON,
        })
      );
      applyCaptured(cards[cards.length - 1]!, activity.detail);
      continue;
    }

    // completed / failed / denied — resolve the matching pending card(s).
    const resolved = statusForPhase(parsed.phase);
    const problem = resolved === "failed" || resolved === "denied";
    let remaining = count;
    while (remaining > 0) {
      const index = openIndex(parsed.tool);
      const target = index === undefined ? undefined : cards[index];
      if (!target) break;
      const take = Math.min(target.pendingCount, remaining);
      const reason =
        parsed.reason ??
        (resolved === "denied" ? absorbGovernanceReason(cards) : undefined);
      if (take >= target.pendingCount) {
        target.status = resolved;
        target.repeat = target.pendingCount;
        target.pendingCount = 0;
        target.live ||= live;
        target.needsAttention ||= flagged || problem;
        target.icon = toolIcon(parsed.tool, resolved);
        appendDetail(target, detail);
        applyCaptured(target, activity.detail);
        if (reason) target.reason = reason;
        if (resolved === "denied") target.governance = DENIED_BY_MUON;
        closeIndex(parsed.tool);
      } else {
        // Partial resolution: split so one failure inside a batch stays visible.
        target.pendingCount -= take;
        target.repeat -= take;
        const split = boundDetail([...target.detail, ...detail]);
        cards.push(
          newCard({
            title: target.title,
            tool: target.tool ?? parsed.tool,
            status: resolved,
            repeat: take,
            detail: split.detail,
            detailTruncated: split.truncated,
            live: target.live || live,
            needsAttention: flagged || problem,
            icon: toolIcon(parsed.tool, resolved),
            pendingCount: 0,
            ...(target.summary ? { summary: target.summary } : {}),
            ...(reason ? { reason } : {}),
            ...(resolved === "denied" ? { governance: DENIED_BY_MUON } : {}),
          })
        );
        // The split card inherits the batch's call identity, then takes this
        // resolution's own output — one failure inside a batch keeps ITS result.
        const splitCard = cards[cards.length - 1]!;
        applyCaptured(splitCard, {
          ...(target.args !== undefined ? { args: target.args } : {}),
          ...(target.argsTruncated ? { argsTruncated: true } : {}),
        });
        applyCaptured(splitCard, activity.detail);
      }
      remaining -= take;
    }

    if (remaining > 0) {
      // An old chat (or a lost `started`) leaves a bare resolution line. Render
      // it as its own honest card rather than dropping it.
      const reason =
        parsed.reason ??
        (resolved === "denied" ? absorbGovernanceReason(cards) : undefined);
      cards.push(
        newCard({
          title,
          tool: parsed.tool,
          status: resolved,
          repeat: remaining,
          detail,
          detailTruncated: truncated,
          live,
          needsAttention: flagged || problem,
          icon: toolIcon(parsed.tool, resolved),
          pendingCount: 0,
          ...(parsed.args ? { summary: parsed.args } : {}),
          ...(reason ? { reason } : {}),
          ...(resolved === "denied" ? { governance: DENIED_BY_MUON } : {}),
        })
      );
      applyCaptured(cards[cards.length - 1]!, activity.detail);
    }
  }

  return mergeAdjacent(cards.filter((card) => !card.absorbed)).map(
    (card, index) => ({
      key: `${index}:${card.tool ?? card.title}`,
      title: card.title,
      status: card.status,
      repeat: card.repeat,
      detail: withoutLifecycleEcho(card),
      detailTruncated: card.detailTruncated,
      icon: card.icon,
      live: card.live,
      needsAttention: card.needsAttention,
      ...(card.tool ? { tool: card.tool } : {}),
      ...(card.summary ? { summary: card.summary } : {}),
      ...(card.reason ? { reason: card.reason } : {}),
      ...(card.governance ? { governance: card.governance } : {}),
      ...(card.args !== undefined ? { args: card.args } : {}),
      ...(card.argsTruncated ? { argsTruncated: true } : {}),
      ...(card.output !== undefined ? { output: card.output } : {}),
      ...(card.outputTruncated ? { outputTruncated: true } : {}),
    })
  );
}

function mergeAdjacent(cards: readonly WorkingCard[]): WorkingCard[] {
  const merged: WorkingCard[] = [];
  for (const card of cards) {
    const previous = merged[merged.length - 1];
    if (previous && signature(previous) === signature(card)) {
      previous.repeat += card.repeat;
      previous.pendingCount += card.pendingCount;
      previous.live ||= card.live;
      previous.needsAttention ||= card.needsAttention;
      previous.detailTruncated ||= card.detailTruncated;
      // Identical signature ⇒ identical raw lines AND identical captured
      // args/output (both are in the signature); keep one copy, not N.
      continue;
    }
    merged.push({ ...card });
  }
  return merged;
}

export type ToolCardProblems = {
  failed: number;
  denied: number;
  /** Human label for the turn header, or undefined when nothing went wrong. */
  label?: string;
};

/** Turn-header rollup so a failure can never hide inside a collapsed turn. */
export function toolCardProblems(cards: readonly ToolCard[]): ToolCardProblems {
  let failed = 0;
  let denied = 0;
  for (const card of cards) {
    if (card.status === "failed") failed += card.repeat;
    if (card.status === "denied") denied += card.repeat;
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (denied > 0) parts.push(`${denied} denied`);
  return {
    failed,
    denied,
    ...(parts.length > 0 ? { label: parts.join(" · ") } : {}),
  };
}
