import { terminalSafe } from "@muon/client";
import { INBOX_NAMED_QUESTIONS } from "../shell/inbox.js";
import type {
  BlockingQuestion,
  Lane,
  MuonApiClient,
  Task,
  TaskPriority,
  TaskStatus,
} from "@muon/client";

export type FormField = {
  id: string;
  label: string;
  required: boolean;
  /** Pre-filled from the current cockpit selection when available. */
  prefill?: string;
};

export type ActionForm = {
  commandId: string;
  title: string;
  fields: FormField[];
};

export type ActionContext = {
  selectedTask?: Task;
  selectedLane?: Lane;
  /**
   * OPEN blocking questions, in the order the inbox shows them (ADR-0043).
   *
   * The human picks by POSITION, not by id: the inbox already numbers them on
   * screen, and asking someone to retype a uuid to unblock an agent is how a
   * surface stays technically capable and practically unused.
   */
  openQuestions?: readonly BlockingQuestion[];
  /**
   * The dispatch job the crew drawer is highlighting, if any — the same
   * resolution `attachGoverned` uses, so a control acts on the agent the human
   * is looking at rather than one they had to name.
   */
  selectedJobId?: string;
  /** What that job is, for a form that must let a human confirm the target. */
  selectedJobLabel?: string;
};

const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "in_progress",
  "review",
  "done",
  "blocked",
];
const TASK_PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

/**
 * THE REGISTRY — one entry per command this desk can actually run, owning both
 * halves of it.
 *
 * There were three lists: `buildActionForm`'s switch (a dozen forms),
 * `executeAction`'s switch (four executors), and a hand-written
 * `EXECUTABLE_ACTIONS` naming which of those to offer. An adversarial review
 * made the point that this is the same manually-synchronised-set class the
 * repo keeps paying for: adding a command meant three edits staying aligned,
 * and the picker's "this command has no form" branch was REACHABLE, which is
 * proof that nothing enforced the alignment.
 *
 * Now an action is a pair — a form factory and an executor — written down
 * once. The picker's list is derived from it, so an entry cannot be offered
 * without an executor, and an executor cannot exist without a form. `label` is
 * what a human reads in the picker; the id stays the CLI's spelling so the two
 * surfaces name the same command.
 */
type ActionEntry = {
  readonly label: string;
  readonly form: (context: ActionContext) => ActionForm;
  readonly run: (
    client: MuonApiClient,
    values: Record<string, string>,
    context: ActionContext
  ) => Promise<ActionResult>;
};

