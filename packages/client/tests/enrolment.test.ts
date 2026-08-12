import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  it("round-trips a choice", () => {
    const dir = tempDir();
    writeEnrolment({ vendors: ["claude-code", "codex"] }, dir);
    const read = readEnrolment(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.enrolment.vendors).toEqual(["claude-code", "codex"]);
      expect(read.enrolment.mode, "durable by default — no lease").toBe("base");
    }
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
      { vendors: ["codex", "codex", " codex "] },
      dir
    );
    expect(written.vendors).toEqual(["codex"]);
  });

  it("is owner-only on disk", () => {
    const dir = tempDir();
    writeEnrolment({ vendors: ["codex"] }, dir);
    expect(fs.statSync(enrolmentFilePath(dir)).mode & 0o777).toBe(0o600);
  });
});
