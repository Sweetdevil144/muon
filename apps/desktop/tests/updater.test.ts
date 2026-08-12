import { describe, expect, it, vi } from "vitest";
import {
  type AutoUpdaterLike,
  type UpdateStatus,
  compareVersions,
  createUpdateController,
  decideUpdateAction,
} from "../src/lib/updater.js";

// A minimal fake of electron-updater's `autoUpdater`: an event registry plus
// controllable checkForUpdates/downloadUpdate. Lets us drive the controller
// deterministically with no network and no electron.
function makeFakeUpdater(
  overrides: Partial<
    Pick<AutoUpdaterLike, "checkForUpdates" | "downloadUpdate">
  > = {}
) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const updater: AutoUpdaterLike & {
    emit: (event: string, ...args: unknown[]) => void;
  } = {
    autoDownload: true, // controller must flip this off
    autoInstallOnAppQuit: true, // controller must flip this off
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return updater;
    },
    checkForUpdates: overrides.checkForUpdates ?? vi.fn(async () => ({})),
    downloadUpdate: overrides.downloadUpdate ?? vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return updater;
}

describe("compareVersions", () => {
  it("orders numeric cores", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("tolerates a leading v and build metadata", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build.9", "1.2.3")).toBe(0);
  });

  it("ranks a release above its prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
  });
});

describe("decideUpdateAction", () => {
  it("prompts when a newer version is available", () => {
    expect(decideUpdateAction("0.1.0", "0.2.0", { online: true })).toBe(
      "prompt-download"
    );
  });

  it("no-ops when the feed is the same or older", () => {
    expect(decideUpdateAction("0.2.0", "0.2.0", { online: true })).toBe(
      "up-to-date"
    );
    expect(decideUpdateAction("0.2.0", "0.1.0", { online: true })).toBe(
      "up-to-date"
    );
  });

  it("is silent when offline or the feed is missing", () => {
    expect(decideUpdateAction("0.1.0", "0.2.0", { online: false })).toBe(
      "silent"
    );
    expect(decideUpdateAction("0.1.0", null, { online: true })).toBe("silent");
  });
});

describe("createUpdateController", () => {
  it("forces autoDownload / autoInstallOnAppQuit off (no silent install)", () => {
    const updater = makeFakeUpdater();
    createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: () => undefined,
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("prompts on a newer release", async () => {
    const updater = makeFakeUpdater();
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (s) => statuses.push(s),
    });
    await ctl.check();
    updater.emit("update-available", { version: "0.2.0" });
    expect(ctl.status()).toEqual({ state: "available", version: "0.2.0" });
    expect(statuses.some((s) => s.state === "checking")).toBe(true);
  });

  it("does NOT prompt when the feed reports the same/older version", () => {
    const updater = makeFakeUpdater();
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.2.0",
      onStatus: () => undefined,
    });
    // Even if the feed (mis)fires update-available for an older build, our
    // decision guard collapses it to up-to-date.
    updater.emit("update-available", { version: "0.1.0" });
    expect(ctl.status()).toEqual({ state: "up-to-date", version: "0.2.0" });

    updater.emit("update-not-available", { version: "0.2.0" });
    expect(ctl.status()).toEqual({ state: "up-to-date", version: "0.2.0" });
  });

  it("offline / failed check is a silent no-op (never throws, never prompts)", async () => {
    const updater = makeFakeUpdater({
      checkForUpdates: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }),
    });
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (s) => statuses.push(s),
    });
    // Must resolve, a network failure cannot reject into the caller.
    await expect(ctl.check()).resolves.toBeUndefined();
    expect(ctl.status().state).toBe("error");
    expect(statuses.some((s) => s.state === "available")).toBe(false);
  });

  it("skips the network entirely when isOnline() is false", async () => {
    const checkForUpdates = vi.fn(async () => ({}));
    const updater = makeFakeUpdater({ checkForUpdates });
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: () => undefined,
      isOnline: () => false,
    });
    await ctl.check();
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("is check-only by default until signed two-version install is verified", async () => {
    const updater = makeFakeUpdater();
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: () => undefined,
    });

    await ctl.download();
    ctl.install();

    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(ctl.status()).toMatchObject({
      state: "error",
      message: expect.stringMatching(/signed.*verified/i),
    });
  });

  it("retains the install seam behind the explicit signed-verified policy", async () => {
    const updater = makeFakeUpdater();
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: () => undefined,
      installPolicy: "signed-verified",
    });

    await ctl.download();
    ctl.install();

    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});

