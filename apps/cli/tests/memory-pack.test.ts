import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryNote, MemoryPackExport, MuonApiClient } from "@muon/client";
import { registerMemoryCommands } from "../src/commands/memory.js";

// P1.4 Slice 1 — `muon memory pack export`: the CLI is a dumb, deterministic
// WRITER of the operator-only route's pack. It writes the origin's own subdir
// (manifest + one content-addressed file per record), prunes stale record files
// in ITS OWN subdir only, and refuses with the server's reason on any 4xx.

const RECORD_HASH = "a".repeat(64);
const FINGERPRINT = "ws-0123456789abcdef";

function fakePack(): MemoryPackExport {
  return {
    manifest: {
      version: 1,
      origin: { fingerprint: FINGERPRINT, label: "repo" },
      counts: { records: 1, tombstones: 1, omitted: 1 },
      records: [
        {
          hash: RECORD_HASH,
          file: `records/${RECORD_HASH}.json`,
          originNoteId: "mem-1",
          textHash: "b".repeat(64),
        },
      ],
      tombstones: [
        {
          originNoteId: "mem-0",
          textHash: "c".repeat(64),
          reason: "revoked",
          supersededByNoteId: null,
          retiredAt: "2026-07-03T10:00:00.000Z",
        },
      ],
      omissions: ["1 note excluded: not human-confirmed"],
      invariants: {
        confirmedOnly: true,
        unconfirmedTextExcluded: true,
        secretsRedactedBeforeWrite: true,
        noCredentialMaterial: true,
      },
      packDigest: "d".repeat(64),
    },
    records: [
      {
        hash: RECORD_HASH,
        record: {
          version: 1,
          origin: { fingerprint: FINGERPRINT, noteId: "mem-1", label: "repo" },
          note: {
            kind: "constraint",
            text: "Never bypass the trust gate.",
            textHash: "b".repeat(64),
            scope: "project",
            trust: "high",
            modules: ["backend/src/lib/auth.ts"],
            topics: ["auth"],
            symbols: [],
            validFrom: "2026-07-01T10:00:00.000Z",
            recordedAt: "2026-07-01T10:00:00.000Z",
          },
          author: { principal: "human:carol", kind: "human" },
          confirmation: {
            principal: "human:carol",
            decision: "confirm",
            at: "2026-07-02T10:00:00.000Z",
            textHash: "b".repeat(64),
          },
          supersededTextHashes: [],
        },
      },
    ],
  };
}

const fakeImportReport = {
  origin: { fingerprint: FINGERPRINT, label: "repo" },
  proposed: [{ recordHash: RECORD_HASH, noteId: "mem-local-1" }],
  duplicatesOfConfirmed: [],
  duplicates: [],
  alreadyImported: [],
  conflicts: [],
  revocations: [],
  refused: [],
  counts: {
    records: 1,
    proposed: 1,
    duplicatesOfConfirmed: 0,
    duplicates: 0,
    alreadyImported: 0,
    conflicts: 0,
    revocations: 0,
    refused: 0,
  },
};

function makeClient(
  overrides: Partial<
    Record<"exportMemoryPack" | "importMemoryPack", unknown>
  > = {}
) {
  return {
    exportMemoryPack: vi.fn(async () => fakePack()),
    importMemoryPack: vi.fn(async () => fakeImportReport),
    ...overrides,
  } as unknown as MuonApiClient;
}

async function runMemory(client: MuonApiClient, args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerMemoryCommands(program, () => client);
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "memory", ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out: out.join(""), err: err.join("") };
}

async function runPack(client: MuonApiClient, args: string[]) {
  return runMemory(client, ["pack", ...args]);
}