export const ACTION_REGISTRY = {
  "task-new": {
    label: "task-new — create a task",
    form: (context: ActionContext) => ({
        commandId: "task-new",
        title: "Create task",
        fields: [
          { id: "title", label: "Title", required: true },
          { id: "description", label: "Description", required: true },
          {
            id: "priority",
            label: "Priority (low|medium|high)",
            required: false,
            prefill: "medium",
          },
          {
            id: "workspace",
            label: "Repo folder (where agents work)",
            required: false,
            prefill: process.cwd(),
          },
        ],
      }),
    run: async (client, values) => {
      const task = await client.createTask({
        title: values.title!.trim(),
        description: values.description!.trim(),
        priority: ((values.priority ?? "medium").trim() || "medium") as TaskPriority,
        workspacePath: (values.workspace ?? "").trim() || undefined,
      });
      return { ok: true, message: `Task created: ${task.id}` };
    },
  },
  run: {
    label: "run — dispatch a brief to a lane",
    form: (context: ActionContext) => ({
        commandId: "run",
        title: "Run task on lane",
        fields: [
          {
            id: "taskId",
            label: "Task id",
            required: true,
            prefill: context.selectedTask?.id,
          },
          {
            id: "laneKey",
            label: "Lane key",
            required: true,
            prefill: context.selectedLane?.key,
          },
          { id: "brief", label: "Brief", required: true },
        ],
      }),
    run: async (client, values) => {
      // Everything about HOW it runs — the role, the budgets, the workspace
      // fence, the cost cap — is resolved and enforced SERVER-SIDE at the
      // dispatch route, so this form stays three fields and cannot become a
      // place where governance is configured by whoever is typing.
      const lane = await resolveLaneByKey(client, values.laneKey!);
      const job = await client.enqueueDispatch({
        vendor: lane.key,
        taskId: values.taskId!.trim(),
        brief: values.brief!.trim(),
      });
      return {
        ok: true,
        message: `Dispatched ${job.id.slice(0, 8)} to ${lane.name}`,
      };
    },
  },
  assign: {
    label: "assign — give a task to a lane",
    form: (context: ActionContext) => ({
        commandId: "assign",
        title: "Assign task to lane",
        fields: [
          {
            id: "taskId",
            label: "Task id",
            required: true,
            prefill: context.selectedTask?.id,
          },
          {
            id: "laneKey",
            label: "Lane key",
            required: true,
            prefill: context.selectedLane?.key,
          },
          { id: "summary", label: "Brief summary", required: true },
        ],
      }),
    run: async (client, values) => {
      const lane = await resolveLaneByKey(client, values.laneKey!);
      await client.assignTask({
        taskId: values.taskId!.trim(),
        laneId: lane.id,
        summary: values.summary!.trim(),
      });
      return {
        ok: true,
        message: `Assigned ${values.taskId!.trim()} to ${lane.name}`,
      };
    },
  },
  answer: {
    label: "answer — answer an agent's blocking question",
    form: (context: ActionContext) => ({
      commandId: "answer",
      title:
        (context.openQuestions?.length ?? 0) > 0
          ? `Answer a blocked agent (${context.openQuestions!.length} waiting)`
          : "Answer a blocked agent (none waiting)",
      fields: [
        {
          id: "question",
          label: `Question # (1-${Math.min(context.openQuestions?.length ?? 1, INBOX_NAMED_QUESTIONS)}, as numbered in the inbox)`,
          required: true,
          // One waiting is the overwhelming case, and it is the one where a
          // human should not have to think at all.
          prefill: (context.openQuestions?.length ?? 0) > 0 ? "1" : undefined,
        },
        {
          id: "answer",
          label: "Your decision, in plain words",
          required: true,
        },
      ],
    }),
    run: async (client, values, context) => {
      const open = context.openQuestions ?? [];
      if (open.length === 0) {
        return {
          ok: false,
          message:
            "No agent is blocked on a question right now, so there is nothing to answer.",
        };
      }
      // BOUNDED BY WHAT THE RAIL NAMED, not by how many exist. Answering a
      // question the human could not see is answering blind, and the failure
      // it produces is telling the wrong agent the wrong thing. The rail says
      // "… N more, after these"; the way to reach those is to clear these.
      const pickable = Math.min(open.length, INBOX_NAMED_QUESTIONS);
      const index = Number(values.question!.trim());
      if (!Number.isInteger(index) || index < 1 || index > pickable) {
        // REFUSED rather than defaulted to the first: answering the wrong
        // agent's question is worse than answering none.
        return {
          ok: false,
          message:
            open.length > pickable
              ? `Pick a question between 1 and ${pickable} — those are the ones the inbox named. ${open.length - pickable} more follow once these are answered.`
              : `Pick a question between 1 and ${pickable} — '${values.question}' is not one of them.`,
        };
      }
      const question = open[index - 1]!;
      // The SAME governed payload the CLI and the desk send; answering confers
      // no authority (one operator-authored event, no receipt, no grant).
      const result = await client.answerQuestion({
        questionId: question.id,
        taskId: question.taskId,
        answer: values.answer!.trim(),
      });
      return result.answered
        ? {
            ok: true,
            message: `Answered ${terminalSafe(question.askedByVendor)}: ${terminalSafe(question.subject)}`,
          }
        : {
            ok: false,
            message:
              "That question is no longer open — it was answered or withdrawn somewhere else.",
          };
    },
  },
  "revoke-grants": {
    label: "revoke-grants — kill a job's live credential NOW",
    form: (context: ActionContext) => ({
      commandId: "revoke-grants",
      title: context.selectedJobLabel
        ? `Revoke the credential of ${context.selectedJobLabel}`
        : "Revoke a job's live credential",
      fields: [
        {
          id: "jobId",
          label: "Job id (highlight an agent in the crew drawer to prefill)",
          required: true,
          prefill: context.selectedJobId,
        },
      ],
    }),
    run: async (client, values) => {
      // TWO DIFFERENT ACTS, and the copy must not blur them: `interrupt` asks
      // the process to stop; this kills the identity it authenticates with.
      // A revoked job may still be running — it simply can no longer act as
      // itself against the brain.
      const result = await client.revokeDispatchGrants(values.jobId!.trim());
      return {
        ok: true,
        message: `Revoked ${result.revoked} grant(s) of ${result.jobId} — ${terminalSafe(result.note)}. The process may still be running; /interrupt stops it.`,
      };
    },
  },
  status: {
    label: "status — move a task's state",
    form: (context: ActionContext) => ({
        commandId: "status",
        title: "Update task status",
        fields: [
          {
            id: "taskId",
            label: "Task id",
            required: true,
            prefill: context.selectedTask?.id,
          },
          {
            id: "status",
            label: "Status (backlog|in_progress|review|done|blocked)",
            required: true,
            prefill: context.selectedTask?.status,
          },
        ],
      }),
    run: async (client, values) => {
      const task = await client.updateTaskStatus(
        values.taskId!.trim(),
        values.status!.trim() as TaskStatus
      );
      return { ok: true, message: `Task ${task.id} → ${task.status}` };
    },
  },
} as const satisfies Record<string, ActionEntry>;

