# The `muon-mcp` server card

> Dated 2026-07-31, written against the tree at `af17acc`. This card is the
> outward-facing description of MUON's MCP server for agent-ecosystem
> consumers (and for the humans configuring them). The inventory below is the
> shipped `packages/protocol/src/mcp-tool-inventory.ts`, restated with links —
> when the two disagree, the source is right and this card is stale.

## What it is

`muon-mcp` is a stdio MCP server that gives a coding-agent session access to
MUON's governed brain and, for authorized sessions, its crew-control surface.
It is injected by MUON into the sessions it spawns, and can be installed into
a human's own CLI (`muon mcp install`) as an unprivileged brain client.

## Transports

**Stdio is the only transport `muon mcp install` ever registers**, and stays
the default for every vendor CLI. ROADMAP P14 added a second, OPT-IN
transport for local scripts and same-host tooling that cannot spawn a stdio
child:

| Transport | Binary | Reachability | Auth |
|---|---|---|---|
| stdio (default) | `muon-mcp` | vendor CLI's own child process only | `resolveMcpApiToken()` — `MUON_API_TOKEN` or the lockfile `agentToken`; falls back to running unauthenticated with a stderr warning if neither resolves |
| Streamable HTTP/SSE (opt-in) | `muon-mcp-http` | loopback only — `127.0.0.1` / `::1` / `localhost`; refuses (throws, before `listen()`) any other bind host | **required** `Authorization: Bearer <agent-or-job-token>` on every request; a missing/empty bearer is 401 before any MCP transport is touched |

`muon-mcp-http` (`packages/mcp/src/http.ts`, `MUON_MCP_HTTP_HOST` /
`MUON_MCP_HTTP_PORT` env, default `127.0.0.1:0` — an ephemeral port) speaks
the MCP Streamable HTTP transport (`@modelcontextprotocol/sdk`'s
`StreamableHTTPServerTransport`) at `/mcp`, one session per `initialize`
handshake keyed by the `Mcp-Session-Id` header. It shares the exact same
`buildMuonServer` request-handling path stdio uses
(`packages/mcp/src/server-factory.ts`), so `tools/list` and `tools/call`
cannot drift between the two.

**Never operator-on-MCP widening.** Every HTTP session gets exactly
`createToolDefinitions(client, {})` — the fixed base (context + coordination)
tool set an unset-`MUON_MCP_MODE` stdio session gets — built fresh from
whichever bearer that request's `initialize` presented. The token decides only
whether the resulting `MuonApiClient`'s calls to the control plane succeed; it
is never compared against the operator token and never selects orchestrator
or delegate mode. Presenting the operator token over this transport grants
nothing beyond what an agent token would. This is loopback-only, existing
two-tier tokens only — **no OAuth-to-cloud** (see
`docs/design/muon-mcp-external-coordinator.md`).

A thin, typed SDK for driving `muon-mcp-http` lives at
`packages/client/src/mcp-sdk.ts` (`@muon/client/mcp-sdk`): `MuonMcpClient.connect({ baseUrl, token })`,
`listTools()`, `callTool(name, args)`, and a few typed helpers
(`memorySearch`, `taskContext`, `codeQuery`, `crewRoles`) over the official
`@modelcontextprotocol/sdk` client transport.

Three properties define it:

1. **Authority is tiered by session, not by tool call.** The tool inventory a
   session sees is fixed at launch from its capability (below); a session
   cannot ask its way into a wider tier.
2. **Identity is declared, never inferred.** `MUON_MCP_MODE` says what a
   session is (`worker` / `orchestrator` / `delegate`); an **absent** mode
   means a human attached this session by hand. `muon mcp install`
   deliberately writes **no mode, no token, and no API base**, so an installed
   entry can never be mistaken for a privileged one, and a privileged mode
   without runner-minted job lineage refuses to start.
3. **Nothing here bypasses the gates.** Every mutating surface the tools reach
   is the same governed API the human surfaces use: approvals fail closed,
   memory writes pass the same ingest governance, `ship` FILES a merge gate
   and can never decide one.

## Tool tiers

### Context — every governed session (21 tools)

`memory_search`, `memory_recall`, `memory_neighbors`, `memory_explain`,
`memory_delete`, `memory_clone`, `memory_add`, `memory_preedit`,
`impact_memory`, `preflight_edit`, `task_context`, `handoff_read`, `code_query`,
`code_context`, `code_impact`, `repo_map`, `review_diff`, `data_boundaries`,
`flow_scope`, `capability_preflight`, `whoami`.

The hero is `preflight_edit`: code-graph blast radius fused with governed
memory, prior decisions, live sibling activity, and coverage telemetry, at
the edit boundary, in one read. Memory reads are workspace-partitioned
(ADR-0026) and trust-gated (only human-confirmed memory reaches the strict
gate view); `memory_delete` is governed by handle-scoped identity and the
ledger's destructive-write authorization — it is not a free delete.

### Coordination — every worker (9 tools)

`publish_finding`, `peer_message`, `peer_inbox`, `peer_wait`, `claim_files`,
`release_files`, `question_ask`, `question_status`, `crew_roles`.

Mission-bounded, horizontal, and deliberately authority-free: a peer message
is untrusted data to its reader, a work claim is advisory, and `crew_roles`
is the read side of role assignment only. `publish_finding` records what an
agent LEARNED and announces it to the crew in one act — the note lands
unconfirmed and the message carries its id, so a peer can look the finding up
instead of receiving prose it cannot resolve. `question_ask` (ADR-0043) files a
blocking question to the human inbox — it confers no authority, pauses
nothing, and extends no budget; `question_status` reads back your own
questions with their operator-authored answers.

### Control — the coordinator seat only (17 tools)

`assign_roles`, `fleet_status`, `set_fleet`, `create_task`, `list_tasks`,
`dispatch`, `read_stream`, `dispatch_status`, `budget_status`, `raise_budget`,
`steer`, `interrupt`, `propose_workflow`, `apply_workflow`, `workflow_status`,
`ship`, `check_approval`.

Dispatch rides the delegation manifest (depth / children / descendants /
iterations / deadline caps, narrowing required); `ship` files the governed
merge gate; approvals are decided by an operator-tier principal, never here.

### Delegate — governed sub-dispatch (1 tool)

`delegate` — a child dispatch under the parent's own capped manifest. The
delegate capability tier is context + coordination + this tool; it does not
carry the control tier.

## Environment contract (MUON-spawned sessions)

| Variable | Meaning |
|---|---|
| `MUON_API_BASE` | The local backend this server talks to. |
| `MUON_MCP_MODE` | `worker` / `orchestrator` / `delegate`; absent = human-attached. |
| `MUON_TASK_ID`, `MUON_LANE_KEY` | The session's task and vendor lane. |
| `MUON_JOB_ID` | Runner-minted job lineage (required by privileged modes). |
| `MUON_WORKSPACE` | The governed workspace root for this session. |
| `MUON_PREFLIGHT_NONCE` | Binds preflight evidence to this exact run. |
| `MUON_API_TOKEN` | The per-job capability token — child env only, never argv, never a config file. |

## Tool annotations

Every tool listed above carries MCP annotations (`readOnlyHint` /
`destructiveHint` / `idempotentHint` / `title`) from the `CONTRACTS` table in
`packages/mcp/src/agent-ui.ts`, applied by `withAgentUiContracts` before the
stdio server advertises the tool. Example: `memory_delete` is
`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`.

Treat the tier descriptions above as the narrative guide; treat the
annotations on the wire as the machine-readable safety labels. When the two
disagree, the `CONTRACTS` source is right and this card is stale.