let workDir: string | null = null;
afterEach(() => {
  process.exitCode = 0;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("muon memory pack export", () => {
  it("writes <store>/<fingerprint>/muon-memory-pack.json + records/<hash>.json", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const client = makeClient();
    const { out } = await runPack(client, ["export", "--out", workDir, "--workspace", "/w"]);
    expect(process.exitCode).toBe(0);
    expect(client.exportMemoryPack).toHaveBeenCalledWith("/w");

    const dir = path.join(workDir, FINGERPRINT);
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "muon-memory-pack.json"), "utf8")
    );
    expect(manifest).toEqual(fakePack().manifest);
    const record = JSON.parse(
      readFileSync(path.join(dir, "records", `${RECORD_HASH}.json`), "utf8")
    );
    expect(record).toEqual(fakePack().records[0].record);
    expect(out).toContain(dir);
    expect(out).toMatch(/1 record/);
  });

  it("prunes stale record files in its OWN origin subdir; never touches foreign subdirs", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const staleName = `${"f".repeat(64)}.json`;
    const ownRecords = path.join(workDir, FINGERPRINT, "records");
    mkdirSync(ownRecords, { recursive: true });
    writeFileSync(path.join(ownRecords, staleName), "{}\n");
    const foreignRecords = path.join(workDir, "ws-ffffffffffffffff", "records");
    mkdirSync(foreignRecords, { recursive: true });
    writeFileSync(path.join(foreignRecords, staleName), "{}\n");

    await runPack(makeClient(), ["export", "--out", workDir, "--workspace", "/w"]);
    expect(process.exitCode).toBe(0);
    expect(existsSync(path.join(ownRecords, staleName))).toBe(false);
    expect(existsSync(path.join(ownRecords, `${RECORD_HASH}.json`))).toBe(true);
    expect(existsSync(path.join(foreignRecords, staleName))).toBe(true);
  });

  it("refuses with the server's reason when the route 4xxs; writes nothing", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const client = makeClient({
      exportMemoryPack: vi.fn(async () => {
        throw new Error(
          "400 Bad Request, workspacePath '/x' resolves to '/x', which is outside the allowed workspace roots"
        );
      }),
    });
    const { err } = await runPack(client, ["export", "--out", workDir, "--workspace", "/x"]);
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/outside the allowed workspace roots/);
    expect(existsSync(path.join(workDir, FINGERPRINT))).toBe(false);
  });
});

