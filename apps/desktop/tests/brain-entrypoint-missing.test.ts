import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── A GIVE-UP WITH NOTHING BEHIND IT HAS TO SAY SO ───────────────────────────
//
// Every other way the supervisor fails to produce coordinates is recoverable and
// now speaks: a slow boot keeps polling and reports "still starting (Ns)", and a
// child that dies before it is ready stands down on both channels. A MISSING
// ENTRYPOINT is neither — it is a packaging defect (no `backend/dist/index.js` in
// the bundle) that no amount of waiting fixes — and it reported itself only to
// the log. Main paints its window before the brain starts and seeds the offline
// banner with "the brain is starting", so a silent give-up here would leave that
// sentence standing forever: a claim of progress that will never happen.
//
// `existsSync` is mocked to refuse everything, which is exactly the packaged
// failure: `resolveEntry` finds no candidate and no override.

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
vi.mock("@muon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/client")>();
  return { ...actual, readLockfile: vi.fn(() => null) };
});

import { BrainSupervisor } from "../src/lib/brain.js";

beforeEach(() => {
  existsSyncMock.mockReturnValue(false);
  spawnMock.mockImplementation(() => new EventEmitter());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a brain with no entrypoint to start", () => {
  it("reports itself unavailable instead of leaving the UI mid-sentence", async () => {
    const logs: string[] = [];
    const onStatus = vi.fn();
    const supervisor = new BrainSupervisor({
      dataDir: "/tmp/muon-no-entrypoint-test",
      onChange: vi.fn(),
      onStatus,
      onLog: (line) => logs.push(line),
    });

    expect(await supervisor.start()).toBeNull();
    // Nothing was spawned, so there is no child whose exit could ever stand a
    // watch down: this call is the only chance to explain itself.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith({
      state: "unavailable",
      detail: expect.stringContaining("could not find the brain"),
    });
    // And the remedy, in the same sentence — this is a reinstall, not a retry.
    const [[status]] = onStatus.mock.calls as [[{ detail: string }]];
    expect(status.detail).toMatch(/MUON_BRAIN_ENTRY/);
    expect(
      logs.some((line) => line.includes("could not locate the brain entrypoint"))
    ).toBe(true);

    supervisor.stop();
  });
});
