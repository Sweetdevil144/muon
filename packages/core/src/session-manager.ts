import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type {
  ApprovalDecision,
  LaneSessionDriver,
  SessionHandle,
  SessionStartInput,
} from "@muon/adapters";
import {
  AcpSessionDriver,
  ClaudeSessionDriver,
  CodexSessionDriver,
  makeSessionEvent,
} from "@muon/adapters";
import {
  RECEIPT_ALLOWED_CLASSES,
  VENDOR_REGISTRY,
  classifyToolAction,
  standingApproverIsWatching,
  type ApprovalEvidence,
  type LaneEvent,
  type PolicyAction,
  type PolicyProfile,
  type StandingApproverGrant,
} from "@muon/protocol";
import { simulatePolicy } from "./policy-simulate.js";

export type SessionLedger = {
  createSession(input: {
    laneId: string;
    taskId: string;
    // Checkpoint edge (P0.1): the DispatchJob this session executes.
    jobId?: string;
    vendorSessionId?: string;
  }): Promise<{ id: string }>;
  updateSession(input: {
    sessionId: string;
    status?: "running" | "waiting_approval" | "interrupted" | "ended" | "failed";
    vendorSessionId?: string;
  }): Promise<unknown>;
  requestApproval(input: {
    taskId: string;
    requestedBy: string;
    kind: "command";
    reason: string;
    evidence: ApprovalEvidence;
    // Checkpoint edge (P0.1): the job binding the session gate is filed under.
    jobId?: string;
  }): Promise<{ id: string }>;
  waitForApproval(approvalId: string, timeoutMs?: number): Promise<void>;
  /**
   * Single-use delivery stamp (consume-before-allow, P0.1): marks an approved
   * command approval as handed to the vendor. MUST throw when the stamp did
   * not land (already consumed, undecided, wrong kind) — the bridge then fails
   * closed to deny. Durable meaning: `consumedAt != null` ⇔ the allow reached
   * the vendor; `approved ∧ consumedAt = null` ⇔ provably never delivered.
   */
  consumeApproval(approvalId: string): Promise<void>;
  /**
   * Content-bound receipt redemption (P0.4, OPTIONAL — a ledger without it
   * never consults receipts). Returns the receipt binding on an exact match of
   * action + payload digest + workspace + run (+ manifest, enforced
   * server-side), `null` on ANY miss. Implementations MUST catch transport
   * errors and return `null` — a miss means "gate exactly as today", never
   * deny and never allow.
   */
  redeemReceipt?(input: {
    taskId: string;
    jobId: string;
    sessionId: string;
    workspacePath: string;
    toolName: string;
    payloadDigest: string;
    // SEC-1: the operator-VISIBLE resolved target of this real tool call (the
    // edit/read path or test command line, redacted identically to the evidence
    // the operator saw). The server matches it against the receipt's minted
    // target, so a receipt whose visible target and payload digest disagree can
    // never redeem the hidden action. `null` for a target-less call.
    resolvedTarget?: string | null;
  }): Promise<{ receiptId: string; expiresAt: string } | null>;
};

