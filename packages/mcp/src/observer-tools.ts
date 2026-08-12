import {
  loadCrewRolePlan,
  type MuonApiClient,
} from "@muon/client";
import { MUON_OBSERVER_TOOL_NAMES } from "@muon/protocol";
import {
  dataOnlyMcpError,
  fail,
  ok,
  withAgentUi,
  type ToolDefinition,
} from "./agent-ui.js";
import {
  createOrchestratorToolDefinitions,
  type OrchestratorScope,
} from "./orchestrator-tools.js";

export type ObserverScope = {
  apiBase: string;
  apiToken?: string;
  /** Durable chat coordinate explicitly written by `muon mcp install --chat`. */
  chatId?: string;
  workspacePath?: string;
};

const CHAT_ID_MAX = 128;
const CHAT_PROPERTY = {
  type: "string",
  minLength: 1,
  maxLength: CHAT_ID_MAX,
  description:
    "Mission chat to observe. Optional only when MUON_CHAT_ID was set by `muon mcp install --chat <id>`.",
} as const;

/**
 * MCP #3 — an observer installed WITHOUT `--chat` used to fence on whatever
 * chat each call named: the tool descriptions advertised an
 * "attached-observer boundary" that was in fact caller-supplied, so one
 * session could wander every mission on the machine one read at a time. The
 * boundary is now PINNED ON FIRST USE: the first explicitly named chat
 * becomes this session's fence, and every later call must match it — the
 * same refusal a configured mismatch gets. One observer session, one chat.
 */
const sessionPinnedChat = new WeakMap<ObserverScope, string>();

function requestedChatId(
  scope: ObserverScope,
  args: Record<string, unknown>
): { ok: true; chatId: string } | { ok: false; error: string } {
  const requested = typeof args.chatId === "string" ? args.chatId.trim() : "";
  const configured = scope.chatId?.trim() ?? "";
  if (requested.length > CHAT_ID_MAX) {
    return { ok: false, error: `chatId exceeds ${CHAT_ID_MAX} characters` };
  }
  const pinned = configured ? "" : (sessionPinnedChat.get(scope) ?? "");
  const boundary = configured || pinned;
  if (boundary && requested && requested !== boundary) {
    return {
      ok: false,
      error: configured
        ? `chat '${requested}' is outside this observer's configured chat '${configured}'`
        : `chat '${requested}' is outside this observer session's chat '${boundary}' (pinned by its first read; one observer session observes one chat)`,
    };
  }
  const chatId = boundary || requested;
  if (!chatId) {
    return {
      ok: false,
      error:
        "chatId is required for this observer read; pass it explicitly or reinstall with `muon mcp install <vendor> --mode observer --chat <id>`",
    };
  }
  if (!configured && !pinned) {
    sessionPinnedChat.set(scope, chatId);
  }
  return { ok: true, chatId };
}

function observerOrchestratorScope(
  scope: ObserverScope,
  chatId?: string
): OrchestratorScope {
  return {
    apiBase: scope.apiBase,
    apiToken: scope.apiToken,
    chatId,
    workspacePath: scope.workspacePath,
  };
}

