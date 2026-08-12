import type { DispatchStatus } from "@muon/client";
import { isJobTerminalAttachId } from "./job-terminal-attach.js";
import { parseChatTerminalScope } from "./terminal-session-id.js";
import {
  vendorSupportsTakeover,
  type TerminalTakeoverMode,
} from "./terminal-spawn.js";

/**
 * A4 — resolves the HOST-side cwd for a terminal session's real-pty path
 * (registerTerminalIpc's `resolveWorkspacePath`, invoked only when
 * MUON_REAL_PTY=1). Pulled out of main.ts as a small, pure, unit-testable
 * function: main.ts is the Electron entry point (side effects on import), so
 * this is the only piece of that wiring that can be exercised without a
 * running app.
 *
 * Two id families reach here:
 *  - "chat:<chatId>" — the current standalone terminal identity, and
 *    "chat:<chatId>:<kind>.<n>" — one human vendor/shell TAB in that chat's
 *    workspace (the vendor tab bar; see terminal-session-id.ts). Both resolve
 *    the chat HOST-side, so switching chats can never reattach a session to
 *    the previous chat's workspace.
 *  - anything else — a real subagent terminal's jobId, resolved through the
 *    injected `getDispatchJob` exactly as before.
 *
 * REMOVED 2026-07-30 — the third branch, `jobId === "shell"`. It claimed to
 * serve "the standalone 'New terminal' tab (session id `terminal-shell`, see
 * app.tsx)". That was false in the way this repo treats as a defect in its own
 * right: app.tsx has never produced `terminal-shell` — it names
 * `terminal-chat:<chatId>` everywhere — so the branch served an id no surface
 * of ours emits. Two things hung off it:
 *  - it was the ONLY cwd branch with no `status === "archived"` refusal, while
 *    both neighbours have one; reachable by archiving a chat from CLI/TUI while
 *    the desktop still held it bound, and
 *  - `authorizeRendererTerminalClose("terminal-shell")` routes to
 *    `getDispatchJob("shell")` → 404 → throw, and `closeChatSessions` does not
 *    match the id either, so NOTHING but app quit could kill the pty this
 *    branch authorized. A slot nothing can close is a slot that leaks a live
 *    vendor child — the exact defect class terminal-host.ts was written to
 *    prevent, re-entered through an id the renderer no longer uses but could
 *    still name.
 * `"shell"` now falls through to the job lookup like any other unknown id and
 * refuses there. No caller changed, because no caller ever sent it.
 *
 * Unknown/unresolvable ids (a bad jobId, an archived chat, a lookup throw) all
 * resolve to `null` — the caller (terminal-host.ts) REFUSES the real-pty open
 * on `null` rather than falling back to the app's own launch directory. This
 * function only decides WHERE to look; it never substitutes a fallback cwd
 * itself.
 */
