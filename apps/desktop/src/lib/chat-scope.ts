type ChatScope = {
  id: string;
  title: string;
  workspacePath: string;
  taskId?: string | null;
  createdAt: string;
};

type ScopedJob = {
  id: string;
  chatId?: string | null;
  taskId: string;
  brief?: string;
  capabilityMode?: string | null;
  agentId?: string | null;
};

type TaskBound = {
  id: string;
  taskId: string;
};

type WorkspaceProposal = {
  id: string;
  chatId?: string | null;
  workspacePath?: string | null;
  createdAt?: string;
};

export function scopeDesktopStateToChat<
  Job extends ScopedJob,
  Approval extends TaskBound,
  Event extends TaskBound,
  Proposal extends WorkspaceProposal,
>(input: {
  chat: ChatScope | null;
  jobs: Job[];
  approvals: Approval[];
  auditEvents: Event[];
  proposals: Proposal[];
}) {
  if (!input.chat) {
    return {
      activeTaskId: null,
      jobs: [] as Job[],
      approvals: [] as Approval[],
      auditEvents: [] as Event[],
      proposals: [] as Proposal[],
      agentIds: new Set<string>(),
    };
  }

  const jobs = input.jobs
    .filter((job) => job.chatId === input.chat!.id)
    .map((job) =>
      job.capabilityMode === "orchestrator"
        ? { ...job, brief: input.chat!.title }
        : job
    ) as Job[];
  const taskIds = new Set(
    [
      input.chat.taskId,
      ...jobs.map((job) => job.taskId),
    ].filter((taskId): taskId is string => Boolean(taskId))
  );
  const agentIds = new Set(
    jobs
      .map((job) => job.agentId)
      .filter((agentId): agentId is string => Boolean(agentId))
  );
  const proposals = input.proposals.filter(
    (proposal) => proposal.chatId === input.chat!.id
  );

  return {
    activeTaskId: input.chat.taskId ?? jobs[0]?.taskId ?? null,
    jobs,
    approvals: input.approvals.filter((approval) =>
      taskIds.has(approval.taskId)
    ),
    auditEvents: input.auditEvents.filter((event) =>
      taskIds.has(event.taskId)
    ),
    proposals,
    agentIds,
  };
}