export type ExecutableAction = keyof typeof ACTION_REGISTRY;

/** The picker's list, DERIVED — an entry cannot be offered without a runner. */
export const EXECUTABLE_ACTIONS = Object.keys(
  ACTION_REGISTRY
) as readonly ExecutableAction[];

export function isExecutableAction(id: string): id is ExecutableAction {
  return id in ACTION_REGISTRY;
}

/** The human-facing name of a command, for any surface that lists them. */
export function actionLabel(id: ExecutableAction): string {
  return ACTION_REGISTRY[id].label;
}

/**
 * A form for any command this desk knows, executable or not.
 *
 * The four the registry owns come FROM the registry — one definition, so a
 * command's form and its executor cannot drift apart. The rest are forms
 * without executors, kept because other surfaces build them; `executeAction`
 * refuses those by name rather than rendering one and failing after a human
 * has typed into it.
 */
export function buildActionForm(
  commandId: string,
  context: ActionContext
): ActionForm | null {
  if (isExecutableAction(commandId)) {
    return ACTION_REGISTRY[commandId].form(context);
  }
  switch (commandId) {
    case "memory-search":
      return {
        commandId,
        title: "Search memory",
        fields: [{ id: "query", label: "Query", required: true }],
      };
    case "context":
      // P6a, the pre-edit context gate: enter a symbol or file/module and MUON
      // fuses its blast-radius with confirmed memory + pending proposals to review.
      return {
        commandId,
        title: "Pre-edit context (Memory): confirmed memory + pending proposals",
        fields: [
          { id: "target", label: "Symbol or file/module to edit", required: true },
        ],
      };
    case "session-start":
      return {
        commandId,
        title: "Start interactive session (approvals go to the inbox)",
        fields: [
          {
            id: "taskId",
            label: "Task id",
            required: true,
            prefill: context.selectedTask?.id,
          },
          {
            id: "laneKey",
            label: "Lane key (claude-code|codex)",
            required: true,
            prefill: context.selectedLane?.key,
          },
          { id: "brief", label: "Brief", required: true },
        ],
      };
    case "session-send":
      return {
        commandId,
        title: "Steer the running session",
        fields: [{ id: "message", label: "Message", required: true }],
      };
    case "ship":
      return {
        commandId,
        title: "Ship review",
        fields: [
          {
            id: "taskId",
            label: "Task id",
            required: true,
            prefill: context.selectedTask?.id,
          },
          {
            id: "laneKey",
            label: "Lane that produced the work",
            required: true,
            prefill: context.selectedLane?.key,
          },
          {
            id: "check",
            label: "Check command",
            required: false,
            prefill: "npm test",
          },
        ],
      };
    case "plan":
      return {
        commandId,
        title: "Plan a request (dry-run; apply from the result)",
        fields: [{ id: "request", label: "What do you want done?", required: true }],
      };
    case "specialist":
      // Specialist factory (VISION §6.5): brief + harness + lane in one
      // action. The form creates the task, assigns the lane, and dispatches
      // with the harness overlay + memory slice applied.
      return {
        commandId,
        title: "Create specialist (task + harness + lane, one action)",
        fields: [
          { id: "title", label: "Task title", required: true },
          { id: "brief", label: "Brief", required: true },
          {
            id: "laneKey",
            label: "Lane key",
            required: true,
            prefill: context.selectedLane?.key,
          },
          {
            id: "harnessKey",
            label: "Harness (implement|review|security-audit|repair)",
            required: false,
            prefill: "implement",
          },
          {
            id: "workspace",
            label: "Repo folder (where the specialist works)",
            required: false,
            prefill: process.cwd(),
          },
        ],
      };
    case "memory-add":
      return {
        commandId,
        title: "Add memory note",
        fields: [
          {
            id: "kind",
            label: "Kind (decision|constraint|convention|attempt|question)",
            required: true,
            prefill: "decision",
          },
          { id: "text", label: "Note", required: true },
          {
            id: "taskId",
            label: "Anchor task id (optional)",
            required: false,
            prefill: context.selectedTask?.id,
          },
          { id: "module", label: "Anchor module/file (optional)", required: false },
        ],
      };
    default:
      return null;
  }
}

