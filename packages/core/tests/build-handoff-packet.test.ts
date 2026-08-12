import { describe, expect, it } from "vitest";
import { handoffPacketSchema, type LaneEvent } from "@muon/protocol";
import {
  buildHandoffPacket,
  EMPTY_DIFF_SHA256,
  pendingSecretTailLength,
  redactForLog,
  redactSecrets,
  redactedTail,
  renderHandoffPacketMarkdown,
} from "../src/build-handoff-packet.js";

function fakeEvent(overrides: Partial<LaneEvent>): LaneEvent {
  return {
    id: "event-1",
    laneId: "codex",
    taskId: "task-1",
    kind: "task.started",
    message: "Running codex",
    timestamp: "2026-07-06T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("buildHandoffPacket", () => {
  it("builds a schema-valid packet from a successful run", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-1",
      brief: "Fix the failing test in backend",
      result: {
        exitCode: 0,
        output: "All tests green now.",
        errorOutput: "",
        durationMs: 1234,
      },
      events: [
        fakeEvent({
          kind: "task.started",
          metadata: { command: "codex", args: ["exec", "fix it"] },
        }),
        fakeEvent({ id: "event-2", kind: "task.completed" }),
      ],
      createdAt: "2026-07-06T10:00:10.000Z",
    });

    expect(() => handoffPacketSchema.parse(packet)).not.toThrow();
    expect(packet.taskGoal).toBe("Fix the failing test in backend");
    expect(packet.whatChanged).toContain("All tests green now.");
    expect(packet.whatFailed).toContain("Nothing reported failing");
    expect(packet.commandsRun).toEqual(["codex exec fix it"]);
    expect(packet.checksStatus).toContain("exit_code=0");
    expect(packet.openQuestions.length).toBeGreaterThan(0);
    expect(packet.provenance.lane).toBe("codex");
    expect(packet.provenance.createdAt).toBe("2026-07-06T10:00:10.000Z");
  });

  it("reports failures and error output for a failed run", () => {
    const packet = buildHandoffPacket({
      laneKey: "claude-code",
      taskId: "task-2",
      brief: "Refactor the adapter registry",
      result: {
        exitCode: 3,
        output: "",
        errorOutput: "TypeError: boom",
        durationMs: 42,
      },
      events: [],
      createdAt: "2026-07-06T11:00:00.000Z",
    });

    expect(() => handoffPacketSchema.parse(packet)).not.toThrow();
    expect(packet.whatFailed).toContain("exit code 3");
    expect(packet.whatFailed).toContain("TypeError: boom");
    expect(packet.checksStatus).toContain("exit_code=3");
    expect(packet.commandsRun).toEqual(["(command not captured)"]);
  });

  it("includes the worktree diff when provided", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-3",
      brief: "Apply the planned edits",
      result: { exitCode: 0, output: "done", errorOutput: "", durationMs: 10 },
      events: [],
      diffStat: " src/index.ts | 4 ++--\n 1 file changed",
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).toContain("src/index.ts | 4 ++--");
    expect(packet.checksStatus.some((line) => line.includes("diff"))).toBe(
      true
    );
  });

  it("surfaces worktree collisions in the checks and open questions", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-6",
      brief: "Apply the planned edits",
      result: { exitCode: 0, output: "done", errorOutput: "", durationMs: 10 },
      events: [],
      collisions: [{ taskId: "task-9", files: ["src/index.ts", "README.md"] }],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(
      packet.checksStatus.some((line) =>
        line.includes(
          "collision: src/index.ts, README.md also claimed by task 'task-9'"
        )
      )
    ).toBe(true);
    expect(
      packet.openQuestions.some((line) => line.includes("task-9"))
    ).toBe(true);
  });

  it("truncates long output to a tail", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-4",
      brief: "Summarize the repo",
      result: {
        exitCode: 0,
        output: `${"x".repeat(5000)}TAIL_MARKER`,
        errorOutput: "",
        durationMs: 10,
      },
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).toContain("TAIL_MARKER");
    expect(packet.whatChanged.length).toBeLessThan(3000);
  });
});

