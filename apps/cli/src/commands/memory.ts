import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { failCommand, exitCodeForError, formatRefusal } from "../lib/refusal.js";
import type {
  MemoryGraphNode,
  MemoryGraphRelation,
  MemoryPackExport,
  MemoryPackImportReport,
  MemoryLifecyclePolicy,
} from "@muon/client";
import { memoryNoteTier } from "@muon/client";
import {
  parseMemoryFilterJson,
  MEMORY_FILTER_FIELDS,
  MEMORY_FILTER_OPERATORS,
  type MemoryFilter,
} from "@muon/protocol";
import { MuonApiClient } from "../lib/api-client.js";
import { printError, printJson } from "../lib/output.js";
import type { MemoryNote } from "../types.js";

const kindSchema = z.enum([
  "decision",
  "constraint",
  "convention",
  "attempt",
  "question",
]);
const trustSchema = z.enum(["low", "medium", "high"]);
const graphRelationSchema = z.enum([
  "SUPERSEDES",
  "CONTRADICTS",
  "AUTHORED_BY",
  "CONFIRMED_BY",
  "ANCHORED_TO",
  "ABOUT_SYMBOL",
  "ABOUT_TASK",
  "BY_LANE",
  "TOUCHED",
  "WORKED_ON",
  "GATED_BY",
  "CLONED_FROM",
]);

// ── R5 filter grammar, CLI side ─────────────────────────────────────────────
//
// The SAME @muon/protocol validator the backend and the MCP tools use, so
// `--filter` is refused here with the identical reason it would be refused with
// server-side. The description is generated from the grammar itself, so a new
// field or operator can never leave the CLI help stale.
const FILTER_OPTION_HELP =
  `Bounded JSON filter: {"field":…,"op":…,"value":…}, combine with and/or/not. ` +
  `Fields: ${Object.keys(MEMORY_FILTER_FIELDS).join(", ")}. ` +
  `Operators: ${MEMORY_FILTER_OPERATORS.join(", ")}`;

/** Parse a `--filter` argument, throwing the grammar's own refusal reason. */
function parseFilterOption(raw: string | undefined): MemoryFilter | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseMemoryFilterJson(raw);
  if (!parsed.ok) {
    throw new Error(`--filter rejected: ${parsed.reason}`);
  }
  return parsed.filter;
}

// ── ADR-0026 §9: the CLI gains a DEFAULT, not an option ─────────────────────
//
// ADR-0026 §1 measured these commands as the unfenced operator surfaces: `search`,
// `library` and `recall` sent no partition coordinate at all, so one invocation
// read every repo's memory on the machine. The hard gate defaults to today's
// behaviour when a surface says nothing (§5), which is exactly why a forgotten
// coordinate here is an unclosed hole and why the fix is a DEFAULT rather than a
// flag nobody would pass.
//
// Three states, and they are the CLI's whole contract with the partition:
//   • (default)              → the invoking directory.
//   • --workspace <path>     → that directory instead.
//   • --unscoped             → §8's residue view: ONLY notes with no workspace.
//
// The raw path goes on the wire and the SERVER canonicalizes it, case-corrects it
// against the filesystem, and reduces a worktree to its parent repo. The CLI
// deliberately does none of that: a second evaluator of that reduction is how a
// read starts disagreeing with the write that stored the value.
const WORKSPACE_OPTION_HELP =
  "Fence this read to one workspace (default: the invoking directory's repo root)";
const UNSCOPED_OPTION_HELP =
  "Read ONLY notes with no workspace assignment (the unassigned residue; operator-only)";

type WorkspaceOptions = { workspace?: string; unscoped?: boolean };

/** The resolved wire coordinate. `--unscoped` suppresses the cwd default, because
 *  sending both is refused server-side — and refused rather than silently
 *  preferring one, so a surface can never quietly read the wrong partition. */
function workspaceArgs(options: WorkspaceOptions): {
  workspace?: string;
  unscoped?: boolean;
} {
  if (options.unscoped) {
    if (options.workspace) {
      throw new Error("--workspace and --unscoped are mutually exclusive.");
    }
    return { unscoped: true };
  }
  return { workspace: options.workspace ?? process.cwd() };
}

/** The one-line partition banner every fenced read prints, so a human never has to
 *  infer which repo an answer came from. */
function workspaceBanner(options: WorkspaceOptions): string {
  const resolved = workspaceArgs(options);
  return resolved.unscoped
    ? "workspace: unscoped (notes with no workspace assignment)\n"
    : `workspace: ${resolved.workspace}\n`;
}

/** Add the two partition options to a command. One definition, so no command can
 *  drift into a laxer spelling of the same coordinate. */
function withWorkspaceOptions(command: Command): Command {
  return command
    .option("--workspace <path>", WORKSPACE_OPTION_HELP)
    .option("--unscoped", UNSCOPED_OPTION_HELP);
}

/**
 * The operator's crew-visible posture (`autoConfirmAgentMemory`), read from
 * the brain so the terminal frames an agent note exactly as the desktop does.
 * STRICT on any failure — an agent-tier token (403), an old brain, or a test
 * double without the method all read as OFF, which only ever presents a note
 * as LESS settled. Sync throws (a mock missing the method) are converted to
 * the same strict answer.
 */
async function crewFraming(client: MuonApiClient): Promise<boolean> {
  return Promise.resolve()
    .then(() => client.getAutoConfirmAgentMemory())
    .catch(() => false);
}

/**
 * P0-2 — does this note still owe the OPERATOR a decision? Exactly when the
 * shared tier rule says nobody is carrying it ("open"): a human confirm, an
 * orchestrator vouch, and — with the operator's crew-visible posture ON — the
 * auto framing all settle it; an expired note is unsettled again whatever once
 * vouched, because nothing is vouching for it now.
 *
 * This used to restate the rule locally and drifted (it never learned the
 * "auto" tier), so the same note read "Auto · crew memory" on the desktop and
 * sat in the terminal's review queue as homework. One rule now:
 * @muon/client's memoryNoteTier.
 */
function awaitingHumanReview(
  note: MemoryNote,
  autoConfirmAgentMemory: boolean
): boolean {
  return memoryNoteTier(note, autoConfirmAgentMemory) === "open";
}

/**
 * P0-3 — the ONE confirm-tier word a printed row may use, so `memory recall`,
 * `memory review` and `memory library` cannot describe the same note three
 * different ways. A direct projection of the shared tier vocabulary.
 */
function confirmFlag(
  note: MemoryNote,
  autoConfirmAgentMemory: boolean
): string {
  const tier = memoryNoteTier(note, autoConfirmAgentMemory);
  if (tier === "human") return "confirmed";
  if (tier === "muon") return "muon-approved";
  if (tier === "auto") return "auto-crew";
  return "unconfirmed";
}

