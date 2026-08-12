import { beforeEach, describe, expect, it, vi } from "vitest";

// P1.4 — auth boundary for the memory-pack routes. The pack transport is
// operator-tier ONLY: an agent-tier caller must never touch the export surface
// (agents receive only accepted compact slices, never the raw sync transport).
// The pack lib is mocked so this file isolates the ROUTE-level tier guard,
// mirroring memory-route-govern.test.ts.

const OPERATOR = "operator-token-mem-pack-1";
const AGENT = "agent-token-mem-pack-1";

const packMock = vi.hoisted(() => ({
  collectMemoryPack: vi.fn(),
}));
const packImportMock = vi.hoisted(() => ({
  importMemoryPack: vi.fn(),
}));
const ledgerMock = vi.hoisted(() => ({
  getMemoryNote: vi.fn(),
  updateMemoryNote: vi.fn(),
  ingestMemoryNote: vi.fn(),
  recordMemoryUsed: vi.fn(),
  listMemoryLibrary: vi.fn(),
  migrateMemoryLifecyclePolicy: vi.fn(),
  MemoryLifecyclePreviewMismatchError: class extends Error {},
  promoteMemoryNoteToGlobal: vi.fn(),
}));
const preeditMock = vi.hoisted(() => ({ preEditContext: vi.fn() }));

vi.mock("../src/lib/memory-pack.js", () => packMock);
vi.mock("../src/lib/memory-pack-import.js", () => packImportMock);
vi.mock("../src/lib/memory-ledger.js", () => ledgerMock);
vi.mock("../src/lib/preedit.js", () => preeditMock);
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
  getEmbedder: () => undefined,
}));
vi.mock("../src/lib/codegraph.js", () => ({
  selectCodeGraphProvider: async () => null,
}));

async function buildTieredApp() {
  process.env.MUON_OPERATOR_TOKEN = OPERATOR;
  process.env.MUON_AGENT_TOKEN = AGENT;
  delete process.env.MUON_API_TOKEN;
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  return buildApp();
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const fakePack = {
  manifest: {
    version: 1,
    origin: { fingerprint: "ws-0123456789abcdef", label: "repo" },
    counts: { records: 0, tombstones: 0, omitted: 0 },
    records: [],
    tombstones: [],
    omissions: [],
    invariants: {
      confirmedOnly: true,
      unconfirmedTextExcluded: true,
      secretsRedactedBeforeWrite: true,
      noCredentialMaterial: true,
    },
    packDigest: "d".repeat(64),
  },
  records: [],
};

describe("memory pack export route governance (operator-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    packMock.collectMemoryPack.mockResolvedValue(fakePack);
  });

  it("agent GET /api/memory/pack/export → 403; the pack lib is never invoked", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/pack/export",
      headers: auth(AGENT),
    });
    expect(res.statusCode).toBe(403);
    expect(packMock.collectMemoryPack).not.toHaveBeenCalled();
    await app.close();
  });

  it("operator GET /api/memory/pack/export → 200 with the pack (workspace defaults to cwd)", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/pack/export",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().manifest.origin.fingerprint).toBe("ws-0123456789abcdef");
    expect(packMock.collectMemoryPack).toHaveBeenCalledOnce();
    await app.close();
  });

  it("operator GET with a workspace outside the allowed roots → 400 with the reason; no pack work", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/memory/pack/export?workspace=%2F",
      headers: auth(OPERATOR),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/outside the allowed/);
    expect(packMock.collectMemoryPack).not.toHaveBeenCalled();
    await app.close();
  });
});

// P1.4 Slice 2 — the import side of the transport is ALSO operator-only: the
// agent tier can never inject records into the brain, not even as proposals.
describe("memory pack import route governance (operator-only)", () => {
  const fakeReport = {
    origin: { fingerprint: "ws-0123456789abcdef", label: "repo" },
    proposed: [],
    duplicatesOfConfirmed: [],
    duplicates: [],
    alreadyImported: [],
    conflicts: [],
    revocations: [],
    refused: [],
    counts: {
      records: 0,
      proposed: 0,
      duplicatesOfConfirmed: 0,
      duplicates: 0,
      alreadyImported: 0,
      conflicts: 0,
      revocations: 0,
      refused: 0,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    packImportMock.importMemoryPack.mockResolvedValue({
      ok: true,
      report: fakeReport,
    });
  });

  it("agent POST /api/memory/pack/import → 403; the import lib is never invoked", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/pack/import",
      headers: { ...auth(AGENT), "content-type": "application/json" },
      payload: fakePack,
    });
    expect(res.statusCode).toBe(403);
    expect(packImportMock.importMemoryPack).not.toHaveBeenCalled();
    expect(ledgerMock.ingestMemoryNote).not.toHaveBeenCalled();
    await app.close();
  });

  it("operator POST /api/memory/pack/import → 200 with the deterministic report", async () => {
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/pack/import",
      headers: { ...auth(OPERATOR), "content-type": "application/json" },
      payload: fakePack,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().origin.fingerprint).toBe("ws-0123456789abcdef");
    expect(packImportMock.importMemoryPack).toHaveBeenCalledOnce();
    await app.close();
  });

  it("operator POST of a refused pack → 400 carrying the verifier's reason", async () => {
    packImportMock.importMemoryPack.mockResolvedValue({
      ok: false,
      reason: "packDigest mismatch: the manifest does not match its records",
    });
    const app = await buildTieredApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/memory/pack/import",
      headers: { ...auth(OPERATOR), "content-type": "application/json" },
      payload: fakePack,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/packDigest mismatch/);
    await app.close();
  });
});