// P1.4 Slice 2 — `muon memory pack import`: strict LOCAL pre-validation (fail
// fast, never POST a malformed pack), content-addressed filenames only (a
// manifest can never induce a read outside the pack dir), and a stable,
// deterministic report print of the server's verdicts.
function writePackDir(storeDir: string, pack: MemoryPackExport = fakePack()) {
  const dir = path.join(storeDir, pack.manifest.origin.fingerprint);
  mkdirSync(path.join(dir, "records"), { recursive: true });
  writeFileSync(
    path.join(dir, "muon-memory-pack.json"),
    `${JSON.stringify(pack.manifest, null, 2)}\n`
  );
  for (const { hash, record } of pack.records) {
    writeFileSync(
      path.join(dir, "records", `${hash}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
  }
  return dir;
}

describe("muon memory pack import", () => {
  it("posts a valid pack dir (manifest + inlined records) and prints the server report", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const dir = writePackDir(workDir);
    const client = makeClient();
    const { out } = await runPack(client, ["import", dir]);
    expect(process.exitCode).toBe(0);
    expect(client.importMemoryPack).toHaveBeenCalledTimes(1);
    const posted = (client.importMemoryPack as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MemoryPackExport;
    expect(posted.manifest).toEqual(fakePack().manifest);
    expect(posted.records).toEqual(fakePack().records);
    expect(out).toMatch(/1 proposed/);
    expect(out).toContain("mem-local-1");
  });

  it("accepts a store ROOT and imports every subdir carrying a manifest", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    writePackDir(workDir);
    const client = makeClient();
    await runPack(client, ["import", workDir]);
    expect(process.exitCode).toBe(0);
    expect(client.importMemoryPack).toHaveBeenCalledTimes(1);
  });

  // ── ADR-0026 §7 step 5: WHICH workspace receives these proposals ────────────
  //
  // Step 5 taught the route to stamp the receiving workspace onto every proposal,
  // and for one commit no surface could send one — so every CLI-driven import
  // landed in §8's residue: invisible to every agent read and non-exportable.
  // Fail-closed, and useless. These two pin the second argument, because the
  // client-level test can only see what the client was given.
  it("forwards --workspace as the RECEIVING workspace", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const dir = writePackDir(workDir);
    const client = makeClient();
    await runPack(client, ["import", dir, "--workspace", "/tmp/muon-receiving"]);
    expect(process.exitCode).toBe(0);
    expect(
      (client.importMemoryPack as ReturnType<typeof vi.fn>).mock.calls[0][1]
    ).toBe("/tmp/muon-receiving");
  });

  it("defaults the receiving workspace to the cwd, the same default `export` uses", async () => {
    // Same default on both halves ON PURPOSE: an operator who exports from one
    // directory and imports into another has made a mistake, not a choice.
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const dir = writePackDir(workDir);
    const client = makeClient();
    await runPack(client, ["import", dir]);
    expect(
      (client.importMemoryPack as ReturnType<typeof vi.fn>).mock.calls[0][1]
    ).toBe(process.cwd());
  });

  it("malformed manifest JSON → refuses with a reason and never POSTs", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const dir = path.join(workDir, FINGERPRINT);
    mkdirSync(path.join(dir, "records"), { recursive: true });
    writeFileSync(path.join(dir, "muon-memory-pack.json"), "{ not json !!");
    const client = makeClient();
    const { err } = await runPack(client, ["import", dir]);
    expect(process.exitCode).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(client.importMemoryPack).not.toHaveBeenCalled();
  });

  it("a record hash that is not 64 lowercase hex chars → refused (path-traversal guard); never POSTs", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const pack = fakePack();
    (pack.manifest.records[0] as { hash: string }).hash =
      "../../../../etc/passwd";
    const dir = path.join(workDir, FINGERPRINT);
    mkdirSync(path.join(dir, "records"), { recursive: true });
    writeFileSync(
      path.join(dir, "muon-memory-pack.json"),
      `${JSON.stringify(pack.manifest, null, 2)}\n`
    );
    const client = makeClient();
    const { err } = await runPack(client, ["import", dir]);
    expect(process.exitCode).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(client.importMemoryPack).not.toHaveBeenCalled();
  });

  it("a record file listed in the manifest but missing on disk → refused; never POSTs", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    const dir = writePackDir(workDir);
    rmSync(path.join(dir, "records", `${RECORD_HASH}.json`));
    const client = makeClient();
    const { err } = await runPack(client, ["import", dir]);
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/missing/i);
    expect(client.importMemoryPack).not.toHaveBeenCalled();
  });
});

// P1.4 Slice 3 — `muon memory pack sync`: PURE COMPOSITION of export + import
// (no new backend surface). Sync exports this workspace's own subdir, then
// imports every foreign subdir; its own pack is skipped (locally by
// fingerprint, and degrade-safe on the server's authoritative "self-pack"
// refusal — the server owns the salt, so only it can truly decide).

function foreignPack(fingerprint: string): MemoryPackExport {
  const pack = fakePack();
  pack.manifest.origin.fingerprint = fingerprint;
  for (const { record } of pack.records) {
    (record as { origin: { fingerprint: string } }).origin.fingerprint =
      fingerprint;
  }
  return pack;
}

describe("muon memory pack sync", () => {
  it("exports its own subdir, then imports each FOREIGN subdir and skips its own", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    writePackDir(workDir, foreignPack("ws-ffffffffffffffff"));
    const client = makeClient();
    const { out } = await runPack(client, ["sync", workDir, "--workspace", "/w"]);
    expect(process.exitCode).toBe(0);
    expect(client.exportMemoryPack).toHaveBeenCalledWith("/w");
    // own subdir was written by the export leg
    expect(
      existsSync(path.join(workDir, FINGERPRINT, "muon-memory-pack.json"))
    ).toBe(true);
    // only the FOREIGN pack was POSTed; the own pack was skipped
    expect(client.importMemoryPack).toHaveBeenCalledTimes(1);
    const posted = (client.importMemoryPack as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MemoryPackExport;
    expect(posted.manifest.origin.fingerprint).toBe("ws-ffffffffffffffff");
    expect(out).toMatch(/own pack/i);
    // ADR-0026 §7 step 5: ONE workspace for BOTH legs. A sync whose export leg
    // read `/w` and whose import leg stamped something else would be a sync
    // between two repositories, which is not what the word means — and the two
    // legs deriving `options.workspace ?? cwd()` separately is the duplicated
    // derivation that would let them drift apart later.
    expect(
      (client.importMemoryPack as ReturnType<typeof vi.fn>).mock.calls[0][1]
    ).toBe("/w");
  });

  it("a server-reported self-pack refusal is a SKIP, not a failure; siblings still import", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    writePackDir(workDir, foreignPack("ws-aaaaaaaaaaaaaaaa"));
    writePackDir(workDir, foreignPack("ws-ffffffffffffffff"));
    const client = makeClient({
      importMemoryPack: vi.fn(async (pack: MemoryPackExport) => {
        if (pack.manifest.origin.fingerprint === "ws-aaaaaaaaaaaaaaaa") {
          throw new Error(
            "400 Bad Request, self-pack: this pack was exported by this workspace"
          );
        }
        return fakeImportReport;
      }),
    });
    const { out } = await runPack(client, ["sync", workDir]);
    expect(process.exitCode).toBe(0);
    expect(client.importMemoryPack).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/self-pack/);
    expect(out).toMatch(/1 proposed/);
  });

  it("double-sync is idempotent: second sync reports already-imported and re-writes byte-identical own pack", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-pack-cli-"));
    writePackDir(workDir, foreignPack("ws-ffffffffffffffff"));
    let calls = 0;
    const client = makeClient({
      importMemoryPack: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return fakeImportReport;
        }
        return {
          ...fakeImportReport,
          proposed: [],
          alreadyImported: [RECORD_HASH],
          counts: {
            ...fakeImportReport.counts,
            proposed: 0,
            alreadyImported: 1,
          },
        };
      }),
    });
    await runPack(client, ["sync", workDir]);
    expect(process.exitCode).toBe(0);
    const manifestPath = path.join(workDir, FINGERPRINT, "muon-memory-pack.json");
    const firstBytes = readFileSync(manifestPath, "utf8");
    const { out } = await runPack(client, ["sync", workDir]);
    expect(process.exitCode).toBe(0);
    expect(out).toMatch(/1 already imported/);
    expect(out).not.toMatch(/1 proposed/);
    // deterministic export + atomic write → byte-identical own subdir
    expect(readFileSync(manifestPath, "utf8")).toBe(firstBytes);
  });
});

// P1.4 Slice 3 — review provenance: `muon memory review` sorts its pending list
// by note id (stable output), prints the AUTHOR (`by=<createdBy>`) so a
// `pack:ws-…` proposal is visibly foreign, and `--from-pack` narrows the queue
// to imported proposals awaiting the local human confirm.

function reviewNote(overrides: Partial<MemoryNote> & { id: string }): MemoryNote {
  return {
    id: overrides.id,
    kind: "decision",
    text: "Use the streaming parser.",
    modules: [],
    topics: [],
    symbols: [],
    trust: "low",
    confirmed: false,
    stale: false,
    status: "active",
    createdBy: "muon-capture",
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("muon memory review provenance", () => {
  const packBy = `pack:${FINGERPRINT}`;

  function reviewClient() {
    return {
      recallMemory: vi.fn(async () => [
        reviewNote({ id: "mem-z", createdBy: packBy, text: "Zed note" }),
        reviewNote({ id: "mem-h", createdBy: "muon-capture", text: "Local note" }),
        reviewNote({ id: "mem-a", createdBy: packBy, text: "Alpha note" }),
      ]),
    } as unknown as MuonApiClient;
  }

  it("--from-pack lists ONLY pack:* notes, sorted by note id", async () => {
    const { out } = await runMemory(reviewClient(), ["review", "--from-pack"]);
    expect(process.exitCode).toBe(0);
    expect(out).toContain("mem-a");
    expect(out).toContain("mem-z");
    expect(out).not.toContain("mem-h");
    expect(out.indexOf("mem-a")).toBeLessThan(out.indexOf("mem-z"));
  });

  it("printNote shows the author: by=pack:ws-… marks a foreign proposal", async () => {
    const { out } = await runMemory(reviewClient(), ["review", "--from-pack"]);
    expect(out).toContain(`by=${packBy}`);
  });

  it("plain review is sorted by note id for stable output", async () => {
    const { out } = await runMemory(reviewClient(), ["review"]);
    expect(process.exitCode).toBe(0);
    const positions = ["mem-a", "mem-h", "mem-z"].map((id) => out.indexOf(id));
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions[0]).toBeLessThan(positions[1]!);
    expect(positions[1]).toBeLessThan(positions[2]!);
  });
});

// ── P0-3 — the CLI's version of the founder's complaint ──────────────────────
//
// The desktop card stopped offering a Confirm on settled crew memory. The CLI's
// equivalent is the review queue itself: "N note(s) awaiting review" over notes
// MUON already vouched for is the same bill for work that is already done. The
// asymmetry is the point — a vouched note is never listed, an unvouched one
// always is.
describe("muon memory review — vouched crew memory is not a queue", () => {
  function vouchedNote(over: Partial<MemoryNote> & { id: string }): MemoryNote {
    return reviewNote({
      confirmedBy: "orchestrator",
      createdBy: "agent:job:job-7",
      ...over,
    });
  }

  function clientWith(notes: MemoryNote[]) {
    return {
      recallMemory: vi.fn(async () => notes),
    } as unknown as MuonApiClient;
  }

  // CLI #10: this file's helpers used to restate the desktop's tier rule and
  // drift — the terminal never learned the crew-visible "auto" tier, so a note
  // the desktop showed as "Auto · crew memory" sat here as homework. The rule
  // is now shared (@muon/client memoryNoteTier) and the CLI reads the
  // operator's real posture.
  it("with the crew-visible posture ON, an unvouched agent note is settled, not homework", async () => {
    const note = reviewNote({
      confirmedBy: null,
      createdBy: "agent:job:job-7",
    });
    const client = {
      recallMemory: vi.fn(async () => [note]),
      getAutoConfirmAgentMemory: vi.fn(async () => true),
    } as unknown as MuonApiClient;
    const { out } = await runMemory(client, ["review"]);
    expect(out).not.toMatch(/awaiting review/);
    expect(out).toMatch(/review queue empty/);
    expect(out).toMatch(/1 settled note/);
  });

  it("the same note IS homework when the posture cannot be read (strict default)", async () => {
    const note = reviewNote({
      confirmedBy: null,
      createdBy: "agent:job:job-7",
    });
    // No getAutoConfirmAgentMemory on the client at all: the sync throw must
    // read as OFF, never as ON.
    const { out } = await runMemory(clientWith([note]), ["review"]);
    expect(out).toMatch(/1 note\(s\) awaiting review/);
  });

  it("recall prints the crew-visible tier as auto-crew, matching the desktop", async () => {
    const note = reviewNote({
      confirmedBy: null,
      createdBy: "agent:job:job-7",
    });
    const client = {
      recallMemory: vi.fn(async () => [note]),
      getAutoConfirmAgentMemory: vi.fn(async () => true),
    } as unknown as MuonApiClient;
    const { out } = await runMemory(client, ["recall"]);
    expect(out).toContain("[auto-crew,");
  });

  it("lists NOTHING and never says 'awaiting review' when every note is vouched", async () => {
    const { out } = await runMemory(
      clientWith([
        vouchedNote({ id: "mem-v1" }),
        vouchedNote({ id: "mem-v2" }),
      ]),
      ["review"]
    );
    expect(process.exitCode).toBe(0);
    expect(out).not.toMatch(/awaiting review/);
    expect(out).not.toContain("mem-v1");
    // …and the empty queue says WHICH empty it is: settled, not barren.
    expect(out).toContain("review queue empty");
    expect(out).toContain("2 settled note(s) are already in every agent's brief");
  });

  it("DOES queue a genuinely unvouched note, counting only that one", async () => {
    const { out } = await runMemory(
      clientWith([
        vouchedNote({ id: "mem-v1" }),
        reviewNote({ id: "mem-open", confirmedBy: null }),
      ]),
      ["review"]
    );
    expect(out).toMatch(/^1 note\(s\) awaiting review/m);
    expect(out).toContain("mem-open");
    expect(out).not.toContain("mem-v1");
  });

  it("hands an EXPIRED vouch back to the human — nothing vouches for it now", async () => {
    const { out } = await runMemory(
      clientWith([vouchedNote({ id: "mem-lapsed", expired: true })]),
      ["review", "--show-expired"]
    );
    expect(out).toMatch(/1 note\(s\) awaiting review/);
    expect(out).toContain("mem-lapsed");
    // The row is not described as settled either: the vouch lapsed with it.
    expect(out).toContain("[unconfirmed,");
    expect(out).toContain("EXPIRED");
  });

  it("keeps ONE tier vocabulary across recall/review and the library listing", async () => {
    const vouched = vouchedNote({ id: "mem-v1" });
    const recalled = await runMemory(clientWith([vouched]), ["recall"]);
    expect(recalled.out).toContain("muon-approved");

    const listMemoryLibrary = vi.fn(async () => ({
      notes: [vouched],
      edges: [],
      confirmations: [],
      imports: [],
      total: 1,
      truncated: false,
    }));
    const listed = await runMemory(
      { listMemoryLibrary } as unknown as MuonApiClient,
      ["library"]
    );
    // The library used to be the one command that still called this note
    // "unconfirmed" — one note, two words, two commands.
    expect(listed.out).toContain("muon-approved");
    expect(listed.out).not.toContain("[unconfirmed,");
  });
});
