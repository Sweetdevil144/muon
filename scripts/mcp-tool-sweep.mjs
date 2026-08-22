// CALL every tool muon-mcp registers, and record what actually happened.
//
// `muon mcp probe` proves REGISTRATION — that the server advertises N tools. It
// says nothing about whether a tool can answer, and that gap was reported as
// "all N tools work" when several could not answer from an undispatched
// session at all. This calls them.
//
// A tool PASSES if it answers, or if it refuses with a diagnosable reason (a
// scope refusal from a session with no dispatch lineage is the boundary
// working). It FAILS on a crash, a hang, an unknown-tool error, or a refusal
// whose message does not say what to do next.
import { spawn } from "node:child_process";

// FROM DIST, DELIBERATELY — the same dist the swept server runs from
// (MUON_MCP_ENTRY defaults to packages/mcp/dist). Grading fixtures against
// SOURCE while sweeping a BUILT server would mix two versions of the truth: a
// renamed tool would look "known" or "unknown" by whichever tree the reader
// happened to trust. One stale dist stales both sides together, which is the
// consistent — and therefore diagnosable — failure.
// Dynamic import so a missing build dies with this tool's own diagnosis, not
// an ERR_MODULE_NOT_FOUND stack (a diagnostic tool must not fail
// undiagnosably).
let MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
  MUON_ORCHESTRATOR_TOOL_NAMES,
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES;
try {
  ({
    MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
    MUON_ORCHESTRATOR_TOOL_NAMES,
    MUON_CONTEXT_TOOL_NAMES,
    MUON_COORDINATION_TOOL_NAMES,
  } = await import("../packages/protocol/dist/index.js"));
} catch (error) {
  console.error(
    `could not load packages/protocol/dist (${error?.code ?? error?.message}). ` +
      "The sweep runs against built output — build it first: (cd packages/protocol && npm run build)."
  );
  process.exit(1);
}

const SERVER = process.env.MUON_MCP_ENTRY ?? "packages/mcp/dist/index.js";
// Must exceed the server's own refresh budget, or a bounded refusal is
// misreported as a hang — which is exactly what happened on the first run.
const TIMEOUT_MS = 40_000;

// Minimal arguments per tool, CHECKED AGAINST EACH TOOL'S OWN SCHEMA at run
// time (see validateArgs). The first version of this file guessed the names —
// `modules` for data_boundaries, `query` for flow_scope, `files` for
// claim_files, `noteId` for memory_neighbors, an invalid memory kind — and the
// tools answered "path is required", "symbol is required", "kind must be one
// of…". Those are SCHEMA ERRORS, and the pass rule read them as clear
// refusals, so eleven tools were reported working without ever running.
//
// WRITES is the set that changes state when it is not refused. They are only
// sent with MUON_SWEEP_WRITES=1: from an undispatched session they refuse and
// leave nothing behind, but this file must not quietly become a thing that
// files questions into a human's inbox the day it runs somewhere governed.
const MODULE = "packages/client/src/paths.ts";
const SYMBOL = "resolveDataDir";
const MISSING_NOTE = "mem-sweep-nonexistent";
// A well-formed id that CANNOT resolve. The coordinator tools that dispatch,
// steer, interrupt or ship real work are reachable from a governed seat, and a
// sweep must never actually spawn a vendor CLI, cancel someone's job, or ship
// code. Probing them with a syntactically valid but nonexistent id exercises
// the whole path — schema, scope, route, handler — and stops at "not found",
// which is the correct answer and proves the plumbing without the side effect.
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

const WRITES = new Set([
  // Records a `task.progress` event and caches a symbol uid — not a read.
  "preflight_edit",
  // Both POST /api/memory/preedit, which fires `recordGateRead` and appends a
  // `memory.gate_read` Event. A gate READ is still a ledger WRITE.
  "memory_preedit",
  "impact_memory",
  "memory_add",
  "memory_clone",
  "memory_delete",
  "publish_finding",
  "peer_message",
  "question_ask",
  "claim_files",
  "release_files",
  // Coordinator tier. `create_task` and `propose_workflow` really do write (a
  // task; an INERT workflow run). The rest are probed with MISSING_ID above and
  // cannot change anything, but they are listed here anyway: a reader deciding
  // whether to run this against a live ledger should see every tool that could.
  "create_task",
  "propose_workflow",
  // The COMMIT of the crew plan: until it runs, `crew_roles` reports the crew
  // as merely proposed and nobody is bound. Binding roles on someone's live
  // mission from a diagnostic sweep is exactly what this set exists to stop.
  "assign_roles",
  "dispatch",
  "steer",
  "interrupt",
  "ship",
]);

