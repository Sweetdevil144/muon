import { describe, expect, it, vi } from "vitest";
import {
  forkMissionFromStep,
  type ForkMissionClient,
} from "../src/lib/fork-mission.js";

/**
 * ADR-0044/0071 — the desktop fork workflow, Electron-free.
 *
 * What is worth pinning here is exactly what the IPC adapter cannot show:
 * the ORDER of the fence and the write (a selection that moved between them
 * refuses BEFORE `forkMission` fires), the bound-chat authorization, and
 * refusals carrying the route's own words. What makes a fork a fork stays
 * server-side and is NOT restated by these tests.
 */

const CHAT = { id: "chat-1", status: "active", taskId: "task-root" };
const SOURCE_JOB = { id: "job-src", taskId: "task-root" };
const FORKED = {
  chat: { id: "chat-fork", title: "Fork: probe" },
  task: { id: "task-fork", title: "probe" },
  job: { id: "job-fork-root" },
  forkedFromJobId: "job-src",
};

function fakeClient(overrides: Partial<Record<keyof ForkMissionClient, unknown>> = {}) {
  return {
    getDispatchJob: vi.fn(async () => SOURCE_JOB),
    getChat: vi.fn(async () => CHAT),
    listDispatchJobs: vi.fn(async () => []),
    forkMission: vi.fn(async () => FORKED),
    ...overrides,
  } as unknown as ForkMissionClient;
}

const INPUT = { sourceJobId: "job-src", brief: "probe it", vendor: "codex" };
const STABLE = () => undefined;

describe("forkMissionFromStep", () => {
  it("no bound chat is a stated refusal — nothing is read, nothing filed", async () => {
    const client = fakeClient();
    const result = await forkMissionFromStep(client, INPUT, null, STABLE);
    expect(result).toEqual({
      ok: false,
      reason: "Select a mission before forking one of its steps.",
    });
    expect(client.getDispatchJob).not.toHaveBeenCalled();
    expect(client.forkMission).not.toHaveBeenCalled();
  });

  it("a blank step or brief refuses before any request", async () => {
    const client = fakeClient();
    for (const input of [
      { ...INPUT, sourceJobId: "   " },
      { ...INPUT, brief: "" },
    ]) {
      const result = await forkMissionFromStep(client, input, "chat-1", STABLE);
      expect(result).toEqual({
        ok: false,
        reason: "A fork names its source step and carries a brief.",
      });
    }
    expect(client.getDispatchJob).not.toHaveBeenCalled();
  });

  it("the fence holds: a source job on a FOREIGN task refuses and never files", async () => {
    // The chat's own task differs and the chat's job list does not contain
    // the source job's task → requireRendererTask throws its sentence.
    const client = fakeClient({
      getDispatchJob: vi.fn(async () => ({ id: "job-src", taskId: "task-foreign" })),
    });
    const result = await forkMissionFromStep(client, INPUT, "chat-1", STABLE);
    expect(result).toEqual({
      ok: false,
      reason: "That task does not belong to the selected chat.",
    });
    expect(client.forkMission).not.toHaveBeenCalled();
  });

  it("a selection that moved between the fence and the write refuses BEFORE forkMission fires", async () => {
    const client = fakeClient();
    const result = await forkMissionFromStep(client, INPUT, "chat-1", () => {
      throw new Error("The selected mission changed before the fork was filed.");
    });
    expect(result).toEqual({
      ok: false,
      reason: "The selected mission changed before the fork was filed.",
    });
    // The fence reads ran; the WRITE did not.
    expect(client.getDispatchJob).toHaveBeenCalledTimes(1);
    expect(client.forkMission).not.toHaveBeenCalled();
  });

  it("success trims the inputs, omits an empty title, and maps the route's names", async () => {
    const client = fakeClient();
    const result = await forkMissionFromStep(
      client,
      { sourceJobId: " job-src ", brief: " probe it ", vendor: "codex", title: "  " },
      "chat-1",
      STABLE
    );
    expect(client.forkMission).toHaveBeenCalledWith({
      sourceJobId: "job-src",
      brief: "probe it",
      vendor: "codex",
    });
    expect(result).toEqual({
      ok: true,
      chatId: "chat-fork",
      chatTitle: "Fork: probe",
      taskId: "task-fork",
      jobId: "job-fork-root",
      vendor: "codex",
    });
  });

  it("a route refusal reaches the caller VERBATIM", async () => {
    const reason =
      "sourceJobId 'job-src' is 'running'; a recorded step is a SETTLED one — interrupt the job or wait for it to finish before forking from it.";
    const client = fakeClient({
      forkMission: vi.fn(async () => {
        throw new Error(reason);
      }),
    });
    const result = await forkMissionFromStep(client, INPUT, "chat-1", STABLE);
    expect(result).toEqual({ ok: false, reason });
  });
});