export type StartManagedSessionInput = SessionStartInput & {
  laneKey: string;
  laneId: string;
  /** Checkpoint edge (P0.1): the DispatchJob this managed session executes. */
  jobId?: string;
  approvalTimeoutMs?: number;
  /**
   * Orchestrator-only (capabilityMode==='orchestrator'). The coordinator holds
   * ONLY the AGENT delegation token; its scaffolding-write approvals land in an
   * inbox NO operator watches, and PATCH /approvals is operator-tier — so a gated
   * call here can ONLY time out (300s) then fail closed, and the vendor retries
   * into the same hang. When set, an un-preauthorized tool call denies FAST with
   * an actionable message instead of filing an approval and blocking on
   * waitForApproval. NEVER set for a worker/delegate session — those keep the
   * full human-in-the-loop gate (file → wait → deny on timeout) unchanged.
   *
   * Says nothing about Full Auto: `resolveStandingApprover` below is what tells
   * this session whether the "no operator watches" premise still holds.
   */
  noInteractiveApprover?: boolean;
  /**
   * The one fact that can make `noInteractiveApprover`'s premise false: a
   * standing operator approver (Full Auto) holding a LIVE, self-expiring lease
   * on the approval inbox. While one is watching, a coordinator's approval is
   * really decided by an operator-tier principal within a poll cycle, so the
   * gate takes the ordinary path (file → wait → decide) instead of denying.
   *
   * Resolved at DECISION time, once per gated call, never snapshotted at session
   * start: standing consent can be withdrawn mid-session, and a grant cached for
   * the life of a session would keep a revoked posture alive for as long as the
   * vendor kept talking. Every failure — no resolver, a throw, a lapsed or
   * malformed lease — resolves to "nobody is watching", which is today's
   * fast-deny, so absence and uncertainty both land on the closed side.
   *
   * This grants NO authority on its own. The call is still filed as an approval,
   * still decided by an operator-tier principal, and still recorded; what changes
   * is only whether MUON refuses to ASK.
   */
  resolveStandingApprover?: () => Promise<StandingApproverGrant | undefined>;
  /**
   * P0.4: the canonical governed workspace (job.workspacePath ?? task's).
   * Absent ⇒ no policy simulation and no receipt redemption — byte-identical
   * to today. The runner NEVER sets it for delegate/orchestrator sessions.
   */
  workspacePath?: string;
  /**
   * CODE-C: the rendered check-command lines (job's harness.checks ∪ job.checks),
   * hoisted OUT of `policy` so `test`-class classification works even with NO
   * policy profile — the default "every gate asks" config. Without this a Bash
   * receipt mints but never redeems (the seam classified with no checks → null →
   * the receipt path was skipped), leaving the P0.4 fatigue fix inert by default.
   * It does NOT widen auto-allow: `test` still requires a byte-equal check match
   * AND a valid receipt; network/merge/ship stay unrepresentable. Rendering MUST
   * stay byte-identical to `receipt.ts renderCheckCommand`.
   */
  checkCommands?: string[];
  /**
   * P0.4: the schema-validated workspace policy profile plus the anchors the
   * seam needs to evaluate it (radius paths resolve against `executionCwd`).
   * Absent ⇒ TODAY'S behavior exactly (every un-preapproved call gates). Note
   * `checkCommands` lives at the top level now (CODE-C), not here — it is needed
   * for receipt redemption independently of whether a profile exists.
   */
  policy?: {
    profile: PolicyProfile;
    executionCwd: string;
    checkCommands: string[];
  };
  onEvent: (event: LaneEvent) => void;
  /**
   * Live view of the vendor's OWN stderr, chunk by chunk, handed to the selected
   * driver. The runner's liveness watchdog subscribes so a stall on the
   * interactive path can report what the vendor ITSELF said inside the window
   * (a provider quota/billing rejection can take minutes to reach the stream the
   * session actually reads), instead of asserting a cause nobody observed.
   * Optional: omitting it leaves every run byte-identical.
   */
  onDiagnostic?: (chunk: string) => void;
  /**
   * Fired synchronously at driver SELECTION — before the ledger write and before
   * the vendor launch — and only when `onDiagnostic` will actually be fed by the
   * chosen driver (`LaneSessionDriver.forwardsVendorStderr`). The caller uses it
   * to decide what it may claim about stderr: "the vendor produced nothing" is
   * only honest once something was listening. Firing it here (not on return)
   * matters because the launch itself is what hangs — the watchdog can fire long
   * before `startManagedSession` resolves.
   */
  onVendorStderrAttached?: () => void;
};

export type ManagedSession = {
  sessionId: string;
  handle: SessionHandle;
};

const SECRET_VALUE =
  /((?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?)([^\s'"]+)/gi;
const TOKEN_SHAPED = /\b(?:sk|key|token)-[a-z0-9_-]{12,}\b/gi;

function redactEvidenceText(value: string): string {
  return value
    .replace(SECRET_VALUE, "$1[redacted]")
    .replace(TOKEN_SHAPED, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function stablePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stablePayload(child)])
    );
  }
  return value;
}

/**
 * How much of the evidence's target the approval REASON repeats. The reason is
 * the one-line receipt every surface renders, so it must name the action; it is
 * not the place to carry a whole command, which is what `evidence` is for.
 */
const APPROVAL_REASON_SCOPE_CHARS = 160;

