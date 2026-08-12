import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachedCoordinatorCapabilityFile } from "@muon/protocol";
import {
  attachedCoordinatorCapabilityDir,
  attachedCoordinatorCapabilityFilePath,
  deleteAttachedCoordinatorCapabilityFile,
  readAttachedCoordinatorCapabilityFile,
  renewAttachedCoordinatorCapabilityFile,
  writeAttachedCoordinatorCapabilityFile,
  ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES,
} from "../src/attached-coordinator-capability.js";

// ── ADR-0028 Tier C: the owner-only capability file ──────────────────────────
//
// Every test roots its own temp "data dir" (never resolveDataDir()'s real
// per-user location) so this suite can never touch a real MUON install.

const tempRoots: string[] = [];
function tempDataDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "muon-attached-capability-")
  );
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function validCapability(
  overrides: Partial<AttachedCoordinatorCapabilityFile> = {}
): AttachedCoordinatorCapabilityFile {
  return {
    version: 1,
    apiBase: "http://127.0.0.1:4317",
    apiToken: "a".repeat(64),
    jobId: "job-attached-root",
    delegationToken: "a".repeat(64),
    chatId: "chat-attached",
    chatTaskId: "task-attached-shadow",
    workspacePath: "/repo",
    vendor: "codex",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...overrides,
  };
}

describe("attachedCoordinatorCapabilityFilePath", () => {
  it("resolves under <dataDir>/attached-coordinators/<vendor>.json", () => {
    const dataDir = tempDataDir();
    expect(attachedCoordinatorCapabilityFilePath("codex", dataDir)).toBe(
      path.join(dataDir, "attached-coordinators", "codex.json")
    );
    expect(attachedCoordinatorCapabilityDir(dataDir)).toBe(
      path.join(dataDir, "attached-coordinators")
    );
  });

  it("refuses a vendor id shaped like a path traversal or containing a separator", () => {
    const dataDir = tempDataDir();
    expect(() =>
      attachedCoordinatorCapabilityFilePath("../escape", dataDir)
    ).toThrow();
    expect(() =>
      attachedCoordinatorCapabilityFilePath("codex/../../etc", dataDir)
    ).toThrow();
    expect(() =>
      attachedCoordinatorCapabilityFilePath("sub/dir", dataDir)
    ).toThrow();
    expect(() => attachedCoordinatorCapabilityFilePath("", dataDir)).toThrow();
  });
});

describe("writeAttachedCoordinatorCapabilityFile", () => {
  it("writes atomically at owner-only 0600, creating the dir at 0700", () => {
    const dataDir = tempDataDir();
    const capability = validCapability();
    const written = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    expect(written).toBe(
      attachedCoordinatorCapabilityFilePath(capability.vendor, dataDir)
    );
    const stat = fs.statSync(written);
    expect(stat.mode & 0o777).toBe(0o600);
    const dirStat = fs.statSync(attachedCoordinatorCapabilityDir(dataDir));
    expect(dirStat.mode & 0o777).toBe(0o700);

    // No leftover temp file from the write-temp-then-rename.
    const entries = fs.readdirSync(attachedCoordinatorCapabilityDir(dataDir));
    expect(entries).toEqual([`${capability.vendor}.json`]);

    const persisted = JSON.parse(fs.readFileSync(written, "utf8"));
    expect(persisted).toEqual(capability);
  });

  it("refuses to write a capability object that fails the protocol schema", () => {
    const dataDir = tempDataDir();
    expect(() =>
      writeAttachedCoordinatorCapabilityFile(
        // @ts-expect-error deliberately malformed for the test
        { ...validCapability(), apiToken: "too-short" },
        dataDir
      )
    ).toThrow();
    // Nothing partial was left behind.
    expect(fs.existsSync(attachedCoordinatorCapabilityDir(dataDir))).toBe(
      false
    );
  });

  it("never follows the old predictable temp path when writing", () => {
    const dataDir = tempDataDir();
    const dir = attachedCoordinatorCapabilityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = attachedCoordinatorCapabilityFilePath("codex", dataDir);
    const oldPredictableTmp = `${target}.${process.pid}.tmp`;
    const victim = path.join(dataDir, "must-not-be-truncated.txt");
    fs.writeFileSync(victim, "keep me");
    fs.symlinkSync(victim, oldPredictableTmp);

    writeAttachedCoordinatorCapabilityFile(validCapability(), dataDir);

    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
    expect(fs.lstatSync(target).isFile()).toBe(true);
  });
});

