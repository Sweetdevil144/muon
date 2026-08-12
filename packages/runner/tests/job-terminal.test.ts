import { describe, expect, it, vi } from "vitest";
import {
  JOB_TERMINAL_SESSION_PREFIX,
  JobTerminalHost,
  jobIdFromTerminalSessionId,
  jobTerminalSessionId,
  newJobTerminalEpoch,
  type JobTerminalFrame,
} from "../src/pty/job-terminal.js";

type Publish = {
  jobId: string;
  sessionId: string;
  frames: JobTerminalFrame[];
  dropped: number;
};

function harness(
  options: Partial<{
    scrollbackBytes: number;
    maxPendingFrames: number;
    fail: boolean;
  }> = {}
) {
  const published: Publish[] = [];
  const logs: string[] = [];
  const host = new JobTerminalHost({
    publish: async (input) => {
      published.push({ ...input, frames: [...input.frames] });
      if (options.fail) throw new Error("brain unreachable");
      return undefined;
    },
    // Zero debounce so a test never has to wait on a timer.
    flushMs: 0,
    ...(options.scrollbackBytes !== undefined
      ? { scrollbackBytes: options.scrollbackBytes }
      : {}),
    ...(options.maxPendingFrames !== undefined
      ? { maxPendingFrames: options.maxPendingFrames }
      : {}),
    onLog: (line) => logs.push(line),
  });
  return {
    host,
    published,
    logs,
    text: () =>
      published.flatMap((batch) => batch.frames).map((f) => f.data).join(""),
  };
}

describe("job live terminal — identity", () => {
  it("derives an id from the jobId plus an execution epoch, and round-trips it", () => {
    expect(jobTerminalSessionId("job-1", "abcd1234")).toBe(
      `${JOB_TERMINAL_SESSION_PREFIX}job-1:abcd1234`
    );
    expect(
      jobIdFromTerminalSessionId(jobTerminalSessionId("job-1", "abcd1234"))
    ).toBe("job-1");
    // Stable for one execution: same inputs, same string.
    expect(jobTerminalSessionId("job-1", "abcd1234")).toBe(
      jobTerminalSessionId("job-1", "abcd1234")
    );
    expect(newJobTerminalEpoch()).toMatch(/^[0-9a-f]{16}$/);
    expect(newJobTerminalEpoch()).not.toBe(newJobTerminalEpoch());
  });

  it("gives a RE-RUN of the same job a new id, so two attempts never splice", () => {
    // A reclaimed job re-runs under the same jobId with its frame sequence
    // restarted at 1. Without a fresh epoch the brain would either drop every
    // new frame as a replay or keep showing the dead attempt as live.
    const first = harness().host.openOrAttach("job-1").sessionId;
    const second = harness().host.openOrAttach("job-1").sessionId;
    expect(second).not.toBe(first);
    expect(jobIdFromTerminalSessionId(second)).toBe("job-1");
  });

  it("refuses to read a desktop terminal-spawn id as one of ours", () => {
    // `terminal-<jobId>` means "spawn a fresh vendor CLI in this job's
    // worktree". Conflating that with "attach to the running job" is the exact
    // defect this prefix exists to make impossible.
    expect(jobIdFromTerminalSessionId("terminal-job-1")).toBeNull();
    expect(jobIdFromTerminalSessionId(JOB_TERMINAL_SESSION_PREFIX)).toBeNull();
    // No epoch, or a non-hex one, is not one of ours either.
    expect(jobIdFromTerminalSessionId("pty:job:job-1")).toBeNull();
    expect(jobIdFromTerminalSessionId("pty:job:job-1:NOTHEX")).toBeNull();
  });
});

