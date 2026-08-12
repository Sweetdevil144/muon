import type { LaneCommandResult } from "@muon/adapters";
import {
  HANDOFF_DEGRADATION,
  HANDOFF_FINAL_MESSAGE_CHARS,
  HANDOFF_PACKET_VERSION,
  handoffPacketSchema,
  type HandoffArtifact,
  type HandoffCheck,
  type HandoffPacket,
  type LaneEvent,
} from "@muon/protocol";
import type { HandoffDiffInput } from "./handoff-evidence.js";
import type { WorktreeCollision } from "./worktree.js";

const OUTPUT_TAIL_CHARS = 2000;
const CHECK_SUMMARY_CHARS = 500;
const CHECK_COMMAND_CHARS = 500;
const DEGRADATION_REASON_CHARS = 200;
const MAX_DEGRADATION_REASONS = 20;
const MAX_CHECKS = 50;
const MAX_CHANGED_FILES = 200;
const MAX_FILE_PATH_CHARS = 260;
const MAX_LIST_ENTRY_CHARS = 500;
const MAX_LIST_ENTRIES = 25;
const MAX_MEMORY_PROPOSALS = 10;
const MAX_MEMORY_PROPOSAL_CHARS = 1000;
const MAX_NEXT_ACTION_CHARS = 1000;
const MAX_ARTIFACTS = 50;
// git diff --stat is unbounded (~4k changed files ⇒ hundreds of KiB); keep only
// the tail (the "N files changed" summary lives there) so a huge diff can never
// push the serialized packet past the 256KiB route backstop.
const DIFF_STAT_TAIL_CHARS = 8000;
// Leading overlap when redacting a tail: enough context to catch a `KEY=value`
// pair whose key sits just before the final tail boundary.
const REDACT_TAIL_OVERLAP_CHARS = 200;

/**
 * The SHA-256 of the empty string. A run reported exactly this as its
 * `diffHash` beside `changedFiles: []` and `diffVerified: true` — a hash of
 * nothing, presented as verification. Named so the check reads as what it is.
 */
export const EMPTY_DIFF_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A hashed diff that provably contains nothing. */
function isEmptyDiff(diff: { hash: string; totalBytes: number }): boolean {
  return diff.totalBytes === 0 || diff.hash === EMPTY_DIFF_SHA256;
}

export type BuildHandoffPacketInput = {
  laneKey: string;
  taskId: string;
  brief: string;
  /** Raw lane command result (v1 path). One of result/outcome is required. */
  result?: LaneCommandResult;
  /** Dispatch-level alternative when no raw command result exists (workflow). */
  outcome?: { ok: boolean; summary: string };
  events: LaneEvent[];
  diffStat?: string;
  collisions?: WorktreeCollision[];
  openQuestions?: string[];
  sessionId?: string;
  createdAt?: string;
  /** Typed check evidence (bounded and redacted by the builder). */
  checks?: HandoffCheck[];
  changedFiles?: string[];
  /** Full-stream diff hash evidence, or an honest unavailability reason. */
  diff?: HandoffDiffInput;
  artifacts?: HandoffArtifact[];
  uncertainties?: string[];
  unresolvedDecisions?: string[];
  recommendedNextAction?: string;
  memoryProposals?: {
    kind?: "decision" | "constraint" | "convention" | "attempt" | "question";
    text: string;
  }[];
  /**
   * The worker's raw closing text. Tailed and redacted here, and kept whether
   * or not the typed report parsed: it is the packet's own durable copy of what
   * the vendor actually said, independent of the live stream's bounds.
   */
  finalMessage?: string;
  /** Extra caller-supplied degradation reasons, merged with the auto ones. */
  degradedReasons?: string[];
};

function tail(text: string, maxChars = OUTPUT_TAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `…${trimmed.slice(-maxChars)}`;
}

/**
 * Best-effort secret scrubbing for agent output tails. Packets must never
 * carry credentials/env values; this strips the common `KEY=value` and
 * bearer-token shapes before any tail lands in a packet field.
 *
 * Exported alongside `redactedTail` for the one caller that must scrub WITHOUT
 * tailing: the live job terminal relays the vendor's console bytes verbatim, so
 * trimming/tailing them would destroy the very layout it exists to show. Same
 * control, different bound — a second copy of these patterns is the drift this
 * repo has already been bitten by.
 */