export type ActionResult = {
  ok: boolean;
  message: string;
};

export function validateFormValues(
  form: ActionForm,
  values: Record<string, string>
): string | null {
  for (const field of form.fields) {
    const value = (values[field.id] ?? "").trim();
    if (field.required && !value) {
      return `${field.label} is required`;
    }
  }
  if (form.commandId === "task-new") {
    const priority = (values.priority ?? "medium").trim() || "medium";
    if (!TASK_PRIORITIES.includes(priority as TaskPriority)) {
      return `Priority must be one of ${TASK_PRIORITIES.join("|")}`;
    }
  }
  if (form.commandId === "status") {
    const status = (values.status ?? "").trim();
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      return `Status must be one of ${TASK_STATUSES.join("|")}`;
    }
  }
  return null;
}

async function resolveLaneByKey(client: MuonApiClient, key: string): Promise<Lane> {
  const lanes = await client.listLanes();
  const lane = lanes.find((entry) => entry.key === key.trim());
  if (!lane) {
    // Stored lane keys, flattened — the same class already flattened in
    // `describeCapVerdict`. This message becomes a FORM error, which is a
    // larger and more modal surface than the status line.
    throw new Error(
      `Lane '${terminalSafe(key)}' not found. Available: ${lanes
        .map((l) => terminalSafe(l.key))
        .join(", ")}`
    );
  }
  return lane;
}

export async function executeAction(
  client: MuonApiClient,
  form: ActionForm,
  values: Record<string, string>,
  /** The same context the form was built from; an executor may need it to
   *  resolve what the human picked BY POSITION back to a record. */
  context: ActionContext = {}
): Promise<ActionResult> {
  const invalid = validateFormValues(form, values);
  if (invalid) {
    return { ok: false, message: invalid };
  }
  // THE REGISTRY DECIDES. There is no switch here to fall out of, so a form
  // this desk can build but not run cannot reach a human — the case that used
  // to answer "unknown action" after taking their input.
  if (!isExecutableAction(form.commandId)) {
    return {
      ok: false,
      message: `'${form.commandId}' cannot be run from here. This desk runs: ${EXECUTABLE_ACTIONS.join(", ")}.`,
    };
  }
  try {
    return await ACTION_REGISTRY[form.commandId].run(client, values, context);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Action failed",
    };
  }
}

export async function resolveApprovalAction(
  client: MuonApiClient,
  approvalId: string,
  decision: "approved" | "rejected",
  notes?: string,
  // P0.4: EXPLICIT operator opt-in — mint a content-bound, expiring receipt
  // alongside an approval. Absent = today's decision payload exactly.
  receiptTtlMs?: number,
  manualReview?: import("@muon/client").ManualReviewAttestation
): Promise<ActionResult> {
  try {
    const approval = await client.resolveApproval({
      approvalId,
      status: decision,
      decisionNotes: notes?.trim() || undefined,
      receipt:
        receiptTtlMs !== undefined && decision === "approved"
          ? { ttlMs: receiptTtlMs }
          : undefined,
      manualReview:
        decision === "approved" ? manualReview : undefined,
    });
    // P0.4 honesty: a receipt can SOFT-SKIP server-side (the action can't be
    // remembered). Report what the SERVER actually did (`receiptSkipped`), never
    // the client-side request flag — otherwise we affirm a receipt that was
    // never minted. Parity with the CLI + desktop.
    const requestedReceipt = receiptTtlMs !== undefined && decision === "approved";
    const receiptNote = !requestedReceipt
      ? ""
      : approval.receiptSkipped
        ? ` · no receipt minted — ${
            approval.receiptSkippedReason ?? "this action cannot be remembered"
          }`
        : " · receipt minted for this exact action";
    return {
      ok: true,
      message: `Approval ${approval.id} ${approval.status}${receiptNote}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Approval update failed",
    };
  }
}
