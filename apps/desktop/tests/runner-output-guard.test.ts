import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { guardRunnerOutput } from "../src/lib/runner-output-guard.js";

describe("guardRunnerOutput", () => {
  it("keeps broken diagnostic pipes from terminating authoritative cleanup", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stop = guardRunnerOutput(stdout, stderr);

    expect(() =>
      stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }))
    ).not.toThrow();
    expect(() =>
      stderr.emit("error", Object.assign(new Error("stream closed"), { code: "EIO" }))
    ).not.toThrow();

    stop();
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
  });
});