describe("buildHandoffPacket v2 evidence", () => {
  const okResult = {
    exitCode: 0,
    output: "done",
    errorOutput: "",
    durationMs: 10,
  };
  const validHash = `sha256:${"b".repeat(64)}`;

  it("maps typed checks and redacts secrets from check summaries", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-10",
      brief: "Run the checks",
      result: okResult,
      events: [],
      checks: [
        {
          name: "unit tests",
          command: "npm test",
          outcome: "passed",
          exitCode: 0,
          summary: "green with API_TOKEN=abc123 in env dump",
        },
        {
          name: "auth probe",
          outcome: "failed",
          exitCode: 1,
          summary: "sent Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 header",
        },
      ],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.schemaVersion).toBe(2);
    expect(packet.checks).toHaveLength(2);
    expect(packet.checks[0]).toMatchObject({
      name: "unit tests",
      command: "npm test",
      outcome: "passed",
      exitCode: 0,
    });
    expect(packet.checks[0]?.summary).toContain("API_TOKEN=[redacted]");
    expect(packet.checks[0]?.summary).not.toContain("abc123");
    expect(packet.checks[1]?.summary).toContain("Bearer [redacted]");
    expect(packet.checks[1]?.summary).not.toContain("eyJhbGciOiJIUzI1NiI");
    expect(packet.degraded.reasons).not.toContain("no_check_evidence");
  });

  it("redacts secrets from outcome summaries placed into whatChanged", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-11",
      brief: "Do the step",
      outcome: {
        ok: true,
        summary: "finished with MY_SECRET=supersecret left in the log",
      },
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).toContain("MY_SECRET=[redacted]");
    expect(packet.whatChanged).not.toContain("supersecret");
  });

  it("marks the diff verified when full-stream hash evidence is present", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-12",
      brief: "Apply the edits",
      result: okResult,
      events: [],
      checks: [
        { name: "tests", outcome: "passed", exitCode: 0, summary: "green" },
      ],
      changedFiles: ["src/a.ts"],
      diff: { hash: validHash, totalBytes: 512 },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.diffHash).toBe(validHash);
    expect(packet.diffVerified).toBe(true);
    expect(packet.changedFiles).toEqual(["src/a.ts"]);
    expect(packet.degraded.flag).toBe(false);
    expect(
      packet.degraded.reasons.some((r) => r.startsWith("no_diff_evidence"))
    ).toBe(false);
  });

  it("visibly degrades when diff evidence is missing", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-13",
      brief: "Apply the edits",
      result: okResult,
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("no_diff_evidence");
    expect(packet.degraded.reasons).toContain("no_check_evidence");
    expect(packet.diffVerified).toBe(false);
    expect(packet.diffHash).toBeUndefined();
  });

  it("carries the honest unavailability reason when the workspace is not a worktree", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-14",
      brief: "Apply the edits",
      result: okResult,
      events: [],
      diff: { unavailableReason: "workspace_not_worktree" },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain(
      "no_diff_evidence:workspace_not_worktree"
    );
  });

  it("builds an honest packet from an outcome alone (no fabricated exit codes)", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-15",
      brief: "Finish step",
      outcome: { ok: true, summary: "step 'fix' finished cleanly" },
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).toContain("Lane 'codex' completed the step.");
    expect(packet.whatChanged).toContain("step 'fix' finished cleanly");
    expect(packet.whatFailed).toContain("Nothing reported failing");
    expect(packet.checksStatus).toEqual(["run: completed"]);
    expect(
      packet.checksStatus.some((line) => line.startsWith("exit_code="))
    ).toBe(false);
  });

  it("reports failure honestly on a failed outcome", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-16",
      brief: "Finish step",
      outcome: { ok: false, summary: "loop escalated: budget exhausted" },
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).toContain("Lane 'codex' failed the step.");
    expect(packet.whatFailed).toContain("budget exhausted");
    expect(packet.checksStatus).toEqual(["run: blocked"]);
  });

  it("throws when neither result nor outcome is provided", () => {
    expect(() =>
      buildHandoffPacket({
        laneKey: "codex",
        taskId: "task-17",
        brief: "No evidence at all",
        events: [],
      })
    ).toThrow(/needs result or outcome/i);
  });

  it("truncates oversized checks and changed-file lists with degradation reasons", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-18",
      brief: "Huge evidence",
      result: okResult,
      events: [],
      checks: Array.from({ length: 55 }, (_, i) => ({
        name: `check-${i}`,
        outcome: "passed" as const,
        summary: "ok",
      })),
      changedFiles: Array.from({ length: 220 }, (_, i) => `src/f${i}.ts`),
      diff: { hash: validHash, totalBytes: 10 },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.checks).toHaveLength(50);
    expect(packet.changedFiles).toHaveLength(200);
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("checks_truncated");
    expect(packet.degraded.reasons).toContain("changed_files_truncated");
  });

  it("redacts a secret sentinel from every v2 free-text field", () => {
    const secret = "sk_live_deadbeefcafe0123456789";
    const pair = (label: string) => `${label}=${secret}`;
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-redact",
      brief: "Redact everything",
      result: okResult,
      events: [
        fakeEvent({
          kind: "task.started",
          metadata: { command: "deploy", args: ["exec", pair("API_KEY")] },
        }),
      ],
      checks: [
        {
          name: "probe",
          command: `run ${pair("SECRET_TOKEN")} now`,
          outcome: "passed",
          summary: `logged ${pair("API_TOKEN")}`,
        },
      ],
      diff: { hash: validHash, totalBytes: 1 },
      uncertainties: [pair("PASSWORD")],
      unresolvedDecisions: [pair("CREDENTIAL")],
      recommendedNextAction: pair("PRIVATE_KEY"),
      memoryProposals: [{ kind: "attempt", text: pair("API_KEY") }],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    // No field of the built packet may carry the raw secret value.
    expect(JSON.stringify(packet)).not.toContain(secret);
    // The fields survive, just scrubbed.
    expect(packet.checks[0]?.command).toContain("[redacted]");
    expect(packet.checks[0]?.summary).toContain("[redacted]");
    expect(packet.commandsRun.join(" ")).toContain("[redacted]");
    expect(packet.uncertainties[0]).toContain("[redacted]");
    expect(packet.unresolvedDecisions[0]).toContain("[redacted]");
    expect(packet.recommendedNextAction).toContain("[redacted]");
    expect(packet.memoryProposals[0]?.text).toContain("[redacted]");
  });

  it("bounds an oversized diff --stat and flags the truncation", () => {
    const hugeStat = `HEAD_SENTINEL_LINE\n${Array.from(
      { length: 4000 },
      (_, i) => ` src/module${i}/file.ts | 3 +++`
    ).join("\n")}\nTAIL_SUMMARY 4000 files changed, 12000 insertions(+)`;
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-hugestat",
      brief: "Touch everything",
      result: okResult,
      events: [],
      diffStat: hugeStat,
      diff: { hash: validHash, totalBytes: 1 },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(hugeStat.length).toBeGreaterThan(8000);
    // The head is dropped; the tail (with the summary line) survives.
    expect(packet.whatChanged).not.toContain("HEAD_SENTINEL_LINE");
    expect(packet.whatChanged).toContain("TAIL_SUMMARY 4000 files changed");
    expect(packet.whatChanged).toContain("diff --stat truncated to last 8000");
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("diff_stat_truncated");
  });

  it("does not leak a secret value fragment split at the output tail boundary", () => {
    // `SECRET_KEY=` sits just before the 2000-char output-tail boundary and its
    // value straddles it: a truncate-THEN-redact would keep the KEY prefix
    // outside the tail and leak the trailing value fragment.
    const value = "Z".repeat(50);
    const output = `${"x".repeat(500)}SECRET_KEY=${value} ${"y".repeat(1980)}`;
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-straddle",
      brief: "Straddle the boundary",
      result: { exitCode: 0, output, errorOutput: "", durationMs: 1 },
      events: [],
      diff: { hash: validHash, totalBytes: 1 },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.whatChanged).not.toContain("Z");
    expect(packet.whatChanged).toContain("[redacted]");
  });

  it("bounds recommendedNextAction and passes caller-supplied degradation reasons", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-19",
      brief: "Bound everything",
      result: okResult,
      events: [],
      checks: [{ name: "tests", outcome: "passed", summary: "ok" }],
      diff: { hash: validHash, totalBytes: 1 },
      recommendedNextAction: "n".repeat(1500),
      degradedReasons: ["custom_reason"],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    expect(packet.recommendedNextAction).toHaveLength(1000);
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("custom_reason");
  });
});

