import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "@muon/client";
import {
  buildActionForm,
  executeAction,
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