function printNote(note: MemoryNote, autoConfirmAgentMemory = false) {
  const flags = [
    confirmFlag(note, autoConfirmAgentMemory),
    note.trust,
    ...(note.stale ? ["STALE"] : []),
    ...(note.status === "paused" ? ["PAUSED"] : []),
    ...(note.status === "rejected" ? ["REJECTED"] : []),
    // R3: an EXPIRED note only appears at all under --show-expired, so labelling
    // it is what tells the human this row is hidden from the crew's recall and
    // that confirming it is how to bring it back.
    ...(note.expired ? ["EXPIRED"] : []),
  ].join(",");
  const anchors = [
    // Author provenance first: a `by=pack:ws-…` note is visibly a FOREIGN
    // proposal (imported evidence awaiting the local human confirm), never
    // something this workspace authored.
    `by=${note.createdBy}`,
    // ADR-0026 §8 — THE LABEL, on EVERY row rather than only in the residue view.
    // §8 requires the unscoped view to label what it returns, and doing it per-row
    // also covers the one view that is genuinely mixed: an operator read that sends
    // no coordinate at all still gets today's every-repo answer (§5's monotonicity),
    // and that is precisely the page §1 measured spanning two repos with nothing
    // distinguishing them. A banner alone would leave that page unlabelled.
    `workspace=${note.workspacePath ?? "unscoped"}`,
    ...(note.taskId ? [`task=${note.taskId}`] : []),
    ...note.modules.map((m) => `module=${m}`),
    ...note.topics.map((t) => `topic=${t}`),
  ].join(" ");
  process.stdout.write(
    `- ${note.id} | ${note.kind} [${flags}] ${anchors}\n  ${note.text}\n`
  );
}

function printGraphNode(node: MemoryGraphNode) {
  const flags = [
    node.type,
    node.kind,
    node.trust,
    node.confirmed === undefined
      ? undefined
      : node.confirmed
        ? "confirmed"
        : "unconfirmed",
    node.status,
    node.textTruncated ? "text-truncated" : undefined,
  ].filter(Boolean);
  process.stdout.write(`- ${node.id} [${flags.join(",")}]\n`);
  if (node.text !== undefined) {
    process.stdout.write(`  ${node.text}\n`);
  } else if (node.type === "note") {
    process.stdout.write("  (coordinates only; note text is gated)\n");
  }
}

// ── P1.4 memory packs (slice 1: export writer) ───────────────────────────────
//
// The CLI is a dumb, deterministic WRITER of the operator-only export route's
// pack: `<store>/<originFingerprint>/muon-memory-pack.json` plus one
// content-addressed `records/<sha256>.json` per confirmed record. It prunes
// record files no longer in the manifest in ITS OWN origin subdir only (never a
// teammate's), writes every file atomically (temp-then-rename), and refuses
// with the server's reason when the route 4xxs. All redaction/filtering happens
// server-side; nothing here inspects or mutates record content.

const RECORD_FILE_RE = /^[0-9a-f]{64}\.json$/;
const RECORD_HASH_RE = /^[0-9a-f]{64}$/;
const MANIFEST_NAME = "muon-memory-pack.json";

// ── P1.4 memory packs (slice 2: import reader) ──────────────────────────────
//
// Import-side pre-validation is STRICT and fails fast: a malformed manifest or
// a missing/unresolvable record file refuses the pack locally with a reason and
// nothing is ever POSTed. Record files are resolved ONLY as
// `records/<64-hex-hash>.json` (content-addressed names), so manifest content
// can never induce a read outside the pack dir. All trust decisions live
// server-side: the backend re-verifies every byte and stages accepted records
// as unconfirmed PROPOSALS.

const packManifestFileSchema = z
  .object({
    version: z.number(),
    origin: z.object({ fingerprint: z.string().min(1), label: z.string() }),
    records: z.array(
      z.object({ hash: z.string().regex(RECORD_HASH_RE) }).passthrough()
    ),
    tombstones: z.array(z.unknown()),
    packDigest: z.string().regex(RECORD_HASH_RE),
  })
  .passthrough();

/** Resolve a store root (subdirs with manifests) or a single pack dir. */
function resolvePackDirs(root: string): string[] {
  if (fs.existsSync(path.join(root, MANIFEST_NAME))) {
    return [root];
  }
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, MANIFEST_NAME)))
    .sort();
  if (dirs.length === 0) {
    throw new Error(`no memory pack (${MANIFEST_NAME}) found under ${root}`);
  }
  return dirs;
}

/** Read + pre-validate one pack dir; throws a refusal reason on any defect. */
function loadPackDir(dir: string): MemoryPackExport {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), "utf8"));
  } catch (error) {
    throw new Error(
      `refusing pack ${dir}: unreadable or malformed manifest JSON (${
        error instanceof Error ? error.message : "parse failed"
      })`
    );
  }
  const parsed = packManifestFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    throw new Error(
      `refusing pack ${dir}: malformed manifest (${issue?.message ?? "invalid"}${at})`
    );
  }
  if (parsed.data.version !== 1) {
    throw new Error(
      `refusing pack ${dir}: unsupported pack version ${parsed.data.version}; re-export it with a compatible MUON`
    );
  }
  const records: { hash: string; record: unknown }[] = [];
  for (const entry of parsed.data.records) {
    // Strict content-addressed resolution (path-traversal guard): the filename
    // is DERIVED from the validated hash, never taken from the manifest.
    const file = path.join(dir, "records", `${entry.hash}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(
        `refusing pack ${dir}: record file missing: records/${entry.hash}.json`
      );
    }
    try {
      records.push({ hash: entry.hash, record: JSON.parse(fs.readFileSync(file, "utf8")) });
    } catch {
      throw new Error(
        `refusing pack ${dir}: malformed record file records/${entry.hash}.json`
      );
    }
  }
  return { manifest: raw, records } as MemoryPackExport;
}

/** Print the server's deterministic import report in its stable order. */
function printImportReport(dir: string, report: MemoryPackImportReport) {
  const counts = report.counts;
  process.stdout.write(
    `Imported ${dir} from ${report.origin.fingerprint} (${report.origin.label}): ` +
      `${counts.proposed ?? 0} proposed, ` +
      `${counts.duplicatesOfConfirmed ?? 0} confirmed-duplicate(s), ` +
      `${counts.alreadyImported ?? 0} already imported, ` +
      `${counts.conflicts ?? 0} conflict(s), ` +
      `${counts.revocations ?? 0} revocation(s), ` +
      `${counts.refused ?? 0} refused\n`
  );
  for (const row of report.proposed) {
    process.stdout.write(`  proposed ${row.noteId} <- ${row.recordHash}\n`);
  }
  for (const row of report.duplicatesOfConfirmed) {
    process.stdout.write(
      `  duplicate-of-confirmed ${row.noteId} <- ${row.recordHash}\n`
    );
  }
  for (const hash of report.alreadyImported) {
    process.stdout.write(`  already-imported ${hash}\n`);
  }
  for (const row of report.conflicts) {
    process.stdout.write(
      `  conflict ${row.noteId} ${row.edgeKind} ${row.withNoteId} (needs review)\n`
    );
  }
  for (const row of report.revocations) {
    process.stdout.write(
      `  revoked-at-origin ${row.noteId} (origin ${row.originNoteId}, ${row.reason}) -> flagged STALE for review\n`
    );
  }
  for (const row of report.refused) {
    process.stdout.write(`  refused ${row.recordHash}: ${row.reason}\n`);
  }
}

function writeFileAtomic(target: string, content: string) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

function writeMemoryPack(storeDir: string, pack: MemoryPackExport): string {
  const dir = path.join(storeDir, pack.manifest.origin.fingerprint);
  const recordsDir = path.join(dir, "records");
  fs.mkdirSync(recordsDir, { recursive: true });
  const expected = new Set(
    pack.manifest.records.map((entry) => `${entry.hash}.json`)
  );
  for (const { hash, record } of pack.records) {
    writeFileAtomic(
      path.join(recordsDir, `${hash}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
  }
  // Deterministic own-subdir state: a record no longer in the manifest (retired
  // → tombstoned at the origin) is removed, so the dir always mirrors the
  // manifest exactly. Only content-addressed names are ever considered.
  for (const entry of fs.readdirSync(recordsDir)) {
    if (RECORD_FILE_RE.test(entry) && !expected.has(entry)) {
      fs.rmSync(path.join(recordsDir, entry), { force: true });
    }
  }
  writeFileAtomic(
    path.join(dir, "muon-memory-pack.json"),
    `${JSON.stringify(pack.manifest, null, 2)}\n`
  );
  return dir;
}