describe("job live terminal — attach, never spawn", () => {
  it("a second call joins the existing session rather than making a new one", () => {
    const { host } = harness();
    const first = host.openOrAttach("job-1");
    const second = host.openOrAttach("job-1");
    expect(second).toBe(first);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("keeps different jobs on different sessions", () => {
    const { host } = harness();
    expect(host.openOrAttach("job-1").sessionId).not.toBe(
      host.openOrAttach("job-2").sessionId
    );
  });
});

describe("job live terminal — the bytes a viewer receives", () => {
  it("publishes exactly what the vendor wrote, stderr included", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "building…\n");
    session.write("stderr", "warning: slow\n");
    session.write("stdout", "done\n");
    await session.end();
    expect(view.text()).toBe("building…\nwarning: slow\ndone\n");
    expect(view.published[0]?.sessionId).toBe(session.sessionId);
    expect(jobIdFromTerminalSessionId(session.sessionId)).toBe("job-1");
  });

  it("reassembles a line split across two chunk boundaries", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "hello ");
    session.write("stdout", "world\n");
    await session.end();
    expect(view.text()).toBe("hello world\n");
  });

  it("flushes a trailing partial line when the child ends", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "no trailing newline");
    expect(view.text()).toBe("");
    await session.end();
    expect(view.text()).toBe("no trailing newline");
  });

  it("numbers frames monotonically so a viewer can spot a gap", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "a\n");
    session.write("stdout", "b\n");
    await session.end();
    const seqs = view.published.flatMap((b) => b.frames).map((f) => f.seq);
    expect(seqs).toEqual([1, 2]);
  });
});

describe("job live terminal — a late viewer still sees scrollback", () => {
  it("retains console bytes locally after the writer moved on", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "first\n");
    session.write("stdout", "second\n");
    await session.end();
    // The session outlives any reader: nothing attached while it ran, and the
    // scrollback is still here to be read afterwards.
    expect(session.scrollback.map((f) => f.data).join("")).toBe(
      "first\nsecond\n"
    );
  });

  it("bounds the retained scrollback by bytes, dropping the oldest", async () => {
    const view = harness({ scrollbackBytes: 16 });
    const session = view.host.openOrAttach("job-1");
    for (let index = 0; index < 20; index += 1) {
      session.write("stdout", `line-${index}\n`);
    }
    await session.end();
    const retained = session.scrollback
      .map((f) => Buffer.byteLength(f.data, "utf8"))
      .reduce((a, b) => a + b, 0);
    expect(retained).toBeLessThanOrEqual(16 + "line-19\n".length);
    expect(session.scrollback.at(-1)?.data).toBe("line-19\n");
    // Every frame still reached the publisher, so the brain's ring — not this
    // local one — is what a late attach actually reads.
    expect(view.text()).toContain("line-0\n");
    expect(view.text()).toContain("line-19\n");
  });
});

