import fs from "node:fs";
import { isAuthorizationFailure, MuonApiHttpError } from "./api-client.js";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  coordinatorVendorIds,
  vendorLabel,
  type VendorId,
} from "@muon/protocol";
import {
  attachedCoordinatorCapabilityFilePath,
  deleteAttachedCoordinatorCapabilityFile,
  readAttachedCoordinatorCapabilityFile,
  writeAttachedCoordinatorCapabilityFile,
} from "./attached-coordinator-capability.js";
import {
  MUON_MCP_ENTRY_NAME,
  installMcpServer,
  muonMcpUnresolvedRefusal,
  readVendorEntry,
  resolveMuonMcpCommand,
  vendorHoldsCoordinatorSeat,
  type InstallOutcome,
  type InstallableVendorSpec,
  type McpVendorIo,
} from "./mcp-vendor-config.js";

/**
 * ADR-0028 Tier C — the SHARED attach/detach orchestration `muon mcp attach |
 * detach`, the desktop Connections row, and the TUI's mcp-attach/mcp-detach
 * actions all call. §5 parity (the same rule `mcp-vendor-config.ts` and
 * `mcp-status.ts` already follow): one evaluator, never three restatements
 * that can drift.
 *
 * THE ONE INVARIANT EVERYTHING HERE IS WRITTEN AROUND: the capability bearer
 * token (`attachCoordinator`'s `capability.token`) enters this module, gets
 * folded into the capability-file write, and NEVER appears on either return
 * type below. `AttachCoordinatorFlowResult`'s success case and
 * `DetachCoordinatorFlowResult` are both safe to hand to a desktop IPC
 * `event.reply` verbatim — there is no field to strip, because none was ever
 * put there. A surface that wants the token has to go read the 0600
 * capability file itself, which is exactly the file `muon-mcp` reads.
 *
 * Partial-failure handling is deliberately paranoid: `attachCoordinatorFlow`
 * mints the backend seat FIRST (it is the one step with a uniqueness
 * constraint — ordinal 0), then writes the local capability file, then writes
 * the vendor config. Any later step failing rolls back every earlier one
 * (detach the backend job, delete the file). A backend cleanup failure is
 * returned explicitly with the job id; it is never swallowed behind a false
 * "rolled back" claim.
 */

export type AttachCoordinatorApiClient = {
  createChat(input: { workspacePath: string }): Promise<{
    id: string;
    workspacePath: string;
    taskId?: string | null;
  }>;
  archiveChat(chatId: string): Promise<unknown>;
  attachCoordinator(input: {
    vendor: string;
    chatId: string;
  }): Promise<{
    job: { id: string; workspacePath?: string | null };
    chat: { id: string; taskId?: string | null; workspacePath: string };
    capability: { token: string; expiresAt: string };
    attestation: { posture: string; claim: string };
  }>;
  detachCoordinator(
    jobId: string
  ): Promise<{ detached: boolean; jobId: string }>;
  listDispatchJobs(filter?: {
    activeRootOnly?: boolean;
  }): Promise<
    Array<{ id: string; vendor: string; capabilityMode?: string | null }>
  >;
  /** Optional (older structural clients): the brain's GitHub identity, read
   *  best-effort to stamp `operatorGitHubLogin` into the capability file. */
  getGitHubStatus?(): Promise<{ connected: boolean; login?: string }>;
};

export type AttachCoordinatorFlowInput = {
  client: AttachCoordinatorApiClient;
  io: McpVendorIo;
  /** This surface's own resolved API base, written into the capability file
   *  verbatim (never re-derived inside the file reader — see ADR-0028 §1.4b
   *  in `mcp-vendor-config.ts`'s header for why a WRITTEN base is dangerous
   *  for the base install, and why this one is fine: it is per-attach and
   *  the file, not the vendor config, is the credential surface). */
  apiBase: string;
  /** Defaults to `resolveDataDir()` inside the capability-file helpers. */
  dataDir?: string;
  spec: InstallableVendorSpec;
  /** Omitted → a fresh chat is created bound to `workspacePath`. */
  chatId?: string;
  workspacePath: string;
  /**
   * P0-2: when true (MUON_REQUIRE_GITHUB_LOGIN=1 on the calling surface),
   * attach REFUSES unless the brain has a verified GitHub identity — the
   * terminal counterpart of the Desktop's login gate. Off by default.
   */
  requireGitHubIdentity?: boolean;
};

