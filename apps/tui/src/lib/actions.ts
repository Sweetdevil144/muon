import { buildApprovalDecision, terminalSafe } from "@muon/client";
// H10 — the ONE session-slug projection, via the same client subpath every
// other surface uses. Identity stays the id; this only makes the confirmation
// sayable out loud.
import { sessionSlug } from "@muon/client/session-slug";
import { heuristicWorkflowProposal } from "@muon/core";
import { INBOX_NAMED_QUESTIONS } from "../shell/inbox.js";
import { runShipReview } from "./ship.js";
import type {
  BlockingQuestion,
  Lane,
  MemoryKind,
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
/** The ledger's own vocabulary. Validated HERE rather than cast at the call
 *  site, which is what the classic desk did — a typo'd kind used to reach the
 *  brain as a string the schema then rejected, after the human had typed the
 *  note. Same shape as the CLI's `kindSchema`. */
const MEMORY_KINDS: MemoryKind[] = [
  "decision",
  "constraint",
  "convention",
  "attempt",
  "question",
  "ownership",
];
/** What `ship` runs when the human leaves the check field empty. */
const DEFAULT_SHIP_CHECK = "npm test";

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
          // Optional pass-throughs so `run` can REPRODUCE a specialist
          // dispatch exactly (review finding: the refusal's advised retry
          // could not carry the harness or workspace, silently changing the
          // governed configuration). Both resolve and enforce server-side.
          { id: "harnessKey", label: "Harness (optional)", required: false },
          {
            id: "workspace",
            label: "Repo folder (optional)",
            required: false,
          },
        ],
      }),
    run: async (client, values) => {
      // Everything about HOW it runs — the role, the budgets, the workspace
      // fence, the cost cap — is resolved and enforced SERVER-SIDE at the
      // dispatch route, so this form stays thin and cannot become a place
      // where governance is configured by whoever is typing.
      const lane = await resolveLaneByKey(client, values.laneKey!);
      const harnessKey = (values.harnessKey ?? "").trim();
      const workspace = (values.workspace ?? "").trim();
      const job = await client.enqueueDispatch({
        vendor: lane.key,
        taskId: values.taskId!.trim(),
        brief: values.brief!.trim(),
        ...(harnessKey ? { harnessKey } : {}),
        ...(workspace ? { workspacePath: workspace } : {}),
      });
      return {
        ok: true,
        message: `Dispatched ${sessionSlug(job.id)} (${job.id.slice(
          0,
          8
        )}) to ${lane.name}`,
      };
    },
  },
  budget: {
    label: "budget — mission usage, and a two-press descendant-pool raise",
    // The classic overlay's arm state, kept where it always lived: in the
    // UI process. Keyed by resolved root + amount so the SECOND press must
    // repeat exactly what the first press armed (review finding: a
    // confirm typed on the first submit performed an authority-changing
    // raise in one press).
    // eslint-disable-next-line no-underscore-dangle
    form: (context: ActionContext) => ({
      commandId: "budget",
      title: "Mission budget (view; a raise takes two presses)",
      fields: [
        {
          id: "jobId",
          label: "Root job id",
          required: true,
          prefill: context.selectedJobId,
        },
        {
          id: "raiseToMinutes",
          label: "Raise descendant pool to (minutes; empty = view only)",
          required: false,
        },
        {
          id: "confirm",
          label: "Type yes to confirm a raise (second press)",
          required: false,
        },
      ],
    }),
    run: async (client, values) => {
      // 0046 D4 port (retirement ledger row B17/G13). ADR-0036 D1: never a
      // bare number — the figures render with what qualifies them. The
      // RAISE keeps the classic overlay's two-press rule in form shape:
      // the first submit ARMS (returns the exact re-submit), the second —
      // with confirm=yes — performs the raise-only, ceiling-bounded call.
      const jobId = values.jobId!.trim();
      const raiseRaw = (values.raiseToMinutes ?? "").trim();
      const minutes = (ms: number) => Math.round(ms / 60_000);
      if (!raiseRaw) {
        const budget = await client.getDispatchBudget(jobId);
        const depth =
          budget.maxDepth === null
            ? `depth ${budget.depth} (no cap)`
            : `depth ${budget.depth}/${budget.maxDepth}`;
        const descendants =
          budget.maxDescendants === null
            ? `${budget.descendantsIssued} descendants (no cap)`
            : `descendants ${budget.descendantsIssued}/${budget.maxDescendants}`;
        return {
          ok: true,
          message: `Pool ${minutes(budget.poolMs)}m: ${minutes(
            budget.consumedMs
          )}m consumed, ${minutes(budget.reservedMs)}m reserved, ${minutes(
            budget.remainingMs
          )}m remaining · ${depth} · ${descendants}`,
        };
      }
      const parsedMinutes = Number(raiseRaw);
      if (!Number.isFinite(parsedMinutes) || parsedMinutes <= 0) {
        return {
          ok: false,
          message: `'${raiseRaw}' is not a positive number of minutes.`,
        };
      }
      // The raise must target the mission ROOT: reads resolve a descendant
      // to its mission, so the read's own jobId is the raise coordinate
      // (review finding: raising by the selected descendant id refused).
      const current = await client.getDispatchBudget(jobId);
      const rootJobId = current.jobId;
      const armKey = `${rootJobId}:${parsedMinutes}`;
      const confirmed = (values.confirm ?? "").trim().toLowerCase() === "yes";
      const armedAt = armedBudgetRaises.get(armKey);
      const armLive =
        armedAt !== undefined && Date.now() - armedAt < ARMED_RAISE_TTL_MS;
      if (!confirmed || !armLive) {
        armedBudgetRaises.set(armKey, Date.now());
        return {
          ok: false,
          message: `ARMED, nothing raised: re-submit with confirm=yes to raise the descendant pool to ${parsedMinutes}m${
            rootJobId === jobId ? "" : ` on root ${rootJobId.slice(0, 8)}`
          } (two presses always — a confirm on the first press only arms; raise-only, the server enforces its ceiling).`,
        };
      }
      armedBudgetRaises.delete(armKey);
      const budget = await client.raiseDispatchBudget(rootJobId, {
        maxDescendantWallMs: Math.round(parsedMinutes * 60_000),
      });
      return {
        ok: true,
        message: `Descendant pool raised: now ${minutes(
          budget.poolMs
        )}m (${minutes(budget.remainingMs)}m remaining).`,
      };
    },
  },
  "return-session": {
    label: "return-session — hand a taken-over session back to MUON",
    form: () => ({
      commandId: "return-session",
      title: "Return a session (reports the worktree's dirty state)",
      fields: [
        {
          id: "sessionId",
          label: "Session id (empty = the latest session you own)",
          required: false,
        },
      ],
    }),
    run: async (client, values) => {
      // 0046 D4 port (retirement ledger row M16, one family with M15).
      let sessionId = (values.sessionId ?? "").trim();
      if (!sessionId) {
        const { latestOwnedByHuman } = await import(
          "../lib/take-over.js"
        );
        const sessions = await client.listSessions();
        const owned = latestOwnedByHuman(sessions);
        if (!owned) {
          return {
            ok: false,
            message:
              "no session is currently owned by you — take-over grants one first",
          };
        }
        sessionId = owned.id;
      }
      const result = await client.returnSession(sessionId);
      // `alreadyOwned: true` from the RETURN route means the session was
      // NOT human-owned — nothing was released and nothing was inspected
      // (review finding: the first copy claimed a record that never
      // happened, with the condition inverted on top).
      if (result.alreadyOwned) {
        return {
          ok: true,
          message: `Session ${sessionId.slice(0, 8)} was not yours — nothing changed and nothing was inspected.`,
        };
      }
      const dirty =
        result.snapshot === null || result.snapshot.dirtyFiles === null
          ? // Absent evidence is absent, never zero: an unreadable worktree
            // must not read as clean.
            "dirty state unknown (the worktree could not be inspected)"
          : `${result.snapshot.dirtyFiles} dirty file(s) in the worktree`;
      const readiness = result.snapshot?.readinessDegraded
        ? " · readiness DEGRADED — re-check with muon doctor before dispatching this lane"
        : "";
      return {
        ok: true,
        message: `Returned ${sessionId.slice(0, 8)} — ${dirty}${readiness}`,
      };
    },
  },
  plan: {
    label: "plan — store a workflow proposal (dry-run; apply is a second consent)",
    form: () => ({
      commandId: "plan",
      title: "Plan a request (stored as a proposal; nothing runs)",
      fields: [
        { id: "request", label: "What do you want done?", required: true },
        {
          id: "workspace",
          label: "Repo folder (where the plan would run)",
          required: false,
          prefill: process.cwd(),
        },
      ],
    }),
    run: async (client, values) => {
      // 0046 D4 port (retirement ledger row M2). Same seam as the classic
      // desk's /plan power path: a heuristic proposal, lane suggestions
      // filled per step, STORED as a workflow run — nothing executes.
      // Applying is a separate consent (M3's pane, until then the CLI),
      // so the confirmation names the exact executable next action rather
      // than implying the plan ran.
      const request = values.request!.trim();
      const workspace = (values.workspace ?? "").trim() || process.cwd();
      const proposal = heuristicWorkflowProposal(request);
      for (const step of proposal.steps) {
        if (step.role === "suggest" && !step.laneKey) {
          const suggestions = await client
            .suggestLanes(undefined, `${step.title} ${step.brief}`)
            .catch(() => []);
          const top = suggestions[0];
          if (top) {
            step.laneKey = top.laneKey;
            step.laneReason = top.reason;
          }
        }
      }
      const run = await client.createWorkflowRun({
        request,
        workspacePath: workspace,
        proposal,
        proposedBy: "heuristic",
      });
      return {
        ok: true,
        message: `Proposal ${run.id.slice(0, 8)} stored (${proposal.steps.length} step${
          proposal.steps.length === 1 ? "" : "s"
        }, nothing ran). Review + apply with: muon workflow apply --run-id ${run.id}`,
      };
    },
  },
  fork: {
    label: "fork — branch a new mission from a settled job",
    form: (context: ActionContext) => ({
      commandId: "fork",
      title: "Fork from a recorded step",
      fields: [
        {
          id: "sourceJobId",
          label: "Settled job id (the recorded step)",
          required: true,
          // The crew drawer's highlighted job, when there is one — the same
          // act-on-what-you-are-looking-at resolution attachGoverned uses.
          prefill: context.selectedJobId,
        },
        { id: "brief", label: "Brief for the fork", required: true },
        {
          id: "laneKey",
          label: "Lane key",
          required: true,
          prefill: context.selectedLane?.key,
        },
        { id: "title", label: "Mission title (optional)", required: false },
      ],
    }),
    run: async (client, values) => {
      // ADR-0044/0071: everything that makes a fork a fork — the
      // latest-settled-step guard, the gesture-time capture, authority
      // re-derivation, offer-prefix inheritance, compensation — is enforced
      // SERVER-SIDE at the fork route. This form only names the step and
      // the brief; a refusal surfaces verbatim through the catch below.
      const lane = await resolveLaneByKey(client, values.laneKey!);
      const forked = await client.forkMission({
        sourceJobId: values.sourceJobId!.trim(),
        brief: values.brief!.trim(),
        vendor: lane.key,
        ...(values.title?.trim() ? { title: values.title.trim() } : {}),
      });
      return {
        ok: true,
        message: `Forked ${sessionSlug(values.sourceJobId!.trim())} into mission "${forked.chat.title}" — root ${sessionSlug(forked.job.id)} queued on ${lane.name}`,
      };
    },
  },
  specialist: {
    label: "specialist — task + harness + lane, one action",
    form: (context: ActionContext) => ({
      commandId: "specialist",
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
    }),
    run: async (client, values) => {
      // 0046 D4 port (parity row M4). Same governed seam as the classic
      // desk: validate the harness by NAME first (a typo'd key refuses
      // before a task exists), create the task, then ENQUEUE a governed
      // dispatch — the shell desk watches jobs through the crew drawer, so
      // it queues rather than running an inline interactive loop, and the
      // confirmation says "queued", never "ran".
      const lane = await resolveLaneByKey(client, values.laneKey!);
      const harnessKey = (values.harnessKey ?? "").trim();
      if (harnessKey) {
        await client.getHarness(harnessKey);
      }
      const workspace = (values.workspace ?? "").trim() || process.cwd();
      const task = await client.createTask({
        title: values.title!.trim(),
        description: values.brief!.trim(),
        priority: "medium",
        workspacePath: workspace,
      });
      // The classic path (run-dispatcher.ts) ASSIGNS the task to its lane —
      // task/lane views and assignment-derived state read it (review
      // finding: the port queued the job but left the task unassigned).
      // Its failure NAMES the kept task too (review finding: only the
      // dispatch leg was covered, so an assign refusal left an unnamed
      // unassigned task behind a generic error).
      try {
        await client.assignTask({
          taskId: task.id,
          laneId: lane.id,
          summary: `tui specialist: ${values.brief!.trim().slice(0, 120)}`,
        });
      } catch (error) {
        return {
          ok: false,
          message: `Assignment refused: ${
            error instanceof Error ? error.message : String(error)
          } — task ${task.id} was created and KEPT (unassigned). Assign it with 'assign' (task ${task.id}, lane ${lane.key}), then dispatch with 'run' — rather than re-running specialist (which would create a duplicate task).`,
        };
      }
      let job;
      try {
        job = await client.enqueueDispatch({
          vendor: lane.key,
          taskId: task.id,
          brief: values.brief!.trim(),
          ...(harnessKey ? { harnessKey } : {}),
          workspacePath: workspace,
        });
      } catch (error) {
        // The task is a durable, USABLE record — kept and NAMED, never
        // silently orphaned (review finding) and never deleted (a human's
        // stated intent is not compensation material). The remedy names the
        // exact retry that does not re-create it.
        return {
          ok: false,
          message: `Dispatch refused: ${
            error instanceof Error ? error.message : String(error)
          } — task ${task.id} was created, ASSIGNED to ${lane.key}, and KEPT. Retry with 'run': task id ${task.id}, lane ${lane.key}, the same brief${
            harnessKey ? `, harness '${harnessKey}'` : ""
          }${
            workspace ? `, repo folder '${workspace}'` : ""
          } — rather than re-running specialist (which would create a duplicate task).`,
        };
      }
      return {
        ok: true,
        message: `Specialist queued: task ${task.id} → ${sessionSlug(job.id)} on ${lane.name}${harnessKey ? ` (+${harnessKey})` : ""}`,
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
  ship: {
    // NAMES WHAT IT DOES. "Ship" sounds like the merge; it is not one. This
    // runs the check and FILES a `kind:"merge"` approval — the decision is a
    // separate, human, evidence-first press in the inbox, and no path from
    // here can reach it.
    label: "ship — run the checks, then FILE the merge gate",
    form: (context: ActionContext) => ({
      commandId: "ship",
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
          prefill: DEFAULT_SHIP_CHECK,
        },
      ],
    }),
    run: async (client, values) => {
      const lane = await resolveLaneByKey(client, values.laneKey!);
      const taskId = values.taskId!.trim();
      // The TASK's workspace, not this process's cwd: run the check where the
      // work lives, or the filed merge gate attests to a check that ran
      // against a different tree. This ALSO proves the task exists before a
      // check is spawned — a typo'd id used to run the whole suite and only
      // then fail at `requestApproval`.
      const detail = await client.getTaskDetail(taskId);
      // `runShipReview` (`lib/ship.ts`) is the implementation the classic
      // desk introduced, called with the same arguments: same check spawn (no shell), same recorded event,
      // same `kind:"merge"` approval payload. Cross-surface parity by sharing
      // the implementation rather than by agreeing to write it twice.
      return await runShipReview({
        client,
        lane,
        taskId,
        checkCommand: (values.check ?? "").trim() || DEFAULT_SHIP_CHECK,
        ...(detail.workspacePath ? { cwd: detail.workspacePath } : {}),
      });
    },
  },
  "memory-add": {
    label: "memory-add — propose a memory note",
    form: (context: ActionContext) => ({
      commandId: "memory-add",
      title: "Add memory note",
      fields: [
        {
          id: "kind",
          label: `Kind (${MEMORY_KINDS.join("|")})`,
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
    }),
    run: async (client, values) => {
      const module = (values.module ?? "").trim();
      const taskId = (values.taskId ?? "").trim();
      // The SAME payload the CLI's `muon memory add` sends (and the classic
      // desk sent), field for field.
      const note = await client.addMemoryNote({
        kind: values.kind!.trim() as MemoryKind,
        text: values.text!.trim(),
        ...(taskId ? { taskId } : {}),
        modules: module ? [module] : [],
        createdBy: "human",
      });
      // REPORTS WHAT THE BRAIN DID, never what this surface asked for. A note
      // is unconfirmed until a human vouches for it, and the confirmation
      // rule is the server's to apply — so the message reads the answer back
      // instead of asserting a trust state from the client side.
      return {
        ok: true,
        message: note.confirmed
          ? `Memory note ${note.id} added (confirmed)`
          : `Memory note ${note.id} added — UNCONFIRMED until a human vouches for it`,
      };
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
 * The ones the registry owns come FROM the registry — one definition, so a
 * command's form and its executor cannot drift apart. The rest are forms
 * without executors, kept because the CLASSIC desk builds them and submits
 * them through its own branches (`components/App.tsx`); `executeAction`
 * refuses those by name rather than rendering one and failing after a human
 * has typed into it.
 *
 * H13: `ship` and `memory-add` used to live down here, forms with no runner —
 * so every desk that derives its offer from the registry could draw them and
 * not run them. They are registry entries now, which is why they vanished
 * from this switch rather than being duplicated into it.
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
    // session-start / session-send forms DELETED (ADR-0087 D1 dispositions:
    // SUPERSEDED by the spawn picker and the pane keyboard). They were
    // unreachable — the composer offers only EXECUTABLE_ACTIONS + take-over
    // and executeAction refuses non-registry ids — and an unreachable form
    // is exactly the advertised-but-inert debris this registry exists to end.
    case "plan":
      return {
        commandId,
        title: "Plan a request (dry-run; apply from the result)",
        fields: [{ id: "request", label: "What do you want done?", required: true }],
      };
    case "take-over":
      // 0046 D4 port (retirement ledger row M15). The COST is stated on
      // the form, BEFORE the press: the session opens in the job's own
      // worktree and the human's edits land there.
      return {
        commandId,
        title:
          "Take over a dispatched session — opens the vendor CLI in the JOB'S WORKTREE; your edits land there, and the session is yours until returned",
        fields: [
          {
            id: "sessionId",
            label: "Session id (empty = the latest resumable session)",
            required: false,
          },
        ],
      };
    default:
      return null;
  }
}

/** ADR-0036 G13 two-press raise: the arm ledger (UI-process state, exactly
 *  as the classic overlay held it), keyed resolved-root + amount. An arm
 *  EXPIRES (review finding: a process-lifetime arm could be redeemed long
 *  after the form was dismissed) — the TTL approximates the form's own
 *  lifetime, and an expired confirm re-arms rather than raising. */
const ARMED_RAISE_TTL_MS = 120_000;
const armedBudgetRaises = new Map<string, number>();

/** Test seam only. */
export function resetArmedBudgetRaisesForTests(): void {
  armedBudgetRaises.clear();
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
  if (form.commandId === "memory-add") {
    const kind = (values.kind ?? "").trim();
    if (!MEMORY_KINDS.includes(kind as MemoryKind)) {
      return `Kind must be one of ${MEMORY_KINDS.join("|")}`;
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
  manualReview?: import("@muon/client").ManualReviewAttestation,
  // ADR-0056: the GRADED form of the same opt-in. Mutually exclusive with
  // `receiptTtlMs` — the builder refuses both rather than picking one.
  grantDuration?: import("@muon/client").ApprovalGrantDuration
): Promise<ActionResult> {
  try {
    // Same reason as the CLI: without the builder this path sent
    // `decisionNotes: undefined` whenever the operator typed no note, losing
    // the attribution the two OTHER TUI desks were already recording.
    const approval = await client.resolveApproval(
      buildApprovalDecision({
        approvalId,
        status: decision,
        surface: "MUON TUI",
        notes: notes?.trim() || undefined,
        ...(receiptTtlMs !== undefined && decision === "approved"
          ? { receiptTtlMs }
          : {}),
        ...(grantDuration !== undefined && decision === "approved"
          ? { grantDuration }
          : {}),
        ...(decision === "approved" && manualReview ? { manualReview } : {}),
      })
    );
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