export async function resolveTerminalWorkspacePath(
  jobId: string,
  boundChatId: string | null,
  // `boundWorkspace` USED TO BE THE THIRD PARAMETER and is gone with the
  // `"shell"` branch above — it was the only thing that read it. A cwd resolver
  // that still accepted the app's ambient workspace would be an invitation to
  // reintroduce the fallback the caller's refusal exists to prevent.
  getDispatchJob: (
    jobId: string
  ) => Promise<{
    workspacePath?: string | null;
    chatId?: string | null;
    executionPath?: string | null;
  }>,
  getChat: (
    chatId: string
  ) => Promise<{ workspacePath?: string | null; status?: string }>
): Promise<string | null> {
  // 0038, second lock on the same door as terminal-host.ts: a live-console
  // ATTACH coordinate (`pty:job:<jobId>:<epoch>`) must never resolve a worktree,
  // because resolving one is what lets a spawn proceed. Null ⇒ the caller
  // REFUSES the open, which is the correct answer for a coordinate that names
  // an already-running process rather than a new one.
  if (isJobTerminalAttachId(jobId)) {
    return null;
  }
  if (jobId.startsWith("chat:")) {
    // Both shapes of a human workspace session resolve here: the legacy
    // single-shell id (`chat:<chatId>`) and a vendor-tab slot
    // (`chat:<chatId>:<kind>.<n>`, terminal-session-id.ts). The slot names
    // only which TAB this is — the kind that gets spawned still comes from
    // the renderer's spawn hint through the host allowlist, and the cwd from
    // the chat record below. Same chat authorization for every slot.
    const scope = parseChatTerminalScope(jobId.slice("chat:".length));
    const chatId = scope?.chatId;
    if (!chatId || chatId !== boundChatId) {
      return null;
    }
    try {
      const chat = await getChat(chatId);
      return chat.status === "archived" ? null : (chat.workspacePath ?? null);
    } catch {
      return null;
    }
  }
  if (!boundChatId) {
    return null;
  }
  try {
    const job = await getDispatchJob(jobId);
    if (job.chatId !== boundChatId) {
      return null;
    }
    const chat = await getChat(boundChatId);
    if (chat.status === "archived") {
      return null;
    }
    // WHERE THE JOB ACTUALLY RAN wins over where it was configured to run:
    // `executionPath` is the fact the lease-holding runner recorded (the
    // task's isolated worktree for editing harnesses), so a human session or
    // a resume opens IN the same directory the dispatched vendor used —
    // which is also what `claude --resume` needs, because claude keys its
    // session store off the cwd. `workspacePath` remains the fallback for a
    // pre-0039 row or a job that never reached launch.
    return job.executionPath ?? job.workspacePath ?? null;
  } catch {
    return null;
  }
}

/**
 * The answer to "may this job's vendor session be reopened, and as what".
 * A refusal carries its own sentence so the terminal host can state it rather
 * than collapsing every cause into one misleading message.
 *
 * `mode` is part of the GRANT, not a hint: it says which of the two doors this
 * job is authorized for right now (see TerminalTakeoverMode), and the spawn
 * resolver composes argv from it.
 */
export type TerminalVendorSessionLookup =
  | {
      ok: true;
      vendor: string;
      sessionId: string;
      mode: TerminalTakeoverMode;
    }
  | {
      ok: false;
      reason: string;
      /**
       * "NOT YET", as distinct from "no".
       *
       * Set only when BOTH halves hold, and each half is stated by the party
       * that knows it — never inferred from the other:
       *
       *  - the JOB is still running (this resolver's own fact), and
       *  - the REFUSAL names something that flips while it runs: the vendor
       *    has not reported a session id yet, or the store check itself
       *    answered `transient` because the vendor has not written the session
       *    into its own store yet (a `codex exec` rollout measured 3 seconds
       *    into a 30-second run; ADR-0025 §3.2).
       *
       * The second half used to be assumed from the first, which was wrong in
       * both directions the store can refuse without a race: a job with no
       * recorded cwd, and a cwd whose worktree had been merged and pruned,
       * both got "can't be opened YET", 21 probes over 40 seconds, and a
       * "Check again" that would answer identically forever.
       *
       * Deliberately NOT set for a refusal that cannot change during the run:
       * a foreign chat, a vendor with no fork at all, an attach coordinate, a
       * pruned worktree, or a lookup that threw. Absent ⇒ "no", so a producer
       * that forgets it can only ever make the pane quieter, never make it
       * promise a door.
       */
      pending?: boolean;
    };

/**
 * IS THE GOVERNED CHILD STILL DRIVING THIS JOB'S SESSION? — stated POSITIVELY
 * for EVERY status, never derived by subtraction from an "active" list.
 *
 * `Record<DispatchStatus, boolean>` is total by construction, so a status added
 * to the protocol cannot land here as a silent `false`: it is a compile error
 * until someone classifies it. That matters because `false` is the permission —
 * it is what grants `resume`, the door that would put a second writer on a
 * transcript — and a tier derived by subtraction is exactly how this repo has
 * previously widened an authority by adding a member somewhere else.
 *
 * What the `false` rows are claiming: `done`, `failed` and `interrupted` are
 * terminal transitions MUON itself wrote, and a terminal transition is one-way.
 * Two residual cases where a `false` job may STILL have a live vendor child are
 * named in ADR-0025 §5; neither is decidable from the fields this resolver can
 * read, and both predate the fork door.
 */