export type AttachCoordinatorFlowResult =
  | {
      kind: "refused";
      reason: string;
      hint?: string;
      /** The brain refused the caller's AUTHORITY (401/403) — callers honor
       *  the exit-2 contract from this, since the reason is now a string. */
      authRefused?: boolean;
    }
  | {
      kind: "attached";
      vendor: VendorId;
      jobId: string;
      chatId: string;
      chatTaskId: string;
      workspacePath: string;
      /** The SHORT heartbeat lease `muon-mcp` renews, never the 30-minute
       *  execution wall (see backend/src/lib/attached-coordinator.ts). */
      expiresAt: string;
      attestation: { posture: string; claim: string };
      capabilityFilePath: string;
      command: string;
      commandSource: string;
      /** Token-free by construction (§2.2/§ADR-0028: attach mode only ever
       *  records the capability file PATH). Safe to render verbatim. */
      vendorConfig: InstallOutcome;
    };

/**
 * Mint an attached-coordinator seat for `input.spec.id` and wire it end to
 * end: validate the seat, resolve `muon-mcp`, attach (operator-tier) against
 * the brain, write the 0600 capability file, and register the vendor's MCP
 * config in `attached-coordinator` mode. Never rejects — every failure is a
 * `{kind: "refused"}` with the reason a human can act on, and any step after
 * the backend attach that fails triggers a best-effort rollback of everything
 * before it.
 */