// ── Action-shaped shell risk ─────────────────────────────────────────────────
//
// Risk used to be TOOL-shaped: every Bash request was `[risk: high]`, `echo`,
// `ls` and `git status` included. On a governance product that label is the
// signal an operator (or Full Auto's audit trail) reads, and a signal that is
// always "high" is decorative — it trains the reader to ignore it. The
// classifier below looks at the COMMAND instead.
//
// ADR-0022 discipline: LOW is a POSITIVE grammar — every pipeline segment's
// head must be on the read-only list and the whole line free of effect
// metacharacters — and anything the grammar does not recognize stays HIGH.
// Quoted separators over-split into false segment heads, which can only
// promote a benign line to HIGH, never demote a dangerous one to LOW. This is
// presentation honesty only: the approval is still filed and still gates.

/** Binaries that read and print, with no write path even via flags. Deliberate
 *  exclusions with reasons: sort (-o writes), uniq (2nd positional is an
 *  output file), sed (-i), awk (in-program redirection), find (-delete/-exec),
 *  tee (writes), xargs/env-as-launcher (run other commands). */
const READ_ONLY_SHELL_HEADS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "stat", "file",
  "du", "df", "basename", "dirname", "readlink", "which", "whoami", "uname",
  "date", "echo", "printf", "true", "tr", "cut", "column", "diff", "cmp",
  "shasum", "sha256sum", "md5", "md5sum", "hexdump", "xxd", "strings", "jq",
]);

/** Git verbs that only read the repository. `branch` (deletes with -d),
 *  `config` and `ls-remote` (network) are deliberately absent. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame",
  "describe", "shortlog",
]);

/** Anything that can redirect output, substitute a command, or splice a
 *  process: `>`/`<` (writes/heredocs), backticks and `$(` (execution). */