export const JOB_STATUS_DRIVES_SESSION: Readonly<
  Record<DispatchStatus, boolean>
> = {
  queued: true,
  running: true,
  done: false,
  failed: false,
  // RESIDUAL, recorded rather than guessed at (ADR-0025 §5): the runner-lease
  // reclaim writes `interrupted` while saying in its own result string that a
  // prior vendor process may still be alive. The common producer of this status
  // is a human SIGINT, whose child the runner did kill — and the two are not
  // distinguishable from any field on the job record MUON exposes here.
  interrupted: false,
};

/**
 * Statuses during which the governed child is still driving the session, read
 * from the table above so the two can never disagree.
 */
const ACTIVE_JOB_STATUSES = new Set(
  Object.entries(JOB_STATUS_DRIVES_SESSION)
    .filter(([, driving]) => driving)
    .map(([status]) => status)
);

/**
 * HOST-side lookup of a job's recorded vendor session (the `vendorSessionId`
 * the lease-holding runner stamped) for a `<vendor>:resume` terminal open.
 *
 * Same authorization shape as the workspace resolver above — the job must
 * belong to the chat bound to THIS window — and every failure is a REFUSAL
 * with a reason, never a guess.
 *
 * A STILL-RUNNING job resolves to `mode: "fork"`, and that decision is made
 * HERE rather than in the renderer. The rule it encodes has not been relaxed:
 * RESUMING a session a governed child is still driving would put two writers
 * on one transcript, and the vendor's own session file is not written for
 * concurrent editors — so a running job is never granted `"resume"`, by any
 * caller, however it asks. What changed is that "two writers" is a reason to
 * pick a different door, not a reason to have none: a fork is a SECOND vendor
 * session seeded from the same history, so the governed child keeps sole
 * ownership of the original and the human still gets a live keyboard.
 *
 * The renderer names neither the mode nor the id. It asks about a job; this
 * function reads the job's own status and answers with both.
 *
 * `verifyStore` is the DEAD-BUTTON GUARD (lib/vendor-session-store.ts): a
 * recorded id is a claim MUON made at dispatch time, and the vendor's own
 * store is the fact — an ephemeral thread codex never saved, a pruned
 * worktree, a cleared temp store all leave the column pointing at nothing,
 * and the founder's click answered with codex's own "No saved session found".
 * When the dep is wired, an id the store cannot back REFUSES with the store's
 * own sentence. It runs on BOTH consumers of this resolver — the renderer's
 * button probe and the spawn-time authorization — so the affordance and the
 * action can never disagree about resumability.
 */