describe("job live terminal — no token reaches the stream", () => {
  it("scrubs credential shapes out of vendor console output", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write(
      "stdout",
      "env: MUON_API_TOKEN=muon_live_abcdef123456 GITHUB_TOKEN=ghp_xxxxxxxx\n"
    );
    session.write("stderr", "curl -H 'Authorization: Bearer sk-ant-0123456789'\n");
    await session.end();
    const text = view.text();
    expect(text).not.toContain("muon_live_abcdef123456");
    expect(text).not.toContain("ghp_xxxxxxxx");
    expect(text).not.toContain("sk-ant-0123456789");
    expect(text).toContain("[redacted]");
    // The retained scrollback is scrubbed too — it is the same bytes.
    expect(session.scrollback.map((f) => f.data).join("")).not.toContain(
      "muon_live_abcdef123456"
    );
  });

  it("does not let a credential straddle a chunk boundary unscrubbed", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    // The key arrives in one chunk and its value in the next. Because a frame
    // is only cut at a line terminator, the pair is scrubbed as one line.
    session.write("stdout", "MUON_API_TOKEN=");
    session.write("stdout", "muon_live_abcdef123456\n");
    await session.end();
    expect(view.text()).not.toContain("muon_live_abcdef123456");
  });

  it("matches whole-text redaction when a value sits on the line AFTER its key", async () => {
    // `redactSecrets`'s separator is `\s*[=:]\s*` and `\s` spans newlines, so
    // scrubbing the whole text catches `GITHUB_TOKEN=\nghp_…`. A relay that cut
    // at every newline would hand the key and the value to two different passes
    // and match in NEITHER — strictly weaker than the control it claims to be.
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "GITHUB_TOKEN=\n");
    session.write("stdout", "ghp_value_on_the_next_line\n");
    await session.end();
    expect(view.text()).not.toContain("ghp_value_on_the_next_line");
    expect(view.text()).toContain("[redacted]");
  });

  it("holds a dangling `Bearer` until its token arrives", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "Authorization: Bearer\r\n");
    session.write("stdout", "sk-ant-value-after-the-break\n");
    await session.end();
    expect(view.text()).not.toContain("sk-ant-value-after-the-break");
  });

  it("still emits a dangling key when no value ever follows", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "printing MY_TOKEN=\n");
    await session.end();
    // Nothing was withheld forever: with no value there is nothing to leak, and
    // the console text the vendor really wrote still reaches the viewer.
    expect(view.text()).toBe("printing MY_TOKEN=\n");
  });

  it("never splits a line, so a credential cannot straddle two scrub passes", async () => {
    // THE defect a streaming scrubber has and a whole-text one does not. This
    // is the exact chunk that DID leak under the size-based cut this code was
    // first written with (forced cut at len-512, 512-char holdback): the key
    // ends precisely at the cut, so the first pass saw `MUON_API_TOKEN=` with
    // no value (no match, `\S+` needs a character) and the second saw the value
    // with no key (no match). Neither pass ever sees `KEY=value` whole, and a
    // holdback cannot fix that — it moves the boundary, it does not remove it,
    // and the emitted side is already gone.
    const secret = "muon_live_leak_me";
    const chunk = `${"A".repeat(8_000)}MUON_API_TOKEN=${secret}${"C".repeat(
      512 - secret.length
    )}`;
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", chunk);
    session.write("stdout", "\n");
    await session.end();
    expect(view.text()).not.toContain(secret);
    expect(view.text()).toContain("[redacted]");
  });

  it("scrubs a terminator-free run whole when the hold ceiling is reached", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    // Past the ceiling with no `\n` or `\r` anywhere, and the credential sits
    // INSIDE that run. The buffer must be emitted as ONE piece, so the scrubber
    // still sees `KEY=value` whole rather than either half of it.
    session.write(
      "stdout",
      `${"z".repeat(256 * 1024)}GITHUB_TOKEN=ghp_ceiling_secret and more text`
    );
    // Emitted by the ceiling, NOT by end(): the whole 256 KiB+ piece went out
    // in one scrub pass while the child was still running.
    await vi.waitFor(() => expect(view.published.length).toBeGreaterThan(0));
    expect(view.text()).not.toContain("ghp_ceiling_secret");
    await session.end();
    expect(view.text()).not.toContain("ghp_ceiling_secret");
    expect(view.text()).toContain("[redacted]");
    expect(view.text().length).toBeGreaterThan(256 * 1024);
  });

  it("carriage-return redraws still stream without a newline", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "progress 10%\rprogress 20%\r");
    // `\r` is a line terminator for cutting purposes — it can appear in neither
    // credential shape — so a spinner is live rather than held to the ceiling.
    // Asserted BEFORE end(), which is the whole point: it streamed.
    await vi.waitFor(() =>
      expect(view.text()).toBe("progress 10%\rprogress 20%\r")
    );
    await session.end();
  });
});