const SHELL_EFFECT_METACHARACTERS = /[<>`]|\$\(/;

/**
 * "low" only when every segment of the command line is provably read-only;
 * "high" for everything else, including anything the grammar cannot parse.
 */
export function classifyShellCommandRisk(command: string): "high" | "low" {
  const trimmed = command.trim();
  if (!trimmed || SHELL_EFFECT_METACHARACTERS.test(trimmed)) return "high";
  for (const segment of trimmed.split(/\|\||&&|[;|&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    // Leading VAR=value assignments prefix the real head.
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
      index += 1;
    }
    const head = words[index];
    if (!head) continue; // an empty segment (trailing `;`) executes nothing
    // A path-invoked binary (./ls, /tmp/ls) is NOT the allowlisted one.
    if (head.includes("/")) return "high";
    if (head === "git") {
      const sub = words[index + 1];
      if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return "high";
      continue;
    }
    if (!READ_ONLY_SHELL_HEADS.has(head)) return "high";
  }
  return "low";
}

function sessionApprovalEvidence(
  toolName: string,
  input: unknown,
  sessionId: string
): ApprovalEvidence {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  // Classification reads the RAW command (the shell executes the raw text);
  // only the DISPLAYED copy is redacted.
  const rawCommand =
    typeof record.command === "string" ? record.command : undefined;
  const command =
    rawCommand !== undefined ? redactEvidenceText(rawCommand) : undefined;
  const path =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : undefined;
  const content =
    typeof record.content === "string"
      ? record.content
      : typeof record.new_string === "string"
        ? record.new_string
        : undefined;
  const normalized = toolName.toLowerCase();
  // An `mcp__` tool name carries NO workspace semantics: `search` there may
  // search a remote mailbox and `exec` a remote database. The substring
  // classes below are tuned to vendor built-ins, so the whole MCP namespace
  // is excluded from them and lands on `unknown` — a positive allowlist can
  // admit specific servers later (closed-positive-list doctrine; review
  // round 6 #7).
  const mcpNamespaced = normalized.startsWith("mcp__");
  const shellLike =
    !mcpNamespaced && /bash|shell|exec|command|terminal/.test(normalized);
  const writeLike =
    !mcpNamespaced && /write|edit|patch|notebook/.test(normalized);
  // "Read-like" means reads WORKSPACE data. A networked tool (WebSearch,
  // WebFetch, browser tools) is egress — a plausible exfiltration channel —
  // and must never ride the read class into `low`; the carve-out sends it to
  // the `unknown` fallthrough instead (review finding on round-3 #7).
  const networkLike = /web|fetch|http|url|browser|network|download/.test(
    normalized
  );
  const readLike =
    !mcpNamespaced &&
    !networkLike &&
    /read|search|glob|grep|find/.test(normalized);
  const details: Record<string, string> = {};

  if (command) details.command = command;
  if (path) details.path = redactEvidenceText(path);
  if (content !== undefined) details.bytes = String(Buffer.byteLength(content));
  details.sessionId = sessionId;

  return {
    action: toolName,
    scope: command
      ? `Command: ${command}`
      : path
        ? `File: ${redactEvidenceText(path)}`
        : `Tool request in session ${sessionId}`,
    // A tool name that matches NONE of the classes is not "low" — it is a
    // risk MUON could not compute, and it says so. The fallthrough used to be
    // `low`, which dressed the one case MUON knows nothing about in the least
    // alarming word on the surface (round-3 #7).
    riskLevel: shellLike
      ? classifyShellCommandRisk(rawCommand ?? "")
      : writeLike
        ? "medium"
        : readLike
          ? "low"
          : "unknown",
    impactIfApproved: shellLike
      ? classifyShellCommandRisk(rawCommand ?? "") === "low"
        ? "Runs a shell command recognized as read-only (every pipeline stage is on the read-only list, no redirection or substitution); it can read workspace data."
        : "Runs a shell command in the selected workspace and may read, modify, or delete files."
      : writeLike
        ? "Writes content to one file in the selected workspace."
        : readLike
          ? "Reads or searches workspace data without granting write authority."
          : "MUON could not classify this tool. Treat it as able to do anything the session's authority allows.",
    payloadDigest: createHash("sha256")
      .update(JSON.stringify(stablePayload(input)) ?? "undefined")
      .digest("hex"),
    details,
  };
}

export function defaultSessionDrivers(): LaneSessionDriver[] {
  const drivers: LaneSessionDriver[] = [
    new ClaudeSessionDriver(),
    new CodexSessionDriver(),
  ];
  // ADR-0007 / TODO 1.2: an ACP vendor is a REGISTRY ENTRY, not a driver.
  // Every vendor declaring `session.driver: "acp"` gets the one shared
  // AcpSessionDriver; the driver itself refuses tier-1 lanes at construction.
  // BOTH misconfigurations fail LOUDLY here, never silently: a tier-1 lane
  // declaring `acp` throws from the constructor, and an `acp` lane MISSING its
  // launch data throws below — because `vendorSupportsInteractive` returns
  // true for it, so a silent skip would route a dispatch to a driver that was
  // never registered (the exact gap this check closes).
  for (const entry of Object.values(VENDOR_REGISTRY)) {
    if (entry.session.driver !== "acp") continue;
    if (!entry.session.acp) {
      throw new Error(
        `Vendor '${entry.id}' declares session.driver "acp" but no session.acp launch data; ` +
          "an ACP lane must carry {command, args} or it is unspawnable."
      );
    }
    drivers.push(
      new AcpSessionDriver({
        laneKey: entry.id,
        command: entry.session.acp.command,
        args: entry.session.acp.args,
      })
    );
  }
  return drivers;
}

/**
 * Persist the vendor session id at FIRST knowledge (P0.1 Slice A), so a
 * mid-run kill does not lose the resume handle. Best-effort BY DESIGN: three
 * attempts with a short backoff, then give up silently — the checkpoint
 * reader treats a missing handle as "resume handle unavailable, refuse with
 * reason", never a guess. The end-of-session persists remain the durable
 * backstop.
 */
async function persistVendorSessionId(
  ledger: SessionLedger,
  sessionId: string,
  vendorSessionId: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ledger.updateSession({ sessionId, vendorSessionId });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Starts an interactive lane session with MUON semantics attached:
 * - session recorded in the ledger with the vendor session id
 * - every un-preapproved tool call becomes a MUON approval request; the
 *   session blocks until a human decides, and denies on timeout (fail closed)
 * - lifecycle transitions land in the session record
 */
export async function startManagedSession(
  ledger: SessionLedger,
  input: StartManagedSessionInput,
  drivers: LaneSessionDriver[] = defaultSessionDrivers()
): Promise<ManagedSession> {
  input.signal?.throwIfAborted();
  const driver = drivers.find((entry) => entry.laneKey === input.laneKey);
  if (!driver) {
    throw new Error(
      `Lane '${input.laneKey}' has no interactive session driver. Available: ${drivers
        .map((entry) => entry.laneKey)
        .join(", ")}. Use \`muon run\` for one-shot execution.`
    );
  }
  // Announce the observer BEFORE anything can hang. A driver that does not
  // declare stderr forwarding stays silent here, so the caller keeps saying
  // "MUON captured no stderr" rather than claiming a silence it never heard.
  if (input.onDiagnostic && driver.forwardsVendorStderr) {
    input.onVendorStderrAttached?.();
  }

  const record = await ledger.createSession({
    laneId: input.laneId,
    taskId: input.taskId,
    jobId: input.jobId,
  });
  if (input.signal?.aborted) {
    await ledger
      .updateSession({
        sessionId: record.id,
        status: "interrupted",
      })
      .catch(() => undefined);
    input.signal.throwIfAborted();
  }

  const bridgeApproval = async (request: {
    toolName: string;
    input: unknown;
    taskId: string;
    laneKey: string;
  }): Promise<ApprovalDecision> => {
    // ── P0.4: policy simulation + receipt redemption BEFORE the gate ─────────
    // The failure direction is fixed: ANY trouble in this block (classifier,
    // simulator, event emission, receipt transport) falls through to TODAY'S
    // gate path below — never a lockout, never an invisible auto-allow. A
    // policy verdict can only ADD friction (deny) or auto-allow within
    // read/test/edit; network/merge/ship cannot be `allow` by schema, and
    // merge/ship are additionally unclassifiable, so they gate every time.
    // The anti-goal stands: an allow is returned from THIS decision callback,
    // never by widening `allowedTools` (which would shadow canUseTool and mint
    // blanket authority).
    let evidence: ApprovalEvidence | undefined;
    const receiptEnabled = Boolean(
      ledger.redeemReceipt && input.workspacePath && input.jobId
    );
    try {
      if (input.policy || receiptEnabled) {
        evidence = sessionApprovalEvidence(
          request.toolName,
          request.input,
          record.id
        );
        // Classification reads the SAME fields the evidence extractor does,
        // but UNREDACTED: the byte-equality test-class check must see the
        // exact command, and the edit target must be the exact path.
        const raw =
          request.input && typeof request.input === "object"
            ? (request.input as Record<string, unknown>)
            : {};
        const command =
          typeof raw.command === "string" ? raw.command : undefined;
        const target =
          typeof raw.file_path === "string"
            ? raw.file_path
            : typeof raw.path === "string"
              ? raw.path
              : undefined;
        const classified = classifyToolAction({
          toolName: request.toolName,
          command,
          path: target,
          // CODE-C: prefer the top-level hoisted checks (present with or without
          // a policy profile) so `test`-class receipts redeem in the default
          // no-profile config; fall back to the legacy in-policy list.
          checkCommands: input.checkCommands ?? input.policy?.checkCommands,
        });

        // Step 1 — policy simulation (explains allow/deny/gate before execution).
        if (input.policy && classified) {
          const { executionCwd } = input.policy;
          const action: PolicyAction =
            classified.class === "edit"
              ? {
                  class: "edit",
                  path: resolvePath(executionCwd, classified.path ?? ""),
                }
              : { class: classified.class };
          // Absolutize radius prefixes against the execution cwd (the per-task
          // worktree for worktree harnesses) — `simulatePolicy` itself stays
          // pure and untouched. The schema already bans `.`/`..` segments.
          const profileForSim: PolicyProfile = {
            ...input.policy.profile,
            taskRadius: input.policy.profile.taskRadius.map((prefix) =>
              resolvePath(executionCwd, prefix)
            ),
          };
          const sim = simulatePolicy(action, profileForSim);
          if (sim.decision === "deny") {
            // Added friction is always in-contract; make it visible.
            input.onEvent(
              makeSessionEvent(
                request.laneKey,
                request.taskId,
                "task.blocked",
                `MUON policy denied: ${sim.reason}`,
                {
                  source: "policy",
                  actionClass: sim.actionClass,
                  payloadDigest: evidence.payloadDigest,
                  ...(input.workspacePath
                    ? { workspacePath: input.workspacePath }
                    : {}),
                }
              )
            );
            return { behavior: "deny", message: sim.reason };
          }
          if (sim.decision === "allow") {
            // The audit record is emitted BEFORE the vendor observes the
            // allow: if it cannot land, we fall through to the gate — an
            // invisible auto-allow must be unrepresentable.
            input.onEvent(
              makeSessionEvent(
                request.laneKey,
                request.taskId,
                "approval.auto",
                sim.reason,
                {
                  source: "policy",
                  actionClass: sim.actionClass,
                  payloadDigest: evidence.payloadDigest,
                  ...(input.workspacePath
                    ? { workspacePath: input.workspacePath }
                    : {}),
                }
              )
            );
            return { behavior: "allow" };
          }
          // "gate": surface the explain-line on the approval card for free.
          evidence.details.policy = sim.reason.slice(0, 2_000);
        }

        // Step 2 — content-bound receipt redemption (read/test/edit only; the
        // server re-guards class, workspace, run, manifest, expiry, revocation).
        // No digest, no receipt — the same rule the mint enforces.
        const payloadDigest = evidence.payloadDigest;
        if (
          classified &&
          (RECEIPT_ALLOWED_CLASSES as readonly string[]).includes(
            classified.class
          ) &&
          payloadDigest &&
          ledger.redeemReceipt &&
          input.workspacePath &&
          input.jobId
        ) {
          const hit = await ledger.redeemReceipt({
            taskId: request.taskId,
            jobId: input.jobId,
            sessionId: record.id,
            workspacePath: input.workspacePath,
            toolName: request.toolName,
            payloadDigest,
            // SEC-1: the operator-VISIBLE target of THIS call, taken from the
            // SAME redacted evidence the mint stored (edit/read → path, test →
            // command). Byte-identical to the mint's `evidence.details`, so an
            // honest action matches and a bait receipt (visible target ≠ digest)
            // cannot.
            resolvedTarget:
              classified.class === "test"
                ? (evidence.details.command ?? null)
                : (evidence.details.path ?? null),
          });
          if (hit) {
            input.onEvent(
              makeSessionEvent(
                request.laneKey,
                request.taskId,
                "approval.auto",
                `receipt ${hit.receiptId} matched this exact action`,
                {
                  source: "receipt",
                  receiptId: hit.receiptId,
                  actionClass: classified.class,
                  payloadDigest: evidence.payloadDigest,
                  ...(input.workspacePath
                    ? { workspacePath: input.workspacePath }
                    : {}),
                }
              )
            );
            return { behavior: "allow" };
          }
        }
      }
    } catch {
      // Degrade-safe: fall through to today's gate path.
    }

    // ── ORCHESTRATOR-ONLY FAST-DENY (defense-in-depth) ──────────────────────
    // A coordinator session (capabilityMode==='orchestrator') normally has NO
    // human watching its approval inbox and cannot self-approve (PATCH
    // /approvals is operator-tier), so filing + blocking on waitForApproval
    // could ONLY 300s-hang then fail closed — and the vendor would retry into
    // the same hang. Deny IMMEDIATELY with an actionable message so the vendor
    // can react instead of burning the timeout. A worker/delegate NEVER sets
    // this flag, so its human-in-the-loop gate below (file → wait → deny on
    // timeout) is untouched. The bounded native file tools are pre-authorized on
    // the orchestrator profile, so a granted Write never reaches here; only an
    // UN-granted coordinator tool does.
    //
    // THE ONE EXCEPTION, stated as a grant rather than as an exemption: while a
    // standing operator approver holds a live lease on that inbox (Full Auto),
    // the premise above is simply false — an operator-tier decider IS there and
    // resolves the request within a poll cycle. So the coordinator gates exactly
    // like everyone else: it files, it waits, a human-authority principal
    // decides, and the decision is recorded. It never self-approves and it is
    // never auto-allowed here; if standing consent turns out not to cover this
    // request, the approval stays pending and surfaces to the human as an
    // ordinary blocking gate. The lease is re-read on EVERY gated call, so
    // switching Full Auto off revokes this on the next one.
    if (input.noInteractiveApprover) {
      const standingApprover = input.resolveStandingApprover
        ? await input.resolveStandingApprover().catch(() => undefined)
        : undefined;
      if (!standingApproverIsWatching(standingApprover)) {
        return {
          behavior: "deny",
          message: `MUON denied: coordinator tool '${request.toolName}' is not pre-authorized and no operator watches the coordinator's approval inbox. Grant it via the harness (preauthorizedTools) so this exact tool is admitted without asking.`,
        };
      }
    }

    // ── TODAY'S PATH (P0.1) — byte-identical call order when no policy and no
    // receipt applies. `waiting_approval` lands here (inside the gate path
    // only), so an auto-allowed call never flaps session status.
    await ledger.updateSession({
      sessionId: record.id,
      status: "waiting_approval",
    });
    try {
      // The receipt a human reads later must say WHAT was authorized, not just
      // that something was. `scope` is the same redacted, bounded target the
      // evidence carries, so the reason cannot describe a different action
      // than the one the digest covers.
      const resolvedEvidence =
        evidence ??
        sessionApprovalEvidence(request.toolName, request.input, record.id);
      const approval = await ledger.requestApproval({
        taskId: request.taskId,
        requestedBy: request.laneKey,
        kind: "command",
        reason: `session tool '${request.toolName}' — ${resolvedEvidence.scope.slice(
          0,
          APPROVAL_REASON_SCOPE_CHARS
        )} (session ${record.id})`,
        evidence: resolvedEvidence,
        jobId: input.jobId,
      });
      await ledger.waitForApproval(approval.id, input.approvalTimeoutMs);
      // Consume-before-allow (P0.1): stamp delivery BEFORE the vendor observes
      // the allow. Any throw falls into the catch below ⇒ deny (fail closed),
      // so `approved ∧ consumedAt = null` durably means "never delivered" —
      // the vendor blocks inside canUseTool until this decision returns.
      await ledger.consumeApproval(approval.id);
      await ledger.updateSession({ sessionId: record.id, status: "running" });
      return { behavior: "allow" };
    } catch (error) {
      await ledger.updateSession({ sessionId: record.id, status: "running" });
      return {
        behavior: "deny",
        message: `MUON denied: ${error instanceof Error ? error.message : "approval failed"}`,
      };
    }
  };

  let handle: SessionHandle;
  try {
    handle = await driver.start(
      {
        taskId: input.taskId,
        brief: input.brief,
        cwd: input.cwd,
        profile: input.profile,
        resumeVendorSessionId: input.resumeVendorSessionId,
        signal: input.signal,
      },
      {
        onEvent: input.onEvent,
        onApprovalRequest: bridgeApproval,
        onVendorSessionId: (vendorSessionId) => {
          // Fire-and-forget: persistence must never block the vendor stream.
          void persistVendorSessionId(ledger, record.id, vendorSessionId);
        },
        // Handed to every driver, not only the declaring ones: a driver that
        // never calls it is a no-op, and one that gains the stream later works
        // immediately (its `forwardsVendorStderr` declaration then upgrades what
        // the caller is allowed to CLAIM — the safe direction).
        ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
      }
    );
  } catch (error) {
    await ledger
      .updateSession({
        sessionId: record.id,
        status: input.signal?.aborted ? "interrupted" : "failed",
      })
      .catch(() => undefined);
    throw error;
  }

  if (handle.vendorSessionId) {
    await ledger.updateSession({
      sessionId: record.id,
      vendorSessionId: handle.vendorSessionId,
    });
  }

  // Session end updates the ledger without the caller having to remember.
  const originalWait = handle.wait.bind(handle);
  handle.wait = async () => {
    const result = await originalWait();
    await ledger
      .updateSession({
        sessionId: record.id,
        status: input.signal?.aborted
          ? "interrupted"
          : result.exitCode === 0
            ? "ended"
            : "failed",
        ...(handle.vendorSessionId
          ? { vendorSessionId: handle.vendorSessionId }
          : {}),
      })
      .catch(() => undefined);
    return result;
  };

  return { sessionId: record.id, handle };
}
