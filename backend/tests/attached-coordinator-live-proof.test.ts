import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTACHED_COORDINATOR_CAPABILITY_MODE,
  ATTACHED_COORDINATOR_LEASE_TTL_MS,
} from "@muon/protocol";
import { writeAttachedCoordinatorCapabilityFile } from "@muon/client/attached-coordinator-capability";
import {
  installMcpServer,
  readVendorEntry,
  resolveInstallableVendor,
  type McpVendorIo,
} from "@muon/client/mcp-vendor-config";

/**
 * ADR-0028 Tier C — disposable live composition proof.
 *
 * Temp SQLite + graph + HOME (never the founder's vendor configs). Exercises
 * attach → capability file 0600 → vendor config secrecy → two heartbeats →
 * create task + delegate child → forbidden routes → lease lapse + sweep →
 * seat free → reattach. MCP process heartbeats use the same HTTP route;
 * tool-layer membership is locked in packages/mcp + protocol inventories.
 */

const OPERATOR = "operator-token-attached-live-proof";
const AGENT = "agent-token-attached-live-proof";
const WORKSPACE = process.cwd();
const MUTATED_ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "MUON_DATA_DIR",
  "DATABASE_URL",
  "MUON_GRAPH_DIR",
  "MUON_OPERATOR_TOKEN",
  "MUON_AGENT_TOKEN",
  "MUON_API_TOKEN",
] as const;
const savedEnv = Object.fromEntries(
  MUTATED_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof MUTATED_ENV_KEYS)[number], string | undefined>;

type Db = typeof import("../src/lib/db.js");
type AttachedLib = typeof import("../src/lib/attached-coordinator.js");

let dir: string;
let home: string;
let dataDir: string;
let db: Db;
let attachedLib: AttachedLib;
let app: FastifyInstance;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Hermetic stand-in for `codex mcp add`: exercise the real MUON writer and
 * read-back parser without requiring a paid vendor binary on the CI runner. */