export function redactSecrets(text: string): string {
  // Provably-equivalent fast path. Neither pattern below can match without one
  // of these literals present, so a chunk without any of them is returned
  // unchanged — same output, without the expensive scan.
  //
  // It matters because the live job terminal calls this on EVERY console chunk,
  // synchronously, on the vendor's data handler. The bounded `{0,64}` runs that
  // make the assignment pattern linear also give it a 64x constant, which costs
  // ~16ms per 64 KiB of identifier-dense output (base64, a minified bundle, a
  // lockfile dump) — paid on the runner's event loop, on every job, whether or
  // not anyone is watching. The prefilter is a plain literal alternation with no
  // bounded-run backtracking and drops that to well under a millisecond.
  if (!SECRET_PREFILTER.test(text)) {
    return text;
  }
  return text
    .replace(SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(BEARER_VALUE, "$1[redacted]");
}

/**
 * How many characters at the END of `text` are the OPENING of a secret shape
 * whose value has not arrived yet — a `SOME_TOKEN=` with nothing after it, or a
 * bare `Bearer `.
 *
 * Only a STREAMING scrubber needs this. `redactSecrets` sees whole text, and its
 * separator is `\s*[=:]\s*` — `\s` spans newlines — so it redacts a value that
 * sits on the line AFTER its key. A relay that scrubs line by line would hand
 * those two lines to two different passes and match in neither. Holding this
 * many characters back until the next chunk arrives restores the whole-text
 * behaviour exactly.
 *
 * Lives here, next to the patterns it is derived from, precisely so it cannot
 * drift away from them — the keyword alternation has exactly one definition.
 */
export function pendingSecretTailLength(text: string): number {
  // Only the TAIL can match an end-anchored pattern, and the pattern's own key
  // runs are bounded — so inspect a bounded window instead of the whole string.
  // This runs on a live vendor's data handler: without the window, a 256 KiB
  // console chunk would make the engine retry from every start position (each
  // scanning up to 64 identifier characters) on the event loop, for a match that
  // can only ever be at the end. The one thing the window gives up is an opening
  // whose separator whitespace is itself longer than the window — in which case
  // nothing is held back and the caller simply behaves as it did before.
  const window =
    text.length > PENDING_SECRET_WINDOW_CHARS
      ? text.slice(-PENDING_SECRET_WINDOW_CHARS)
      : text;
  const match = PENDING_SECRET_OPENING.exec(window);
  return match ? match[0].length : 0;
}

/**
 * Character runs bounded to a constant so scanning is LINEAR (no O(n^2)
 * backtracking on long keyword-free identifier runs — ReDoS SEC-3/SEC-4).
 * Kept byte-identical to the @muon/client run-bundle mirror. Real secrets
 * still redact: a longer name matches from a later start position, and the
 * value group (\S+) is unbounded.
 */
const SECRET_KEYWORDS =
  "(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)";
const SECRET_KEY = `[A-Za-z0-9_-]{0,64}${SECRET_KEYWORDS}[A-Za-z0-9_-]{0,64}`;
const SECRET_SEPARATOR = "\\s*[=:]\\s*";
const SECRET_ASSIGNMENT = new RegExp(
  `(${SECRET_KEY})(${SECRET_SEPARATOR})(\\S+)`,
  "gi"
);
const BEARER_VALUE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * Every literal either pattern requires. Built from the SAME keyword constant,
 * plus `Bearer` for the second pattern, so it cannot drift out of agreement with
 * what it is guarding. Deliberately NOT global: `test` on a /g/ regex carries
 * `lastIndex` state and would alternate between hit and miss across calls.
 */
const SECRET_PREFILTER = new RegExp(`${SECRET_KEYWORDS}|Bearer`, "i");
/** Deliberately NOT global: `exec` on a /g/ regex carries `lastIndex` state. */
const PENDING_SECRET_OPENING = new RegExp(
  `(?:${SECRET_KEY}${SECRET_SEPARATOR}|Bearer\\s+)$`,
  "i"
);
/**
 * Comfortably wider than the longest opening the pattern can match (two bounded
 * 64-character runs, the keyword, and a separator), so the window costs nothing
 * in fidelity while making the match O(1) in the size of the console chunk.
 */
const PENDING_SECRET_WINDOW_CHARS = 1024;

/**
 * Redacted tail, hard-bounded to maxChars even if redaction lengthens it.
 * Redaction runs BEFORE the final tail, over a window that reaches
 * REDACT_TAIL_OVERLAP_CHARS earlier than the tail boundary, so a `KEY=value`
 * pair straddling that boundary is scrubbed with its key prefix intact instead
 * of leaking the trailing value fragment.
 *
 * Exported because it is THE redaction control for surfaced vendor text: the
 * runner's liveness watchdog reuses it for the stderr tail it puts in a stall
 * reason. A second copy of a redaction control is the drift pattern this repo
 * has been bitten by before — new callers reuse this one.
 */
export function redactedTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const windowChars = maxChars + REDACT_TAIL_OVERLAP_CHARS;
  const window =
    trimmed.length <= windowChars ? trimmed : trimmed.slice(-windowChars);
  return tail(redactSecrets(window), maxChars).slice(0, maxChars + 1);
}

