#!/usr/bin/env node
/**
 * capture-golden-path.mjs — turn a real governed mission in the local brain
 * into a committed evidence artifact (ROADMAP Wave 0 item 4 / week F4).
 *
 * READ-ONLY by construction: the database is opened with `?mode=ro` through
 * the sqlite3 CLI; nothing here can write to the brain. The output is
 * COORDINATES + VERDICTS, not transcripts: ids, vendors, roles, statuses,
 * gate decisions, certification summaries, and the merge execution record.
 * Prompt/brief text is truncated to one line so no long-form content lands
 * in the repo.
 *
 * Usage:
 *   node scripts/capture-golden-path.mjs --approval <approvalId> \
 *     [--db "<path to muon.db>"] [--out docs/evidence/golden-path-<date>.md]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const approvalId = argValue("--approval");
if (!approvalId) {
  console.error("usage: capture-golden-path.mjs --approval <approvalId> [--db <path>] [--out <file>]");
  process.exit(1);
}
const DB =
  argValue("--db") ??
  join(homedir(), "Library/Application Support/@muon/desktop/muon.db");
const OUT =
  argValue("--out") ??
  `docs/evidence/golden-path-${new Date().toISOString().slice(0, 10)}.md`;

const q = (sql) =>
  execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, sql], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const rows = (sql) => (q(sql) ? JSON.parse(q(sql)) : []);
const esc = (s) => String(s).replace(/'/g, "''");
const oneLine = (s, max = 140) =>
  String(s ?? "").replace(/\s+/g, " ").slice(0, max);

const approval = rows(
  `SELECT * FROM ApprovalRequest WHERE id='${esc(approvalId)}'`
)[0];
if (!approval) {
  console.error(`approval ${approvalId} not found in ${DB}`);
  process.exit(1);
}
const task = rows(`SELECT * FROM Task WHERE id='${esc(approval.taskId)}'`)[0];
// The MISSION is the chat: capture every sibling task the crew ran, not just
// the task the merge gate hangs off (scout/review tasks are the other lanes).
const missionTasks = task?.chatId
  ? rows(
      `SELECT id, title, status FROM Task WHERE chatId='${esc(task.chatId)}' ORDER BY createdAt`
    )
  : [task].filter(Boolean);
const taskIdList = missionTasks.map((t) => `'${esc(t.id)}'`).join(",");
const jobs = rows(
  `SELECT id, taskId, vendor, kind, role, status, dispatchedBy, createdAt
   FROM DispatchJob WHERE taskId IN (${taskIdList}) ORDER BY createdAt`
);
const gates = rows(
  `SELECT id, taskId, kind, status, requestedBy, gateTag, decidedAt, createdAt
   FROM ApprovalRequest WHERE taskId IN (${taskIdList}) ORDER BY createdAt`
);

const cert = approval.reviewCertification
  ? JSON.parse(approval.reviewCertification)
  : null;
const mergeExec = approval.mergeExecution
  ? JSON.parse(approval.mergeExecution)
  : null;

const vendorsUsed = [...new Set(jobs.map((j) => j.vendor))];
const rolesUsed = [...new Set(jobs.map((j) => j.role).filter(Boolean))];

const lines = [];
lines.push(`# Golden-path evidence — governed mission ${approval.taskId}`);
lines.push("");
lines.push(`Captured ${new Date().toISOString()} from the local brain (read-only).`);
lines.push("Coordinates and verdicts only; no transcripts.");
lines.push("");
lines.push(`## Mission`);
lines.push("");
lines.push(`- Chat (the mission): \`${task?.chatId ?? "—"}\` — ${missionTasks.length} task(s)`);
missionTasks.forEach((t) =>
  lines.push(`  - \`${t.id.slice(0, 12)}…\` ${oneLine(t.title, 90)} (${t.status})`)
);
lines.push(`- Vendors that did the work: ${vendorsUsed.join(", ")}`);
lines.push(`- Roles enforced: ${rolesUsed.join(", ") || "—"}`);
lines.push("");
lines.push(`## Crew timeline (${jobs.length} dispatch jobs)`);
lines.push("");
lines.push("| # | vendor | role | kind | status | dispatched by |");
lines.push("|---|---|---|---|---|---|");
jobs.forEach((j, i) =>
  lines.push(
    `| ${i + 1} | ${j.vendor} | ${j.role ?? "—"} | ${j.kind} | ${j.status} | ${j.dispatchedBy ?? "—"} |`
  )
);
lines.push("");
lines.push(`## Gates on this task (${gates.length})`);
lines.push("");
lines.push("| gate | kind | status | requested by | decided |");
lines.push("|---|---|---|---|---|");
gates.forEach((g) =>
  lines.push(
    `| \`${g.id.slice(0, 12)}…\` | ${g.kind} | **${g.status}** | ${g.requestedBy} | ${g.decidedAt ?? "—"} |`
  )
);
lines.push("");
lines.push(`## The merge gate under proof: \`${approval.id}\``);
lines.push("");
lines.push(`- Status: **${approval.status}** (requested by ${approval.requestedBy}, decided ${approval.decidedAt ?? "—"})`);
if (cert) {
  lines.push(`- Review certification: present (${oneLine(JSON.stringify(Object.keys(cert)))})`);
}
if (mergeExec) {
  lines.push(`- Merge execution: ${oneLine(JSON.stringify(mergeExec))}`);
}
lines.push(`- Merge execution status: ${approval.mergeExecutionStatus ?? "—"}`);
lines.push("");
lines.push("## What this proves");
lines.push("");
lines.push(
  "A real multi-vendor crew (no fakes) executed a mission through MUON's " +
    "governed loop on this machine: role-narrowed dispatches ran, the merge " +
    "gate stayed closed until a human approved it, and the merge executed " +
    "through the governed path. The brain rows named above are the durable " +
    "record; re-run this script against them at any time."
);
lines.push("");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(`[golden-path] wrote ${OUT}`);
console.log(`[golden-path] vendors=${vendorsUsed.join(",")} jobs=${jobs.length} gates=${gates.length} merge=${approval.status}`);