export async function attachCoordinatorFlow(
  input: AttachCoordinatorFlowInput
): Promise<AttachCoordinatorFlowResult> {
  const { client, io, apiBase, spec, dataDir } = input;

  if (!vendorHoldsCoordinatorSeat(spec.id)) {
    return {
      kind: "refused",
      reason: `${vendorLabel(spec.id)} does not hold MUON's coordinator seat. ADR-0028 attach is only for ${coordinatorVendorIds()
        .map((id) => vendorLabel(id))
        .join(" and ")}.`,
    };
  }

  const resolution = resolveMuonMcpCommand(io);
  if (!resolution.ok) {
    return { kind: "refused", reason: muonMcpUnresolvedRefusal(resolution.searched) };
  }

  // P0-2 identity binding: read the brain's verified GitHub identity NOW, so
  // the capability file can name the human this seat was minted for. Read is
  // best-effort (a brain without the routes, or offline GitHub, degrades to
  // "unknown") — but under `requireGitHubIdentity` an unknown identity is a
  // fail-closed refusal, the terminal counterpart of the Desktop login gate.
  let operatorGitHubLogin: string | undefined;
  try {
    const github = await client.getGitHubStatus?.();
    if (github?.connected) {
      operatorGitHubLogin = github.login?.trim() || "connected";
    }
  } catch {
    /* unknown stays unknown */
  }
  if (input.requireGitHubIdentity && !operatorGitHubLogin) {
    return {
      kind: "refused",
      reason:
        "MUON requires a verified GitHub identity before an attached coordinator seat is minted (MUON_REQUIRE_GITHUB_LOGIN=1). Run `muon github login` (or connect GitHub in Desktop Settings), then retry.",
    };
  }

  let chatId = input.chatId?.trim();
  let createdChatId: string | null = null;
  const archiveCreatedChat = async (): Promise<string> => {
    if (!createdChatId) return "";
    try {
      await client.archiveChat(createdChatId);
      return "";
    } catch (error) {
      return ` The newly created chat '${createdChatId}' also could not be archived: ${errorMessage(error)}`;
    }
  };
  const detachAttachedJob = async (jobId: string): Promise<string> => {
    try {
      await client.detachCoordinator(jobId);
      return "";
    } catch (error) {
      return ` Backend rollback for attached job '${jobId}' failed: ${errorMessage(error)}. Run \`muon mcp detach ${spec.aliases[0]}\` before retrying.`;
    }
  };
  if (!chatId) {
    try {
      const chat = await client.createChat({ workspacePath: input.workspacePath });
      chatId = chat.id;
      createdChatId = chat.id;
    } catch (error) {
      return {
        kind: "refused",
        reason: `Could not create a chat to attach to: ${errorMessage(error)}`,
      };
    }
  }

  let attached: Awaited<ReturnType<AttachCoordinatorApiClient["attachCoordinator"]>>;
  try {
    attached = await client.attachCoordinator({ vendor: spec.id, chatId });
  } catch (error) {
    const cleanup = await archiveCreatedChat();
    return {
      kind: "refused",
      reason: `Attach was refused: ${errorMessage(error)}${cleanup}`,
      ...(isAuthorizationFailure(error) ? { authRefused: true } : {}),
    };
  }

  // The backend attach route already refuses an inactive/task-less chat
  // before it ever mints the job (backend/src/lib/attached-coordinator.ts),
  // so this should be unreachable — but the capability-file schema requires a
  // non-blank chatTaskId, and writing one from an unchecked optional would be
  // exactly the "trust the network response" bug ADR-0028 warns fail-closed
  // readers against. Detach rather than leave an orphaned seat.
  const chatTaskId = attached.chat.taskId?.trim();
  if (!chatTaskId) {
    const detachFailure = await detachAttachedJob(attached.job.id);
    const cleanup = await archiveCreatedChat();
    return {
      kind: "refused",
      reason: detachFailure
        ? `Attach succeeded server-side but the chat carries no task id.${detachFailure}${cleanup}`
        : `Attach succeeded server-side but the chat carries no task id; detached rather than leave an orphaned seat.${cleanup}`,
    };
  }

  const workspacePath =
    attached.job.workspacePath?.trim() || attached.chat.workspacePath;
  const capabilityFilePath = attachedCoordinatorCapabilityFilePath(
    spec.id,
    dataDir
  );

  try {
    writeAttachedCoordinatorCapabilityFile(
      {
        version: 1,
        apiBase,
        // The ONE bearer: it authenticates muon-mcp's Authorization header AND
        // is the x-muon-delegation-token its dispatch tool sends — see
        // api-client.ts's ADR-0028 comment atop attachCoordinator.
        apiToken: attached.capability.token,
        jobId: attached.job.id,
        delegationToken: attached.capability.token,
        chatId,
        chatTaskId,
        workspacePath,
        vendor: spec.id,
        expiresAt: attached.capability.expiresAt,
        // ADR-0049: this file has never heartbeated, so it declares itself and
        // is bounded by the BOOTSTRAP horizon — the only way a file may buy the
        // wider window. The first heartbeat drops the flag and the ordinary
        // horizon governs from there.
        bootstrap: true,
        ...(operatorGitHubLogin ? { operatorGitHubLogin } : {}),
      },
      dataDir
    );
  } catch (error) {
    const detachFailure = await detachAttachedJob(attached.job.id);
    const cleanup = await archiveCreatedChat();
    return {
      kind: "refused",
      reason: `Attached server-side but could not write the local capability file: ${errorMessage(error)}${detachFailure || " Backend attach rolled back."}${cleanup}`,
    };
  }

  const vendorConfig = installMcpServer(io, {
    spec,
    scope: spec.defaultScope,
    command: resolution.command,
    dryRun: false,
    mode: "attached-coordinator",
    capabilityFile: capabilityFilePath,
  });
  if (vendorConfig.kind === "refused") {
    const capabilityRemoved =
      deleteAttachedCoordinatorCapabilityFile(capabilityFilePath);
    const detachFailure = await detachAttachedJob(attached.job.id);
    const cleanup = await archiveCreatedChat();
    return {
      kind: "refused",
      reason: `Attached server-side but could not register ${spec.cli}'s MCP config: ${vendorConfig.reason}${detachFailure || " Backend attach rolled back."}${capabilityRemoved ? "" : ` Owner-only capability file ${capabilityFilePath} could not be removed.`}${cleanup}`,
      hint: vendorConfig.hint,
    };
  }

  return {
    kind: "attached",
    vendor: spec.id,
    jobId: attached.job.id,
    chatId,
    chatTaskId,
    workspacePath,
    expiresAt: attached.capability.expiresAt,
    attestation: attached.attestation,
    capabilityFilePath,
    command: resolution.command,
    commandSource: resolution.source,
    vendorConfig,
  };
}

export type DetachCoordinatorApiClient = Pick<
  AttachCoordinatorApiClient,
  "detachCoordinator" | "listDispatchJobs"
>;

export type DetachCoordinatorFlowInput = {
  client: DetachCoordinatorApiClient;
  io: McpVendorIo;
  dataDir?: string;
  spec: InstallableVendorSpec;
};

export type DetachCoordinatorFlowResult = {
  /** `not-attached` when NOTHING was found or touched anywhere (no local
   *  file, no matching backend job, no attach-mode vendor entry) — the
   *  idempotent "already clean" case, not a failure. `partial` means at least
   *  one cleanup boundary did not confirm success; `notes` names it. */
  kind: "detached" | "not-attached" | "partial";
  jobId: string | null;
  capabilityFileRemoved: boolean;
  vendorConfigReverted: boolean;
  /** Non-fatal observations (a 409 "already terminal", an unresolvable
   *  muon-mcp command for the revert, …). Never thrown — detach is a cleanup
   *  path and every step is best-effort past the first. */
  notes: string[];
};