/**
 * TODO 7.1 — THE error/log chokepoint.
 *
 * Distinct from {@link redactedTail} (vendor stream tails, keep-from-end) and
 * from {@link redactSecrets} (hot path on every console chunk). Log lines want
 * head-bounded text, a CWE-117 control-char strip, and the vendor token shapes
 * (`sk-` / `sess-` / `key-`) that never appear as KEY=value pairs. Call this
 * from every `printError` / `log.error` / `console.error` of an Error.message.
 */
const LOG_VENDOR_TOKEN = /\b(?:sk|sess|key)-[A-Za-z0-9_-]{8,}/g;
const LOG_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;
const LOG_HEX_RUN = /\b[0-9a-f]{32,}\b/gi;

export function redactForLog(value: unknown, maxChars = 2000): string {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value == null
          ? ""
          : String(value);
  const noControls = raw.replace(LOG_CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const scrubbed = redactSecrets(noControls)
    .replace(LOG_VENDOR_TOKEN, "[redacted]")
    .replace(LOG_HEX_RUN, "[redacted]");
  if (scrubbed.length <= maxChars) return scrubbed;
  return `${scrubbed.slice(0, maxChars)}…`;
}

function commandsFromEvents(events: LaneEvent[]): string[] {
  const commands = events
    .filter((event) => event.kind === "task.started")
    .map((event) => {
      const command = event.metadata.command;
      const args = event.metadata.args;
      if (typeof command !== "string") {
        return undefined;
      }
      const argList = Array.isArray(args)
        ? args.filter((arg): arg is string => typeof arg === "string")
        : [];
      // Command + args are agent/harness text; scrub before they land verbatim.
      return redactSecrets([command, ...argList].join(" "));
    })
    .filter((entry): entry is string => Boolean(entry));

  return commands.length > 0 ? commands : ["(command not captured)"];
}

function boundedList(entries: string[] | undefined): string[] {
  return (entries ?? [])
    .filter((entry) => entry.length > 0)
    // Redact BEFORE truncating so a value split at the char bound cannot leak.
    .map((entry) => redactSecrets(entry).slice(0, MAX_LIST_ENTRY_CHARS))
    .slice(0, MAX_LIST_ENTRIES);
}

export function buildHandoffPacket(
  input: BuildHandoffPacketInput
): HandoffPacket {
  const { result, outcome } = input;
  if (!result && !outcome) {
    throw new Error("buildHandoffPacket needs result or outcome");
  }

  const degradedReasons: string[] = [];

  let whatChanged: string;
  let whatFailed: string;
  let checksStatus: string[];

  if (result) {
    const succeeded = result.exitCode === 0;

    const changedParts = [
      succeeded
        ? `Lane '${input.laneKey}' completed the brief.`
        : `Lane '${input.laneKey}' attempted the brief but exited non-zero.`,
    ];
    const outputTail = redactedTail(result.output, OUTPUT_TAIL_CHARS);
    changedParts.push(
      outputTail.length > 0
        ? `Output tail:\n${outputTail}`
        : "No output captured."
    );
    if (input.diffStat && input.diffStat.trim().length > 0) {
      const trimmedStat = input.diffStat.trim();
      let statText = trimmedStat;
      if (trimmedStat.length > DIFF_STAT_TAIL_CHARS) {
        // Keep the tail (the summary line + most-recent files); flag the loss.
        statText = `…[diff --stat truncated to last ${DIFF_STAT_TAIL_CHARS} chars]\n${trimmedStat.slice(
          -DIFF_STAT_TAIL_CHARS
        )}`;
        degradedReasons.push(HANDOFF_DEGRADATION.diffStatTruncated);
      }
      changedParts.push(`Worktree diff (git diff --stat):\n${statText}`);
    }
    whatChanged = changedParts.join("\n\n");

    const errorTail = redactedTail(result.errorOutput, OUTPUT_TAIL_CHARS);
    whatFailed = succeeded
      ? "Nothing reported failing. Exit code 0."
      : `Run exited with exit code ${result.exitCode}.${
          errorTail.length > 0 ? ` Error output tail:\n${errorTail}` : ""
        }`;

    checksStatus = [
      `exit_code=${result.exitCode}`,
      `duration_ms=${result.durationMs}`,
      succeeded ? "run: completed" : "run: blocked",
    ];
    if (input.diffStat !== undefined) {
      checksStatus.push(
        input.diffStat.trim().length > 0
          ? "diff: captured from isolated worktree"
          : "diff: no tracked changes in isolated worktree"
      );
    }
  } else {
    // Outcome-only path (no raw command result): no fabricated exit codes or
    // durations, only what the dispatch honestly reported.
    const succeeded = outcome!.ok;
    const summaryTail = redactedTail(outcome!.summary, OUTPUT_TAIL_CHARS);
    whatChanged = [
      `Lane '${input.laneKey}' ${succeeded ? "completed" : "failed"} the step.`,
      ...(summaryTail.length > 0 ? [summaryTail] : []),
    ].join("\n\n");
    whatFailed = succeeded
      ? "Nothing reported failing."
      : summaryTail.length > 0
        ? summaryTail
        : "The step failed without a reported summary.";
    checksStatus = [succeeded ? "run: completed" : "run: blocked"];
  }

  const collisions = input.collisions ?? [];
  for (const collision of collisions) {
    checksStatus.push(
      `collision: ${collision.files.join(", ")} also claimed by task '${collision.taskId}'`
    );
  }
  const collisionQuestions = collisions.map(
    (collision) =>
      `Task '${collision.taskId}' also touches ${collision.files.join(", ")}, who lands first?`
  );

  // ---- v2 typed evidence ----
  const inputChecks = input.checks ?? [];
  if (inputChecks.length > MAX_CHECKS) {
    degradedReasons.push(HANDOFF_DEGRADATION.checksTruncated);
  }
  const checks = inputChecks.slice(0, MAX_CHECKS).map((check) => ({
    ...check,
    name: check.name.slice(0, 120),
    ...(check.command !== undefined
      ? { command: redactSecrets(check.command).slice(0, CHECK_COMMAND_CHARS) }
      : {}),
    summary: redactedTail(check.summary ?? "", CHECK_SUMMARY_CHARS - 1).slice(
      0,
      CHECK_SUMMARY_CHARS
    ),
  }));
  if (inputChecks.length === 0) {
    degradedReasons.push(HANDOFF_DEGRADATION.noCheckEvidence);
  }

  const inputChangedFiles = input.changedFiles ?? [];
  if (inputChangedFiles.length > MAX_CHANGED_FILES) {
    degradedReasons.push(HANDOFF_DEGRADATION.changedFilesTruncated);
  }
  const changedFiles = inputChangedFiles
    .filter((file) => file.length > 0)
    .map((file) => file.slice(0, MAX_FILE_PATH_CHARS))
    .slice(0, MAX_CHANGED_FILES);

  // A check that ran but observed none of the changed paths is evidence of
  // nothing, and it must not read as evidence of something. Said in the v1
  // prose field as well as the typed one, so a reader on ANY surface gets
  // "tests ran but covered none of the changed files" rather than "tests: pass".
  for (const check of checks) {
    if (check.outcome === "passed-but-uncovering") {
      degradedReasons.push(HANDOFF_DEGRADATION.uncoveredDiff);
      checksStatus.push(
        `check '${check.name}': ran and exited 0, but covered NONE of the changed files — it certifies nothing about this change`
      );
    }
  }

  let diffHash: string | undefined;
  let diffVerified = false;
  if (input.diff === undefined) {
    degradedReasons.push(HANDOFF_DEGRADATION.noDiffEvidence);
  } else if ("hash" in input.diff) {
    diffHash = input.diff.hash;
    // `diffVerified` used to mean "a hash exists", which made it true for a run
    // whose diff was EMPTY (`changedFiles: []`, hash `sha256:e3b0c442…b855` —
    // the SHA-256 of the empty string) and true for a run whose only green check
    // could not see the diff. A verification flag that holds in those cases
    // verifies nothing, so it now means what its name promises: there was a
    // change, and at least one check that could observe it passed.
    if (input.changedFiles === undefined) {
      degradedReasons.push(HANDOFF_DEGRADATION.changedFilesUnknown);
    } else if (changedFiles.length === 0 || isEmptyDiff(input.diff)) {
      degradedReasons.push(HANDOFF_DEGRADATION.emptyDiff);
    } else if (!checks.some((check) => check.outcome === "passed")) {
      degradedReasons.push(HANDOFF_DEGRADATION.uncoveredDiff);
    } else {
      diffVerified = true;
    }
  } else {
    degradedReasons.push(
      `${HANDOFF_DEGRADATION.noDiffEvidence}:${input.diff.unavailableReason}`
    );
  }

  const reasons = [
    ...new Set(
      [...degradedReasons, ...(input.degradedReasons ?? [])]
        .filter((reason) => reason.length > 0)
        .map((reason) => reason.slice(0, DEGRADATION_REASON_CHARS))
    ),
  ].slice(0, MAX_DEGRADATION_REASONS);

  const packet: HandoffPacket = {
    taskGoal: input.brief,
    whatChanged,
    whatFailed,
    nextLaneRequest: `Review the run result for task '${input.taskId}' and continue the work.`,
    commandsRun: commandsFromEvents(input.events),
    checksStatus,
    openQuestions: [
      ...collisionQuestions,
      ...(input.openQuestions && input.openQuestions.length > 0
        ? input.openQuestions
        : collisionQuestions.length > 0
          ? []
          : [
              "None captured during this run. Add questions before the next lane starts.",
            ]),
    ],
    provenance: {
      lane: input.laneKey,
      sessionId: input.sessionId,
      createdAt: input.createdAt ?? new Date().toISOString(),
    },
    schemaVersion: HANDOFF_PACKET_VERSION,
    changedFiles,
    ...(diffHash !== undefined ? { diffHash } : {}),
    diffVerified,
    checks,
    artifacts: (input.artifacts ?? []).slice(0, MAX_ARTIFACTS),
    uncertainties: boundedList(input.uncertainties),
    unresolvedDecisions: boundedList(input.unresolvedDecisions),
    ...(input.recommendedNextAction !== undefined
      ? {
          // Redact BEFORE truncating so a secret cut at the bound cannot leak.
          recommendedNextAction: redactSecrets(
            input.recommendedNextAction
          ).slice(0, MAX_NEXT_ACTION_CHARS),
        }
      : {}),
    memoryProposals: (input.memoryProposals ?? [])
      .filter((proposal) => proposal.text.length > 0)
      .map((proposal) => ({
        kind: proposal.kind ?? "attempt",
        text: redactSecrets(proposal.text).slice(0, MAX_MEMORY_PROPOSAL_CHARS),
      }))
      .slice(0, MAX_MEMORY_PROPOSALS),
    // TAIL-kept: a worker's report ENDS with the ten labels and the verdict, so
    // the tail is the part a reader (and a human reading over its shoulder)
    // cannot do without.
    ...(input.finalMessage && input.finalMessage.trim().length > 0
      ? {
          finalMessage: redactedTail(
            input.finalMessage,
            HANDOFF_FINAL_MESSAGE_CHARS
          ),
        }
      : {}),
    degraded: { flag: reasons.length > 0, reasons },
  };

  return handoffPacketSchema.parse(packet);
}

const MAX_RENDERED_CHANGED_FILES = 20;

/**
 * Why a hashed diff is not verified. `verified: false` on its own reads as a
 * missing feature; the reason is what tells a reader whether the run proved
 * nothing because there was nothing to prove, or because the checks that
 * passed could not see the change.
 */
function unverifiedReason(packet: HandoffPacket): string {
  const reasons = packet.degraded.reasons;
  if (reasons.includes(HANDOFF_DEGRADATION.emptyDiff)) {
    return "the diff is EMPTY, so there was nothing to verify";
  }
  if (reasons.includes(HANDOFF_DEGRADATION.uncoveredDiff)) {
    return "no check covered the changed files, so nothing here certifies them";
  }
  if (reasons.includes(HANDOFF_DEGRADATION.changedFilesUnknown)) {
    return "the changed-file list is unavailable, so coverage is unprovable";
  }
  return "no full-stream diff evidence";
}

export function renderHandoffPacketMarkdown(packet: HandoffPacket): string {
  const list = (items: string[]) =>
    items.map((item) => `- ${item}`).join("\n");

  const provenanceLines = [
    `- lane: ${packet.provenance.lane}`,
    ...(packet.provenance.sessionId
      ? [`- session: ${packet.provenance.sessionId}`]
      : []),
    `- created: ${packet.provenance.createdAt}`,
  ];

  const lines = [
    ...(packet.degraded.flag
      ? [`> ⚠ DEGRADED: ${packet.degraded.reasons.join("; ")}`, ""]
      : []),
    "## Task goal",
    packet.taskGoal,
    "",
    "## What changed",
    packet.whatChanged,
    "",
    "## What failed",
    packet.whatFailed,
    "",
    "## Next lane request",
    packet.nextLaneRequest,
    "",
    "## Commands run",
    list(packet.commandsRun),
    "",
    "## Checks status",
    list(packet.checksStatus),
    "",
    "## Open questions",
    list(packet.openQuestions),
    "",
    "## Provenance",
    provenanceLines.join("\n"),
    "",
  ];

  if (packet.schemaVersion >= 2) {
    if (packet.diffHash !== undefined || packet.changedFiles.length > 0) {
      lines.push(
        "## Evidence",
        `- diff hash: ${packet.diffHash ?? "none"} (verified: ${packet.diffVerified}${
          packet.diffVerified ? "" : ` — ${unverifiedReason(packet)}`
        })`
      );
      if (packet.changedFiles.length > 0) {
        lines.push(`- changed files (${packet.changedFiles.length}):`);
        for (const file of packet.changedFiles.slice(
          0,
          MAX_RENDERED_CHANGED_FILES
        )) {
          lines.push(`  - ${file}`);
        }
        if (packet.changedFiles.length > MAX_RENDERED_CHANGED_FILES) {
          lines.push(
            `  - …and ${packet.changedFiles.length - MAX_RENDERED_CHANGED_FILES} more`
          );
        }
      }
      lines.push("");
    }
    if (packet.checks.length > 0) {
      lines.push(
        "## Checks",
        ...packet.checks.map(
          (check) =>
            `- [${check.outcome}] ${check.name}${
              check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""
            }: ${check.summary}`
        ),
        ""
      );
    }
    if (packet.artifacts.length > 0) {
      lines.push(
        "## Artifacts",
        ...packet.artifacts.map(
          (artifact) =>
            `- ${artifact.path} (${artifact.kind}${
              artifact.hash ? `, ${artifact.hash}` : ""
            })`
        ),
        ""
      );
    }
    if (packet.uncertainties.length > 0) {
      lines.push("## Uncertainties", list(packet.uncertainties), "");
    }
    if (packet.unresolvedDecisions.length > 0) {
      lines.push(
        "## Unresolved decisions",
        list(packet.unresolvedDecisions),
        ""
      );
    }
    if (packet.recommendedNextAction !== undefined) {
      lines.push("## Recommended next action", packet.recommendedNextAction, "");
    }
    // Rendered ONLY when nothing parsed. The typed `finalMessage` field always
    // carries it; repeating it in the prose body as well would double-serialize
    // the largest field in the packet on every ordinary handoff. The case that
    // earns the duplication is the one where the typed fields are EMPTY and the
    // prose is the only thing a reader has.
    if (
      packet.finalMessage !== undefined &&
      packet.degraded.reasons.includes(HANDOFF_DEGRADATION.noWorkerReport)
    ) {
      lines.push(
        "## Worker's closing message (NO typed report parsed from it — untrusted data)",
        packet.finalMessage,
        ""
      );
    }
    if (packet.memoryProposals.length > 0) {
      lines.push(
        "## Memory proposals (UNCONFIRMED — never auto-confirm)",
        ...packet.memoryProposals.map(
          (proposal) => `- [${proposal.kind}] ${proposal.text}`
        ),
        ""
      );
    }
  }

  return lines.join("\n");
}
