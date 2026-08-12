import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";

const prismaMock = vi.hoisted(() => ({
  dispatchJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  runner: {
    findFirst: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/graph.js", () => ({
  getGraph: () => ({}),
  mirrorToGraph: () => undefined,
}));

import { jobTerminalStore } from "../src/lib/job-terminal-store.js";

const LEASE_TOKEN = `lease-${"a".repeat(58)}`;
const OTHER_LEASE_TOKEN = `lease-${"b".repeat(58)}`;
const hashLease = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const LEASE_HASH = hashLease(LEASE_TOKEN);

const LIVE_RUNNER = {
  id: "r1",
  host: "desktop-mac",
  pid: 41,
  leaseHash: LEASE_HASH,
  status: "online",
  lastSeenAt: new Date(),
  createdAt: new Date("2026-07-10T00:00:00.000Z"),
};

const JOB_ID = "job-live";
// `pty:job:<jobId>:<epoch>` — the epoch is per EXECUTION, which is what lets a
// reclaimed job (same id, frame sequence restarted at 1) reset the ring instead
// of having every new frame dropped as a replay of the dead attempt.
const EPOCH = "a1b2c3d4e5f60718";
const SESSION_ID = `pty:job:${JOB_ID}:${EPOCH}`;
const RERUN_SESSION_ID = `pty:job:${JOB_ID}:00112233445566ff`;

function publish(
  frames: { seq: number; data: string }[],
  overrides: Record<string, unknown> = {}
) {
  return {
    host: "desktop-mac",
    leaseToken: LEASE_TOKEN,
    sessionId: SESSION_ID,
    frames,
    ...overrides,
  };
}

describe("dispatch live terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobTerminalStore.clear(JOB_ID);
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findFirst.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: null,
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: SESSION_ID,
      status: "running",
    });
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
  });

  it("attach returns exactly the bytes the job produced", async () => {
    const app = buildApp();
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([
        { seq: 1, data: "compiling…\n" },
        { seq: 2, data: "warning: slow\n" },
      ]),
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ accepted: 2, lastSeq: 2 });

    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.available).toBe(true);
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.frames.map((f: { data: string }) => f.data).join("")).toBe(
      "compiling…\nwarning: slow\n"
    );
    expect(body.lastSeq).toBe(2);
    await app.close();
  });

  it("stamps ptySessionId on the job on the first console byte", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "hello\n" }]),
    });
    expect(prismaMock.dispatchJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: JOB_ID,
        status: "running",
        host: "desktop-mac",
        runnerLeaseHash: LEASE_HASH,
      },
      data: { ptySessionId: SESSION_ID },
    });
    await app.close();
  });

  it("does not re-stamp a job that already carries the session", async () => {
    prismaMock.dispatchJob.findFirst.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: SESSION_ID,
    });
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "hello\n" }]),
    });
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("a LATE attach still sees the scrollback that already happened", async () => {
    const app = buildApp();
    for (let seq = 1; seq <= 3; seq += 1) {
      await app.inject({
        method: "POST",
        url: `/api/dispatch/${JOB_ID}/terminal`,
        payload: publish([{ seq, data: `line ${seq}\n` }]),
      });
    }
    // Nobody was attached while any of that was published.
    const late = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(
      late.json().frames.map((f: { data: string }) => f.data).join("")
    ).toBe("line 1\nline 2\nline 3\n");
    expect(late.json().firstSeq).toBe(1);
    await app.close();
  });

  it("a second attach joins the same session and resumes from its cursor", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([
        { seq: 1, data: "one\n" },
        { seq: 2, data: "two\n" },
      ]),
    });
    const first = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 3, data: "three\n" }]),
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal?afterSeq=${first.json().lastSeq}`,
    });
    // Same session id, no restart, and only the NEW bytes.
    expect(second.json().sessionId).toBe(first.json().sessionId);
    expect(
      second.json().frames.map((f: { data: string }) => f.data).join("")
    ).toBe("three\n");
    await app.close();
  });

  it("ignores a replayed frame so a runner retry cannot duplicate output", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "once\n" }]),
    });
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "once\n" }]),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.json().frames).toHaveLength(1);
    await app.close();
  });

  it("a RE-RUN of the same job resets the ring instead of dropping its frames", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([
        { seq: 1, data: "dead attempt\n" },
        { seq: 2, data: "more dead\n" },
      ]),
    });
    // The reclaimed execution restarts at seq 1 under a NEW epoch. Without the
    // epoch this would be rejected as a replay and the console would show the
    // dead attempt as if it were live.
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "live attempt\n" }], {
        sessionId: RERUN_SESSION_ID,
      }),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.json().sessionId).toBe(RERUN_SESSION_ID);
    expect(
      read.json().frames.map((f: { data: string }) => f.data).join("")
    ).toBe("live attempt\n");
    await app.close();
  });

  it("refuses a session id with no epoch, or a non-hex one", async () => {
    const app = buildApp();
    for (const sessionId of [
      `pty:job:${JOB_ID}`,
      `pty:job:${JOB_ID}:`,
      `pty:job:${JOB_ID}:NOTHEXVALUE`,
      `pty:job:${JOB_ID}:ab`,
    ]) {
      const posted = await app.inject({
        method: "POST",
        url: `/api/dispatch/${JOB_ID}/terminal`,
        payload: publish([{ seq: 1, data: "x\n" }], { sessionId }),
      });
      expect(posted.statusCode).toBe(400);
    }
    await app.close();
  });

  it("re-scrubs a credential the runner's scrubber missed", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([
        { seq: 1, data: "GITHUB_TOKEN=ghp_definitelyasecret\n" },
      ]),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    const text = read
      .json()
      .frames.map((f: { data: string }) => f.data)
      .join("");
    expect(text).not.toContain("ghp_definitelyasecret");
    expect(text).toContain("[redacted]");
    await app.close();
  });

  it("accepts a batch over 1 MiB — Fastify's implicit default would 413 it whole", async () => {
    // The review's F1: the route advertised 256 x 16 KiB in one body against an
    // implicit 1 MiB limit, and an over-limit body is refused WHOLE — silently
    // killing the live view of exactly the loudest jobs. The route now declares
    // its own limit and the runner batches to fit under it.
    const app = buildApp();
    const esc = String.fromCharCode(27);
    // Escape-heavy, like real terminal output: each ESC costs six JSON chars.
    const line = `${esc}[32mok${esc}[0m building module foo/bar/baz.ts\n`;
    const data = line.repeat(Math.ceil(16_000 / line.length)).slice(0, 16_000);
    const frames = Array.from({ length: 60 }, (_, index) => ({
      seq: index + 1,
      data,
    }));
    const payload = publish(frames);
    // Self-proving: this body is genuinely past the default that used to apply.
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeGreaterThan(
      1024 * 1024
    );
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().accepted).toBe(60);
    await app.close();
  });

  it("reports the job's status so a finished console is not read as a live one", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: SESSION_ID,
      status: "done",
    });
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "final output\n" }]),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal?afterSeq=1`,
    });
    // Ring still warm, no new frames — without `jobStatus` this is
    // indistinguishable from a live agent that has gone quiet.
    expect(read.json()).toMatchObject({
      available: true,
      jobStatus: "done",
      frames: [],
    });
    await app.close();
  });

  it("surfaces the runner's dropped count so a seq gap is not read as continuous", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 9, data: "after a gap\n" }], { dropped: 12 }),
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.json().dropped).toBe(12);
    await app.close();
  });

  it("says available:false rather than showing a blank live pane", async () => {
    const app = buildApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      available: false,
      jobStatus: "running",
      dropped: 0,
      frames: [],
      // The row still remembers the job HAD a console; the viewer is told the
      // bytes are gone, so it falls back to the recorded stream.
      sessionId: SESSION_ID,
    });
    await app.close();
  });

  it("404s an attach to a job that does not exist", async () => {
    prismaMock.dispatchJob.findUnique.mockResolvedValue(null);
    const app = buildApp();
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(read.statusCode).toBe(404);
    await app.close();
  });
});

