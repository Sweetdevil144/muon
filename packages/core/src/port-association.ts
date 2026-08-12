import type { ListeningPort } from "./port-scan.js";

export type PortOwnerKind = "workspace" | "job" | "terminal";

export type PortOwner = {
  kind: PortOwnerKind;
  workspacePath: string;
  chatId?: string;
  jobId?: string;
  sessionId?: string;
};

export type WorkspacePortTarget = {
  chatId: string;
  workspacePath: string;
};

export type JobPortTarget = {
  jobId: string;
  workspacePath: string;
  chatId?: string;
};

export type AssociatedListeningPort = ListeningPort & {
  owner?: PortOwner;
};

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

/** True when `cwd` is the workspace root or a path beneath it. */
export function cwdMatchesWorkspace(cwd: string, workspacePath: string): boolean {
  const root = normalizePath(workspacePath);
  const candidate = normalizePath(cwd);
  if (!root || !candidate) {
    return false;
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function associateListeningPorts(input: {
  ports: readonly ListeningPort[];
  processCwds: Readonly<Record<number, string>>;
  workspaces: readonly WorkspacePortTarget[];
  jobs: readonly JobPortTarget[];
  pidOwners?: Readonly<Record<number, PortOwner>>;
}): AssociatedListeningPort[] {
  const workspaceByPath = new Map<string, WorkspacePortTarget>();
  for (const workspace of input.workspaces) {
    workspaceByPath.set(normalizePath(workspace.workspacePath), workspace);
  }

  return input.ports.map((port) => {
    const direct = input.pidOwners?.[port.pid];
    if (direct) {
      return { ...port, owner: direct };
    }

    const cwd = input.processCwds[port.pid];
    if (!cwd) {
      return { ...port };
    }

    for (const job of input.jobs) {
      if (cwdMatchesWorkspace(cwd, job.workspacePath)) {
        return {
          ...port,
          owner: {
            kind: "job",
            workspacePath: job.workspacePath,
            jobId: job.jobId,
            ...(job.chatId ? { chatId: job.chatId } : {}),
          },
        };
      }
    }

    for (const workspace of input.workspaces) {
      if (cwdMatchesWorkspace(cwd, workspace.workspacePath)) {
        return {
          ...port,
          owner: {
            kind: "workspace",
            workspacePath: workspace.workspacePath,
            chatId: workspace.chatId,
          },
        };
      }
    }

    const exact = workspaceByPath.get(normalizePath(cwd));
    if (exact) {
      return {
        ...port,
        owner: {
          kind: "workspace",
          workspacePath: exact.workspacePath,
          chatId: exact.chatId,
        },
      };
    }

    return { ...port };
  });
}

/** Ports attributed to one chat (direct chatId or matching workspace path). */
export function portsForChat(
  ports: readonly AssociatedListeningPort[],
  chatId: string,
  workspacePath: string
): AssociatedListeningPort[] {
  const root = normalizePath(workspacePath);
  return ports.filter((port) => {
    if (port.owner?.chatId === chatId) {
      return true;
    }
    if (!port.owner) {
      return false;
    }
    return normalizePath(port.owner.workspacePath) === root;
  });
}

/** Localhost-only ports are the only ones eligible for in-app preview. */
export function isLocalhostListenAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "*"
  );
}