// CONVENTION: `{}` in this map is a DELIBERATE fixture — "call it with the
// default/empty input, that path is the one under test" (whoami, fleet_status,
// assign_roles' auto-derive). A tool ABSENT from the map is unpinned, and the
// "no fixture (called with {})" line below names it. The two are behaviourally
// identical at the call, and deliberately not in the report.
const ARGS = {
  whoami: {},
  repo_map: {},
  capability_preflight: {},
  crew_roles: {},
  question_status: {},
  peer_inbox: {},
  task_context: {},
  handoff_read: {},
  review_diff: {},
  code_query: { query: "pre-edit gate" },
  code_context: { name: SYMBOL },
  code_impact: { target: SYMBOL },
  flow_scope: { symbol: SYMBOL },
  data_boundaries: { path: MODULE },
  // ADR-0053. Read-only over the repository's own markdown; no CLI, no index.
  docs_query: { query: "governed memory" },
  docs_context: { target: "docs/README.md" },
  docs_impact: { path: MODULE },
  impact_memory: { target: SYMBOL, filePath: MODULE },
  preflight_edit: { target: SYMBOL, filePath: MODULE },
  memory_preedit: { symbol: SYMBOL, module: MODULE },
  memory_search: { query: "ledger" },
  memory_recall: { module: MODULE },
  memory_explain: { noteId: MISSING_NOTE },
  memory_neighbors: { nodeId: MISSING_NOTE },
  memory_clone: { noteId: MISSING_NOTE },
  memory_delete: { noteId: MISSING_NOTE },
  memory_add: { kind: "attempt", text: "mcp tool sweep probe" },
  publish_finding: { kind: "attempt", subject: "sweep", text: "sweep probe" },
  peer_message: {
    to_kind: "role",
    to_role: "reviewer",
    kind: "finding",
    subject: "sweep",
    body: "sweep probe",
  },
  peer_wait: { timeoutMs: 1 },
  question_ask: { subject: "sweep probe", body: "sweep probe" },
  claim_files: { coordinates: [MODULE], intent: "review" },
  release_files: { coordinates: [MODULE] },
  fleet_status: {},
  list_tasks: {},
  dispatch_status: {},
  budget_status: {},
  assign_roles: {},
  create_task: { title: "MCP sweep probe", brief: "created by scripts/mcp-tool-sweep.mjs" },
  propose_workflow: { request: "mcp tool sweep probe" },
  workflow_status: { runId: MISSING_ID },
  check_approval: { approvalId: MISSING_ID },
  read_stream: { jobId: MISSING_ID },
  dispatch: { vendor: "claude-code", taskId: MISSING_ID, brief: "sweep probe" },
  steer: { jobId: MISSING_ID, message: "sweep probe" },
  interrupt: { jobId: MISSING_ID },
  ship: { taskId: MISSING_ID, summary: "sweep probe" },
};

/** Fail loudly on a fixture the tool could never accept. */
function validateArgs(tool, args) {
  const schema = tool.inputSchema ?? {};
  const props = new Set(Object.keys(schema.properties ?? {}));
  const required = schema.required ?? [];
  const unknown = Object.keys(args).filter((k) => !props.has(k));
  const missing = required.filter((k) => !(k in args));
  if (unknown.length) return `fixture sends unknown args: ${unknown.join(", ")}`;
  if (missing.length) return `fixture omits required args: ${missing.join(", ")}`;
  return null;
}