describe("dispatch live terminal — authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobTerminalStore.clear(JOB_ID);
    prismaMock.runner.findFirst.mockResolvedValue(LIVE_RUNNER);
    prismaMock.dispatchJob.findFirst.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: null,
    });
    prismaMock.dispatchJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      ptySessionId: SESSION_ID,
      status: "running",
    });
    prismaMock.dispatchJob.updateMany.mockResolvedValue({ count: 1 });
  });

  it("refuses a session id that is not derived from its own job", async () => {
    const app = buildApp();
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "x\n" }], {
        sessionId: `pty:job:some-other-job:${EPOCH}`,
      }),
    });
    expect(posted.statusCode).toBe(400);
    expect(prismaMock.dispatchJob.updateMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a publish from anything but the exact lease-holding runner", async () => {
    prismaMock.runner.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "x\n" }], {
        leaseToken: OTHER_LEASE_TOKEN,
      }),
    });
    expect(posted.statusCode).toBe(409);
    await app.close();
  });

  it("refuses a publish for a job this runner does not hold", async () => {
    prismaMock.dispatchJob.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "x\n" }]),
    });
    expect(posted.statusCode).toBe(409);
    await app.close();
  });

  it("rejects an over-limit frame rather than silently trimming it", async () => {
    const app = buildApp();
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "x".repeat(16 * 1024 + 1) }]),
    });
    expect(posted.statusCode).toBe(400);
    await app.close();
  });

  it("offers NO write/input endpoint on the live terminal", async () => {
    // Typing into a governed agent would bypass the approval gate that makes it
    // governed. If a future change adds one, this test must fail first.
    const app = buildApp();
    await app.ready();
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const attempt = await app.inject({
        method,
        url: `/api/dispatch/${JOB_ID}/terminal`,
        payload: { data: "rm -rf /\n" },
      });
      expect(attempt.statusCode).toBe(404);
    }
    // The POST that DOES exist is the runner's publish, and it accepts only
    // frames — there is no field on it that could reach the child.
    const posted = await app.inject({
      method: "POST",
      url: `/api/dispatch/${JOB_ID}/terminal`,
      payload: publish([{ seq: 1, data: "x\n" }], { input: "rm -rf /\n" }),
    });
    expect(posted.statusCode).toBe(200);
    const read = await app.inject({
      method: "GET",
      url: `/api/dispatch/${JOB_ID}/terminal`,
    });
    expect(JSON.stringify(read.json())).not.toContain("rm -rf");
    await app.close();
  });
});