// ── ADR-0029: the staged-swap policy ────────────────────────────────────────

describe("staged-swap policy", () => {
  const feedInfo = {
    version: "0.1.1",
    files: [
      { url: "MUON-0.1.1-arm64-mac.zip", sha512: "abc==", size: 10 },
      { url: "MUON-0.1.1-arm64.dmg", sha512: "def==", size: 10 },
    ],
  };

  function makeStaged() {
    return {
      download: vi.fn(async (_file: { url: string; sha512: string }, onPercent: (p: number) => void) => {
        onPercent(50);
        return "/tmp/update.zip";
      }),
      apply: vi.fn(async () => undefined),
    };
  }

  it("downloads through the staged hook with verified-feed metadata and applies on install", async () => {
    const updater = makeFakeUpdater();
    const staged = makeStaged();
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      installPolicy: "staged-swap",
      staged,
    });

    updater.emit("update-available", feedInfo);
    await ctl.download();
    expect(staged.download).toHaveBeenCalledWith(
      expect.objectContaining({ url: "MUON-0.1.1-arm64-mac.zip", sha512: "abc==" }),
      expect.any(Function)
    );
    // electron-updater's own downloader must NOT be used on this path.
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(statuses).toContainEqual({ state: "downloading", percent: 50 });
    expect(statuses).toContainEqual({ state: "downloaded", version: "0.1.1" });

    ctl.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(staged.apply).toHaveBeenCalledWith("/tmp/update.zip", "0.1.1");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("refuses to download when the feed carried no sha512 (verified bytes only)", async () => {
    const updater = makeFakeUpdater();
    const staged = makeStaged();
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      installPolicy: "staged-swap",
      staged,
    });

    updater.emit("update-available", {
      version: "0.1.1",
      files: [{ url: "MUON-0.1.1-arm64-mac.zip" }],
    });
    await ctl.download();
    expect(staged.download).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      message: expect.stringMatching(/sha512/i),
    });
  });

  it("surfaces a failed apply as an error status instead of half-updating", async () => {
    const updater = makeFakeUpdater();
    const staged = makeStaged();
    staged.apply.mockRejectedValueOnce(new Error("disk full"));
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      installPolicy: "staged-swap",
      staged,
    });

    updater.emit("update-available", feedInfo);
    await ctl.download();
    ctl.install();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      message: expect.stringContaining("disk full"),
    });
  });

  it("refuses install with nothing downloaded", () => {
    const updater = makeFakeUpdater();
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      installPolicy: "staged-swap",
      staged: makeStaged(),
    });
    ctl.install();
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      message: expect.stringMatching(/no downloaded update/i),
    });
  });
});