export function registerMemoryCommands(
  program: Command,
  createClient: () => MuonApiClient
) {
  const memory = program
    .command("memory")
    .description("Work memory: decisions, constraints, conventions, attempts");

  memory
    .command("add")
    .description("Add a memory note (human-confirmable, provenanced)")
    .requiredOption(
      "--kind <kind>",
      "decision | constraint | convention | attempt | question"
    )
    .requiredOption("--text <text>", "The note itself")
    .option("--task-id <taskId>", "Anchor to a task")
    .option("--lane-id <laneId>", "Anchor to a lane")
    .option("--module <module...>", "Anchor to file/module path(s)")
    // ADR-0012 on-symbol anchoring: `<module>#<name>` ids. The pre-edit hero lifts
    // on-SYMBOL notes above on-module ones, so a note about a specific function
    // must be able to carry that anchor from the CLI, not modules-only.
    .option("--symbol <symbol...>", "Anchor to symbol id(s): <module>#<name>")
    .option("--topic <topic...>", "Topic tag(s)")
    .option("--trust <trust>", "low | medium | high (default medium)")
    .option("--by <createdBy>", "Author", "human")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        kind: string;
        text: string;
        taskId?: string;
        laneId?: string;
        module?: string[];
        symbol?: string[];
        topic?: string[];
        trust?: string;
        by: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const note = await client.addMemoryNote({
            kind: kindSchema.parse(options.kind),
            text: options.text,
            taskId: options.taskId,
            laneId: options.laneId,
            modules: options.module ?? [],
            symbols: options.symbol ?? [],
            topics: options.topic ?? [],
            trust: options.trust ? trustSchema.parse(options.trust) : undefined,
            createdBy: options.by,
          });
          if (options.json) {
            printJson({ note });
            return;
          }
          printNote(note, await crewFraming(client));
        } catch (error) {
          failCommand(error, "Memory add failed.");
        }
      }
    );

  withWorkspaceOptions(
    memory
      .command("search")
      .description(
        "Lexical search over memory notes (fenced to the invoking workspace)"
      )
      .argument("<query...>", "Search terms")
      .option("--show-expired", "Also return notes past their retention TTL")
      .option("--filter <json>", FILTER_OPTION_HELP)
      .option("--json", "Print as JSON")
  ).action(async (
    query: string[],
    options: {
      showExpired?: boolean;
      filter?: string;
      json?: boolean;
    } & WorkspaceOptions
  ) => {
    try {
      const client = createClient();
      const notes = await client.searchMemory(query.join(" "), {
        ...workspaceArgs(options),
        showExpired: options.showExpired,
        filter: parseFilterOption(options.filter),
      });
      if (options.json) {
        printJson({ notes });
        return;
      }
      process.stdout.write(workspaceBanner(options));
      if (notes.length === 0) {
        process.stdout.write("no matching notes\n");
        return;
      }
      // Never `forEach(printNote)`: forEach's index would land in the
      // autoConfirmAgentMemory parameter.
      const crewVisible = await crewFraming(client);
      notes.forEach((note) => printNote(note, crewVisible));
    } catch (error) {
      failCommand(error, "Memory search failed.");
    }
  });

  withWorkspaceOptions(
    memory
      .command("library")
      .description(
        "Browse the operator memory library (governed snapshot: filter by status/confirmed/kind/trust/text, fenced to the invoking workspace)"
      )
      .option("--q <text>", "Free-text filter over note text")
      .option("--status <status>", "all | active | paused | rejected", "all")
      .option("--confirmed <confirmed>", "all | confirmed | unconfirmed", "all")
      .option(
        "--kind <kind>",
        "decision | constraint | convention | attempt | question"
      )
      .option("--trust <trust>", "low | medium | high")
      .option("--limit <n>", "Max notes (1-200, default 200)")
      .option(
        "--show-expired",
        "Also list notes past their retention TTL (confirming one clears its expiry)"
      )
      .option("--filter <json>", FILTER_OPTION_HELP)
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        q?: string;
        status?: string;
        confirmed?: string;
        kind?: string;
        trust?: string;
        limit?: string;
        showExpired?: boolean;
        filter?: string;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          const limit =
            options.limit !== undefined ? Number(options.limit) : undefined;
          if (
            limit !== undefined &&
            (!Number.isInteger(limit) || limit < 1 || limit > 200)
          ) {
            throw new Error("--limit must be an integer of 1-200.");
          }
          const libraryClient = createClient();
          const snapshot = await libraryClient.listMemoryLibrary({
            ...workspaceArgs(options),
            q: options.q,
            status: options.status as
              | "all"
              | "active"
              | "paused"
              | "rejected"
              | undefined,
            confirmed: options.confirmed as
              | "all"
              | "confirmed"
              | "unconfirmed"
              | undefined,
            kind: options.kind
              ? kindSchema.parse(options.kind)
              : undefined,
            trust: options.trust ? trustSchema.parse(options.trust) : undefined,
            limit,
            showExpired: options.showExpired,
            filter: parseFilterOption(options.filter),
          });
          if (options.json) {
            printJson({ library: snapshot });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          process.stdout.write(
            `${snapshot.notes.length}/${snapshot.total} note(s)${
              snapshot.truncated ? " (truncated at limit)" : ""
            }\n`
          );
          const crewVisible = await crewFraming(libraryClient);
          snapshot.notes.forEach((note) => {
            const flags = [
              // P0-3: this list used to be the one place a MUON-vouched note
              // still read "unconfirmed", one command over from `review`
              // calling the very same note settled.
              confirmFlag(note, crewVisible),
              note.trust,
              ...(note.stale ? ["STALE"] : []),
              ...(note.status === "paused" ? ["PAUSED"] : []),
              ...(note.status === "rejected" ? ["REJECTED"] : []),
              ...(note.expired ? ["EXPIRED"] : []),
            ].join(",");
            process.stdout.write(
              `- ${note.id} | ${note.kind} [${flags}] by=${note.createdBy} ` +
                // ADR-0026 §8: the same per-row label `printNote` carries, on the
                // page §1 actually measured leaking.
                `workspace=${note.workspacePath ?? "unscoped"}\n  ${note.text}\n`
            );
          });
        } catch (error) {
          failCommand(error, "Memory library failed.");
        }
      }
    );

  withWorkspaceOptions(
    memory
      .command("analytics")
      .description(
        "Show coordinate-only load-bearing memory modules and communities (fenced to the invoking workspace: hot-module paths are workspace-relative)"
      )
      .option("--chat-id <chatId>", "Hard-scope analytics to one chat")
      .option("--limit <n>", "Maximum source notes (1-5000)", "2000")
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        chatId?: string;
        limit: string;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          const limit = Number(options.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
            throw new Error("--limit must be an integer from 1 to 5000.");
          }
          const analytics = await createClient().memoryAnalytics({
            ...workspaceArgs(options),
            chatId: options.chatId,
            limit,
          });
          if (options.json) {
            printJson({ analytics });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          process.stdout.write(
            `${analytics.source.notes} note(s), ${analytics.source.modules} module(s), ` +
              `${analytics.communities.length} communit${
                analytics.communities.length === 1 ? "y" : "ies"
              }${analytics.source.truncated ? " (truncated)" : ""}\n`
          );
          for (const module of analytics.hotModules) {
            process.stdout.write(
              `- ${module.module} | score=${module.score.toFixed(3)} | ` +
                `notes=${module.noteCount} | ${module.communityId}\n`
            );
          }
        } catch (error) {
          failCommand(error, "Memory analytics failed.");
        }
      }
    );

  withWorkspaceOptions(
    memory
      .command("access-analytics")
      .description(
        "Compare typed memory-delivery paths with later human confirmation (association, not causation)"
      )
      .option("--limit <n>", "Newest access rows to scan (1-50000)", "50000")
      .option("--json", "Print as JSON")
  ).action(
    async (
      options: { limit: string; json?: boolean } & WorkspaceOptions
    ) => {
      try {
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) {
          throw new Error("--limit must be an integer from 1 to 50000.");
        }
        const analytics = await createClient().memoryAccessAnalytics({
          ...workspaceArgs(options),
          limit,
        });
        if (options.json) {
          printJson({ accessAnalytics: analytics });
          return;
        }
        process.stdout.write(workspaceBanner(options));
        process.stdout.write(
          `${analytics.rowsScanned} access row(s), ${analytics.distinctNotes} note(s)` +
            `${analytics.truncated ? " (newest bounded window)" : ""}\n`
        );
        for (const row of analytics.byType) {
          const rate =
            row.confirmationRate === null
              ? "n/a"
              : `${(row.confirmationRate * 100).toFixed(1)}%`;
          process.stdout.write(
            `- ${row.accessType}: ${row.laterHumanConfirmedNotes}/` +
              `${row.accessedUnconfirmedNotes} later human-confirmed (${rate})\n`
          );
        }
        process.stdout.write("association only; this does not establish causation\n");
      } catch (error) {
        failCommand(error, "Memory access analytics failed.");
      }
    }
  );

  memory
    .command("promote-global")
    .description(
      "Promote a human-confirmed note to operator-governed global memory"
    )
    .requiredOption("--note-id <noteId>", "Memory note identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { noteId: string; json?: boolean }) => {
      try {
        const result = await createClient().promoteMemoryToGlobal(
          options.noteId
        );
        if (options.json) {
          printJson(result);
          return;
        }
        process.stdout.write(
          result.alreadyGlobal
            ? `${result.noteId} is already global\n`
            : `promoted ${result.noteId} to global memory\n`
        );
      } catch (error) {
        failCommand(error, "Memory promotion failed.");
      }
    });

  withWorkspaceOptions(
    memory
      .command("recall")
      .description(
        "Recall notes by task, lane, module, or topic (fenced to the invoking workspace — module/topic anchors are workspace-RELATIVE, so this read is workspace-fenced)"
      )
      .option("--task-id <taskId>", "Filter by task")
      .option("--lane-id <laneId>", "Filter by lane")
      .option("--module <module>", "Filter by module/file path")
      .option("--topic <topic>", "Filter by topic")
      .option("--show-expired", "Also return notes past their retention TTL")
      .option("--filter <json>", FILTER_OPTION_HELP)
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        taskId?: string;
        laneId?: string;
        module?: string;
        topic?: string;
        showExpired?: boolean;
        filter?: string;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          const client = createClient();
          const notes = await client.recallMemory({
            ...workspaceArgs(options),
            taskId: options.taskId,
            laneId: options.laneId,
            module: options.module,
            topic: options.topic,
            showExpired: options.showExpired,
            filter: parseFilterOption(options.filter),
          });
          if (options.json) {
            printJson({ notes });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          if (notes.length === 0) {
            process.stdout.write("no notes for this filter\n");
            return;
          }
          const crewVisible = await crewFraming(client);
          notes.forEach((note) => printNote(note, crewVisible));
        } catch (error) {
          failCommand(error, "Memory recall failed.");
        }
      }
    );

  withWorkspaceOptions(
    memory
      .command("neighbors")
      .description(
        "Traverse a bounded memory neighborhood (1-3 hops, fenced to the invoking workspace)"
      )
      .requiredOption("--node-id <nodeId>", "Memory note or canonical graph node id")
      .option("--hops <n>", "Traversal depth (1-3)", "1")
      .option(
        "--relation <relation...>",
        `Relationship filter: ${graphRelationSchema.options.join(" | ")}`
      )
      .option("--limit <n>", "Maximum returned nodes (1-100)", "40")
      .option("--chat-id <chatId>", "Hard-scope traversal to one chat")
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        nodeId: string;
        hops: string;
        relation?: string[];
        limit: string;
        chatId?: string;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          const hops = Number(options.hops);
          const limit = Number(options.limit);
          if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
            throw new Error("--hops must be an integer from 1 to 3.");
          }
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("--limit must be an integer from 1 to 100.");
          }
          const relations = options.relation?.map(
            (relation) => graphRelationSchema.parse(relation)
          ) as MemoryGraphRelation[] | undefined;
          const neighbors = await createClient().memoryNeighbors(options.nodeId, {
            ...workspaceArgs(options),
            hops,
            relations,
            limit,
            chatId: options.chatId,
          });
          if (options.json) {
            printJson({ neighbors });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          process.stdout.write(
            `${neighbors.nodes.length} node(s), ${neighbors.edges.length} edge(s), ` +
              `${neighbors.provenance.hops} hop(s)${
                neighbors.provenance.truncated ? " (truncated)" : ""
              }\n`
          );
          neighbors.nodes.forEach(printGraphNode);
        } catch (error) {
          failCommand(error, "Memory traversal failed.");
        }
      }
    );

  withWorkspaceOptions(
    memory
      .command("explain")
      .description(
        "Show the shortest governed provenance path for a memory note (fenced to the invoking workspace)"
      )
      .requiredOption("--note-id <noteId>", "Memory note identifier")
      .option("--limit <n>", "Maximum traversal nodes considered (1-100)", "100")
      .option("--chat-id <chatId>", "Hard-scope explanation to one chat")
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        noteId: string;
        limit: string;
        chatId?: string;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          const limit = Number(options.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("--limit must be an integer from 1 to 100.");
          }
          const explanation = await createClient().memoryExplain(options.noteId, {
            ...workspaceArgs(options),
            limit,
            chatId: options.chatId,
          });
          if (options.json) {
            printJson({ explanation });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          process.stdout.write(
            `goal=${explanation.path.goal} · ${Math.max(
              0,
              explanation.path.nodes.length - 1
            )} hop(s)${
              explanation.provenance.truncated ? " · traversal truncated" : ""
            }\n`
          );
          explanation.path.nodes.forEach(printGraphNode);
          if (explanation.contradictions.length > 0) {
            process.stdout.write(
              `contradictions (${explanation.contradictions.length}):\n`
            );
            explanation.contradictions.forEach(printGraphNode);
          }
        } catch (error) {
          failCommand(error, "Memory explanation failed.");
        }
      }
    );

  memory
    .command("delete")
    .description("Permanently tombstone a memory note (operator authority)")
    .requiredOption("--note-id <noteId>", "Memory note identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { noteId: string; json?: boolean }) => {
      try {
        const deletion = await createClient().deleteMemoryNote(options.noteId);
        if (options.json) {
          printJson({ deletion });
          return;
        }
        process.stdout.write(
          `${deletion.alreadyDeleted ? "already tombstoned" : "tombstoned"} ${deletion.noteId}\n`
        );
      } catch (error) {
        failCommand(error, "Memory deletion failed.");
      }
    });

  for (const pinned of [true, false] as const) {
    const command = pinned ? "pin" : "unpin";
    memory
      .command(command)
      .description(
        pinned
          ? "Protect a note; a confirmed global decision also joins workspace cold-start canon"
          : "Remove retention protection and any decision-canon membership"
      )
      .requiredOption("--note-id <noteId>", "Memory note identifier")
      .option("--json", "Print as JSON")
      .action(async (options: { noteId: string; json?: boolean }) => {
        try {
          const note = await createClient().updateMemoryNote({
            noteId: options.noteId,
            pinned,
            principal: "human",
          });
          if (options.json) {
            printJson({ note });
            return;
          }
          process.stdout.write(
            `${pinned ? "pinned" : "unpinned"} ${note.id}\n`
          );
        } catch (error) {
          failCommand(error, `Memory ${command} failed.`);
        }
      });
  }

  memory
    .command("clone")
    .description("Clone a memory note into a fresh unconfirmed proposal")
    .requiredOption("--note-id <noteId>", "Memory note identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { noteId: string; json?: boolean }) => {
      try {
        const clone = await createClient().cloneMemoryNote(options.noteId);
        if (options.json) {
          printJson({ clone });
          return;
        }
        process.stdout.write(
          `cloned ${clone.clonedFromNoteId} → ${clone.noteId} (unconfirmed)\n`
        );
      } catch (error) {
        failCommand(error, "Memory clone failed.");
      }
    });

  memory
    .command("compact")
    .description("Tombstone retired memory past the operator retention window")
    .option(
      "--retention-days <n>",
      "Persist a new retention window before compacting (1-3650)"
    )
    .option("--dry-run", "Report what would be tombstoned without writing")
    .option(
      "--max-forget <n>",
      "Cap how many notes this run may tombstone (1-500)"
    )
    .option("--batch-id <id>", "Group this compaction under a batch id for audit")
    .option("--reason <text>", "Operator reason recorded in provenance")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        retentionDays?: string;
        dryRun?: boolean;
        maxForget?: string;
        batchId?: string;
        reason?: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          if (options.retentionDays !== undefined) {
            const retentionDays = Number(options.retentionDays);
            if (
              !Number.isInteger(retentionDays) ||
              retentionDays < 1 ||
              retentionDays > 3_650
            ) {
              throw new Error(
                "--retention-days must be an integer from 1 to 3650."
              );
            }
            await client.setMemoryCompactionRetentionDays(retentionDays);
          }
          const removal: {
            dryRun?: boolean;
            maxForget?: number;
            batchId?: string;
            reason?: string;
          } = {};
          if (options.dryRun) {
            removal.dryRun = true;
          }
          if (options.maxForget !== undefined) {
            const maxForget = Number(options.maxForget);
            if (
              !Number.isInteger(maxForget) ||
              maxForget < 1 ||
              maxForget > 500
            ) {
              throw new Error("--max-forget must be an integer from 1 to 500.");
            }
            removal.maxForget = maxForget;
          }
          if (options.batchId !== undefined) {
            removal.batchId = options.batchId;
          }
          if (options.reason !== undefined) {
            removal.reason = options.reason;
          }
          const compaction = await client.compactMemory(removal);
          if (options.json) {
            printJson({ compaction });
            return;
          }
          process.stdout.write(
            compaction.dryRun
              ? `dry run: would tombstone ${compaction.tombstoned}/${compaction.scanned} retired note(s) ` +
                  `older than ${compaction.retentionDays} day(s)\n`
              : `tombstoned ${compaction.tombstoned}/${compaction.scanned} retired note(s) ` +
                  `older than ${compaction.retentionDays} day(s)` +
                  (compaction.batchId ? ` (batch ${compaction.batchId})` : "") +
                  `\n`
          );
        } catch (error) {
          failCommand(error, "Memory compaction failed.");
        }
      }
    );

  // ── R3 TTL: the operator's policy dial + the on-demand sweep ───────────────
  memory
    .command("ttl")
    .description(
      "Show or set the retention TTL for unconfirmed agent memory (confirmed, human-authored, and high-trust notes never expire)"
    )
    .option(
      "--days <n>",
      "Days an eligible note stays recallable (0 disables expiry, max 3650)"
    )
    .option(
      "--trust-ceiling <trust>",
      "Highest trust that still expires: low | medium"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        days?: string;
        trustCeiling?: string;
        json?: boolean;
      }) => {
        try {
          const client = createClient();
          const ceilingSchema = z.enum(["low", "medium"]);
          let policy = await client.getMemoryTtlPolicy();
          if (options.days !== undefined || options.trustCeiling !== undefined) {
            const days =
              options.days !== undefined ? Number(options.days) : policy.days;
            if (!Number.isInteger(days) || days < 0 || days > 3_650) {
              throw new Error("--days must be an integer from 0 to 3650.");
            }
            policy = await client.setMemoryTtlPolicy({
              days,
              trustCeiling:
                options.trustCeiling !== undefined
                  ? ceilingSchema.parse(options.trustCeiling)
                  : policy.trustCeiling,
            });
          }
          if (options.json) {
            printJson({ ttl: policy });
            return;
          }
          process.stdout.write(
            policy.days === 0
              ? "memory TTL disabled: no note auto-expires\n"
              : `unconfirmed agent memory at or below ${policy.trustCeiling} trust ` +
                  `hides after ${policy.days} day(s); confirming a note clears its expiry\n`
          );
        } catch (error) {
          failCommand(error, "Memory TTL failed.");
        }
      }
    );

  memory
    .command("lifecycle-policy")
    .description(
      "Preview or activate kind-dependent memory lifetimes (apply requires the exact dry-run digest)"
    )
    .option("--decision-days <n>", "Decision lifetime in days; 0 = never")
    .option("--constraint-days <n>", "Constraint lifetime in days; 0 = never")
    .option("--convention-days <n>", "Convention lifetime in days; 0 = never")
    .option("--attempt-days <n>", "Attempt lifetime in days; 0 = never")
    .option("--question-days <n>", "Question lifetime in days; 0 = never")
    .option(
      "--trust-ceiling <trust>",
      "Highest trust that may expire: low | medium"
    )
    .option("--dry-run", "Count exact deadline changes without writing")
    .option(
      "--apply <previewDigest>",
      "Apply only the exact ledger snapshot returned by --dry-run"
    )
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        decisionDays?: string;
        constraintDays?: string;
        conventionDays?: string;
        attemptDays?: string;
        questionDays?: string;
        trustCeiling?: string;
        dryRun?: boolean;
        apply?: string;
        json?: boolean;
      }) => {
        try {
          if (options.dryRun && options.apply) {
            throw new Error("Use either --dry-run or --apply, not both.");
          }
          const client = createClient();
          const setting = await client.getMemoryLifecyclePolicy();
          const migrating = Boolean(options.dryRun || options.apply);
          const overrides = [
            options.decisionDays,
            options.constraintDays,
            options.conventionDays,
            options.attemptDays,
            options.questionDays,
            options.trustCeiling,
          ].some((value) => value !== undefined);
          if (overrides && !migrating) {
            throw new Error(
              "Lifecycle changes require --dry-run first, then --apply <digest>."
            );
          }

          // First activation starts from the proposed table; later edits start
          // from the table already in force. Either way every changed row still
          // faces the same preview digest protocol.
          const base =
            setting.source === "legacy_global"
              ? setting.recommended
              : setting.policy;
          const parseDays = (
            raw: string | undefined,
            fallback: number
          ): number => {
            if (raw === undefined) return fallback;
            const value = Number(raw);
            if (!Number.isInteger(value) || value < 0 || value > 3_650) {
              throw new Error("Lifecycle days must be integers from 0 to 3650.");
            }
            return value;
          };
          const ceiling = options.trustCeiling ?? base.trustCeiling;
          if (ceiling !== "low" && ceiling !== "medium") {
            throw new Error("--trust-ceiling must be low or medium.");
          }
          const policy: MemoryLifecyclePolicy = {
            version: 1,
            trustCeiling: ceiling,
            daysByKind: {
              decision: parseDays(
                options.decisionDays,
                base.daysByKind.decision
              ),
              constraint: parseDays(
                options.constraintDays,
                base.daysByKind.constraint
              ),
              convention: parseDays(
                options.conventionDays,
                base.daysByKind.convention
              ),
              attempt: parseDays(options.attemptDays, base.daysByKind.attempt),
              question: parseDays(
                options.questionDays,
                base.daysByKind.question
              ),
            },
            permanentWhenConfirmedByKind:
              base.permanentWhenConfirmedByKind,
          };

          if (!migrating) {
            if (options.json) {
              printJson({ lifecycle: setting });
              return;
            }
            process.stdout.write(
              `memory lifecycle: ${setting.source}\n` +
                Object.entries(setting.policy.daysByKind)
                  .map(
                    ([kind, days]) =>
                      `  ${kind}: ${days === 0 ? "never" : `${days}d`}`
                  )
                  .join("\n") +
                `\n  trust ceiling: ${setting.policy.trustCeiling}\n`
            );
            return;
          }

          const result = await client.migrateMemoryLifecyclePolicy(
            policy,
            options.dryRun
              ? { dryRun: true }
              : { dryRun: false, previewDigest: options.apply! }
          );
          if (options.json) {
            printJson({ lifecycleMigration: result });
            return;
          }
          process.stdout.write(
            `${result.dryRun ? "dry run" : "applied"}: ` +
              `${result.changed}/${result.scanned} deadline(s) change; ` +
              `${result.wouldHideNow} hide now, ${result.wouldRestoreNow} restore now, ` +
              `${result.wouldBecomePermanent} become permanent\n` +
              (result.dryRun
                ? `apply with --apply ${result.previewDigest} and the same policy options\n`
                : `kind-dependent lifecycle active (${result.previewDigest})\n`)
          );
        } catch (error) {
          failCommand(error, "Memory lifecycle policy failed.");
        }
      }
    );

  memory
    .command("sweep-expired")
    .description(
      "Materialize the soft tombstone for notes past their TTL (bounded, idempotent, never deletes)"
    )
    .option("--dry-run", "Report what would expire without writing")
    .option(
      "--max-forget <n>",
      "Cap how many notes this run may expire (1-500)"
    )
    .option("--batch-id <id>", "Group this sweep under a batch id for reversal")
    .option("--reason <text>", "Operator reason recorded in provenance")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        dryRun?: boolean;
        maxForget?: string;
        batchId?: string;
        reason?: string;
        json?: boolean;
      }) => {
        try {
          const removal: {
            dryRun?: boolean;
            maxForget?: number;
            batchId?: string;
            reason?: string;
          } = {};
          if (options.dryRun) {
            removal.dryRun = true;
          }
          if (options.maxForget !== undefined) {
            const maxForget = Number(options.maxForget);
            if (
              !Number.isInteger(maxForget) ||
              maxForget < 1 ||
              maxForget > 500
            ) {
              throw new Error("--max-forget must be an integer from 1 to 500.");
            }
            removal.maxForget = maxForget;
          }
          if (options.batchId !== undefined) {
            removal.batchId = options.batchId;
          }
          if (options.reason !== undefined) {
            removal.reason = options.reason;
          }
          const sweep = await createClient().sweepExpiredMemory(removal);
          if (options.json) {
            printJson({ sweep });
            return;
          }
          const horizon =
            sweep.policySource === "kind_table"
              ? "its kind-specific lifecycle deadline"
              : `a ${sweep.ttlDays}-day TTL`;
          process.stdout.write(
            sweep.skipped
              ? "memory expiry sweep skipped: the TTL policy is unreadable, nothing was expired\n"
              : sweep.dryRun
                ? `dry run: would expire ${sweep.expired}/${sweep.scanned} scanned note(s) ` +
                    `past ${horizon} (hidden, not deleted)\n`
                : `expired ${sweep.expired}/${sweep.scanned} scanned note(s) ` +
                    `past ${horizon} (hidden, not deleted)` +
                    (sweep.batchId ? ` (batch ${sweep.batchId})` : "") +
                    `\n`
          );
        } catch (error) {
          failCommand(error, "Memory expiry sweep failed.");
        }
      }
    );

  memory
    .command("revert-expired-batch")
    .description(
      "Reverse a soft expiry sweep as a unit (compaction batches are not reversible)"
    )
    .argument("<batchId>", "The batch id returned by sweep-expired")
    .option("--json", "Print as JSON")
    .action(async (batchId: string, options: { json?: boolean }) => {
      try {
        const result = await createClient().revertExpiredMemoryBatch(batchId);
        if (options.json) {
          printJson({ revert: result });
          return;
        }
        process.stdout.write(
          `reverted ${result.reverted} expired note(s) from batch ${result.batchId}\n`
        );
      } catch (error) {
        failCommand(error, "Memory batch revert failed.");
      }
    });

  withWorkspaceOptions(
    memory
      .command("review")
      .description(
        "Review queue: UNVOUCHED notes awaiting confirm/reject, for one workspace (MUON-approved crew memory is settled and never listed)"
      )
      .option("--task-id <taskId>", "Filter by task")
      .option("--lane-id <laneId>", "Filter by lane")
      .option(
        "--auto",
        "Only notes captured automatically (muon-capture / muon-extractor)"
      )
      .option(
        "--from-pack",
        "Only notes imported from teammate memory packs (createdBy pack:*)"
      )
      // R3: an expired note is still unconfirmed and still redeemable — confirming
      // it clears its expiry — so the review queue is exactly where a human needs
      // to be able to see one. Opt-in, like every other expired view.
      .option("--show-expired", "Also review notes past their retention TTL")
      .option("--json", "Print as JSON")
  ).action(
      async (options: {
        taskId?: string;
        laneId?: string;
        auto?: boolean;
        fromPack?: boolean;
        showExpired?: boolean;
        json?: boolean;
      } & WorkspaceOptions) => {
        try {
          // ADR-0026 §1 named this call site (`recall` at :942) among the unfenced
          // ones. It is also where `--unscoped` earns its keep: the §8 residue is
          // adjudicated in exactly this queue, so `muon memory review --unscoped`
          // is the operator path for assigning or confirming an unassigned note.
          const client = createClient();
          const notes = await client.recallMemory({
            ...workspaceArgs(options),
            taskId: options.taskId,
            laneId: options.laneId,
            showExpired: options.showExpired,
          });
          // The operator's crew-visible posture decides whether an "auto" note
          // is homework here, exactly as it does on the desktop's queue.
          const crewVisible = await crewFraming(client);
          const pending = notes
            .filter(
              (note) =>
                // P0-2: the queue is what still owes the HUMAN a decision, which
                // is "nobody has vouched" — not "no human has". A note the
                // orchestrator approved is settled, crew-visible and already in
                // every agent's brief; listing it as awaiting review is what
                // made auto-approved memory read as homework. An EXPIRED note
                // stays listed: nothing is vouching for it now, and a human
                // confirm is the only way back.
                awaitingHumanReview(note, crewVisible) &&
                note.status === "active" &&
                (!options.auto || note.createdBy.startsWith("muon-")) &&
                (!options.fromPack || note.createdBy.startsWith("pack:"))
            )
            // Stable, deterministic review output (P1.4: the conflict-review
            // list must read the same on every run).
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (options.json) {
            printJson({ notes: pending });
            return;
          }
          process.stdout.write(workspaceBanner(options));
          if (pending.length === 0) {
            // P0-3: an empty queue with settled notes behind it is not "you have
            // no memory" — it is "MUON already vouched for all of it". Say which
            // world this is, or the operator reads the silence as an empty brain
            // and goes looking for the review screen that no longer owes them
            // anything.
            const settled = notes.filter(
              (note) =>
                !awaitingHumanReview(note, crewVisible) &&
                note.status === "active"
            ).length;
            process.stdout.write(
              settled > 0
                ? `review queue empty, nothing to confirm — ${settled} settled note(s) are already in every agent's brief\n`
                : "review queue empty, nothing to confirm\n"
            );
            return;
          }
          process.stdout.write(
            `${pending.length} note(s) awaiting review, confirm with \`muon memory confirm --note-id <id>\`, drop with \`muon memory reject --note-id <id>\`:\n`
          );
          pending.forEach((note) => printNote(note, crewVisible));
        } catch (error) {
          failCommand(error, "Memory review failed.");
        }
      }
    );

  const pack = memory
    .command("pack")
    .description(
      "Workspace memory packs: file-based export of CONFIRMED memories for team sync"
    );

  pack
    .command("export")
    .description(
      "Export this workspace's confirmed memories (+ tombstones) into a pack store directory"
    )
    .requiredOption(
      "--out <storeDir>",
      "Pack store directory (a plain dir; may live inside a team-managed git repo)"
    )
    .option(
      "--workspace <path>",
      "Workspace to export (default: current directory)"
    )
    .option("--json", "Print the written manifest as JSON")
    .action(
      async (options: { out: string; workspace?: string; json?: boolean }) => {
        try {
          const exported = await createClient().exportMemoryPack(
            options.workspace ?? process.cwd()
          );
          const dir = writeMemoryPack(path.resolve(options.out), exported);
          if (options.json) {
            printJson({ dir, manifest: exported.manifest });
            return;
          }
          const { counts } = exported.manifest;
          process.stdout.write(
            `Wrote memory pack to ${dir} (${counts.records} record(s), ` +
              `${counts.tombstones} tombstone(s), ${counts.omitted} omitted)\n`
          );
          for (const line of exported.manifest.omissions) {
            process.stdout.write(`  omitted: ${line}\n`);
          }
        } catch (error) {
          failCommand(error, "Memory pack export failed.");
        }
      }
    );

  pack
    .command("import")
    .description(
      "Import teammate packs as PROPOSALS (every record needs a local human confirm before agents ever see it)"
    )
    .argument(
      "<store>",
      "Pack store root (imports every subdir with a manifest) or a single pack directory"
    )
    // ADR-0026 §7: which workspace RECEIVES these proposals. Same spelling and
    // same default as `pack export`'s option, because an operator who exports from
    // one directory and imports into another has made a mistake, not a choice.
    // Omitting it would land every proposal in §8's residue — invisible to every
    // agent read and non-exportable — which is fail-closed and also useless.
    .option(
      "--workspace <path>",
      "Workspace that receives these proposals (default: current directory)"
    )
    .option("--json", "Print the server reports as JSON")
    .action(
      async (
        store: string,
        options: { workspace?: string; json?: boolean }
      ) => {
        try {
          const root = path.resolve(store);
          const dirs = resolvePackDirs(root);
          const client = createClient();
          const receiving = options.workspace ?? process.cwd();
          const imports: { dir: string; report: MemoryPackImportReport }[] = [];
          for (const dir of dirs) {
            const pack = loadPackDir(dir);
            const report = await client.importMemoryPack(pack, receiving);
            imports.push({ dir, report });
            if (!options.json) {
              printImportReport(dir, report);
            }
          }
          if (options.json) {
            printJson({ imports });
          }
        } catch (error) {
          failCommand(error, "Memory pack import failed.");
        }
      }
    );

  pack
    .command("sync")
    .description(
      "Export this workspace's pack, then import every teammate pack in the store (pure composition; every incoming record stays a proposal)"
    )
    .argument(
      "<store>",
      "Pack store root shared with teammates (a plain dir; may live inside a team-managed git repo)"
    )
    .option(
      "--workspace <path>",
      "Workspace to sync (default: current directory)"
    )
    .option("--json", "Print the sync result as JSON")
    .action(
      async (store: string, options: { workspace?: string; json?: boolean }) => {
        try {
          const root = path.resolve(store);
          const client = createClient();
          // ADR-0026 §7: ONE workspace for BOTH legs, resolved once. A sync that
          // exported from one partition and imported into another would be a sync
          // between two repositories, which is not what the word means — and the
          // two legs reading `options.workspace ?? process.cwd()` separately is
          // exactly the kind of duplicated derivation that drifts.
          const workspace = options.workspace ?? process.cwd();
          // 1) Export leg: refresh this workspace's OWN subdir first, so the
          //    store always carries our latest confirmed slice + tombstones.
          const exported = await client.exportMemoryPack(workspace);
          const ownFingerprint = exported.manifest.origin.fingerprint;
          const ownDir = writeMemoryPack(root, exported);
          if (!options.json) {
            const { counts } = exported.manifest;
            process.stdout.write(
              `Wrote memory pack to ${ownDir} (${counts.records} record(s), ` +
                `${counts.tombstones} tombstone(s), ${counts.omitted} omitted)\n`
            );
          }
          // 2) Import leg: every OTHER subdir. Our own pack is skipped locally
          //    by fingerprint; the server's "self-pack" refusal (it owns the
          //    salt, so only it can truly decide) degrades to a skip too.
          const imports: { dir: string; report: MemoryPackImportReport }[] = [];
          const skipped: { dir: string; reason: string }[] = [];
          for (const dir of resolvePackDirs(root)) {
            const packData = loadPackDir(dir);
            if (packData.manifest.origin.fingerprint === ownFingerprint) {
              skipped.push({ dir, reason: "own pack" });
              if (!options.json) {
                process.stdout.write(
                  `  skipped ${dir}: own pack (${ownFingerprint})\n`
                );
              }
              continue;
            }
            try {
              const report = await client.importMemoryPack(packData, workspace);
              imports.push({ dir, report });
              if (!options.json) {
                printImportReport(dir, report);
              }
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              if (!message.includes("self-pack")) {
                throw error;
              }
              skipped.push({ dir, reason: message });
              if (!options.json) {
                process.stdout.write(
                  `  skipped ${dir}: self-pack (server refused it as this workspace's own export)\n`
                );
              }
            }
          }
          if (options.json) {
            printJson({
              dir: ownDir,
              manifest: exported.manifest,
              imports,
              skipped,
            });
          }
        } catch (error) {
          failCommand(error, "Memory pack sync failed.");
        }
      }
    );

  memory
    .command("pause")
    .description(
      "Pause a note without rejecting it (preserves provenance; hidden from crew reads)"
    )
    .requiredOption("--note-id <noteId>", "Note identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { noteId: string; json?: boolean }) => {
      try {
        const note = await createClient().updateMemoryNote({
          noteId: options.noteId,
          status: "paused",
        });
        if (options.json) {
          printJson({ note });
          return;
        }
        printNote(note);
      } catch (error) {
        failCommand(error, "Pause failed.");
      }
    });

  memory
    .command("resume")
    .description("Resume a paused note with its prior confirmation intact")
    .requiredOption("--note-id <noteId>", "Note identifier")
    .option("--json", "Print as JSON")
    .action(async (options: { noteId: string; json?: boolean }) => {
      try {
        const client = createClient();
        const note = await client.updateMemoryNote({
          noteId: options.noteId,
          status: "active",
        });
        if (options.json) {
          printJson({ note });
          return;
        }
        // Resume is the one single-note verb whose result can be crew-visible
        // "auto" again (active + unconfirmed + agent-authored), so it reads
        // the posture. Pause/confirm/reject land in posture-independent tiers
        // and keep the strict default.
        printNote(note, await crewFraming(client));
      } catch (error) {
        failCommand(error, "Resume failed.");
      }
    });

  memory
    .command("confirm")
    .description("Mark a note as human-confirmed")
    .requiredOption("--note-id <noteId>", "Note identifier")
    .option("--trust <trust>", "Optionally raise/lower trust: low | medium | high")
    // KG-6 F1: a confirmation is a HUMAN governance act, the CLI is operated by a
    // human, so it passes an explicit human principal (default the operator
    // "human"). Only a human principal elevates a note into gate views; an omitted
    // principal would NOT confirm. Pass e.g. --principal human:alice to attribute it.
    .option("--principal <principal>", "Confirming principal (human:*)", "human")
    .option("--json", "Print as JSON")
    .action(
      async (options: {
        noteId: string;
        trust?: string;
        principal?: string;
        json?: boolean;
      }) => {
        try {
          const note = await createClient().updateMemoryNote({
            noteId: options.noteId,
            confirmed: true,
            principal: options.principal ?? "human",
            trust: options.trust ? trustSchema.parse(options.trust) : undefined,
          });
          if (options.json) {
            printJson({ note });
            return;
          }
          printNote(note);
        } catch (error) {
          // Confirming memory is operator-only by design, so an agent-tier
          // token lands here routinely; say what is reachable and exit 2.
          printError(formatRefusal(error, "memory confirm"));
          process.exitCode = exitCodeForError(error);
        }
      }
    );

  memory
    .command("reject")
    .description("Reject a note (kept for traceability, hidden from recall)")
    .requiredOption("--note-id <noteId>", "Note identifier")
    // KG-6: a rejection is a HUMAN governance act, exactly like `confirm`. Sending
    // `confirmed:false` (not a bare `status:"rejected"`) forces the backend's
    // tier-first govern branch — requireOperator + a ledger `reject` Confirmation
    // attributed to this principal + resolution of any PROPOSES_SUPERSEDE the note
    // authored. Without it, rejecting an unconfirmed agent note would skip operator
    // auth and leave no confirming principal on the append-only ledger. The
    // explicit `status:"rejected"` is still needed to retire the note (hide it from
    // recall): `confirmed:false` alone records the decision but does not set status.
    .option("--principal <principal>", "Rejecting principal (human:*)", "human")
    .option("--json", "Print as JSON")
    .action(
      async (options: { noteId: string; principal?: string; json?: boolean }) => {
        try {
          const note = await createClient().updateMemoryNote({
            noteId: options.noteId,
            confirmed: false,
            status: "rejected",
            principal: options.principal ?? "human",
          });
          if (options.json) {
            printJson({ note });
            return;
          }
          printNote(note);
        } catch (error) {
          failCommand(error, "Reject failed.");
        }
      }
    );
}