function addChatArgument(tool: ToolDefinition): ToolDefinition {
  const properties =
    typeof tool.inputSchema.properties === "object" &&
    tool.inputSchema.properties !== null
      ? (tool.inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...tool,
    description:
      `${tool.description} Attached-observer boundary: name one chat, or use the chat fixed at install time; a mismatch refuses.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...properties, chatId: CHAT_PROPERTY },
      additionalProperties: false,
    },
  };
}

function scopedControlRead(
  client: MuonApiClient,
  scope: ObserverScope,
  name: "dispatch_status" | "read_stream" | "budget_status"
): ToolDefinition {
  const metadata = createOrchestratorToolDefinitions(
    client,
    observerOrchestratorScope(scope, scope.chatId),
    { principal: "agent" }
  ).find((tool) => tool.name === name);
  if (!metadata) {
    throw new Error(`Observer read '${name}' is missing from the control inventory.`);
  }
  const wrapped = addChatArgument(metadata);
  return {
    ...wrapped,
    handler: async (args) => {
      const selected = requestedChatId(scope, args);
      if (!selected.ok) return dataOnlyMcpError(name, selected.error);
      const implementation = createOrchestratorToolDefinitions(
        client,
        observerOrchestratorScope(scope, selected.chatId),
        { principal: "agent" }
      ).find((tool) => tool.name === name);
      if (!implementation) {
        return dataOnlyMcpError(name, `Observer read '${name}' is unavailable.`);
      }
      const { chatId: _chatId, ...forwarded } = args;
      return implementation.handler(forwarded);
    },
  };
}

function customObserverReads(
  client: MuonApiClient,
  scope: ObserverScope
): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    {
      name: "list_tasks",
      description:
        "List bounded ledger tasks for one mission chat. Read-only: it cannot create or update a task.",
      inputSchema: {
        type: "object",
        properties: { chatId: CHAT_PROPERTY, status: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (args) => {
        const selected = requestedChatId(scope, args);
        if (!selected.ok) return fail(selected.error);
        const tasks = (await client.listTasks()).filter(
          (task) => task.chatId === selected.chatId
        );
        const filtered = args.status
          ? tasks.filter((task) => task.status === String(args.status))
          : tasks;
        const rows = filtered.slice(0, 30).map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          workspacePath: task.workspacePath ?? null,
          workflowRunId: task.workflowRunId ?? null,
        }));
        return ok(
          { chatId: selected.chatId, tasks: rows },
          {
            evidence: {
              bounded: true,
              limit: 30,
              included: rows.length,
              omitted: Math.max(0, filtered.length - rows.length),
              kind: "chat-scoped task rows",
            },
          }
        );
      },
    },
    {
      name: "workflow_status",
      description:
        "Read one workflow run and its step-task statuses inside one mission chat. Read-only; proposals cannot be changed or applied here.",
      inputSchema: {
        type: "object",
        properties: { chatId: CHAT_PROPERTY, runId: { type: "string" } },
        required: ["runId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const selected = requestedChatId(scope, args);
        if (!selected.ok) return fail(selected.error);
        const runId = String(args.runId ?? "").trim();
        if (!runId) return fail("runId is required");
        const [runs, tasks] = await Promise.all([
          client.listWorkflowRuns({ chatId: selected.chatId }),
          client.listTasks(),
        ]);
        const run = runs.find((entry) => entry.id === runId);
        if (!run) return fail(`workflow run '${runId}' is outside chat '${selected.chatId}' or does not exist`);
        const runTasks = tasks.filter(
          (task) =>
            task.chatId === selected.chatId && task.workflowRunId === run.id
        );
        return ok({
          run: {
            id: run.id,
            status: run.status,
            summary: run.proposal.summary,
            workspacePath: run.workspacePath ?? null,
          },
          steps: run.proposal.steps.map((step) => {
            const task = runTasks.find((entry) => entry.stepKey === step.stepKey);
            return {
              stepKey: step.stepKey,
              laneKey: step.laneKey ?? step.role,
              taskId: task?.id ?? null,
              status: task?.status ?? "not-applied",
            };
          }),
        });
      },
    },
    {
      name: "crew_roles",
      description:
        "Read the committed or proposed role-to-vendor plan for one mission chat. Coordinates only; it cannot assign or change roles.",
      inputSchema: {
        type: "object",
        properties: { chatId: CHAT_PROPERTY },
        additionalProperties: false,
      },
      handler: async (args) => {
        const selected = requestedChatId(scope, args);
        if (!selected.ok) return fail(selected.error);
        const view = await loadCrewRolePlan({
          apiBase: scope.apiBase,
          apiToken: scope.apiToken,
          chatId: selected.chatId,
        });
        const roles =
          view.plan?.bindings.map((binding) => ({
            role: binding.role,
            vendor: binding.vendor,
            fit: binding.fit,
            assignedBy: binding.assignedBy,
            blocked: binding.blocked,
          })) ?? [];
        return ok({
          chatId: selected.chatId,
          assigned: view.planStatus === "assigned",
          planStatus: view.planStatus,
          roles,
          unfilled: view.plan?.unfilled ?? [],
        });
      },
    },
    {
      name: "check_approval",
      description:
        "Read one approval's status only when its task belongs to the named mission chat. It cannot approve, reject, or redeem anything.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: CHAT_PROPERTY,
          approvalId: { type: "string" },
        },
        required: ["approvalId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const selected = requestedChatId(scope, args);
        if (!selected.ok) return fail(selected.error);
        const approvalId = String(args.approvalId ?? "").trim();
        if (!approvalId) return fail("approvalId is required");
        const [tasks, approvals] = await Promise.all([
          client.listTasks(),
          client.listApprovals(),
        ]);
        const taskIds = new Set(
          tasks
            .filter((task) => task.chatId === selected.chatId)
            .map((task) => task.id)
        );
        const approval = approvals.find(
          (entry) => entry.id === approvalId && taskIds.has(entry.taskId)
        );
        if (!approval) {
          return fail(
            `approval '${approvalId}' is outside chat '${selected.chatId}' or does not exist`
          );
        }
        return ok({
          id: approval.id,
          status: approval.status,
          kind: approval.kind,
          taskId: approval.taskId,
        });
      },
    },
  ];
  return withAgentUi(definitions, {
    principal: "agent",
    taskScoped: false,
    laneScoped: false,
    chatScoped: true,
  });
}

/**
 * The complete Tier B read surface. Runtime order is the protocol's positive
 * authority list, so a control-tool addition cannot join by omission.
 */
export function createObserverToolDefinitions(
  client: MuonApiClient,
  scope: ObserverScope
): ToolDefinition[] {
  const fleet = createOrchestratorToolDefinitions(
    client,
    observerOrchestratorScope(scope, scope.chatId),
    { principal: "agent" }
  ).find((tool) => tool.name === "fleet_status");
  if (!fleet) throw new Error("Observer read 'fleet_status' is unavailable.");
  const all = [
    fleet,
    scopedControlRead(client, scope, "dispatch_status"),
    scopedControlRead(client, scope, "read_stream"),
    scopedControlRead(client, scope, "budget_status"),
    ...customObserverReads(client, scope),
  ];
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  return MUON_OBSERVER_TOOL_NAMES.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Observer inventory '${name}' has no definition.`);
    return tool;
  });
}