describe("job live terminal — it is never a dependency", () => {
  it("swallows a publish failure and keeps accepting output", async () => {
    const view = harness({ fail: true });
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "still working\n");
    await session.end();
    expect(() => session.write("stdout", "after end\n")).not.toThrow();
    expect(view.logs.some((line) => line.includes("degraded"))).toBe(true);
  });

  it("drops the oldest frames rather than blocking the vendor on overflow", async () => {
    const view = harness({ maxPendingFrames: 2 });
    const session = view.host.openOrAttach("job-1");
    // Written before any flush can run, so all four contend for a 2-slot queue.
    for (const line of ["a\n", "b\n", "c\n", "d\n"]) {
      session.write("stdout", line);
    }
    await session.end();
    expect(session.dropped).toBeGreaterThan(0);
    // The loss is visible as a seq gap, never as silently reordered output.
    const seqs = view.published.flatMap((b) => b.frames).map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(view.text()).toContain("d\n");
  });

  it("does not leak a credential straddling a ceiling emit and its continuation", async () => {
    // The review's F2, exactly: the ceiling emits a 256 KiB run ending mid-key,
    // and the value arrives before the next terminator. Emitting that
    // continuation would put the two halves in two scrub passes and neither
    // would match.
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", `${"z".repeat(256 * 1024)}GITHUB_TOKEN=ghp_AB`);
    session.write("stdout", "CDEFGHIJKLMNOP_TAIL\n");
    await session.end();
    expect(view.text()).not.toContain("CDEFGHIJKLMNOP_TAIL");
    expect(session.dropped).toBeGreaterThan(0);
  });

  it("bounds each publish so the brain's body limit cannot reject a batch whole", async () => {
    // The review's F1: the queue advertised 256 x 16 KiB = 4 MiB in one body,
    // against a 1 MiB default. An over-limit body is refused WHOLE, and the
    // loudest jobs are exactly the ones that would hit it.
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    for (let index = 0; index < 40; index += 1) {
      session.write("stdout", `${"x".repeat(16 * 1024 - 1)}\n`);
    }
    await session.end();
    expect(view.published.length).toBeGreaterThan(1);
    for (const batch of view.published) {
      const chars = batch.frames.reduce(
        (total, frame) => total + frame.data.length,
        0
      );
      // Worst-case JSON escaping of terminal output is ~6x (every ESC becomes
      // six characters), so this must stay far below the route's 2 MiB body.
      expect(chars).toBeLessThanOrEqual(96 * 1024 + 16 * 1024);
    }
  });

  it("counts a refused batch as dropped instead of losing it silently", async () => {
    const view = harness({ fail: true });
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "one\n");
    session.write("stdout", "two\n");
    await session.end();
    // The frames are gone; the gap they leave in `seq` is reported.
    expect(session.dropped).toBeGreaterThan(0);
    expect(view.logs.some((line) => line.includes("frame(s) lost"))).toBe(true);
  });

  it("reports the cumulative drop count to the brain on every publish", async () => {
    const view = harness({ maxPendingFrames: 2 });
    const session = view.host.openOrAttach("job-1");
    for (const line of ["a\n", "b\n", "c\n", "d\n", "e\n"]) {
      session.write("stdout", line);
    }
    await session.end();
    expect(view.published.at(-1)?.dropped).toBe(session.dropped);
    expect(session.dropped).toBeGreaterThan(0);
  });

  it("drops rather than splits a credential across two ceiling emits", async () => {
    // The residual straddle a whole-buffer ceiling emit still had: 256 KiB with
    // no terminator emits piece 1, then ANOTHER 256 KiB with still no
    // terminator would have emitted piece 2 — and a `KEY=value` sitting across
    // that join would land half in each pass. Fail closed: piece 2 is dropped.
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", `${"a".repeat(256 * 1024)}GITHUB_TOKEN`);
    session.write("stdout", `=ghp_split_across_ceilings${"b".repeat(256 * 1024)}`);
    await session.end();
    expect(view.text()).not.toContain("ghp_split_across_ceilings");
    expect(session.dropped).toBeGreaterThan(0);
    // The first piece still went out — only the continuation was withheld.
    expect(view.text()).toContain("a".repeat(100));
  });

  it("drops the continuation of a ceiling emit, then resyncs on the NEXT line", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "c".repeat(256 * 1024));
    // Everything up to the first terminator is the CONTINUATION of the run the
    // ceiling already emitted — emitting it would split that run across two
    // scrub passes, so it is dropped and counted, not shown.
    session.write("stdout", "tail-of-the-unbroken-run\n");
    expect(session.dropped).toBeGreaterThan(0);
    // From the next line on, the stream is line-aligned again and streams.
    session.write("stdout", "back to lines\n");
    await session.end();
    expect(view.text()).not.toContain("tail-of-the-unbroken-run");
    expect(view.text()).toContain("back to lines\n");
  });

  it("does not grow an unbounded publish chain behind a slow brain", async () => {
    // The queue cap bounds the QUEUE; a chain of `.then()`s would have let each
    // link pin its own batch, so a wedged publisher grew memory without limit
    // even though `pendingOut` never did.
    const batches: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = new JobTerminalHost({
      publish: async (input) => {
        batches.push(input.frames.length);
        await gate;
      },
      flushMs: 0,
      maxPendingFrames: 4,
    });
    const session = host.openOrAttach("job-1");
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    session.write("stdout", "first\n");
    await tick(); // the one drain starts and blocks on the gate
    expect(batches).toEqual([1]);

    for (let index = 0; index < 200; index += 1) {
      session.write("stdout", `line ${index}\n`);
      await tick(); // every one of these ticks used to append a chain link
    }

    // Still exactly one publish outstanding. The 200 lines waited in the CAPPED
    // queue and its overflow was dropped; under the chain they would each have
    // been moved into their own pinned closure and nothing would have dropped.
    expect(batches).toEqual([1]);
    expect(session.dropped).toBeGreaterThan(0);

    release();
    await session.end();
    // What finally goes out is bounded by the cap, not by how far behind the
    // brain fell.
    const delivered = batches.reduce((total, size) => total + size, 0);
    expect(delivered).toBeLessThanOrEqual(1 + 4);
  });

  it("end() gives up on a wedged brain instead of delaying the job's terminal write", async () => {
    // `end()` runs between the vendor finishing and the job's terminal status
    // being written. A publish that never settles must not hold that up.
    const host = new JobTerminalHost({
      publish: () => new Promise<void>(() => undefined),
      flushMs: 0,
      endDrainMs: 20,
    });
    const session = host.openOrAttach("job-1");
    session.write("stdout", "output\n");
    const startedAt = Date.now();
    await session.end();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("a throwing publisher cannot make write() throw at the vendor handler", () => {
    const host = new JobTerminalHost({
      publish: () => {
        throw new Error("synchronous explosion");
      },
      flushMs: 0,
    });
    const session = host.openOrAttach("job-1");
    expect(() => session.write("stdout", "output\n")).not.toThrow();
  });

  it("publishes nothing at all when the vendor produced no console bytes", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    await session.end();
    // This is what keeps `ptySessionId` meaning "a real console exists": an
    // in-process SDK lane writes nothing, so the brain is never told otherwise
    // and the viewer honestly falls back to the recorded stream.
    expect(view.published).toEqual([]);
  });
});

