import {
  associateListeningPorts,
  lookupProcessCwds,
  isLocalhostListenAddress,
  scanListeningPorts,
  createPortScanPoller,
  type AssociatedListeningPort,
  type PortScanPoller,
} from "@muon/core";
import type { DispatchJobRecord, OrchestratorChatRecord } from "@muon/client";

export type { AssociatedListeningPort };

let latestPorts: AssociatedListeningPort[] = [];
let poller: PortScanPoller | null = null;
let monitorEpoch = 0;

export function currentListeningPorts(): readonly AssociatedListeningPort[] {
  return latestPorts;
}

export function startPortMonitor(input: {
  listChats: () => Promise<OrchestratorChatRecord[]>;
  listActiveJobs: () => Promise<DispatchJobRecord[]>;
  resolveJobWorkspace: (jobId: string) => Promise<string | null>;
  onChange?: () => void;
}): PortScanPoller {
  poller?.stop();
  const epoch = ++monitorEpoch;
  let updateVersion = 0;
  const monitor = createPortScanPoller({
    scan: async () => scanListeningPorts(),
    onUpdate: (ports) => {
      const version = ++updateVersion;
      void refreshAssociations(ports, input)
        .then((associated) => {
          // Association joins include several asynchronous ledger/process reads.
          // A slower older scan, or a stopped/replaced monitor, must never publish
          // after the newest observation and resurrect stale preview authority.
          if (epoch !== monitorEpoch || version !== updateVersion) {
            return;
          }
          latestPorts = associated;
          input.onChange?.();
        })
        .catch(() => {
          if (epoch !== monitorEpoch || version !== updateVersion) {
            return;
          }
          // Preview authority fails closed when the association join is not
          // available; keeping the previous scan would authorize stale ports.
          latestPorts = [];
          input.onChange?.();
        });
    },
  });
  poller = monitor;
  monitor.start();
  return monitor;
}

export function stopPortMonitor(): void {
  poller?.stop();
  poller = null;
  monitorEpoch += 1;
  latestPorts = [];
}

async function refreshAssociations(
  ports: Awaited<ReturnType<typeof scanListeningPorts>>,
  input: {
    listChats: () => Promise<OrchestratorChatRecord[]>;
    listActiveJobs: () => Promise<DispatchJobRecord[]>;
    resolveJobWorkspace: (jobId: string) => Promise<string | null>;
  }
): Promise<AssociatedListeningPort[]> {
  const pids = ports.map((port) => port.pid);
  const [processCwds, chats, jobs] = await Promise.all([
    lookupProcessCwds(pids),
    input.listChats().catch(() => []),
    input.listActiveJobs().catch(() => []),
  ]);

  const workspaces = chats.map((chat) => ({
    chatId: chat.id,
    workspacePath: chat.workspacePath,
  }));

  const jobTargets = (
    await Promise.all(
      jobs.map(async (job) => {
        // Current dispatch rows already carry the governed workspace. Resolve
        // only legacy rows that predate that field, and do those fallbacks in
        // parallel so a 200-job page cannot serialize 200 control-plane calls.
        const workspacePath =
          job.workspacePath ?? (await input.resolveJobWorkspace(job.id));
        if (!workspacePath) {
          return null;
        }
        return {
          jobId: job.id,
          workspacePath,
          ...(job.chatId ? { chatId: job.chatId } : {}),
        };
      })
    )
  ).filter(
    (
      target
    ): target is { jobId: string; workspacePath: string; chatId?: string } =>
      target !== null
  );

  return associateListeningPorts({
    ports,
    processCwds,
    workspaces,
    jobs: jobTargets,
  });
}

export function portsForBoundChat(
  chatId: string | null,
  workspacePath: string | null,
  ports: readonly AssociatedListeningPort[] = latestPorts
): AssociatedListeningPort[] {
  if (!chatId || !workspacePath) {
    return [];
  }
  const root = workspacePath.replace(/[\\/]+$/, "");
  return ports.filter((port) => {
    if (!port.owner) {
      return false;
    }
    if (port.owner.chatId === chatId) {
      return true;
    }
    const ownerRoot = port.owner.workspacePath.replace(/[\\/]+$/, "");
    return ownerRoot === root;
  });
}

/**
 * Main-process authorization for the opt-in preview IPC. Renderer input is
 * never enough: the port must still be a localhost listener associated with
 * the currently bound chat/workspace in the latest host-side scan.
 */
export function canPreviewPortForBoundChat(
  chatId: string | null,
  workspacePath: string | null,
  port: number,
  ports: readonly AssociatedListeningPort[] = latestPorts
): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return false;
  }
  return portsForBoundChat(chatId, workspacePath, ports).some(
    (candidate) =>
      candidate.port === port && isLocalhostListenAddress(candidate.address)
  );
}

export function toListeningPortSnapshot(
  port: AssociatedListeningPort
): import("../shared/ipc.js").ListeningPortSnapshot {
  return {
    port: port.port,
    address: port.address,
    pid: port.pid,
    ...(port.command ? { command: port.command } : {}),
    ...(port.owner
      ? {
          ownerKind: port.owner.kind,
          workspacePath: port.owner.workspacePath,
          ...(port.owner.chatId ? { chatId: port.owner.chatId } : {}),
          ...(port.owner.jobId ? { jobId: port.owner.jobId } : {}),
        }
      : {}),
  };
}

export function listeningPortSnapshotsForChat(
  chatId: string | null,
  workspacePath: string | null
): import("../shared/ipc.js").ListeningPortSnapshot[] {
  return portsForBoundChat(chatId, workspacePath).map(toListeningPortSnapshot);
}