/**
 * Read the LOCAL capability file for its `jobId` through the same bounded,
 * no-symlink, owner-only parser as startup. Cleanup explicitly admits a
 * legitimately expired lease without weakening any other trust check.
 */
function readLocalCapabilityJobId(
  filePath: string,
  vendorId: string
): string | null {
  const read = readAttachedCoordinatorCapabilityFile(filePath, {
    allowExpired: true,
  });
  return read.ok && read.capability.vendor === vendorId
    ? read.capability.jobId
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Revoke `spec.id`'s attached seat end to end: find the job (local capability
 * file first, then a fallback scan of active root jobs), detach it
 * (operator-tier), delete the local capability file, and revert the vendor's
 * MCP config back to base — WITHOUT destroying a sibling MCP server, because
 * `installMcpServer`'s read-modify-write only ever touches MUON's own entry.
 * Idempotent and safe to run twice: a seat that is already gone anywhere
 * still finishes cleanly with `kind: "not-attached"`.
 */
export async function detachCoordinatorFlow(
  input: DetachCoordinatorFlowInput
): Promise<DetachCoordinatorFlowResult> {
  const { client, io, spec, dataDir } = input;
  const notes: string[] = [];
  let partial = false;
  const capabilityFilePath = attachedCoordinatorCapabilityFilePath(
    spec.id,
    dataDir
  );

  let jobId = readLocalCapabilityJobId(capabilityFilePath, spec.id);
  if (!jobId) {
    try {
      const roots = await client.listDispatchJobs({ activeRootOnly: true });
      const match = roots.find(
        (job) =>
          job.vendor === spec.id &&
          job.capabilityMode === ATTACHED_COORDINATOR_CAPABILITY_MODE
      );
      jobId = match?.id ?? null;
    } catch (error) {
      partial = true;
      notes.push(
        `backend state is unknown because dispatch jobs could not be listed: ${errorMessage(error)}`
      );
    }
  }

  if (jobId) {
    try {
      await client.detachCoordinator(jobId);
    } catch (error) {
      // Only a typed 409 proves the seat is already absent/terminal. A string
      // containing "409", a timeout, auth refusal, or 5xx proves no such thing.
      if (!(error instanceof MuonApiHttpError && error.status === 409)) {
        partial = true;
      }
      notes.push(
        `backend detach for job ${jobId}: ${errorMessage(error)} (continuing with local cleanup)`
      );
    }
  }

  const capabilityFileExisted = fs.existsSync(capabilityFilePath);
  const capabilityFileAbsent =
    deleteAttachedCoordinatorCapabilityFile(capabilityFilePath);
  const capabilityFileRemoved = capabilityFileExisted && capabilityFileAbsent;
  if (!capabilityFileAbsent) {
    partial = true;
    notes.push(
      `could not remove owner-only capability file ${capabilityFilePath}; remove it before retrying`
    );
  }

  const current = readVendorEntry(spec, spec.defaultScope, io.roots);
  let vendorConfigReverted = false;
  if (
    current.kind === "present" &&
    (current.environment.MUON_MCP_MODE === ATTACHED_COORDINATOR_CAPABILITY_MODE ||
      current.environment.MUON_ATTACHED_CAPABILITY_FILE !== undefined)
  ) {
    // Reuse the RECORDED command rather than re-resolving `muon-mcp`: the
    // revert must succeed even if the binary moved since attach, as long as
    // the entry itself is still readable.
    let command = current.command;
    if (!command) {
      const resolution = resolveMuonMcpCommand(io);
      command = resolution.ok ? resolution.command : undefined;
    }
    if (command) {
      const revertOutcome = installMcpServer(io, {
        spec,
        scope: spec.defaultScope,
        command,
        dryRun: false,
      });
      if (revertOutcome.kind === "refused") {
        partial = true;
        notes.push(
          `could not revert ${spec.cli}'s MCP config to base: ${revertOutcome.reason}`
        );
      } else {
        vendorConfigReverted = true;
      }
    } else {
      partial = true;
      notes.push(
        `${spec.cli}'s MCP config still names attach mode; could not resolve muon-mcp to revert it. Remove '${MUON_MCP_ENTRY_NAME}' manually or re-run \`muon mcp install ${spec.id}\`.`
      );
    }
  } else if (current.kind === "unreadable") {
    partial = true;
    notes.push(
      `could not verify or revert ${spec.cli}'s MCP config: ${current.reason}`
    );
  }

  return {
    kind: partial
      ? "partial"
      : jobId || capabilityFileRemoved || vendorConfigReverted
        ? "detached"
        : "not-attached",
    jobId,
    capabilityFileRemoved,
    vendorConfigReverted,
    notes,
  };
}
