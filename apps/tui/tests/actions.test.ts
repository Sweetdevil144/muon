import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import { sessionSlug } from "@muon/client/session-slug";
import {
  buildActionForm,
  executeAction,
  resetArmedBudgetRaisesForTests,
  resolveApprovalAction,
  validateFormValues,
} from "../src/lib/actions.js";

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

const task = {
  id: "task-1",
  title: "Ship",
  description: "",
  status: "in_progress" as const,
  priority: "high" as const,
};

const lane = {
  id: "lane-1",
  key: "codex",
  name: "Codex",
  provider: "openai",
  role: "peer",
  status: "available",
};

describe("actions", () => {
  it("prefills assign form from cockpit selection", () => {
    const form = buildActionForm("assign", { selectedTask: task, selectedLane: lane });
    expect(form).not.toBeNull();
    expect(form!.fields.find((f) => f.id === "taskId")?.prefill).toBe("task-1");
    expect(form!.fields.find((f) => f.id === "laneKey")?.prefill).toBe("codex");
  });

  it("uses the approved product vocabulary in the pre-edit context form title", () => {
    const form = buildActionForm("context", {});
    expect(form).not.toBeNull();
    expect(form!.title).toBe(
      "Pre-edit context (Memory): confirmed memory + pending proposals"
    );
    expect(form!.title).not.toMatch(/brain/i);
    expect(form!.title).not.toMatch(/governed/i);
    expect(form!.title).not.toMatch(/fail-closed/i);
  });

  it("validates required fields and enum values", () => {
    const form = buildActionForm("status", {})!;
    expect(validateFormValues(form, { taskId: "", status: "review" })).toMatch(
      /required/
    );
    expect(validateFormValues(form, { taskId: "t1", status: "nope" })).toMatch(
      /Status must be/
    );
    expect(validateFormValues(form, { taskId: "t1", status: "done" })).toBeNull();
  });

  it("creates a task through the client", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        task: { id: "task-9", title: "T", description: "D", status: "backlog", priority: "high" },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("task-new", {})!;

    const result = await executeAction(client, form, {
      title: "T",
      description: "D",
      priority: "high",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("task-9");
  });

  it("resolves lane by key when assigning", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse({ assignment: { id: "a1" } }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("assign", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      summary: "do it",
    });

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/tasks/task-1/assignments",
      expect.objectContaining({ method: "POST" })
    );
  });

  // H10 — the line a human reads after dispatching. `Dispatched cmb4k2xw…` is
  // a coordinate nobody can say out loud or hold in their head for the ten
  // seconds before they go look at it. The slug leads; the id fragment stays
  // so the line is still greppable back to the job.
  it("confirms a dispatch by NAME, with the id fragment still on the line", async () => {
    const job = {
      id: "cmb4k2xw90003abcdefghijk",
      kind: "session",
      vendor: "codex",
      taskId: "task-1",
      brief: "do it",
      status: "queued",
      dispatchedBy: "human",
      interruptRequested: false,
      steerMessages: [],
      createdAt: "2026-08-17T09:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      // Parsed through the client's REAL dispatch schema, so this asserts the
      // shipped command output rather than a shape only the test believes in.
      .mockResolvedValueOnce(mockResponse({ job }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("run", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      brief: "do it",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain(sessionSlug(job.id));
    expect(result.message).toContain("(cmb4k2xw)");
    expect(result.message).toContain("to Codex");
  });

  // ADR-0044/0071 — the fork's DESK surface. The form prefills the crew
  // drawer's highlighted job (act on what you are looking at), the executor
  // rides the client's real forkMission parse, and a server refusal — the
  // latest-settled-step guard, a live source, a vanished worktree — reaches
  // the human verbatim rather than as a generic failure.
  // 0087 retirement-ledger row B17/G13: `budget` renders the usage with
  // what qualifies it (ADR-0036 D1 — never a bare number) and keeps the
  // classic overlay's TWO-PRESS raise in form shape: first submit arms,
  // second (confirm=yes) performs the raise-only call.
  it("budget: view renders qualified figures; a raise takes two presses through the real client", async () => {
    resetArmedBudgetRaisesForTests();
    const budget = {
      jobId: "cmb4budgetjob0001abcdefgh",
      rootWallMs: 1_800_000,
      maxDescendantWallMs: 4_800_000,
      poolMs: 4_800_000,
      reservedMs: 480_000,
      consumedMs: 720_000,
      remainingMs: 3_600_000,
      deadlineAt: null,
      childrenIssued: 2,
      maxChildren: 4,
      descendantsIssued: 5,
      maxDescendants: 12,
      depth: 1,
      maxDepth: 4,
      children: [],
    };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return mockResponse({
          budget: { ...budget, poolMs: 6_000_000, remainingMs: 4_800_000 },
        });
      }
      return mockResponse({ budget });
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("budget", {
      selectedJobId: "cmb4budgetjob0001abcdefgh",
    })!;
    expect(form.fields.find((f) => f.id === "jobId")?.prefill).toBe(
      "cmb4budgetjob0001abcdefgh"
    );

    const view = await executeAction(client, form, {
      jobId: "cmb4budgetjob0001abcdefgh",
    });
    expect(view.ok).toBe(true);
    expect(view.message).toContain("Pool 80m");
    expect(view.message).toContain("12m consumed");
    expect(view.message).toContain("60m remaining");
    expect(view.message).toContain("depth 1/4");
    expect(view.message).toContain("descendants 5/12");

    // First press with a raise value ARMS — nothing was raised — and a
    // confirm typed on the FIRST press still only arms (the two-press rule
    // cannot be bypassed in one submission; review finding).
    const bypass = await executeAction(client, form, {
      jobId: "cmb4budgetjob0001abcdefgh",
      raiseToMinutes: "90",
      confirm: "yes",
    });
    expect(bypass.ok).toBe(false);
    expect(bypass.message).toContain("ARMED, nothing raised");
    const armed = await executeAction(client, form, {
      jobId: "cmb4budgetjob0001abcdefgh",
      raiseToMinutes: "100",
    });
    expect(armed.ok).toBe(false);
    expect(armed.message).toContain("ARMED, nothing raised");
    expect(armed.message).toContain("confirm=yes");
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")
    ).toHaveLength(0);

    // A STALE arm does not redeem: past the TTL the confirm re-arms.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now());
      await executeAction(client, form, {
        jobId: "cmb4budgetjob0001abcdefgh",
        raiseToMinutes: "70",
      });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const stale = await executeAction(client, form, {
        jobId: "cmb4budgetjob0001abcdefgh",
        raiseToMinutes: "70",
        confirm: "yes",
      });
      expect(stale.ok).toBe(false);
      expect(stale.message).toContain("ARMED, nothing raised");
    } finally {
      vi.useRealTimers();
    }

    // Second press performs the raise through the real client parse.
    const raised = await executeAction(client, form, {
      jobId: "cmb4budgetjob0001abcdefgh",
      raiseToMinutes: "100",
      confirm: "yes",
    });
    expect(raised.ok).toBe(true);
    expect(raised.message).toContain("now 100m");
    const patch = fetcher.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    );
    expect(String(patch![0])).toContain(
      "/api/dispatch/cmb4budgetjob0001abcdefgh/budget"
    );
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body).toEqual({ maxDescendantWallMs: 6_000_000 });
  });

  // 0087 retirement-ledger row M2: `plan` stores a proposal through the
  // SAME seam as the classic desk's /plan — heuristic proposal, lane
  // suggestions per step, createWorkflowRun — and NOTHING runs; the
  // confirmation names the exact executable apply command.
  it("plan: stores a heuristic proposal through the real client parse; nothing runs", async () => {
    const proposal = {
      summary: "add retries to the fetcher",
      steps: [
        {
          stepKey: "task-1",
          title: "add retries to the fetcher",
          brief: "whatever the heuristic wrote",
          role: "suggest",
          priority: "medium",
        },
      ],
    };
    const storedRun = {
      id: "cmb4planrun0001abcdefghij",
      request: "add retries to the fetcher",
      workspacePath: "/repo",
      proposal,
      status: "proposed",
      proposedBy: "heuristic",
      createdAt: "2026-08-22T09:00:00.000Z",
      updatedAt: "2026-08-22T09:00:00.000Z",
    };
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes("/api/routing/suggest")) {
        return mockResponse({ suggestions: [] });
      }
      return mockResponse({ run: storedRun });
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("plan", {})!;
    expect(form.title).toContain("nothing runs");

    const result = await executeAction(client, form, {
      request: "add retries to the fetcher",
      workspace: "/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("nothing ran");
    expect(result.message).toContain(
      "muon workflow apply --run-id cmb4planrun0001abcdefghij"
    );
    const runCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/api/workflow-runs")
    );
    expect(runCall).toBeTruthy();
    const body = JSON.parse((runCall![1] as RequestInit).body as string);
    expect(body.request).toBe("add retries to the fetcher");
    expect(body.workspacePath).toBe("/repo");
    expect(body.proposedBy).toBe("heuristic");
    expect(Array.isArray(body.proposal.steps)).toBe(true);
    expect(body.proposal.steps.length).toBeGreaterThan(0);
  });

  it("plan: the store route's refusal surfaces verbatim, and no apply is implied", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes("/api/routing/suggest")) {
        return mockResponse({ suggestions: [] });
      }
      return mockResponse(
        { message: "workspacePath is outside the allowed roots" },
        400
      );
    });
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("plan", {})!;
    const result = await executeAction(client, form, {
      request: "do a thing",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("outside the allowed roots");
  });

  it("forks a settled job into a new mission through the real client parse", async () => {
    const rootJob = {
      id: "cmb4forkroot0003abcdefghi",
      kind: "session",
      vendor: "codex",
      taskId: "task-fork-1",
      brief: "explore the alternative",
      status: "queued",
      dispatchedBy: "human",
      interruptRequested: false,
      steerMessages: [],
      createdAt: "2026-08-22T09:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(
        mockResponse({
          chat: { id: "chat-fork-1", title: "Alt exploration" },
          task: { id: "task-fork-1", title: "Chat, Alt exploration" },
          job: rootJob,
          forkedFromJobId: "cmb4sourcejob0001abcdefgh",
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("fork", {
      selectedJobId: "cmb4sourcejob0001abcdefgh",
      selectedLane: lane,
    })!;
    expect(
      form.fields.find((field) => field.id === "sourceJobId")?.prefill
    ).toBe("cmb4sourcejob0001abcdefgh");

    const result = await executeAction(client, form, {
      sourceJobId: "cmb4sourcejob0001abcdefgh",
      brief: "explore the alternative",
      laneKey: "codex",
      title: "Alt exploration",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain(sessionSlug(rootJob.id));
    expect(result.message).toContain('"Alt exploration"');
    expect(result.message).toContain("on Codex");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/dispatch/fork",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(
      (fetcher.mock.calls[1]![1] as RequestInit).body as string
    );
    expect(body).toEqual({
      sourceJobId: "cmb4sourcejob0001abcdefgh",
      brief: "explore the alternative",
      vendor: "codex",
      title: "Alt exploration",
    });
  });

  it("surfaces the fork route's own refusal verbatim", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(
        mockResponse(
          {
            message:
              "sourceJobId 'job-x' is not the task's latest settled step — later or live work has since reshaped its worktree, and the ledger holds only the latest recorded state. Fork the task's most recent settled job instead.",
          },
          409
        )
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("fork", {})!;
    const result = await executeAction(client, form, {
      sourceJobId: "job-x",
      brief: "no",
      laneKey: "codex",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("latest settled step");
  });

  // 0046 D4 port (parity row M4): specialist reaches the same governed seam
  // — harness validated BY NAME before any task exists, then task + governed
  // enqueue with the harness key. The confirmation says QUEUED, never "ran".
  it("specialist: validates the harness first, then creates the task and queues the governed dispatch", async () => {
    const harness = {
      id: "h1",
      key: "implement",
      name: "Implement",
      config: { description: "", profileOverlay: {}, checks: [] },
      version: 1,
      createdBy: "human:carol",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const job = {
      id: "cmb4specjob0001abcdefghij",
      kind: "session",
      vendor: "codex",
      taskId: "task-spec-1",
      brief: "build the thing",
      status: "queued",
      dispatchedBy: "human",
      interruptRequested: false,
      steerMessages: [],
      createdAt: "2026-08-22T09:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse({ harness }))
      .mockResolvedValueOnce(
        mockResponse({ task: { ...task, id: "task-spec-1" } })
      )
      .mockResolvedValueOnce(mockResponse({ assignment: { id: "a-spec-1" } }))
      .mockResolvedValueOnce(mockResponse({ job }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("specialist", { selectedLane: lane })!;
    const result = await executeAction(client, form, {
      title: "Build it",
      brief: "build the thing",
      laneKey: "codex",
      harnessKey: "implement",
      workspace: "/tmp/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Specialist queued");
    expect(result.message).toContain("task-spec-1");
    expect(result.message).toContain("(+implement)");
    expect(fetcher.mock.calls[1]![0]).toBe(
      "http://localhost:4000/api/harnesses/implement"
    );
    // The lane ASSIGNMENT lands before the dispatch (classic-path parity).
    expect(fetcher.mock.calls[3]![0]).toBe(
      "http://localhost:4000/api/tasks/task-spec-1/assignments"
    );
    const dispatchBody = JSON.parse(
      (fetcher.mock.calls[4]![1] as RequestInit).body as string
    );
    expect(dispatchBody).toMatchObject({
      vendor: "codex",
      taskId: "task-spec-1",
      harnessKey: "implement",
      workspacePath: "/tmp/repo",
    });
  });

  it("specialist: an unknown harness refuses BEFORE any task exists", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse({ message: "not found" }, 404));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("specialist", {})!;
    const result = await executeAction(client, form, {
      title: "Build it",
      brief: "build the thing",
      laneKey: "codex",
      harnessKey: "no-such-harness",
    });
    expect(result.ok).toBe(false);
    // Two calls only: lanes + the harness read. No task, no dispatch.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports unknown lane keys without mutating", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ lanes: [lane] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("assign", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "claude",
      summary: "do it",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("approves the selected request", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "ap-1",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "command",
          reason: "run",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await resolveApprovalAction(client, "ap-1", "approved");

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/approvals/ap-1",
      expect.objectContaining({ method: "PATCH" })
    );
    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body).not.toHaveProperty("receipt");
  });

  it("rides the explicit receipt TTL on an opted-in approval", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "ap-1",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "command",
          reason: "run",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await resolveApprovalAction(
      client,
      "ap-1",
      "approved",
      undefined,
      900_000
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.receipt).toEqual({ ttlMs: 900_000 });
    // Server minted it (no skip flag) → the message affirms the receipt.
    expect(result.message).toContain("receipt minted for this exact action");
  });

  it("reports an HONEST 'no receipt minted' when the server soft-skips the receipt", async () => {
    // P0.4: the operator asked to remember, but the action can't be remembered.
    // The message must read the server's `receiptSkipped`, never the client-side
    // request flag — otherwise it affirms a receipt that was never minted.
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        // The soft-skip signal is a TOP-LEVEL sibling of `approval` on the wire.
        approval: {
          id: "ap-1",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "command",
          reason: "run",
          status: "approved",
        },
        receiptSkipped: true,
        receiptSkippedReason: "network actions cannot be remembered",
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await resolveApprovalAction(
      client,
      "ap-1",
      "approved",
      undefined,
      900_000
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("no receipt minted");
    expect(result.message).toContain("network actions cannot be remembered");
    expect(result.message).not.toContain("receipt minted for this exact action");
  });

  it("rides an explicit REVIEW BLIND attestation on a merge approval", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({
        approval: {
          id: "ap-merge",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "merge",
          reason: "ship review passed",
          status: "approved",
        },
      })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const result = await resolveApprovalAction(
      client,
      "ap-merge",
      "approved",
      undefined,
      undefined,
      {
        acknowledged: true,
        artifactDigest: "c".repeat(64),
        blindFiles: ["src/new.ts"],
      }
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body.manualReview).toEqual({
      acknowledged: true,
      artifactDigest: "c".repeat(64),
      blindFiles: ["src/new.ts"],
    });
  });
});

describe("/answer — unblocking an agent from the terminal", () => {
  /**
   * The audit's item 1 asked for the questions inbox on the desk AND the TUI.
   * The TUI showed them and pointed the human at another surface, so the one
   * thing that blocks a whole crew was the one thing the hero surface could
   * not do.
   */
  const questions = [
    {
      id: "q-1",
      taskId: "task-9",
      subject: "which retry cap?",
      body: "30s or 60s",
      askedByVendor: "codex",
      askedAt: "2026-08-11T00:00:00.000Z",
    },
    {
      id: "q-2",
      taskId: "task-4",
      subject: "drop the column?",
      body: "it is unused",
      askedByVendor: "claude-code",
      askedAt: "2026-08-11T00:01:00.000Z",
    },
  ] as never;

  it("answers the question the human NUMBERED, not the first one", async () => {
    // The ROUTE's shape, not the client's return shape: mocking `{answered}`
    // here passed the executor and failed the client's own parse.
    const fetcher = vi.fn(async () =>
      mockResponse({ question: { id: "q-2", status: "answered" } })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("answer", { openQuestions: questions })!;
    const result = await executeAction(
      client,
      form,
      { question: "2", answer: "yes, drop it" },
      { openQuestions: questions }
    );
    expect(result.ok).toBe(true);
    // Answering the wrong agent's question is the failure this guards, and the
    // question id rides the URL while the task and the answer ride the body.
    const [url, init] = fetcher.mock.calls[0] as [string, { body: string }];
    expect(url).toContain("/api/questions/q-2/answer");
    expect(JSON.parse(init.body)).toMatchObject({
      taskId: "task-4",
      answer: "yes, drop it",
    });
  });

  it("REFUSES an out-of-range pick rather than defaulting to the first", async () => {
    const fetcher = vi.fn();
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("answer", { openQuestions: questions })!;
    const result = await executeAction(
      client,
      form,
      { question: "7", answer: "…" },
      { openQuestions: questions }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/between 1 and 2/);
    expect(fetcher, "a mis-picked answer never reaches the brain").not.toHaveBeenCalled();
  });

  it("says nothing is waiting rather than failing obscurely", async () => {
    const client = new MuonApiClient("http://localhost:4000", vi.fn());
    const form = buildActionForm("answer", { openQuestions: [] })!;
    const result = await executeAction(
      client,
      form,
      { question: "1", answer: "…" },
      { openQuestions: [] }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No agent is blocked/);
  });

  it("reports a question that closed elsewhere instead of claiming success", async () => {
    const client = new MuonApiClient(
      "http://localhost:4000",
      vi.fn(async () => mockResponse({ question: null }))
    );
    const form = buildActionForm("answer", { openQuestions: questions })!;
    const result = await executeAction(
      client,
      form,
      { question: "1", answer: "30s" },
      { openQuestions: questions }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no longer open/);
  });

  it("prefills the only question, so one waiting needs no thought", () => {
    const form = buildActionForm("answer", {
      openQuestions: [questions[0]!],
    })!;
    expect(form.fields.find((field) => field.id === "question")?.prefill).toBe(
      "1"
    );
    expect(form.title).toMatch(/1 waiting/);
  });
});

describe("/revoke-grants — killing a credential from the terminal", () => {
  /**
   * The audit claimed the desk had this and the TUI did not. Neither did: it
   * was CLI-only on both surfaces. It is the control an operator reaches for
   * when an agent must stop being able to act as itself RIGHT NOW, which is
   * not the same act as interrupting it.
   */
  it("targets the highlighted agent's job without retyping an id", () => {
    const form = buildActionForm("revoke-grants", {
      selectedJobId: "job-77",
      selectedJobLabel: "codex-2",
    })!;
    expect(form.fields[0]!.prefill).toBe("job-77");
    expect(form.title).toContain("codex-2");
  });

  it("says the process may still be running — revoke is not interrupt", async () => {
    const client = new MuonApiClient(
      "http://localhost:4000",
      vi.fn(async () =>
        mockResponse({ jobId: "job-77", revoked: 2, note: "identity killed" })
      )
    );
    const form = buildActionForm("revoke-grants", {})!;
    const result = await executeAction(client, form, { jobId: "job-77" });
    expect(result.ok).toBe(true);
    // Blurring the two is how an operator believes a job stopped when it did
    // not, and walks away.
    expect(result.message).toMatch(/may still be running/);
    expect(result.message).toMatch(/Revoked 2 grant/);
  });

  it("refuses an empty target rather than posting to a bare route", async () => {
    const fetcher = vi.fn();
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("revoke-grants", {})!;
    const result = await executeAction(client, form, { jobId: "" });
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("/answer never answers a question the rail did not name", () => {
  const many = Array.from({ length: 6 }, (_unused, index) => ({
    id: `q-${index + 1}`,
    taskId: `task-${index + 1}`,
    subject: `question ${index + 1}`,
    body: "…",
    askedByVendor: "codex",
    askedAt: "2026-08-11T00:00:00.000Z",
  })) as never;

  it("refuses a pick beyond the three the inbox showed", async () => {
    const fetcher = vi.fn();
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("answer", { openQuestions: many })!;
    const result = await executeAction(
      client,
      form,
      { question: "4", answer: "…" },
      { openQuestions: many }
    );
    // Answering blind is the failure: the human cannot know what #4 asks.
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/between 1 and 3/);
    expect(result.message).toMatch(/3 more follow/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says the range on the field, so the bound is visible before typing", () => {
    const form = buildActionForm("answer", { openQuestions: many })!;
    expect(form.fields[0]!.label).toContain("1-3");
  });
});

/**
 * ROADMAP H13 — the two commands ported off the sixteen refusals.
 *
 * Both had a form and no runner, so every desk that derives its offer from
 * the registry could draw them and not run them. These pin that the runner
 * reaches the SAME governed call the classic desk and the CLI make, and — for
 * `ship` — that porting it moved no authority: it FILES a merge gate and
 * cannot answer one.
 */
describe("memory-add — a proposal, never a confirmation", () => {
  const noteRow = (over: Record<string, unknown> = {}) => ({
    id: "note-1",
    kind: "decision",
    text: "we ship the gate first",
    modules: ["src/lib/actions.ts"],
    topics: [],
    symbols: [],
    trust: "medium",
    confirmed: false,
    stale: false,
    status: "active",
    createdBy: "human",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...over,
  });

  it("writes through the client with the SAME payload the CLI sends", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ note: noteRow() }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("memory-add", {})!;

    const result = await executeAction(client, form, {
      kind: "decision",
      text: "  we ship the gate first  ",
      taskId: " task-1 ",
      module: " src/lib/actions.ts ",
    });

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:4000/api/memory",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body).toEqual({
      kind: "decision",
      text: "we ship the gate first",
      taskId: "task-1",
      modules: ["src/lib/actions.ts"],
      createdBy: "human",
    });
  });

  it("omits the optional anchors instead of sending empty ones", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ note: noteRow() }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("memory-add", {})!;

    await executeAction(client, form, {
      kind: "constraint",
      text: "no shell operators in a check command",
      taskId: "   ",
      module: "",
    });

    const body = JSON.parse(
      (fetcher.mock.calls[0]![1] as { body: string }).body
    );
    expect(body).not.toHaveProperty("taskId");
    expect(body.modules).toEqual([]);
  });

  it("REPORTS the trust state the brain answered with, never the one it hoped for", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ note: noteRow() }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("memory-add", {})!;

    const result = await executeAction(client, form, {
      kind: "decision",
      text: "t",
    });
    expect(result.message).toContain("UNCONFIRMED");

    const confirmedFetcher = vi
      .fn()
      .mockResolvedValue(mockResponse({ note: noteRow({ confirmed: true }) }));
    const confirmed = await executeAction(
      new MuonApiClient("http://localhost:4000", confirmedFetcher),
      form,
      { kind: "decision", text: "t" }
    );
    expect(confirmed.message).toContain("confirmed");
    expect(confirmed.message).not.toContain("UNCONFIRMED");
  });

  it("refuses a kind the ledger does not have, before any write", async () => {
    const fetcher = vi.fn();
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("memory-add", {})!;

    const result = await executeAction(client, form, {
      kind: "vibes",
      text: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Kind must be one of/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("ship — files the merge gate, and cannot answer it", () => {
  const taskDetail = (over: Record<string, unknown> = {}) => ({
    task: {
      id: "task-1",
      title: "Ship",
      description: "",
      status: "in_progress",
      priority: "high",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      assignments: [],
      handoffs: [],
      approvals: [],
      ...over,
    },
  });

  it("runs the check, records the outcome, then files a kind:merge approval", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse(taskDetail()))
      .mockResolvedValueOnce(
        mockResponse({
          event: {
            id: "ev-1",
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.completed",
            message: "ship review",
            metadata: {},
            timestamp: "2026-08-17T00:00:00.000Z",
          },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          approval: {
            id: "ap-77",
            taskId: "task-1",
            requestedBy: "codex",
            kind: "merge",
            reason: "ship review passed",
            status: "pending",
          },
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("ship", {})!;

    // `true` is a real binary that exits 0 — the check genuinely spawns, so
    // this exercises the no-shell argv path rather than a stubbed promise.
    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      check: "true",
    });

    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain("ap-77");
    const posts = fetcher.mock.calls.map((call) => call[0] as string);
    expect(posts).toContain("http://localhost:4000/api/tasks/task-1");
    expect(posts).toContain("http://localhost:4000/api/approvals");
    const approvalCall = fetcher.mock.calls.find(
      (call) => call[0] === "http://localhost:4000/api/approvals"
    )!;
    const body = JSON.parse((approvalCall[1] as { body: string }).body);
    expect(body.kind).toBe("merge");
    expect(body.taskId).toBe("task-1");
    // FILED, not decided: nothing here carries a status, a decision or a
    // receipt. The gate is answered in the inbox, on evidence, by a human.
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("decisionNotes");
    // ...and no PATCH — the verb that resolves an approval — was ever sent.
    for (const call of fetcher.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).not.toBe(
        "PATCH"
      );
    }
  });

  it("FILES NOTHING when the check fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse(taskDetail()))
      .mockResolvedValueOnce(
        mockResponse({
          event: {
            id: "ev-1",
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.blocked",
            message: "ship review",
            metadata: {},
            timestamp: "2026-08-17T00:00:00.000Z",
          },
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("ship", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      check: "false",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("ship checks failed");
    expect(
      fetcher.mock.calls.some((call) => call[0] === "http://localhost:4000/api/approvals")
    ).toBe(false);
  });

  it("runs the check in the TASK's workspace, not the desk's cwd", async () => {
    // A gate that attests to a check run against a different tree attests to
    // nothing. The classic desk resolves the same path from its snapshot.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(
        mockResponse(taskDetail({ workspacePath: "/nonexistent-workspace" }))
      )
      .mockResolvedValueOnce(
        mockResponse({
          event: {
            id: "ev-1",
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.blocked",
            message: "ship review",
            metadata: {},
            timestamp: "2026-08-17T00:00:00.000Z",
          },
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("ship", {})!;

    // `true` exits 0 anywhere it can start. Spawning it into a directory that
    // does not exist is the observable proof that the cwd came from the task
    // record rather than from this process — the check is reported FAILED for
    // a command that cannot fail on its own.
    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      check: "true",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("FAIL true");
    expect(
      fetcher.mock.calls.some((call) => call[0] === "http://localhost:4000/api/approvals")
    ).toBe(false);
  });

  it("refuses a check command that needs a shell, and files nothing", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(mockResponse(taskDetail()))
      .mockResolvedValueOnce(
        mockResponse({
          event: {
            id: "ev-1",
            laneId: "lane-1",
            taskId: "task-1",
            kind: "task.blocked",
            message: "ship review",
            metadata: {},
            timestamp: "2026-08-17T00:00:00.000Z",
          },
        })
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("ship", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "codex",
      check: "true; rm -rf /",
    });

    expect(result.ok).toBe(false);
    // Refused by `parseCheckCommand` BEFORE a process existed — the metachar
    // was never handed to a shell, because no shell is in the path at all.
    expect(result.message).toMatch(/shell operator/);
    expect(
      fetcher.mock.calls.some((call) => call[0] === "http://localhost:4000/api/approvals")
    ).toBe(false);
  });

  it("stops at an unknown lane without spawning or filing anything", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockResponse({ lanes: [lane] }));
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("ship", {})!;

    const result = await executeAction(client, form, {
      taskId: "task-1",
      laneKey: "not-a-lane",
      check: "true",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// The review finding on the specialist port: a dispatch refusal after the
// task exists must NAME the kept task and the retry that does not duplicate
// it — never a bare error over a silent orphan.
describe("specialist dispatch refusal", () => {
  it("names the KEPT task and the non-duplicating retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ lanes: [lane] }))
      .mockResolvedValueOnce(
        mockResponse({
          harness: {
            id: "h1",
            key: "implement",
            name: "Implement",
            config: { description: "", profileOverlay: {}, checks: [] },
            version: 1,
            createdBy: "human:carol",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({ task: { ...task, id: "task-kept-1" } })
      )
      .mockResolvedValueOnce(mockResponse({ assignment: { id: "a-kept-1" } }))
      .mockResolvedValueOnce(
        mockResponse({ message: "workspacePath resolves outside the allowed roots" }, 400)
      );
    const client = new MuonApiClient("http://localhost:4000", fetcher);
    const form = buildActionForm("specialist", {})!;
    const result = await executeAction(client, form, {
      title: "Build it",
      brief: "build the thing",
      laneKey: "codex",
      harnessKey: "implement",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("task-kept-1");
    expect(result.message).toContain("KEPT");
    expect(result.message).toContain("'run'");
    expect(result.message).toContain("lane codex");
    expect(result.message).toContain("ASSIGNED to codex");
    // The advised retry can REPRODUCE the configuration: the refusal names
    // the harness so the human re-enters it on run's optional field.
    expect(result.message).toContain("harness 'implement'");
  });
});
