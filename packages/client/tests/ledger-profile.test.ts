import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dbFilePath, lockfilePath } from "../src/paths.js";
import {
  detectLedgerCollision,
  legacyDesktopDataDir,
  resolveLedgerProfile,
} from "../src/ledger-profile.js";

const roots: string[] = [];
function profile(withLedger: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-profile-"));
  roots.push(dir);
  if (withLedger) fs.writeFileSync(dbFilePath(dir), "sqlite-ish");
  return dir;
}
afterEach(() => {
  roots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  roots.length = 0;
});

describe("ADR-0050 — which ledger a surface opens", () => {
  it("MOVES the legacy ledger when it is the ONLY history", () => {
    // The ordinary upgrade. Opening it in place would NOT converge: the
    // desktop would keep writing the legacy profile while every CLI command
    // still resolved the canonical one, so the first `muon` command run with
    // the app closed would spawn a second brain on an empty db — and then both
    // exist and the split is permanent.
    const legacy = profile(true);
    const canonical = profile(false);
    const result = resolveLedgerProfile(legacy, canonical);
    expect(result.reason).toBe("migrated");
    expect(result.dataDir).toBe(canonical);
    // The history is THERE, not merely pointed at.
    expect(fs.existsSync(dbFilePath(canonical))).toBe(true);
    expect(fs.readFileSync(dbFilePath(canonical), "utf8")).toBe("sqlite-ish");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("keeps a displaced canonical directory instead of merging or deleting it", () => {
    const legacy = profile(true);
    const canonical = profile(false);
    fs.writeFileSync(path.join(canonical, "settings.json"), "{}");
    const result = resolveLedgerProfile(legacy, canonical);
    expect(result.reason).toBe("migrated");
    roots.push(`${canonical}.pre-migration`);
    expect(
      fs.readFileSync(path.join(`${canonical}.pre-migration`, "settings.json"), "utf8")
    ).toBe("{}");
  });

  it("opens the legacy ledger in place, WITHOUT moving it, while a brain holds it", () => {
    // Renaming a profile out from under a running brain is how a half-moved
    // ledger happens. Deferring keeps the machine split — recoverable — and
    // says so.
    const legacy = profile(true);
    const canonical = profile(false);
    fs.writeFileSync(
      lockfilePath(legacy),
      JSON.stringify({
        port: 10566,
        token: "t",
        pid: process.pid,
        dbPath: dbFilePath(legacy),
        startedAt: new Date(0).toISOString(),
      })
    );
    const result = resolveLedgerProfile(legacy, canonical);
    expect(result.reason).toBe("adopted-legacy");
    expect(result.dataDir).toBe(legacy);
    expect(fs.existsSync(dbFilePath(legacy)), "nothing moved").toBe(true);
    expect(result.note).toMatch(/second, empty brain/);
  });

  it("counts a WAL sidecar as history — the main db may not be checkpointed", () => {
    // The brain opens SQLite in WAL mode, so committed history can sit in
    // `muon.db-wal` with the main file still empty. Judging by `muon.db` alone
    // would read a real ledger as a fresh profile and migrate the wrong way.
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "muon-profile-"));
    roots.push(legacy);
    fs.writeFileSync(dbFilePath(legacy), "");
    fs.writeFileSync(`${dbFilePath(legacy)}-wal`, "uncheckpointed");
    const canonical = profile(true);
    expect(resolveLedgerProfile(legacy, canonical).reason).toBe("collision");
  });

  it("uses the canonical one on a fresh machine", () => {
    const result = resolveLedgerProfile(profile(false), profile(false));
    expect(result.reason).toBe("canonical");
    expect(result.note).toBeUndefined();
  });

  it("uses the canonical one when only it has history", () => {
    const canonical = profile(true);
    expect(resolveLedgerProfile(profile(false), canonical)).toMatchObject({
      dataDir: canonical,
      reason: "canonical",
    });
  });

  it("REFUSES TO CHOOSE when both are real, and names both", () => {
    // Picking by size or mtime would silently strand somebody's history —
    // the exact failure the ADR exists to end, committed by the code meant
    // to fix it. It keeps the one already in use and says so.
    const legacy = profile(true);
    const canonical = profile(true);
    const result = resolveLedgerProfile(legacy, canonical);
    expect(result.reason).toBe("collision");
    expect(result.dataDir, "a running session's history never moves").toBe(legacy);
    expect(result.otherDataDir).toBe(canonical);
    expect(result.note).toContain(legacy);
    expect(result.note).toContain(canonical);
    expect(result.note).toMatch(/never merged/);
  });

  it("never merges — it only ever returns ONE directory", () => {
    const result = resolveLedgerProfile(profile(true), profile(true));
    expect(typeof result.dataDir).toBe("string");
    expect(result.dataDir).not.toBe(result.otherDataDir);
  });

  it("is a no-op when a surface already uses the canonical dir", () => {
    const canonical = profile(true);
    expect(resolveLedgerProfile(canonical, canonical).reason).toBe("canonical");
  });

  it("treats an EMPTY db file as no ledger, not as history", () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "muon-profile-"));
    roots.push(legacy);
    fs.writeFileSync(dbFilePath(legacy), "");
    const canonical = profile(false);
    expect(resolveLedgerProfile(legacy, canonical).reason).toBe("canonical");
  });
});

describe("ADR-0050 — what `muon doctor` can see", () => {
  it("reports a split when BOTH profiles hold a ledger, naming both", () => {
    const canonical = profile(true);
    const legacy = profile(true);
    const result = detectLedgerCollision(canonical, legacy);
    expect(result.split).toBe(true);
    expect(result.detail).toContain(canonical);
    expect(result.detail).toContain(legacy);
    expect(result.detail).toMatch(/never merged/);
  });

  it("is quiet when only one ledger exists", () => {
    expect(detectLedgerCollision(profile(true), profile(false)).split).toBe(false);
    expect(detectLedgerCollision(profile(false), profile(true)).split).toBe(false);
    expect(detectLedgerCollision(profile(false), profile(false)).split).toBe(false);
  });

  it("is quiet when both paths are the SAME dir — one ledger, seen twice", () => {
    const only = profile(true);
    expect(detectLedgerCollision(only, only).split).toBe(false);
  });

  it("finds the desktop's pre-ADR profile, slash and all", () => {
    // Electron derives userData from `productName ?? name`, and the package is
    // `@muon/desktop` with no productName — so `@muon` is a real directory.
    const legacy = legacyDesktopDataDir();
    expect(legacy).toContain(path.join("@muon", "desktop"));
    expect(path.isAbsolute(legacy)).toBe(true);
  });
});