describe("job live terminal — read-only by construction", () => {
  it("exposes no way to send anything toward the child", () => {
    const { host } = harness();
    const session = host.openOrAttach("job-1");
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(session)),
      ...Object.keys(session),
    ]);
    for (const forbidden of ["send", "input", "kill", "resize", "interrupt"]) {
      expect(surface.has(forbidden)).toBe(false);
    }
    // `write` exists, but it is the INBOUND sink (the child wrote this), never
    // an outbound one; it takes a stream name the child owns.
    expect(session.write.length).toBe(2);
  });
});

describe("job live terminal — the host lifecycle", () => {
  it("close() flushes and forgets, and a later openOrAttach starts fresh", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "before close");
    await view.host.close("job-1");
    expect(view.text()).toBe("before close");
    expect(view.host.has("job-1")).toBe(false);
    expect(view.host.openOrAttach("job-1")).not.toBe(session);
  });

  it("close() on an unknown job is a no-op", async () => {
    const { host } = harness();
    await expect(host.close("nope")).resolves.toBeUndefined();
  });

  it("end() is idempotent", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "x\n");
    await session.end();
    await session.end();
    expect(view.text()).toBe("x\n");
  });
});

describe("job live terminal — very large writes", () => {
  it("splits one huge write into bounded frames", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", `${"x".repeat(40_000)}\n`);
    await session.end();
    const frames = view.published.flatMap((b) => b.frames);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.data.length).toBeLessThanOrEqual(16 * 1024);
    }
    expect(view.text().length).toBe(40_001);
  });

  it("holds a terminator-free run rather than splitting it, and flushes it at end", async () => {
    const view = harness();
    const session = view.host.openOrAttach("job-1");
    session.write("stdout", "y".repeat(9_000));
    // Deliberately NOT streamed yet: splitting it is the one thing that could
    // let a credential past the scrubber. Under pipes, vendors write lines, so
    // this branch is a safety net rather than a latency cost.
    expect(view.published).toEqual([]);
    await session.end();
    expect(view.text().length).toBe(9_000);
  });
});