describe("round-3 #2 — an update queues behind live governed work", () => {
  const feedInfo = {
    version: "0.1.1",
    files: [{ url: "MUON-0.1.1-arm64-mac.zip", sha512: "abc==", size: 10 }],
  };

  function makeStaged() {
    return {
      download: vi.fn(async (_f: { url: string; sha512: string }, onPercent: (p: number) => void) => {
        onPercent(50);
        return "/tmp/update.zip";
      }),
      apply: vi.fn(async () => undefined),
    };
  }

  async function readyController(liveWork: () => Promise<string[]>) {
    const updater = makeFakeUpdater();
    const staged = makeStaged();
    const statuses: UpdateStatus[] = [];
    const ctl = createUpdateController({
      autoUpdater: updater,
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      installPolicy: "staged-swap",
      staged,
      liveWork,
      workRecheckMs: 10,
    });
    updater.emit("update-available", feedInfo);
    await ctl.download();
    return { ctl, staged, statuses, updater };
  }

  it("names the lanes it would interrupt and does NOT restart under them", async () => {
    const { ctl, staged, statuses } = await readyController(async () => [
      "codex#abc123 (running)",
      "claude-code#def456 (running)",
    ]);
    ctl.install();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(staged.apply).not.toHaveBeenCalled();
    expect(statuses).toContainEqual({
      state: "waiting-for-work",
      version: "0.1.1",
      lanes: ["codex#abc123 (running)", "claude-code#def456 (running)"],
    });
  });

  it("completes the queued install on its own when the crew drains", async () => {
    let calls = 0;
    const { ctl, staged } = await readyController(async () =>
      ++calls <= 2 ? ["codex#abc123 (running)"] : []
    );
    ctl.install();
    await vi.waitFor(() => expect(staged.apply).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(staged.apply).toHaveBeenCalledWith("/tmp/update.zip", "0.1.1");
  });

  it("force is the informed interruption — applies without probing", async () => {
    const liveWork = vi.fn(async () => ["codex#abc123 (running)"]);
    const { ctl, staged } = await readyController(liveWork);
    ctl.install({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(staged.apply).toHaveBeenCalledWith("/tmp/update.zip", "0.1.1");
    expect(liveWork).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the probe fails — no restart over an unverifiable crew", async () => {
    const { ctl, staged, statuses } = await readyController(async () => {
      throw new Error("brain unreachable");
    });
    ctl.install();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(staged.apply).not.toHaveBeenCalled();
    expect(
      statuses.some(
        (status) =>
          status.state === "error" && /could not verify/i.test(status.message)
      )
    ).toBe(true);
  });

  it("a probe slower than the recheck interval cannot double-apply", async () => {
    let resolveFirst: (lanes: string[]) => void = () => undefined;
    let call = 0;
    const { ctl, staged } = await readyController(() => {
      call += 1;
      if (call === 1) {
        return new Promise<string[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve([]);
    });
    ctl.install(); // first probe hangs past the 10ms recheck cadence
    await new Promise((resolve) => setTimeout(resolve, 40));
    resolveFirst([]); // now BOTH the slow probe and any rechecks say clear
    await vi.waitFor(() => expect(staged.apply).toHaveBeenCalled(), {
      timeout: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(staged.apply).toHaveBeenCalledTimes(1);
  });

  it("a SECOND install cannot start a second swap over the same paths", async () => {
    // Greptile P1 (PR #35 round 4): the generation fence guarded the probe,
    // but `applied` was per-install — so a second install() got fresh local
    // guards and could apply again while the first apply was still running,
    // over the same application/backup/staging paths.
    let releaseApply: () => void = () => undefined;
    const { ctl, staged } = await readyController(async () => []);
    staged.apply.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve;
        })
    );

    ctl.install({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(staged.apply).toHaveBeenCalledTimes(1);

    // The operator hits Restart again while the first swap is mid-flight.
    ctl.install({ force: true });
    ctl.install();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(staged.apply).toHaveBeenCalledTimes(1);
    releaseApply();
  });

  it("a FAILED apply releases the latch, so a genuine retry still works", async () => {
    const { ctl, staged } = await readyController(async () => []);
    staged.apply.mockRejectedValueOnce(new Error("rename failed"));
    ctl.install({ force: true });
    await vi.waitFor(() => expect(staged.apply).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    ctl.install({ force: true });
    await vi.waitFor(() => expect(staged.apply).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
  });

  it("a probe superseded mid-await decides nothing — no double swap after force", async () => {
    let resolveProbe: (lanes: string[]) => void = () => undefined;
    const slowProbe = new Promise<string[]>((resolve) => {
      resolveProbe = resolve;
    });
    const { ctl, staged } = await readyController(() => slowProbe);
    ctl.install(); // probe hangs
    ctl.install({ force: true }); // supersedes; applies immediately
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(staged.apply).toHaveBeenCalledTimes(1);
    resolveProbe([]); // the STALE probe now says "all clear"
    await new Promise((resolve) => setTimeout(resolve, 10));
    // …and must not trigger a second apply over the same bundle paths.
    expect(staged.apply).toHaveBeenCalledTimes(1);
  });
});