describe("renderHandoffPacketMarkdown v2", () => {
  const validHash = `sha256:${"c".repeat(64)}`;

  it("prepends a degradation banner as the first line when degraded", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-20",
      brief: "Degraded run",
      result: { exitCode: 0, output: "done", errorOutput: "", durationMs: 5 },
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    const markdown = renderHandoffPacketMarkdown(packet);
    expect(markdown.startsWith("> ⚠ DEGRADED:")).toBe(true);
    expect(markdown.split("\n")[0]).toContain("no_diff_evidence");
    expect(markdown.split("\n")[0]).toContain("no_check_evidence");
  });

  it("renders evidence and checks sections, capping changed files at 20", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-21",
      brief: "Full evidence run",
      result: { exitCode: 0, output: "done", errorOutput: "", durationMs: 5 },
      events: [],
      checks: [
        { name: "tests", outcome: "passed", exitCode: 0, summary: "green" },
        { name: "lint", outcome: "failed", exitCode: 1, summary: "2 errors" },
      ],
      changedFiles: Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`),
      diff: { hash: validHash, totalBytes: 2048 },
      artifacts: [{ path: "reports/out.html", kind: "report" }],
      uncertainties: ["Is the cache warm?"],
      unresolvedDecisions: ["Flag removal pending."],
      recommendedNextAction: "Run the integration suite.",
      memoryProposals: [{ kind: "decision", text: "Backoff is exponential." }],
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    const markdown = renderHandoffPacketMarkdown(packet);
    expect(markdown).not.toContain("DEGRADED");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain(`diff hash: ${validHash} (verified: true)`);
    expect(markdown).toContain("changed files (25):");
    expect(markdown).toContain("src/f19.ts");
    expect(markdown).not.toContain("src/f20.ts");
    expect(markdown).toContain("…and 5 more");
    expect(markdown).toContain("## Checks");
    expect(markdown).toContain("[passed] tests (exit 0): green");
    expect(markdown).toContain("[failed] lint (exit 1): 2 errors");
    expect(markdown).toContain("## Artifacts");
    expect(markdown).toContain("## Uncertainties");
    expect(markdown).toContain("## Unresolved decisions");
    expect(markdown).toContain("## Recommended next action");
    expect(markdown).toContain("Run the integration suite.");
    expect(markdown).toContain(
      "## Memory proposals (UNCONFIRMED — never auto-confirm)"
    );
  });

  it("omits empty v2 sections", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-22",
      brief: "Minimal evidence run",
      result: { exitCode: 0, output: "done", errorOutput: "", durationMs: 5 },
      events: [],
      checks: [{ name: "tests", outcome: "passed", summary: "ok" }],
      diff: { hash: validHash, totalBytes: 0 },
      createdAt: "2026-07-06T12:00:00.000Z",
    });

    const markdown = renderHandoffPacketMarkdown(packet);
    expect(markdown).not.toContain("## Artifacts");
    expect(markdown).not.toContain("## Uncertainties");
    expect(markdown).not.toContain("## Unresolved decisions");
    expect(markdown).not.toContain("## Memory proposals");
  });
});

describe("renderHandoffPacketMarkdown", () => {
  it("renders every packet section as markdown", () => {
    const packet = buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-5",
      brief: "Fix the failing test in backend",
      result: {
        exitCode: 0,
        output: "All green.",
        errorOutput: "",
        durationMs: 5,
      },
      events: [
        fakeEvent({
          metadata: { command: "codex", args: ["exec", "fix"] },
        }),
      ],
      createdAt: "2026-07-06T10:00:10.000Z",
    });

    const markdown = renderHandoffPacketMarkdown(packet);

    expect(markdown).toContain("## Task goal");
    expect(markdown).toContain("## What changed");
    expect(markdown).toContain("## What failed");
    expect(markdown).toContain("## Next lane request");
    expect(markdown).toContain("## Commands run");
    expect(markdown).toContain("## Checks status");
    expect(markdown).toContain("## Open questions");
    expect(markdown).toContain("## Provenance");
    expect(markdown).toContain("codex exec fix");
    expect(markdown).toContain("lane: codex");
  });
});

describe("redactedTail (shared redaction control)", () => {
  // Exported so the runner's liveness watchdog reuses THIS redactor for the
  // vendor stderr tail it surfaces, instead of growing a second copy.
  it("scrubs credential shapes and stays hard-bounded", () => {
    const surfaced = redactedTail(
      "warn: refreshing\nOPENAI_API_KEY=sk-live-abc123\nAuthorization: Bearer abcdef0123456789",
      2000
    );
    expect(surfaced).toContain("warn: refreshing");
    expect(surfaced).not.toContain("sk-live-abc123");
    expect(surfaced).not.toContain("abcdef0123456789");
    expect(surfaced).toContain("[redacted]");

    const huge = redactedTail(`${"x".repeat(2_000_000)}tail-marker`, 2000);
    expect(huge.length).toBeLessThanOrEqual(2001);
    expect(huge).toContain("tail-marker");
  });
});

describe("redactSecrets / pendingSecretTailLength (the one redaction control)", () => {
  it("still scrubs the shapes the packet tails depend on", () => {
    expect(redactSecrets("MUON_API_TOKEN=muon_live_abc123")).toBe(
      "MUON_API_TOKEN=[redacted]"
    );
    expect(redactSecrets("Authorization: Bearer sk-ant-0123456789")).toBe(
      "Authorization: Bearer [redacted]"
    );
    // The separator is `\s*[=:]\s*`, and `\s` spans newlines — this is the
    // behaviour a streaming caller has to reproduce.
    expect(redactSecrets("GITHUB_TOKEN=\nghp_secret_value")).toBe(
      "GITHUB_TOKEN=\n[redacted]"
    );
    expect(redactSecrets("nothing to see here")).toBe("nothing to see here");
  });

  it("reports the trailing opening of a secret whose value has not arrived", () => {
    // A streaming scrubber must hold these back; without that it would hand the
    // key and its value to two different passes and match in neither.
    expect(pendingSecretTailLength("env: GITHUB_TOKEN=")).toBe(
      "GITHUB_TOKEN=".length
    );
    expect(pendingSecretTailLength("Authorization: Bearer ")).toBe("Bearer ".length);
    expect(pendingSecretTailLength("MY_TOKEN=\n")).toBe("MY_TOKEN=\n".length);
    // A complete pair holds nothing back — the value is already there.
    expect(pendingSecretTailLength("MY_TOKEN=value")).toBe(0);
    expect(pendingSecretTailLength("ordinary console output")).toBe(0);
    expect(pendingSecretTailLength("")).toBe(0);
  });

  it("is not stateful across calls (a /g/ regex would carry lastIndex)", () => {
    const text = "GITHUB_TOKEN=";
    expect(pendingSecretTailLength(text)).toBe(pendingSecretTailLength(text));
    expect(pendingSecretTailLength(text)).toBe(pendingSecretTailLength(text));
    // Same trap on the scrubber's own prefilter: a stateful `test` would make
    // every second identical call skip redaction entirely.
    const secret = "MY_TOKEN=abc123";
    expect(redactSecrets(secret)).toBe("MY_TOKEN=[redacted]");
    expect(redactSecrets(secret)).toBe("MY_TOKEN=[redacted]");
    expect(redactSecrets(secret)).toBe("MY_TOKEN=[redacted]");
  });

  it("finds a credential regardless of how much innocuous text precedes it", () => {
    // The prefilter must never turn into a length-dependent miss.
    for (const filler of [0, 1_000, 100_000]) {
      const text = `${"a".repeat(filler)} MY_TOKEN=abc123`;
      expect(redactSecrets(text)).toContain("[redacted]");
      expect(redactSecrets(text)).not.toContain("abc123");
    }
    // …and text with no credential shape comes back byte-identical.
    const plain = "abcdefghij".repeat(6_554);
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("holds back a pending opening found at the end of a very large chunk", () => {
    const held = pendingSecretTailLength(
      `${"abcdefghij".repeat(26_215)}GITHUB_TOKEN=`
    );
    // At least the opening itself; the bounded key runs may claim a little of
    // the preceding text, which is safe — it is simply emitted one cut later.
    expect(held).toBeGreaterThanOrEqual("GITHUB_TOKEN=".length);
  });
});

describe("TODO 7.1: redactForLog (error/log chokepoint)", () => {
  it("scrubs Bearer, KEY=value, sk- tokens, and control chars", () => {
    const line = redactForLog(
      "boom\nMUON_API_TOKEN=muon_live_abc123 Bearer sk-ant-0123456789abcd"
    );
    expect(line).not.toContain("muon_live_abc123");
    expect(line).not.toContain("sk-ant-0123456789abcd");
    expect(line).toContain("[redacted]");
    expect(line).not.toMatch(/[\u0000-\u001f]/);
  });

  it("accepts Error values and bounds the result", () => {
    const long = `prefix ${"x".repeat(3000)} MUON_API_TOKEN=secret_value`;
    const line = redactForLog(new Error(long), 80);
    expect(line.length).toBeLessThanOrEqual(81);
    expect(line).not.toContain("secret_value");
  });
});

/**
 * `diffVerified` was true for a docs job whose `changedFiles` was `[]` and
 * whose `diffHash` was the SHA-256 of the empty string — and true for a run
 * whose only green check could not observe the diff. A verification flag that
 * holds in those cases verifies nothing.
 */
describe("buildHandoffPacket diffVerified honesty", () => {
  const okResult = {
    exitCode: 0,
    output: "done",
    errorOutput: "",
    durationMs: 10,
  };
  const validHash = `sha256:${"d".repeat(64)}`;
  const passingCheck = {
    name: "tests",
    command: "npm test",
    outcome: "passed" as const,
    exitCode: 0,
    summary: "68 tests",
  };

  const build = (input: Partial<Parameters<typeof buildHandoffPacket>[0]>) =>
    buildHandoffPacket({
      laneKey: "codex",
      taskId: "task-cov",
      brief: "Apply the edits",
      result: okResult,
      events: [],
      createdAt: "2026-07-06T12:00:00.000Z",
      ...input,
    });

  it("refuses to call an EMPTY diff verified", () => {
    const packet = build({
      checks: [passingCheck],
      changedFiles: [],
      diff: { hash: EMPTY_DIFF_SHA256, totalBytes: 0 },
    });

    expect(packet.diffHash).toBe(EMPTY_DIFF_SHA256);
    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.reasons).toContain("empty_diff");
  });

  it("refuses even when the empty hash arrives with a non-zero byte count", () => {
    const packet = build({
      checks: [passingCheck],
      changedFiles: ["a.ts"],
      diff: { hash: EMPTY_DIFF_SHA256, totalBytes: 512 },
    });

    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.reasons).toContain("empty_diff");
  });

  it("refuses to call a diff verified when no check covered it", () => {
    const packet = build({
      checks: [{ ...passingCheck, outcome: "passed-but-uncovering" as const }],
      changedFiles: ["apps/cli/tests/crew.test.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffHash).toBe(validHash);
    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.flag).toBe(true);
    expect(packet.degraded.reasons).toContain("checks_did_not_cover_diff");
  });

  it("refuses to call a diff verified when there were no checks at all", () => {
    const packet = build({
      changedFiles: ["a.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.reasons).toContain("checks_did_not_cover_diff");
  });

  it("names an unknown changed-file list rather than assuming either way", () => {
    const packet = build({
      checks: [passingCheck],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.reasons).toContain("changed_files_unknown");
  });

  it("verifies a diff that a DERIVED check covered, and drops the superseded one", () => {
    // What the loop hands the packet after derivation: the declared repo-wide
    // check withdrawn as evidence (`skipped`), and the changed package's own
    // suite carrying the pass.
    const packet = build({
      checks: [
        { ...passingCheck, outcome: "skipped" as const },
        {
          name: "tests[apps/cli]",
          command: "npm run --prefix apps/cli test",
          outcome: "passed" as const,
          exitCode: 0,
          summary: "33 passed",
        },
      ],
      changedFiles: ["apps/cli/tests/crew.test.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffVerified).toBe(true);
    // A withdrawn check must not carry the "covered nothing" degradation any
    // more: a suite that CAN see the change ran and passed.
    expect(packet.degraded.reasons).not.toContain("checks_did_not_cover_diff");
    expect(renderHandoffPacketMarkdown(packet)).toContain(
      "[skipped] tests"
    );
  });

  it("refuses to verify a diff whose only checks were skipped", () => {
    const packet = build({
      checks: [{ ...passingCheck, outcome: "skipped" as const }],
      changedFiles: ["apps/cli/tests/crew.test.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffVerified).toBe(false);
    expect(packet.degraded.reasons).toContain("checks_did_not_cover_diff");
  });

  it("still verifies a real diff that a covering check passed on", () => {
    const packet = build({
      checks: [passingCheck],
      changedFiles: ["packages/protocol/src/handoff.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(packet.diffVerified).toBe(true);
    expect(packet.degraded.flag).toBe(false);
  });

  it("says in prose, on every surface, that the check covered nothing", () => {
    const packet = build({
      checks: [{ ...passingCheck, outcome: "passed-but-uncovering" as const }],
      changedFiles: ["apps/cli/tests/crew.test.ts"],
      diff: { hash: validHash, totalBytes: 900 },
    });

    expect(
      packet.checksStatus.some((line) =>
        line.includes("covered NONE of the changed files")
      )
    ).toBe(true);

    const markdown = renderHandoffPacketMarkdown(packet);
    expect(markdown).toContain("[passed-but-uncovering] tests");
    expect(markdown).toContain(
      "verified: false — no check covered the changed files"
    );
    expect(markdown.startsWith("> ⚠ DEGRADED:")).toBe(true);
  });

  it("explains an empty diff in the rendered evidence line", () => {
    const packet = build({
      checks: [passingCheck],
      changedFiles: [],
      diff: { hash: EMPTY_DIFF_SHA256, totalBytes: 0 },
    });

    expect(renderHandoffPacketMarkdown(packet)).toContain(
      "verified: false — the diff is EMPTY, so there was nothing to verify"
    );
  });
});