export async function resolveTerminalVendorSession(
  jobId: string,
  boundChatId: string | null,
  getDispatchJob: (
    jobId: string
  ) => Promise<{
    chatId?: string | null;
    vendor?: string | null;
    status?: string | null;
    vendorSessionId?: string | null;
    executionPath?: string | null;
    workspacePath?: string | null;
  }>,
  verifyStore?: (input: {
    vendor: string;
    sessionId: string;
    cwd: string | null;
    mode: TerminalTakeoverMode;
  }) =>
    | { ok: true; evidencePath: string }
    // `transient` is the STORE's own statement about whether its refusal can
    // change while the vendor keeps working (vendor-session-store.ts). It is
    // required so this resolver can never go back to guessing it from the job
    // status — which is how a pruned worktree acquired a "not yet".
    | { ok: false; reason: string; transient: boolean }
): Promise<TerminalVendorSessionLookup> {
  if (isJobTerminalAttachId(jobId)) {
    return {
      ok: false,
      reason:
        "this is a governed agent's live console coordinate, not a resumable session.",
    };
  }
  if (!boundChatId) {
    return {
      ok: false,
      reason: "no mission is selected in this window, so MUON cannot authorize a resume.",
    };
  }
  try {
    const job = await getDispatchJob(jobId);
    if (job.chatId !== boundChatId) {
      return {
        ok: false,
        reason: "this job belongs to a different mission than the one selected here.",
      };
    }
    // THE ONE FACT THAT PICKS THE DOOR. Read from the job record, never from
    // the caller: a running job can only ever be granted a fork.
    const running = ACTIVE_JOB_STATUSES.has(job.status ?? "");
    const mode: TerminalTakeoverMode = running ? "fork" : "resume";
    const vendor = job.vendor?.trim();
    const sessionId = job.vendorSessionId?.trim();
    if (!vendor || !sessionId) {
      return {
        ok: false,
        reason: running
          ? "MUON has not recorded this job's vendor session yet — the id is stamped as soon as the vendor reports one, usually within the first seconds of a run. This pane will offer the door once it has."
          : "MUON has no recorded vendor session for this job, so there is nothing to reopen. A session id is recorded once the vendor reports one; jobs that ran before this feature, or that were killed before reporting, have none.",
        // A running job's missing stamp is the textbook "not yet": the id
        // lands mid-run, so the FIRST answer is routinely a miss.
        ...(running ? { pending: true } : {}),
      };
    }
    // Stated POSITIVELY, from the same table the spawn composes argv from: a
    // vendor that has no fork is refused a LIVE takeover even though it has a
    // perfectly good resume, rather than silently falling back to the resume
    // that the running-job rule exists to forbid.
    if (!vendorSupportsTakeover(vendor, mode)) {
      return {
        ok: false,
        reason: running
          ? `${vendor} has no way to fork a session that is still being written, so MUON cannot open this job's session while its agent is still working. It will offer it when the job finishes.`
          : `Sessions on '${vendor}' cannot be reopened in a terminal — the vendor's CLI has no session resume for MUON to drive.`,
      };
    }
    if (verifyStore) {
      // Where the job ACTUALLY ran wins over where it was configured to run —
      // the same precedence the workspace resolver above applies, because the
      // vendor's store is keyed off the directory the dispatched child used.
      let stored:
        | { ok: true; evidencePath: string }
        | { ok: false; reason: string; transient: boolean };
      try {
        stored = verifyStore({
          vendor,
          sessionId,
          cwd: job.executionPath ?? job.workspacePath ?? null,
          mode,
        });
      } catch {
        stored = {
          ok: false,
          reason:
            "MUON could not check the vendor's own session store, so it will not offer a resume it cannot vouch for.",
          // An unexpected failure of the check itself is not a race the vendor
          // is going to win — fail closed to the quieter answer.
          transient: false,
        };
      }
      if (!stored.ok) {
        // WHILE THE JOB RUNS, a store MISS is a RACE, not a verdict. The
        // vendor writes its session file at its own pace — a `codex exec`
        // rollout appeared 3 seconds into a 30-second run — and the probe
        // fires within about a second of the id being stamped. Reporting that
        // window as "this session cannot be reopened" is a permanent claim
        // about a transient fact, which is exactly the class of quiet lie the
        // dead-button guard exists to stop pointing the other way.
        //
        // But only a MISS. `running` alone was the wrong test: the store also
        // refuses for a job with no recorded cwd and for a cwd whose worktree
        // has been pruned, neither of which changes however long the job keeps
        // running. The store now says which kind of refusal it is, so this
        // reads the fact instead of inferring it.
        return {
          ok: false,
          reason: stored.reason,
          ...(running && stored.transient ? { pending: true } : {}),
        };
      }
    }
    return { ok: true, vendor, sessionId, mode };
  } catch {
    return {
      ok: false,
      reason:
        "MUON could not read this job while authorizing the resume. It will work again once the brain is reachable.",
    };
  }
}
