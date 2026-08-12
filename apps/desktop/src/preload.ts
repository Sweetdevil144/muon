import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";
import type { MuonBridge, MuonEvents } from "./shared/ipc.js";
import type {
  TerminalHostFrame,
  TerminalSpawn,
} from "./shared/terminal-protocol.js";
import type { TerminalLinkTarget } from "./shared/terminal-link-protocol.js";

// Sandboxed preload: must stay self-contained (only requires "electron").
// All shared imports are type-only and erase at compile time.

// Wave 4 §2.5 — per-session terminal byte channel. Main hands us a MessagePort
// via `muon:terminal-port`; we wrap it as a bytes-only TerminalClientPort. The
// wrapper BUFFERS host frames until the renderer registers its onFrame handler
// (a MessagePort queues until started), which is exactly what lets a reconnecting
// tab receive the replayed scrollback it missed while wiring up. NO token ever
// crosses this channel — only the typed byte/coordinate frames.
const TERMINAL_OPEN_TIMEOUT_MS = 10_000;
const terminalPortWaiters = new Map<
  string,
  { deliver: (port: MessagePort) => void; cancel: (error: Error) => void }
>();
ipcRenderer.on(
  "muon:terminal-port",
  (event: IpcRendererEvent, meta: { sessionId: string }) => {
    const port = event.ports[0];
    const waiter = terminalPortWaiters.get(meta.sessionId);
    if (waiter && port) {
      terminalPortWaiters.delete(meta.sessionId);
      waiter.deliver(port);
    }
  }
);

const EVENT_CHANNELS: ReadonlySet<string> = new Set([
  "muon:assistant",
  "muon:status",
  "muon:open-approval",
  "muon:update-status",
  "muon:job-idle-terminal",
  "muon:gitnexus",
  "muon:close-active-tab",
  "muon:open-command-palette",
]);