function codexConfigIo(): McpVendorIo {
  return {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: WORKSPACE,
      redirectVendorConfigDirs: true,
    },
    run: (command, args, environment) => {
      if (command !== "codex" || args.slice(0, 3).join(" ") !== "mcp add muon") {
        throw new Error(
          `unexpected vendor writer invocation: ${command} ${args.join(" ")}`
        );
      }
      const codexHome = environment.CODEX_HOME;
      if (!codexHome) {
        throw new Error("hermetic Codex writer requires an isolated CODEX_HOME");
      }
      const entryEnvironment: Record<string, string> = {};
      for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== "--env") continue;
        const pair = args[index + 1] ?? "";
        const separator = pair.indexOf("=");
        if (separator > 0) {
          entryEnvironment[pair.slice(0, separator)] = pair.slice(separator + 1);
        }
      }
      mkdirSync(codexHome, { recursive: true });
      const environmentRows = Object.entries(entryEnvironment).map(
        ([key, value]) => `${key} = ${JSON.stringify(value)}`
      );
      writeFileSync(
        path.join(codexHome, "config.toml"),
        [
          "[mcp_servers.muon]",
          `command = ${JSON.stringify(args.at(-1))}`,
          "[mcp_servers.muon.env]",
          ...environmentRows,
          "",
        ].join("\n")
      );
      return {
        code: 0,
        stdout: "Added global MCP server 'muon'.",
        stderr: "",
        spawnFailed: false,
      };
    },
    which: (command) => (command === "codex" ? "/fake/codex" : null),
    isExecutableFile: (candidate) => candidate === "/usr/bin/true",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "muon-attached-live-proof-"));
  home = path.join(dir, "home");
  dataDir = path.join(dir, "data");
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.MUON_DATA_DIR = dataDir;
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  process.env.MUON_GRAPH_DIR = path.join(dir, "graph");
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();

  db = await import("../src/lib/db.js");
  attachedLib = await import("../src/lib/attached-coordinator.js");
  await db.ensureSchema();

  for (const vendor of ["codex", "claude-code"] as const) {
    await db.prisma.agent.create({
      data: { vendor, ordinal: 0, name: `${vendor}-coordinator` },
    });
  }

  const { buildApp } = await import("../src/app.js");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
  for (const key of MUTATED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("ADR-0028 disposable live composition", () => {
  it("attach → secrecy → heartbeats → child → forbid → lapse → reattach", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: {
        title: "Attached coordinator live proof",
        workspacePath: WORKSPACE,
      },
    });
    expect(chatRes.statusCode).toBe(201);
    const chat = chatRes.json().chat as { id: string; taskId: string };
    expect(chat.id).toBeTruthy();
    expect(chat.taskId).toBeTruthy();

    const attachRes = await app.inject({
      method: "POST",
      url: "/api/dispatch/attached",
      headers: auth(OPERATOR),
      payload: { vendor: "codex", chatId: chat.id },
    });
    if (attachRes.statusCode !== 201) {
      throw new Error(
        `attach failed ${attachRes.statusCode}: ${attachRes.body}`
      );
    }
    const attached = attachRes.json() as {
      job: {
        id: string;
        capabilityMode: string;
        delegationDeadline: string;
        delegationBudgetReservedMs: number;
      };
      chat: { id: string; taskId: string };
      capability: { token: string; expiresAt: string };
      attestation?: { posture: string };
    };
    expect(attached.job.capabilityMode).toBe(ATTACHED_COORDINATOR_CAPABILITY_MODE);
    expect(attached.attestation?.posture ?? "non-hermetic").toMatch(
      /non-hermetic|compatibility/i
    );

    const capToken = attached.capability.token;
    expect(capToken.length).toBeGreaterThanOrEqual(32);

    const capPath = writeAttachedCoordinatorCapabilityFile(
      {
        version: 1,
        vendor: "codex",
        apiBase: "http://127.0.0.1:9",
        apiToken: capToken,
        jobId: attached.job.id,
        delegationToken: capToken,
        chatId: chat.id,
        chatTaskId: chat.taskId,
        workspacePath: WORKSPACE,
        expiresAt: attached.capability.expiresAt,
        // ADR-0049: a real attach writes this, and the expiry above is now the
        // BOOTSTRAP width — a fixture without it would no longer be the file
        // production writes, and would be refused by the file's own reader.
        bootstrap: true,
      },
      dataDir
    );
    expect(statSync(capPath).mode & 0o777).toBe(0o600);
    const capRaw = readFileSync(capPath, "utf8");
    expect(capRaw).toContain(capToken);

    const io = codexConfigIo();
    const spec = resolveInstallableVendor("codex")!;
    const outcome = installMcpServer(io, {
      spec,
      scope: spec.defaultScope,
      command: "/usr/bin/true",
      dryRun: false,
      mode: "attached-coordinator",
      capabilityFile: capPath,
    });
    const outcomeJson = JSON.stringify(outcome);
    expect(outcomeJson).not.toContain(capToken);
    const entry = readVendorEntry(spec, spec.defaultScope, io.roots);
    expect(entry.kind).toBe("present");
    if (entry.kind === "present") {
      expect(entry.environment.MUON_MCP_MODE).toBe(
        ATTACHED_COORDINATOR_CAPABILITY_MODE
      );
      expect(entry.environment.MUON_ATTACHED_CAPABILITY_FILE).toBe(capPath);
      expect(entry.environment.MUON_API_TOKEN).toBeUndefined();
      expect(entry.environment.MUON_AGENT_TOKEN).toBeUndefined();
      expect(Object.values(entry.environment)).not.toContain(capToken);
    }

    let lastExpiry = attached.capability.expiresAt;
    for (let i = 0; i < 2; i++) {
      const hb = await app.inject({
        method: "POST",
        url: `/api/dispatch/attached/${attached.job.id}/heartbeat`,
        headers: auth(capToken),
      });
      expect(hb.statusCode).toBe(200);
      lastExpiry = hb.json().expiresAt as string;
    }
    // ADR-0049: heartbeats NARROW a bootstrap lease back to the steady state —
    // the wide window exists only until the seat proves it is alive. What must
    // hold is that the lease is still live and still bounded.
    expect(new Date(lastExpiry).getTime()).toBeLessThan(
      new Date(attached.capability.expiresAt).getTime()
    );
    expect(new Date(lastExpiry).getTime()).toBeGreaterThan(Date.now());

    const taskRes = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: auth(capToken),
      payload: {
        title: "live-proof child task",
        description: "governed child task created by attached coordinator",
        workspacePath: WORKSPACE,
      },
    });
    if (![200, 201].includes(taskRes.statusCode)) {
      throw new Error(`create task ${taskRes.statusCode}: ${taskRes.body}`);
    }
    const taskId =
      (taskRes.json() as { id?: string; task?: { id: string } }).id ??
      (taskRes.json() as { task?: { id: string } }).task?.id ??
      chat.taskId;

    const childRes = await app.inject({
      method: "POST",
      url: `/api/dispatch/${attached.job.id}/delegate`,
      headers: { ...auth(capToken), "x-muon-delegation-token": capToken },
      payload: {
        vendor: "codex",
        taskId,
        brief: "live-proof governed child under attached root",
      },
    });
    expect(childRes.statusCode).toBe(201);
    const child = childRes.json().job as {
      id: string;
      capabilityMode: string;
      parentJobId?: string;
    };
    expect(child.capabilityMode).toBe("delegate");
    expect(child.parentJobId ?? attached.job.id).toBeTruthy();

    const root = await db.prisma.dispatchJob.findUnique({
      where: { id: attached.job.id },
    });
    expect(root?.delegationBudgetReservedMs).toBeGreaterThan(0);
    expect(root!.delegationDeadline!.getTime()).toBeGreaterThan(
      Date.now() + ATTACHED_COORDINATOR_LEASE_TTL_MS * 5
    );

    for (const probe of [
      { method: "PUT" as const, url: "/api/fleet", payload: {} },
      {
        method: "PATCH" as const,
        url: `/api/dispatch/${attached.job.id}/budget`,
        payload: { maxDescendantWallMs: 999_999_999 },
      },
      {
        method: "POST" as const,
        url: "/api/workflow-runs/does-not-exist/apply",
        payload: {},
      },
      {
        method: "PATCH" as const,
        url: "/api/approvals/does-not-exist",
        payload: { status: "approved" },
      },
    ]) {
      const res = await app.inject({
        method: probe.method,
        url: probe.url,
        headers: auth(capToken),
        payload: probe.payload,
      });
      expect(res.statusCode).toBe(403);
    }

    const otherChat = await app.inject({
      method: "POST",
      url: "/api/chats",
      headers: auth(OPERATOR),
      payload: {
        title: "other chat for cross-chat refuse",
        workspacePath: WORKSPACE,
      },
    });
    const otherId = otherChat.json().chat.id as string;
    const cross = await app.inject({
      method: "GET",
      url: `/api/chats/${otherId}`,
      headers: auth(capToken),
    });
    expect(cross.statusCode).not.toBe(200);

    // Stop heartbeats → lapse lease → sweeper (same as MCP exit + TTL+sweep).
    await db.prisma.delegationGrant.update({
      where: { jobId: attached.job.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const reaped = await attachedLib.sweepExpiredAttachedCoordinators();
    expect(reaped).toContain(attached.job.id);

    const seat = await db.prisma.agent.findUnique({
      where: { vendor_ordinal: { vendor: "codex", ordinal: 0 } },
    });
    expect(seat?.status).toBe("idle");
    expect(seat?.currentJobId).toBeNull();

    const childAfter = await db.prisma.dispatchJob.findUnique({
      where: { id: child.id },
    });
    expect(childAfter?.status).toBe("interrupted");

    const reattach = await app.inject({
      method: "POST",
      url: "/api/dispatch/attached",
      headers: auth(OPERATOR),
      payload: { vendor: "codex", chatId: chat.id },
    });
    expect(reattach.statusCode).toBe(201);
  });
});
