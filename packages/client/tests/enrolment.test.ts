import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrolledVendorIds,
  enrolmentFilePath,
  readEnrolment,
  writeEnrolment,
} from "../src/enrolment.js";

const roots: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-enrolment-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  roots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  roots.length = 0;
});

describe("the enrolment record — what the human chose", () => {
  it("round-trips a choice, with the mode ON EACH VENDOR", () => {
    const dir = tempDir();
    writeEnrolment(
      {
        vendors: [
          { id: "claude-code" },
          { id: "codex", mode: "observer" },
        ],
      },
      dir
    );
    const read = readEnrolment(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      // v2: per-vendor mode — the one shape that can tell the truth about a
      // machine whose vendors were installed differently.
      expect(read.enrolment.vendors).toEqual([
        { id: "claude-code", mode: "base" },
        { id: "codex", mode: "observer" },
      ]);
      expect(enrolledVendorIds(read.enrolment)).toEqual([
        "claude-code",
        "codex",
      ]);
    }
  });

  it("a v1 record READS as v2 — each vendor inherits the machine-wide mode", () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      enrolmentFilePath(dir),
      JSON.stringify({
        version: 1,
        vendors: ["claude-code", "codex"],
        mode: "observer",
        updatedAt: "2026-08-01T00:00:00.000Z",
      })
    );
    const read = readEnrolment(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.enrolment.version).toBe(2);
      expect(read.enrolment.vendors).toEqual([
        { id: "claude-code", mode: "observer" },
        { id: "codex", mode: "observer" },
      ]);
    }
    // Reading upgraded IN MEMORY only; the file itself is untouched — a read
    // must never mutate the record it reports on.
    expect(
      (JSON.parse(fs.readFileSync(enrolmentFilePath(dir), "utf8")) as { version: number })
        .version
    ).toBe(1);
  });

  it("NEVER SET UP and CHOSE NOTHING are different answers", () => {
    const dir = tempDir();
    // Absent: this machine has never been through setup, so `--fix` has
    // nothing to restore and should say so rather than repairing to empty.
    expect(readEnrolment(dir)).toEqual({ ok: false, reason: "absent" });

    writeEnrolment({ vendors: [] }, dir);
    const read = readEnrolment(dir);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.enrolment.vendors).toEqual([]);
  });

  it("a corrupt file is REPORTED, never read as absent", () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(enrolmentFilePath(dir), "{ not json");
    const read = readEnrolment(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("unreadable");
  });

  it("de-duplicates, so a vendor named twice is not installed twice", () => {
    const dir = tempDir();
    const written = writeEnrolment(
      {
        vendors: [
          { id: "codex" },
          { id: "codex" },
          // …and a re-record of the same vendor in a new mode is an UPDATE,
          // last one wins — not a second row.
          { id: " codex ", mode: "observer" },
        ],
      },
      dir
    );
    expect(written.vendors).toEqual([{ id: "codex", mode: "observer" }]);
  });

  it("is owner-only on disk", () => {
    const dir = tempDir();
    writeEnrolment({ vendors: [{ id: "codex" }] }, dir);
    expect(fs.statSync(enrolmentFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});