describe("readAttachedCoordinatorCapabilityFile", () => {
  it("round-trips a freshly written, valid capability file", () => {
    const dataDir = tempDataDir();
    const capability = validCapability();
    const written = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const result = readAttachedCoordinatorCapabilityFile(written);
    expect(result).toEqual({ ok: true, capability });
  });

  it("rejects a missing file", () => {
    const dataDir = tempDataDir();
    const target = attachedCoordinatorCapabilityFilePath("codex", dataDir);
    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("rejects a symlink without ever following it", () => {
    const dataDir = tempDataDir();
    const capability = validCapability();
    const real = writeAttachedCoordinatorCapabilityFile(capability, dataDir);
    const link = path.join(path.dirname(real), "symlinked.json");
    fs.symlinkSync(real, link);

    const result = readAttachedCoordinatorCapabilityFile(link);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("symlink");
  });

  it("rejects a file over the byte bound", () => {
    const dataDir = tempDataDir();
    const dir = attachedCoordinatorCapabilityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, "codex.json");
    const oversized = JSON.stringify(
      validCapability({ workspacePath: "/".concat("a".repeat(
        ATTACHED_COORDINATOR_CAPABILITY_MAX_BYTES
      )) })
    );
    fs.writeFileSync(target, oversized, { mode: 0o600 });

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("oversized");
  });

  it("rejects malformed JSON", () => {
    const dataDir = tempDataDir();
    const dir = attachedCoordinatorCapabilityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, "codex.json");
    fs.writeFileSync(target, "{ not json", { mode: 0o600 });

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-json");
  });

  it("rejects a schema-invalid document (e.g. a missing required field)", () => {
    const dataDir = tempDataDir();
    const dir = attachedCoordinatorCapabilityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, "codex.json");
    const { jobId: _jobId, ...withoutJobId } = validCapability();
    fs.writeFileSync(target, JSON.stringify(withoutJobId), { mode: 0o600 });

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-schema");
  });

  it("rejects group/other-readable permissions even with valid content", () => {
    const dataDir = tempDataDir();
    const capability = validCapability();
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);
    fs.chmodSync(target, 0o644);

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insecure-permissions");
  });

  it("rejects an expired capability", () => {
    const dataDir = tempDataDir();
    const capability = validCapability({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("treats an expiresAt exactly at `now` as already expired (fail closed on the boundary)", () => {
    const dataDir = tempDataDir();
    const now = new Date();
    const capability = validCapability({ expiresAt: now.toISOString() });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const result = readAttachedCoordinatorCapabilityFile(target, { now });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a far-future expiry outside the independent lease horizon", () => {
    const dataDir = tempDataDir();
    const now = new Date();
    const capability = validCapability({
      expiresAt: new Date(now.getTime() + 150_001).toISOString(),
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const result = readAttachedCoordinatorCapabilityFile(target, { now });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("inconsistent");
      expect(result.detail).toMatch(/independent lease horizon/i);
    }
  });

  it("can admit an expired file only for bounded cleanup inspection", () => {
    const dataDir = tempDataDir();
    const capability = validCapability({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    expect(
      readAttachedCoordinatorCapabilityFile(target, { allowExpired: true })
    ).toEqual({ ok: true, capability });
  });

  it("rejects a field that is blank once trimmed, even though the schema's min(1) alone would not catch it", () => {
    const dataDir = tempDataDir();
    const dir = attachedCoordinatorCapabilityDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, "codex.json");
    const capability = validCapability({ workspacePath: "   " });
    fs.writeFileSync(target, JSON.stringify(capability), { mode: 0o600 });

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("inconsistent");
      expect(result.detail).toContain("workspacePath");
    }
  });

  it("never includes apiToken or delegationToken in a rejection's detail string", () => {
    const dataDir = tempDataDir();
    const capability = validCapability({
      apiToken: "SECRET-API-TOKEN-VALUE-PADDING-PADDING-PADDING-PADDING",
      delegationToken:
        "SECRET-DELEGATION-TOKEN-PADDING-PADDING-PADDING-PADDING",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const result = readAttachedCoordinatorCapabilityFile(target);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain("SECRET-API-TOKEN");
      expect(result.detail).not.toContain("SECRET-DELEGATION-TOKEN");
    }
  });
});

describe("deleteAttachedCoordinatorCapabilityFile", () => {
  it("removes the file on detach", () => {
    const dataDir = tempDataDir();
    const capability = validCapability();
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);
    expect(fs.existsSync(target)).toBe(true);

    expect(deleteAttachedCoordinatorCapabilityFile(target)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("is a best-effort no-op when the file is already gone", () => {
    const dataDir = tempDataDir();
    const target = attachedCoordinatorCapabilityFilePath("codex", dataDir);
    expect(deleteAttachedCoordinatorCapabilityFile(target)).toBe(true);
  });
});

describe("renewAttachedCoordinatorCapabilityFile", () => {
  it("atomically persists the heartbeat expiry so a restarted MCP process remains valid", () => {
    const dataDir = tempDataDir();
    const now = new Date();
    const originalExpiry = new Date(now.getTime() + 30_000);
    const nextExpiry = new Date(now.getTime() + 150_000);
    const capability = validCapability({
      expiresAt: originalExpiry.toISOString(),
    });
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    const renewed = renewAttachedCoordinatorCapabilityFile(
      target,
      capability,
      nextExpiry.toISOString(),
      { now }
    );
    expect(renewed.expiresAt).toBe(nextExpiry.toISOString());

    const restartedRead = readAttachedCoordinatorCapabilityFile(target, {
      now: new Date(originalExpiry.getTime() + 1),
    });
    expect(restartedRead.ok).toBe(true);
    if (restartedRead.ok) {
      expect(restartedRead.capability.expiresAt).toBe(nextExpiry.toISOString());
      expect(restartedRead.capability.apiToken).toBe(capability.apiToken);
      expect(restartedRead.capability.delegationToken).toBe(
        capability.delegationToken
      );
    }
  });

  it("refuses to overwrite a capability file that changed after startup", () => {
    const dataDir = tempDataDir();
    const original = validCapability();
    const target = writeAttachedCoordinatorCapabilityFile(original, dataDir);
    writeAttachedCoordinatorCapabilityFile(
      validCapability({
        apiToken: "b".repeat(64),
        delegationToken: "b".repeat(64),
      }),
      dataDir
    );

    expect(() =>
      renewAttachedCoordinatorCapabilityFile(
        target,
        original,
        new Date(Date.now() + 120_000).toISOString()
      )
    ).toThrow(/changed at field apiToken/);
  });

  it("refuses a heartbeat expiry outside the independent lease horizon", () => {
    const dataDir = tempDataDir();
    const now = new Date();
    const capability = validCapability();
    const target = writeAttachedCoordinatorCapabilityFile(capability, dataDir);

    expect(() =>
      renewAttachedCoordinatorCapabilityFile(
        target,
        capability,
        new Date(now.getTime() + 150_001).toISOString(),
        { now }
      )
    ).toThrow(/invalid, expired, or out-of-horizon lease/);
  });
});

describe("ADR-0049 — the bootstrap window, and what bounds it", () => {
  /**
   * The failure this exists for: `muon mcp attach` printed "Next: restart
   * claude" and minted a lease that expired in two minutes. A restart takes
   * longer, so the remedy expired before it could be used and the operator
   * looped on `-32000`.
   */
  const TEN_MINUTES = 600_000;

  it("accepts a ten-minute lease ONLY from a file that declares itself un-heartbeated", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const filePath = writeAttachedCoordinatorCapabilityFile(
      validCapability({
        bootstrap: true,
        expiresAt: new Date(now.getTime() + TEN_MINUTES).toISOString(),
      }),
      dir
    );
    const read = readAttachedCoordinatorCapabilityFile(filePath, { now });
    expect(read.ok, "a declared bootstrap lease survives its own horizon").toBe(
      true
    );
  });

  it("REFUSES the same ten minutes when the file does not declare it", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const filePath = writeAttachedCoordinatorCapabilityFile(
      validCapability({
        expiresAt: new Date(now.getTime() + TEN_MINUTES).toISOString(),
      }),
      dir
    );
    const read = readAttachedCoordinatorCapabilityFile(filePath, { now });
    // Absent is the NARROW case: a forged far-future timestamp cannot buy the
    // wider window, and a file from an older build is bounded as it was.
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("inconsistent");
  });

  it("still refuses a lease beyond even the bootstrap horizon", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const filePath = writeAttachedCoordinatorCapabilityFile(
      validCapability({
        bootstrap: true,
        // A year out. Declaring bootstrap widens the guard; it never removes it.
        expiresAt: new Date(now.getTime() + 31_536_000_000).toISOString(),
      }),
      dir
    );
    const read = readAttachedCoordinatorCapabilityFile(filePath, { now });
    expect(read.ok).toBe(false);
  });

  it("the FIRST heartbeat ends the window — the flag is dropped, not carried", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const capability = validCapability({
      bootstrap: true,
      expiresAt: new Date(now.getTime() + TEN_MINUTES).toISOString(),
    });
    const filePath = writeAttachedCoordinatorCapabilityFile(capability, dir);
    const renewed = renewAttachedCoordinatorCapabilityFile(
      filePath,
      capability,
      new Date(now.getTime() + 120_000).toISOString(),
      { now }
    );
    expect(renewed.bootstrap, "a connected seat is back under the steady-state horizon").toBeUndefined();

    // And the file on disk agrees: re-widening it now would be refused.
    const wide = new Date(now.getTime() + TEN_MINUTES).toISOString();
    expect(() =>
      renewAttachedCoordinatorCapabilityFile(filePath, renewed, wide, { now })
    ).toThrow(/out-of-horizon/);
  });

  it("a heartbeat cannot renew at the bootstrap width, so one wide grant cannot stay wide", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const capability = validCapability({
      bootstrap: true,
      expiresAt: new Date(now.getTime() + TEN_MINUTES).toISOString(),
    });
    const filePath = writeAttachedCoordinatorCapabilityFile(capability, dir);
    expect(() =>
      renewAttachedCoordinatorCapabilityFile(
        filePath,
        capability,
        new Date(now.getTime() + TEN_MINUTES).toISOString(),
        { now }
      )
    ).toThrow(/out-of-horizon/);
  });

  it("an expired bootstrap lease is still expired — the window is not immunity", () => {
    const dir = tempDataDir();
    const now = new Date("2026-08-11T12:00:00.000Z");
    const filePath = writeAttachedCoordinatorCapabilityFile(
      validCapability({
        bootstrap: true,
        expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      }),
      dir
    );
    const read = readAttachedCoordinatorCapabilityFile(filePath, { now });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("expired");
  });
});