const bridge: MuonBridge = {
  getState: () => ipcRenderer.invoke("muon:getState"),
  gitnexusGraph: (repoPath?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke("muon:gitnexusGraph", {
      repoPath,
      force: options?.force === true,
    }),
  clearGitnexusGraphCache: (repoPath?: string) =>
    ipcRenderer.invoke("muon:clearGitnexusGraphCache", { repoPath }),
  gitnexusReindex: (repoPath?: string) =>
    ipcRenderer.invoke("muon:gitnexusReindex", { repoPath }),
  createChat: (input) => ipcRenderer.invoke("muon:createChat", input),
  selectChat: (chatId) => ipcRenderer.invoke("muon:selectChat", { chatId }),
  listChats: () => ipcRenderer.invoke("muon:listChats"),
  getChat: (chatId) => ipcRenderer.invoke("muon:getChat", { chatId }),
  archiveChat: (chatId) => ipcRenderer.invoke("muon:archiveChat", { chatId }),
  cancelChat: (chatId) => ipcRenderer.invoke("muon:cancelChat", { chatId }),
  updateChat: (input) => ipcRenderer.invoke("muon:updateChat", input),
  getDispatchBudget: (jobId) =>
    ipcRenderer.invoke("muon:getDispatchBudget", { jobId }),
  raiseDispatchBudget: (jobId, maxDescendantWallMs) =>
    ipcRenderer.invoke("muon:raiseDispatchBudget", {
      jobId,
      maxDescendantWallMs,
    }),
  interruptDispatch: (jobId) =>
    ipcRenderer.invoke("muon:interruptDispatch", { jobId }),
  revokeDispatchGrants: (input) =>
    ipcRenderer.invoke("muon:revokeDispatchGrants", input),
  steerDispatch: (jobId, message) =>
    ipcRenderer.invoke("muon:steerDispatch", { jobId, message }),
  pauseAutonomyCommitment: (input) =>
    ipcRenderer.invoke("muon:pauseAutonomyCommitment", input),
  resumeObjectiveLoop: (input) =>
    ipcRenderer.invoke("muon:resumeObjectiveLoop", input),
  sendMessage: (input) => ipcRenderer.invoke("muon:sendMessage", input),
  continueOrchestration: (input) =>
    ipcRenderer.invoke("muon:continueOrchestration", input),
  setFleet: (counts) => ipcRenderer.invoke("muon:setFleet", { counts }),
  refreshReadiness: () => ipcRenderer.invoke("muon:refreshReadiness"),
  mcpStatus: () => ipcRenderer.invoke("muon:mcpStatus"),
  mcpInstall: (vendor) => ipcRenderer.invoke("muon:mcpInstall", { vendor }),
  mcpAttach: (input) => ipcRenderer.invoke("muon:mcpAttach", input),
  mcpDetach: (vendor) => ipcRenderer.invoke("muon:mcpDetach", { vendor }),
  listCustomAgents: () => ipcRenderer.invoke("muon:listCustomAgents"),
  reviewApproval: (approvalId) =>
    ipcRenderer.invoke("muon:reviewApproval", { approvalId }),
  resolveApproval: (input) => ipcRenderer.invoke("muon:resolveApproval", input),
  answerQuestion: (input) => ipcRenderer.invoke("muon:answerQuestion", input),
  taskHandoffs: (input) => ipcRenderer.invoke("muon:taskHandoffs", input),
  mcpProbe: (input) => ipcRenderer.invoke("muon:mcpProbe", input),
  memoryGovernance: () => ipcRenderer.invoke("muon:memoryGovernance"),
  setMemoryTtl: (policy) => ipcRenderer.invoke("muon:setMemoryTtl", policy),
  setMemoryMining: (enabled) =>
    ipcRenderer.invoke("muon:setMemoryMining", enabled),
  setMemoryCompactionRetentionDays: (days) =>
    ipcRenderer.invoke("muon:setMemoryCompactionRetentionDays", days),
  sweepExpiredMemory: (input) =>
    ipcRenderer.invoke("muon:sweepExpiredMemory", input),
  compactMemory: (input) => ipcRenderer.invoke("muon:compactMemory", input),
  revertExpiredMemoryBatch: (batchId) =>
    ipcRenderer.invoke("muon:revertExpiredMemoryBatch", batchId),
  missionCost: () => ipcRenderer.invoke("muon:missionCost"),
  setMissionCostCap: (capUsd) =>
    ipcRenderer.invoke("muon:setMissionCostCap", { capUsd }),
  shipTask: (input) => ipcRenderer.invoke("muon:shipTask", input),
  applyWorkflowProposal: (runId) =>
    ipcRenderer.invoke("muon:applyWorkflowProposal", { runId }),
  dismissWorkflowProposal: (runId) =>
    ipcRenderer.invoke("muon:dismissWorkflowProposal", { runId }),
  stopAll: () => ipcRenderer.invoke("muon:stopAll"),
  streams: (query) => ipcRenderer.invoke("muon:streams", query),
  jobTerminal: (query) => ipcRenderer.invoke("muon:jobTerminal", query),
  jobResumeProbe: (query) => ipcRenderer.invoke("muon:jobResumeProbe", query),
  startGitHubDeviceFlow: () =>
    ipcRenderer.invoke("muon:startGitHubDeviceFlow"),
  pollGitHubDeviceFlow: (flowId) =>
    ipcRenderer.invoke("muon:pollGitHubDeviceFlow", { flowId }),
  disconnectGitHub: () => ipcRenderer.invoke("muon:disconnectGitHub"),
  githubReview: (query) => ipcRenderer.invoke("muon:githubReview", query),
  createGitHubPullRequest: (query) =>
    ipcRenderer.invoke("muon:createGitHubPullRequest", query),
  mergeGitHubPullRequest: (query) =>
    ipcRenderer.invoke("muon:mergeGitHubPullRequest", query),
  openGitHubUrl: (url) => ipcRenderer.invoke("muon:openGitHubUrl", { url }),
  workspaceReview: (query) =>
    ipcRenderer.invoke("muon:workspaceReview", query),
  crewRoles: (chatId) => ipcRenderer.invoke("muon:crewRoles", { chatId }),
  coordination: (chatId, missionId) =>
    ipcRenderer.invoke("muon:coordination", { chatId, missionId }),
  reviewDiff: (query) => ipcRenderer.invoke("muon:reviewDiff", query),
  reconMap: () => ipcRenderer.invoke("muon:reconMap"),
  dataBoundaries: (query) => ipcRenderer.invoke("muon:dataBoundaries", query),
  preEditContext: (input) => ipcRenderer.invoke("muon:preEditContext", input),
  getMemoryNote: (noteId) => ipcRenderer.invoke("muon:getMemoryNote", { noteId }),
  memoryExplain: (noteId) =>
    ipcRenderer.invoke("muon:memoryExplain", { noteId }),
  memoryNeighbors: (noteId) =>
    ipcRenderer.invoke("muon:memoryNeighbors", { noteId }),
  updateMemoryNote: (input) =>
    ipcRenderer.invoke("muon:updateMemoryNote", input),
  deleteMemoryNote: (noteId) =>
    ipcRenderer.invoke("muon:deleteMemoryNote", { noteId }),
  getAutoConfirmAgentMemory: () =>
    ipcRenderer.invoke("muon:getAutoConfirmAgentMemory"),
  memoryLibrary: (query) => ipcRenderer.invoke("muon:memoryLibrary", query),
  pickFolder: () => ipcRenderer.invoke("muon:pickFolder"),
  runFirstTask: () => ipcRenderer.invoke("muon:runFirstTask"),
  autoContext: (taskId) => ipcRenderer.invoke("muon:autoContext", { taskId }),
  saveSettings: (input) => ipcRenderer.invoke("muon:saveSettings", input),
  savePresets: (presets) =>
    ipcRenderer.invoke("muon:savePresets", { presets }),
  saveCrewConfig: (crew) =>
    ipcRenderer.invoke("muon:saveCrewConfig", { crew }),
  listVendorModels: (vendor) =>
    ipcRenderer.invoke("muon:listVendorModels", { vendor }),
  resolveVendorModel: (vendor) =>
    ipcRenderer.invoke("muon:resolveVendorModel", { vendor }),
  applyPreset: (presetId) =>
    ipcRenderer.invoke("muon:applyPreset", { presetId }),
  checkForUpdates: () => ipcRenderer.invoke("muon:checkForUpdates"),
  downloadUpdate: () => ipcRenderer.invoke("muon:downloadUpdate"),
  installUpdate: (input) => ipcRenderer.invoke("muon:installUpdate", input),
  setAutoUpdate: (enabled) =>
    ipcRenderer.invoke("muon:setAutoUpdate", { enabled }),
  setAutoContinue: (enabled) =>
    ipcRenderer.invoke("muon:setAutoContinue", { enabled }),
  setTelemetryEnabled: (enabled) =>
    ipcRenderer.invoke("muon:setTelemetryEnabled", { enabled }),
  observatorySummary: () => ipcRenderer.invoke("muon:observatorySummary"),
  setFullAuto: (enabled) => ipcRenderer.invoke("muon:setFullAuto", { enabled }),
  setFullAutoVendors: (vendors) =>
    ipcRenderer.invoke("muon:setFullAutoVendors", { vendors }),
  setPortPreviewEnabled: (enabled) =>
    ipcRenderer.invoke("muon:setPortPreviewEnabled", { enabled }),
  openPortPreview: (port) =>
    ipcRenderer.invoke("muon:openPortPreview", { port }),
  terminal: {
    close: (sessionId: string) =>
      ipcRenderer.invoke("muon:closeTerminal", { sessionId }),
    scrollback: (sessionId: string) =>
      ipcRenderer.invoke("muon:terminalScrollback", { sessionId }),
    openLink: (target: TerminalLinkTarget) =>
      ipcRenderer.invoke("muon:openTerminalLink", { target }),
    open: (sessionId: string, spawn: TerminalSpawn) =>
      new Promise((resolve, reject) => {
        // Supersede any still-pending open for this id so its promise settles
        // (a stale waiter would otherwise leak + never resolve).
        terminalPortWaiters
          .get(sessionId)
          ?.cancel(new Error(`terminal '${sessionId}' superseded by a newer open`));
        const timer = setTimeout(() => {
          terminalPortWaiters.delete(sessionId);
          reject(
            new Error(
              `terminal channel '${sessionId}' did not open within ${TERMINAL_OPEN_TIMEOUT_MS}ms`
            )
          );
        }, TERMINAL_OPEN_TIMEOUT_MS);
        terminalPortWaiters.set(sessionId, {
          cancel: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          deliver: (port) => {
            clearTimeout(timer);
            let listener: ((frame: TerminalHostFrame) => void) | undefined;
            const buffered: TerminalHostFrame[] = [];
            port.onmessage = (event: MessageEvent) => {
              const frame = event.data as TerminalHostFrame;
              if (listener) {
                listener(frame);
              } else {
                buffered.push(frame);
              }
            };
            port.start();
            resolve({
              post: (frame) => port.postMessage(frame),
              onFrame: (callback) => {
                listener = callback;
                buffered.splice(0).forEach(callback);
              },
              close: () => {
                try {
                  port.close();
                } catch {
                  // Already closed — a double close/unmount is harmless.
                }
              },
            });
          },
        });
        ipcRenderer.send("muon:openTerminal", { sessionId, spawn });
      }),
  },
  getHumanTerminalRestore: () =>
    ipcRenderer.invoke("muon:getHumanTerminalRestore"),
  getDetectionManifest: () => ipcRenderer.invoke("muon:getDetectionManifest"),
  on: <K extends keyof MuonEvents>(
    channel: K,
    callback: (payload: MuonEvents[K]) => void
  ) => {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`unknown event channel: ${channel}`);
    }
    const listener = (_event: IpcRendererEvent, payload: MuonEvents[K]) => {
      callback(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld("muon", bridge);
