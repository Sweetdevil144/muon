import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_MAX_BYTES,
  RotatingLogSink,
  createLogSink,
  logMaxBytesFromEnv,
} from "../src/lib/log-sink.js";

const dirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "muon-log-sink-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function write(sink: RotatingLogSink, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function close(sink: RotatingLogSink): Promise<void> {
  return new Promise((resolve) => sink.end(() => resolve()));
}

describe("rotating log sink", () => {
  it("appends to the log file with owner-only permissions", async () => {
    const dir = workDir();
    const file = path.join(dir, "brain.log");
    const sink = createLogSink({ file });
    await write(sink, "first\n");
    await write(sink, "second\n");
    await close(sink);

    expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates to <file>.1 once the cap is passed and keeps only one generation", async () => {
    const dir = workDir();
    const file = path.join(dir, "brain.log");
    const sink = createLogSink({ file, maxBytes: 64 * 1024 });
    const block = `${"x".repeat(1023)}\n`;

    for (let index = 0; index < 70; index += 1) {
      await write(sink, block);
    }
    await write(sink, "after-rotation\n");
    await close(sink);

    expect(statSync(`${file}.1`).size).toBeGreaterThanOrEqual(64 * 1024);
    expect(readFileSync(file, "utf8")).toContain("after-rotation");
    // Bounded: the active file restarted from zero after the rotation.
    expect(statSync(file).size).toBeLessThan(64 * 1024);
    expect(() => statSync(`${file}.2`)).toThrow();
  });

  it("counts pre-existing bytes so an already-huge log rotates immediately", async () => {
    const dir = workDir();
    const file = path.join(dir, "runner.log");
    writeFileSync(file, "y".repeat(200 * 1024));
    const sink = createLogSink({ file, maxBytes: 64 * 1024 });
    await write(sink, "fresh line\n");
    // The rotated generation holds the old bytes plus that write; the next write
    // reopens a brand-new active file.
    await write(sink, "after rotation\n");
    await close(sink);

    expect(statSync(`${file}.1`).size).toBeGreaterThan(200 * 1024);
    expect(readFileSync(file, "utf8")).toBe("after rotation\n");
  });

  it("mirrors every chunk to the tee without disturbing the file", async () => {
    const dir = workDir();
    const file = path.join(dir, "brain.log");
    const teed: string[] = [];
    const sink = createLogSink({ file, tee: (chunk) => teed.push(chunk) });
    await write(sink, "mirrored\n");
    await close(sink);

    expect(teed).toEqual(["mirrored\n"]);
    expect(readFileSync(file, "utf8")).toBe("mirrored\n");
  });

  it("keeps accepting writes when the tee throws", async () => {
    const dir = workDir();
    const file = path.join(dir, "brain.log");
    const sink = createLogSink({
      file,
      tee: () => {
        throw new Error("terminal closed");
      },
    });
    await write(sink, "still logged\n");
    await close(sink);

    expect(readFileSync(file, "utf8")).toBe("still logged\n");
  });

  it("reads the cap from the environment, treating 0 as unbounded", () => {
    expect(logMaxBytesFromEnv({})).toBe(DEFAULT_LOG_MAX_BYTES);
    expect(logMaxBytesFromEnv({ MUON_LOG_MAX_BYTES: "1048576" })).toBe(1048576);
    expect(logMaxBytesFromEnv({ MUON_LOG_MAX_BYTES: "0" })).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(logMaxBytesFromEnv({ MUON_LOG_MAX_BYTES: "nonsense" })).toBe(
      DEFAULT_LOG_MAX_BYTES
    );
  });
});
