#!/usr/bin/env node
// MUON TUI — ADR-0042 desk. THE DEFAULT surface: `npm run tui`.
// The previous desk is still reachable as `npm run tui:legacy` while the
// commands listed in `catalogue-actions.ts` as NOT_PORTED live only there.

import { render } from "ink";
import {
  discoverLiveBrain,
  MuonApiClient,
  readProbedLiveLockfile,
  resolveApiBase,
  resolveApiToken,
  resolveDataDir,
} from "@muon/client";
import { ensureBrain } from "@muon/client/ensure-brain";
import { runLaneDoctor } from "@muon/core";
import {
  createBrainStore,
  type BrainTarget,
  type LaneDoctorStatus,
} from "../lib/brain-store.js";
import { resolveStartupTarget } from "../lib/startup.js";
import { Desk } from "./Desk.js";

function parseArgs(argv: string[]) {
  let apiBase: string | undefined;
  let apiToken: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api-base" && argv[i + 1]) {
      apiBase = argv[i + 1];
      i += 1;
    }
    if (arg === "--api-token" && argv[i + 1]) {
      apiToken = argv[i + 1];
      i += 1;
    }
  }
  return { apiBase, apiToken };
}

const { apiBase, apiToken } = parseArgs(process.argv.slice(2));

// Local-first startup (mirrors the CLI preAction hook): with no explicit target,
// make sure the embedded brain is up before we build the client; never
// auto-spawn over an explicit --api-base / MUON_API_BASE (F1 no-hijack).
const startup = await resolveStartupTarget({
  apiBase,
  ensureBrain,
  resolveApiBase,
  resolveDataDir,
});
if (startup.note) {
  process.stderr.write(`muon-tui: ${startup.note}\n`);
}

const client = new MuonApiClient(
  resolveApiBase(apiBase),
  fetch,
  resolveApiToken(apiToken, apiBase)
);

// Auto-discovered brains rotate (fresh port + token per boot). After a
// connection-level failure, re-read the LIVE lockfile — confirming it actually
// answers /health — and re-point at the new base AND token together. Explicit
// targets are never re-resolved (the store also guards on target.source).
const reresolve = async (): Promise<
  { client: MuonApiClient; target: BrainTarget } | null
> => {
  // The startup profile first; if ITS brain is gone (the common dev path:
  // this TUI's own brain died and the founder started the desktop, whose
  // brain lives under a SIBLING profile), fall back to the same adoption
  // discovery the startup used — pinning to one dataDir made that path an
  // unrecoverable CONTROL_PLANE_UNREACHABLE until the TUI was restarted.
  let dataDir = startup.target.dataDir;
  let lock = await readProbedLiveLockfile(dataDir);
  if (!lock) {
    const adopted = discoverLiveBrain();
    if (adopted) {
      dataDir = adopted.dataDir;
      lock = await readProbedLiveLockfile(dataDir);
    }
  }
  if (!lock) {
    return null;
  }
  const base = `http://127.0.0.1:${lock.port}`;
  return {
    // Base AND token from the SAME lockfile just probed — resolveApiToken()
    // re-ran discovery from scratch and could pair this base with a DIFFERENT
    // profile's token (its own profile wins discovery), a 401 that never
    // heals.
    client: new MuonApiClient(base, fetch, lock.token || resolveApiToken()),
    target: { base, dataDir, source: "lockfile" },
    ...(lock.token ? { token: lock.token } : {}),
  };
};

const store = createBrainStore(
  client,
  async (lanes) => {
    const report = await runLaneDoctor(
      lanes.map((lane) => ({
        id: lane.id,
        key: lane.key,
        name: lane.name,
        role: lane.role,
        status: lane.status,
      }))
    );
    const status: LaneDoctorStatus = {};
    for (const record of report.records) {
      if (record.adapterFound && record.health) {
        status[record.lane.key] = record.health.status;
      } else {
        status[record.lane.key] = "unavailable";
      }
    }
    return status;
  },
  {
    target: startup.target,
    apiToken: resolveApiToken(apiToken, apiBase),
    reresolve: startup.reresolvable ? reresolve : undefined,
    startupError: startup.note,
  }
);
store.start(2000);

// ADR-0042 — the rebuilt desk. Same bootstrap as the classic entry (same
// brain discovery, same re-resolution, same store), different surface.
const instance = render(
  <Desk store={store} workspace={process.cwd()} />
);

const shutdown = () => {
  store.stop();
  instance.unmount();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