const child = spawn("node", [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

// A DIAGNOSTIC TOOL MUST NOT FAIL UNDIAGNOSABLY. Without these, a wrong
// MUON_MCP_ENTRY throws ENOENT as an unhandled event, and a server that dies
// mid-sweep leaves every remaining call waiting out its full timeout before
// reporting a hang that was really a crash.
let serverDied = null;
child.on("error", (error) => {
  console.error(`could not start ${SERVER}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (!finished) {
    // The line that explains it, not the last line — a Node stack ends with
    // the version banner, which says nothing.
    const lines = stderrTail.trim().split("\n").filter(Boolean);
    const why = (
      lines.find((l) => /error|cannot find|not found|refus/i.test(l)) ??
      lines[0] ??
      ""
    ).slice(0, 200);
    serverDied =
      `server exited early (code ${code}, signal ${signal})` +
      (why ? ` — ${why}` : "");
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ __died: serverDied });
    }
  }
});

let finished = false;
let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});
// KEPT, BOUNDED. Discarding it meant a crash mid-sweep reported only
// "server exited early (code 1)" with nothing about why.
let stderrTail = "";
child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-2000);
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => { pending.delete(id); resolve({ __timeout: true }); },
      TIMEOUT_MS
    );
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "muon-tool-sweep", version: "1" },
});
if (init.__died || init.__timeout || init.error) {
  // `__died` first: a server that exited has a real reason, and reporting it
  // as a handshake timeout hides that and costs a full timeout to discover.
  console.error("handshake failed:", JSON.stringify(init).slice(0, 200));
  child.kill();
  process.exit(1);
}
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const listed = await send("tools/list", {});
if (listed.__died || listed.__timeout || listed.error || !Array.isArray(listed.result?.tools)) {
  // Otherwise the loop body never runs, nothing is marked broken, and the
  // script exits 0 having tested nothing — a green sweep of zero tools.
  console.error(
    `tools/list failed: ${JSON.stringify(listed).slice(0, 200)}`
  );
  child.kill();
  process.exit(1);
}
const tools = [...listed.result.tools].sort((a, b) => a.name.localeCompare(b.name));
if (tools.length === 0) {
  console.error("tools/list returned no tools — nothing to sweep");
  child.kill();
  process.exit(1);
}
console.log(`registered: ${tools.length}`);

// A fixture for a name that is NOT registered is a typo that silently
// downgrades a tool to `{}` — the `repo_mapx` key proved nothing checked this.
//
// The reverse is not an error: `MUON_MCP_MODE=orchestrator|observer` composes
// extra tools (`list_tasks`, `workflow_status`, …) this map has never heard of.
// Aborting on those would refuse to sweep two supported modes. They are called
// with `{}` and graded normally — a required-argument complaint then surfaces
// as FIXTURE_INVALID, which is the honest report of a missing fixture.
// A FIXTURE FOR A TIER THIS SERVER DOES NOT EXPOSE IS NOT A TYPO — but a typo
// is still a typo. The map covers the attached-coordinator surface as well as
// the base one — two DIFFERENT sizes, so a hand-launched sweep legitimately
// sees strays; aborting on those refused to sweep the most common mode.
// Deliberately no literal counts here: they were written as 44 and 30, went
// stale twice (31 base, then 34 when ADR-0053 added the docs tools), and a
// stale number in a comment is worse than none — it is read as current. The
// sizes live in `packages/protocol/src/mcp-tool-inventory.ts`, which is the
// positive inventory every tier is derived from and the only place they are
// pinned.
// Grading them against the RUNNING server alone, though, reopened the hole the
// abort was added for: `repo_mapx` would demote `repo_map` to `{}`, which
// PASSES for every tool with no required args and reports green. So strays are
// judged against the protocol's own inventories instead: known to SOME tier →
// noted and skipped; known to NO tier → the original loud exit(1).
const registered = new Set(tools.map((t) => t.name));
// THE SWEPT MODE'S OWN INVENTORY IS THE CONTRACT. "Shipped is not reachable"
// is the exact regression this sweep exists to catch — a tool green in CI can
// still be missing from the LIVE surface — so a base-tier tool absent from a
// base-tier server is a FAILED sweep, not a log line. (Relaxing the stray
// check alone had quietly re-opened this: the union set contains every base
// tool, so a dropped registration read as a benign cross-tier fixture.)
const mode = process.env.MUON_MCP_MODE?.trim() || "base";
const EXPECTED_BY_MODE = {
  base: [...MUON_CONTEXT_TOOL_NAMES, ...MUON_COORDINATION_TOOL_NAMES],
  "attached-coordinator": [...MUON_ATTACHED_COORDINATOR_TOOL_NAMES],
};
const expected = EXPECTED_BY_MODE[mode];
if (!expected) {
  // NO SILENT CAPS: the completeness check covers the two modes whose live
  // composition the protocol constants are verified to equal (base and
  // attached-coordinator). Any other mode — including a typo'd one — must say
  // the check did not run, or a skipped check reads as a passed one.
  console.log(
    `surface completeness NOT checked for mode '${mode}' — only ${Object.keys(EXPECTED_BY_MODE).join(", ")} are pinned to a protocol inventory`
  );
}
if (expected) {
  const missing = expected.filter((name) => !registered.has(name));
  const unlisted = [...registered].filter((name) => !expected.includes(name));
  if (missing.length) {
    console.error(
      `LIVE SURFACE IS MISSING ${mode}-tier tools the protocol inventory promises: ${missing.join(", ")}`
    );
    child.kill();
    process.exit(1);
  }
  if (unlisted.length) {
    console.error(
      `live ${mode} surface registers tools the protocol inventory does not list (update the inventory): ${unlisted.join(", ")}`
    );
    child.kill();
    process.exit(1);
  }
}
// The base tier is listed EXPLICITLY even though both composite inventories
// already contain it by construction — the guard's correctness should be
// readable off this line, not off how a constant three files away happens to
// be composed today.
const knownAnywhere = new Set([
  ...MUON_CONTEXT_TOOL_NAMES,
  ...MUON_COORDINATION_TOOL_NAMES,
  ...MUON_ORCHESTRATOR_TOOL_NAMES,
  ...MUON_ATTACHED_COORDINATOR_TOOL_NAMES,
]);
const strays = Object.keys(ARGS).filter((name) => !registered.has(name));
const typos = strays.filter((name) => !knownAnywhere.has(name));
if (typos.length) {
  console.error(`ARGS names tools no MUON tier registers (typo?): ${typos.join(", ")}`);
  child.kill();
  process.exit(1);
}
if (strays.length) {
  console.log(`fixtures for tools this tier does not expose: ${strays.join(", ")}`);
}
const unfixtured = tools.map((t) => t.name).filter((name) => !(name in ARGS));
if (unfixtured.length) {
  console.log(`no fixture (called with {}): ${unfixtured.join(", ")}`);
}

const runWrites = process.env.MUON_SWEEP_WRITES === "1";
const rows = [];

// Ids the sweep learns as it goes. `workflow_status` against a made-up run id
// only ever proves the refusal path; run against the run `propose_workflow`
// just created, it proves the READ — which is the half that was broken.
//
// ORDER-DEPENDENT, deliberately and safely: the loop walks `tools` sorted by
// name, and "propose_workflow" < "workflow_status" alphabetically, so the
// producer always runs before the consumer. If either tool is ever renamed
// across that boundary the chain silently degrades to the MISSING_ID probe —
// REFUSED_OK, never a false pass.
const chain = {};
// The A2A routes space peer sends 250ms apart, so two back-to-back sends grade
// the second one 429 and tell you nothing about whether it works.
const A2A = new Set(["peer_message", "publish_finding"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const tool of tools) {
  const name = tool.name;
  if (WRITES.has(name) && !runWrites) {
    rows.push({ name, status: "SKIPPED_WRITE", detail: "set MUON_SWEEP_WRITES=1 to include" });
    console.log(`${"SKIPPED_WRITE".padEnd(15)} ${name.padEnd(22)} state-changing; not run by default`);
    continue;
  }
  const args = { ...(ARGS[name] ?? {}), ...(chain[name] ?? {}) };
  const fixtureError = validateArgs(tool, args);
  if (fixtureError) {
    rows.push({ name, status: "FIXTURE_INVALID", detail: fixtureError });
    console.log(`${"FIXTURE_INVALID".padEnd(15)} ${name.padEnd(22)} ${fixtureError}`);
    continue;
  }
  if (serverDied) {
    // Every later `send()` would write to a destroyed stdin and then wait out
    // its full timeout, turning one crash into N slow phantom hangs.
    rows.push({ name, status: "SERVER_DIED", detail: serverDied });
    console.log(`${"SERVER_DIED".padEnd(15)} ${name.padEnd(22)} ${serverDied}`);
    continue;
  }
  if (A2A.has(name)) await sleep(300);
  const res = await send("tools/call", { name, arguments: args });
  let status, detail;
  if (res.__died) {
    status = "SERVER_DIED";
    detail = res.__died;
  } else if (res.__timeout) {
    status = "HANG";
    detail = `no response in ${TIMEOUT_MS}ms`;
  } else if (res.error) {
    status = "PROTOCOL_ERROR";
    detail = String(res.error.message ?? "").slice(0, 90);
  } else {
    const text = (res.result?.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join(" ");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* prose payload */ }
    const outcome = parsed?._muon?.outcome;
    const degraded = parsed?._muon?.degradation?.active === true;
    if (res.result?.isError) {
      // A refusal is fine — IF it says why and what to do.
      // "X is required" / "must be one of" means the CALL never happened —
      // that is a fixture defect, and grading it as a clean refusal is how
      // eleven tools were reported working without running.
      const schemaComplaint =
        /is required|must be one of|must be a|invalid .*(argument|param)/i.test(text);
      // GRADED ON THE STRUCTURED FIELD, not on prose. `finalize()` gives every
      // isError result a default `nextActions` of "Correct the reported input
      // or state, then retry this tool", and the old regex matched `retry` —
      // so REFUSED_OPAQUE was unreachable and the grading was decorative.
      // A refusal counts as actionable only when it offers advice BEYOND that
      // boilerplate.
      // The question is whether the advice is TRUE, not whether it is bespoke.
      // "Correct the reported input or state, then retry" is exactly right for
      // "No task id given" — the caller can supply one. It is a lie for a scope
      // refusal, which no retry from this session can fix. So generic advice
      // only fails the sweep when the refusal is PERMANENT.
      //
      // BOTH boilerplates, and the ACTION as well as the nextActions. There are
      // two: the RETURNED-failure default above, and `remedyFor`'s unmatched
      // fallback ("Inspect `muon doctor` … correct the state, then retry"),
      // which `withAgentUi`'s catch path stamps on EVERY thrown failure. Only
      // filtering the first left `action.length > 0` unconditionally true for
      // thrown failures, so REFUSED_OPAQUE could not be reached down that path
      // either — the grading was decorative exactly where it mattered most.
      const GENERIC =
        /^(Correct the reported input or state|Inspect `?muon doctor|Correct the reported state)/i;
      const next = Array.isArray(parsed?._muon?.nextActions)
        ? parsed._muon.nextActions.filter((a) => !GENERIC.test(String(a)))
        : [];
      const rawAction = String(parsed?._muon?.degradation?.action ?? "");
      const action = GENERIC.test(rawAction) ? "" : rawAction;
      // Matched against the ERROR STRING, never the serialized envelope: the
      // envelope's own keys defeat prose probes — `authority` carries
      // `humanDecisionRequired` on EVERY result, so `/required/` against the
      // whole JSON was unconditionally true and the non-permanent arm could
      // never grade REFUSED_OPAQUE. Third unreachable-grading defect in this
      // block; all three had the same shape (probing text that always
      // contains the probe).
      const errorText = String(parsed?.error ?? "");
      const permanent =
        /job-scoped agent session|job- and lane-scoped|hand-launched|attached coordinator seat|exact active job capability|runner-issued/i.test(
          errorText
        );
      const actionable = permanent
        ? next.length > 0 || action.length > 0
        : next.length > 0 ||
          action.length > 0 ||
          /required|must be|no task id|not found|does not exist|no dispatch job|outside the current chat scope|supply exactly one/i.test(
            errorText
          );
      status = schemaComplaint
        ? "FIXTURE_INVALID"
        : actionable
          ? "REFUSED_OK"
          : "REFUSED_OPAQUE";
      detail = text.replace(/\s+/g, " ").slice(0, 90);
    } else if (outcome) {
      if (name === "propose_workflow" && parsed?.runId) {
        chain.workflow_status = { runId: String(parsed.runId) };
      }
      status = degraded ? "OK_DEGRADED" : "OK";
      detail = degraded ? String(parsed._muon.degradation.reason ?? "").slice(0, 70) : outcome;
    } else {
      status = text ? "OK" : "EMPTY";
      detail = text.replace(/\s+/g, " ").slice(0, 70);
    }
  }
  rows.push({ name, status, detail });
  console.log(`${status.padEnd(15)} ${name.padEnd(22)} ${detail}`);
}

finished = true;
child.kill();
const bad = rows.filter((r) =>
  ["HANG", "PROTOCOL_ERROR", "REFUSED_OPAQUE", "EMPTY", "FIXTURE_INVALID", "SERVER_DIED"].includes(
    r.status
  )
);
const skipped = rows.filter((r) => r.status === "SKIPPED_WRITE").length;
console.log(
  `\nregistered ${tools.length}  called ${rows.length - skipped}  ok ${rows.filter((r) => r.status.startsWith("OK")).length}` +
    `  refused-clearly ${rows.filter((r) => r.status === "REFUSED_OK").length}` +
    `  skipped-writes ${skipped}  BROKEN ${bad.length}`
);
for (const r of bad) console.log(`  BROKEN: ${r.name} — ${r.detail}`);
process.exit(bad.length ? 1 : 0);