/** Replace the base `crew_roles` definition, then append the seven new reads. */
/**
 * Task-keyed BASE reads, re-fenced for observer mode. `task_context` and
 * `handoff_read` take a bare taskId and, on the shared agent token (no job
 * capability), the backend applies no chat fence — so an observer session
 * could read ANY mission's brief and handoff prose, and use the returned
 * chatId to pin itself to a mission the human never pointed it at. The fence:
 * resolve the task's OWN chat first and refuse when it is outside this
 * session's chat boundary (configured or pinned). The task lookup that
 * enforces this is also what PINS an unconfigured session — reading a task is
 * choosing a mission.
 */
function chatFencedTaskRead(
  client: MuonApiClient,
  scope: ObserverScope,
  base: ToolDefinition
): ToolDefinition {
  return {
    ...base,
    description:
      `${base.description} Attached-observer boundary: only tasks of this session's one chat are readable; a foreign task refuses.`,
    handler: async (args) => {
      const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (taskId) {
        let taskChatId: string | null | undefined;
        try {
          taskChatId = (await client.getTaskDetail(taskId)).chatId;
        } catch (error) {
          return dataOnlyMcpError(
            base.name,
            `could not resolve task '${taskId}': ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        // A task with NO chat binding has no lane into this session's fence;
        // fail closed rather than guess.
        if (!taskChatId) {
          return dataOnlyMcpError(
            base.name,
            `task '${taskId}' is not bound to a chat; an attached observer reads only its own chat's tasks`
          );
        }
        const selected = requestedChatId(scope, { chatId: taskChatId });
        if (!selected.ok) {
          return dataOnlyMcpError(base.name, selected.error);
        }
      }
      return base.handler(args);
    },
  };
}

export function createObserverModeToolDefinitions(
  client: MuonApiClient,
  baseTools: ToolDefinition[],
  scope: ObserverScope
): ToolDefinition[] {
  const observer = createObserverToolDefinitions(client, scope);
  const overrides = new Map(observer.map((tool) => [tool.name, tool]));
  const composed = baseTools.map((tool) => {
    const override = overrides.get(tool.name);
    if (override) return override;
    // Task-keyed base reads get the chat fence (see chatFencedTaskRead).
    if (tool.name === "task_context" || tool.name === "handoff_read") {
      return chatFencedTaskRead(client, scope, tool);
    }
    return tool;
  });
  for (const tool of observer) {
    if (!baseTools.some((base) => base.name === tool.name)) composed.push(tool);
  }
  return composed;
}
