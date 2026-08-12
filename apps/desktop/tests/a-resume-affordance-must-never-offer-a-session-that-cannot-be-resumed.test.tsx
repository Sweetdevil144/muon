// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  claudeProjectSlug,
  claudeTranscriptCandidates,
  findCodexRolloutFile,
  verifyVendorSessionInStore,
  type StoreFs,
} from "../src/lib/vendor-session-store.js";
import { resolveTerminalVendorSession } from "../src/lib/terminal-workspace-resolver.js";
import { JobStreamTerminal } from "../src/renderer/job-stream-terminal.js";

/**
 * A RESUME AFFORDANCE MUST NEVER OFFER A SESSION THAT CANNOT BE RESUMED.
 *
 * The founder clicked "Open this job's real Codex session (019fa2c4…)" and the
 * pane answered with codex's own stack-trace-shaped refusal: `ERROR: No saved
 * session found with ID …`. The id was real — MUON had stamped it — but the
 * session behind it was not: the app-server thread had been started ephemeral
 * and codex never saved a rollout. The same dead-button class covers a pruned
 * worktree (claude keys its store off the cwd), a cleared temp store, and a
 * vendor-trimmed transcript.
 *
 * The rule these tests pin: the affordance decides whether to EXIST from the
 * exact check the click will be judged by — the vendor's own session store —
 * and every refusal carries a sentence, never a vendor error after the click.
 */

const SESSION_ID = "019fa2c4-5f9b-70f1-9225-03dba896d740";

/**
 * The resume pane's terminal body, stubbed: mounting the real one would open a
 * MessagePort through an Electron bridge jsdom does not have. It records every
 * MOUNT (a retry must actually remount, or the terminal never re-opens) and
 * offers a button that plays the host's own refusal back through `onError`.
 */
const previewMounts = vi.hoisted(() => [] as string[]);
const SPAWN_REFUSAL = vi.hoisted(
  () =>
    "the last process in this session exited immediately (code 127) without becoming a session"
);
vi.mock("../src/renderer/terminal-preview.js", async () => {
  const react = await import("react");
  return {
    TerminalPreview: (props: {
      sessionId: string;
      onError?: (reason: string) => void;
    }) => {
      // MOUNTS, not renders: only a remount re-opens the byte channel, which
      // is the whole point of the retry.
      react.useEffect(() => {
        previewMounts.push(props.sessionId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return react.createElement(
        "button",
        { onClick: () => props.onError?.(SPAWN_REFUSAL), type: "button" },
        "simulate a refused spawn"
      );
    },
  };
});

/** In-memory store: a set of existing paths plus their directory listings. */
function storeFs(input: {
  files?: string[];
  dirs?: Record<string, { name: string; isDirectory: boolean }[]>;
  realpaths?: Record<string, string>;
}): StoreFs {
  const files = new Set(input.files ?? []);
  const dirs = input.dirs ?? {};
  return {
    exists: (target) =>
      files.has(target) || Object.prototype.hasOwnProperty.call(dirs, target),
    list: (dir) => dirs[dir] ?? [],
    realpath: (target) => input.realpaths?.[target] ?? target,
  };
}

beforeEach(() => {
  previewMounts.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("the vendor's own store is the fact the affordance answers to", () => {
  it("derives claude's project slug exactly as the live store does", () => {
    // Verified against the real store on this machine: `/` and `.` both map
    // to `-`, existing hyphens survive.
    expect(
      claudeProjectSlug("/Users/dev/SWE/MUON-LABS/.muon/worktrees/abc123")
    ).toBe("-Users-dev-SWE-MUON-LABS--muon-worktrees-abc123");
    expect(claudeProjectSlug("/tmp/muon-claude-probe/repo")).toBe(
      "-tmp-muon-claude-probe-repo"
    );
  });

  it("checks BOTH the recorded cwd and its realpath (claude slugs the resolved path)", () => {
    const candidates = claudeTranscriptCandidates({
      home: "/home/op",
      cwd: "/tmp/repo",
      realCwd: "/private/tmp/repo",
      sessionId: SESSION_ID,
    });
    expect(candidates).toContain(
      path.join(
        "/home/op",
        ".claude",
        "projects",
        "-tmp-repo",
        `${SESSION_ID}.jsonl`
      )
    );
    expect(candidates).toContain(
      path.join(
        "/home/op",
        ".claude",
        "projects",
        "-private-tmp-repo",
        `${SESSION_ID}.jsonl`
      )
    );
  });

  it("finds a codex rollout by its `rollout-<ts>-<sessionId>.jsonl` name, and only that", () => {
    const home = "/guard";
    const day = path.join(home, "sessions", "2026", "07", "27");
    const fs = storeFs({
      dirs: {
        [path.join(home, "sessions")]: [
          { name: "2026", isDirectory: true },
        ],
        [path.join(home, "sessions", "2026")]: [
          { name: "07", isDirectory: true },
        ],
        [path.join(home, "sessions", "2026", "07")]: [
          { name: "27", isDirectory: true },
        ],
        [day]: [
          {
            name: `rollout-2026-07-27T14-19-58-${SESSION_ID}.jsonl`,
            isDirectory: false,
          },
          {
            name: "rollout-2026-07-27T14-23-54-019fa2c7-d9ab-73c1-814b-49526ff94695.jsonl",
            isDirectory: false,
          },
        ],
      },
    });
    expect(findCodexRolloutFile(home, SESSION_ID, fs)).toBe(
      path.join(day, `rollout-2026-07-27T14-19-58-${SESSION_ID}.jsonl`)
    );
    expect(
      findCodexRolloutFile(home, "019fa2c4-0000-70f1-9225-03dba896d740", fs)
    ).toBeNull();
  });

  it("the founder's exact case: a stamped codex thread with NO saved rollout is refused with a sentence", () => {
    const verdict = verifyVendorSessionInStore(
      { vendor: "codex", sessionId: SESSION_ID, cwd: "/wt" },
      {
        codexHome: "/guard",
        fs: storeFs({ dirs: { "/wt": [] } }),
      }
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/no saved rollout/i);
      expect(verdict.reason).toMatch(/codex resume/i);
    }
  });

  it("a codex session whose rollout exists under the guard home is offered", () => {
    const day = path.join("/guard", "sessions", "2026", "07", "27");
    const verdict = verifyVendorSessionInStore(
      { vendor: "codex", sessionId: SESSION_ID, cwd: "/wt" },
      {
        codexHome: "/guard",
        fs: storeFs({
          dirs: {
            "/wt": [],
            [path.join("/guard", "sessions")]: [
              { name: "2026", isDirectory: true },
            ],
            [path.join("/guard", "sessions", "2026")]: [
              { name: "07", isDirectory: true },
            ],
            [path.join("/guard", "sessions", "2026", "07")]: [
              { name: "27", isDirectory: true },
            ],
            [day]: [
              {
                name: `rollout-2026-07-27T14-19-58-${SESSION_ID}.jsonl`,
                isDirectory: false,
              },
            ],
          },
        }),
      }
    );
    expect(verdict.ok).toBe(true);
  });

  it("a claude session with no transcript in the job's directory is refused with a sentence", () => {
    const verdict = verifyVendorSessionInStore(
      { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
      { home: "/home/op", fs: storeFs({ dirs: { "/wt": [] } }) }
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/no transcript/i);
    }
  });

  it("a claude session whose transcript exists is offered", () => {
    const transcript = path.join(
      "/home/op",
      ".claude",
      "projects",
      "-wt",
      `${SESSION_ID}.jsonl`
    );
    const verdict = verifyVendorSessionInStore(
      { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
      {
        home: "/home/op",
        configDir: null,
        fs: storeFs({ files: [transcript], dirs: { "/wt": [] } }),
      }
    );
    expect(verdict).toMatchObject({ ok: true, evidencePath: transcript });
  });

  it("honors CLAUDE_CONFIG_DIR — a relocated store is still a real store", () => {
    // The same env key vendor-models.ts already reads, and a declared vendor
    // credential key MUON forwards to the child: a dispatch under a relocated
    // config writes its transcript THERE. Looking only under `~/.claude` would
    // report a perfectly resumable session as gone and hide the button.
    const relocated = "/home/op/.config/claude";
    const transcript = path.join(
      relocated,
      "projects",
      "-wt",
      `${SESSION_ID}.jsonl`
    );
    const fs = storeFs({ files: [transcript], dirs: { "/wt": [] } });
    expect(
      verifyVendorSessionInStore(
        { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
        { home: "/home/op", configDir: relocated, fs }
      )
    ).toMatchObject({ ok: true, evidencePath: transcript });
    // …and the default is unchanged when the operator relocated nothing.
    expect(
      verifyVendorSessionInStore(
        { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
        { home: "/home/op", configDir: null, fs }
      ).ok
    ).toBe(false);
  });

  it("reads CLAUDE_CONFIG_DIR from the environment when no dep is injected", () => {
    const relocated = "/home/op/.config/claude";
    const transcript = path.join(
      relocated,
      "projects",
      "-wt",
      `${SESSION_ID}.jsonl`
    );
    const previous = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = ` ${relocated} `; // trimmed, like vendor-models
    try {
      expect(
        verifyVendorSessionInStore(
          { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
          {
            home: "/home/op",
            fs: storeFs({ files: [transcript], dirs: { "/wt": [] } }),
          }
        ).ok
      ).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env["CLAUDE_CONFIG_DIR"];
      } else {
        process.env["CLAUDE_CONFIG_DIR"] = previous;
      }
    }
  });

  it("a pruned worktree refuses BOTH vendors — there is nowhere to reopen the session", () => {
    for (const vendor of ["claude-code", "codex"]) {
      const verdict = verifyVendorSessionInStore(
        { vendor, sessionId: SESSION_ID, cwd: "/gone" },
        { home: "/home/op", codexHome: "/guard", fs: storeFs({}) }
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/no longer exists/i);
    }
  });

  it("a vendor with no resume path is refused, never guessed at", () => {
    const verdict = verifyVendorSessionInStore(
      { vendor: "cursor", sessionId: SESSION_ID, cwd: "/wt" },
      { fs: storeFs({ dirs: { "/wt": [] } }) }
    );
    expect(verdict.ok).toBe(false);
  });

  /**
   * F4 — EVERY refusal says whether it can change on its own.
   *
   * The caller turns `transient` into "can't be opened YET" plus ~40 s of
   * polling plus a "Check again" button. Only a STORE MISS earns that: the
   * vendor writes its session file at its own pace. An unrecorded cwd, a
   * pruned worktree and a vendor with no reopenable session are answers the
   * vendor will never revise, and they used to get the wait anyway because the
   * resolver inferred transience from the job merely being `running`.
   */
  it("classifies every refusal as transient or not, and only a STORE MISS is transient", () => {
    const cases: {
      label: string;
      input: Parameters<typeof verifyVendorSessionInStore>[0];
      deps: Parameters<typeof verifyVendorSessionInStore>[1];
      transient: boolean;
    }[] = [
      {
        label: "no recorded cwd",
        input: { vendor: "codex", sessionId: SESSION_ID, cwd: null },
        deps: { fs: storeFs({}) },
        transient: false,
      },
      {
        label: "pruned worktree",
        input: { vendor: "codex", sessionId: SESSION_ID, cwd: "/gone" },
        deps: { codexHome: "/guard", fs: storeFs({}) },
        transient: false,
      },
      {
        label: "codex store miss",
        input: { vendor: "codex", sessionId: SESSION_ID, cwd: "/wt" },
        deps: { codexHome: "/guard", fs: storeFs({ dirs: { "/wt": [] } }) },
        transient: true,
      },
      {
        label: "claude store miss",
        input: { vendor: "claude-code", sessionId: SESSION_ID, cwd: "/wt" },
        deps: {
          home: "/home/op",
          configDir: null,
          fs: storeFs({ dirs: { "/wt": [] } }),
        },
        transient: true,
      },
      {
        label: "vendor with no reopenable session",
        input: { vendor: "cursor", sessionId: SESSION_ID, cwd: "/wt" },
        deps: { fs: storeFs({ dirs: { "/wt": [] } }) },
        transient: false,
      },
    ];
    for (const testCase of cases) {
      const verdict = verifyVendorSessionInStore(
        testCase.input,
        testCase.deps
      );
      expect(verdict.ok, testCase.label).toBe(false);
      if (!verdict.ok) {
        expect(verdict.transient, testCase.label).toBe(testCase.transient);
      }
    }
  });
});

describe("the spawn-side resolver refuses what the store cannot back", () => {
  const jobRow = {
    chatId: "chat-a",
    vendor: "codex",
    status: "done",
    vendorSessionId: SESSION_ID,
    executionPath: "/wt",
    workspacePath: "/repo",
  };

  it("a recorded id the store refuses never resolves into a spawn", async () => {
    const result = await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue(jobRow),
      () => ({
        ok: false,
        reason: "the store has no saved rollout for it.",
        transient: true,
      })
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/no saved rollout/);
  });

  it("verifies against where the job ACTUALLY ran (executionPath wins)", async () => {
    const verify = vi.fn().mockReturnValue({ ok: true, evidencePath: "/x" });
    await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue(jobRow),
      verify
    );
    expect(verify).toHaveBeenCalledWith({
      vendor: "codex",
      sessionId: SESSION_ID,
      cwd: "/wt",
      mode: "resume",
    });
  });

  it("a throwing store check fails CLOSED with a reason, never open", async () => {
    const result = await resolveTerminalVendorSession(
      "job-1",
      "chat-a",
      vi.fn().mockResolvedValue(jobRow),
      () => {
        throw new Error("disk detached");
      }
    );
    expect(result).toMatchObject({ ok: false });
  });
});

describe("the renderer draws the button only on a verified probe", () => {
  const base = {
    mode: {
      kind: "replay",
      jobId: "job-1",
      label: "Run activity — this job has finished",
      following: false,
    },
    chunks: [
      {
        seq: 1,
        taskId: "t",
        laneId: "l",
        kind: "output",
        content: "done",
        timestamp: "2026-07-27T10:00:00.000Z",
      },
    ],
    vendorLabel: "Codex",
    spawnKind: "codex",
    spawnSessionId: "terminal-job-1",
    vendorSessionId: SESSION_ID,
    resumeKind: "codex:resume",
    // ONE SLOT PER DOOR (F1): a fork and a resume are different vendor
    // sessions, so they never share a pty coordinate.
    resumeSessionId: "terminal-job-1.resume",
    forkSessionId: "terminal-job-1.fork",
  } as unknown as Parameters<typeof JobStreamTerminal>[0];

  it("no probe answer yet ⇒ no button (a stamped id alone is not an offer)", () => {
    render(React.createElement(JobStreamTerminal, { ...base, resumeProbe: null }));
    expect(screen.queryByText(/Open this job's real Codex session/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Codex session" })
    ).toBeNull();
  });

  it("an unavailable probe shows its reason IN THE BUTTON'S PLACE — never a click that fails", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "unavailable",
          reason:
            "MUON recorded Codex session 019fa2c4…, but Codex's own session store has no saved rollout for it.",
        },
      })
    );
    expect(
      screen.getByText(/real Codex session can't be reopened/)
    ).toBeTruthy();
    expect(screen.getByText(/no saved rollout/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Open Codex session" })
    ).toBeNull();
  });

  it("a ready probe renders the door", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "resume",
        },
      })
    );
    expect(
      screen.getByText(/Open this job's real Codex session/)
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Codex session" })
    ).toBeTruthy();
  });

  /**
   * THE LIVE TAKEOVER. A `fork` grant is the running-job answer, and the
   * button must SAY fork: the human is about to get a second session, not the
   * one the agent is working in, and a button that promised "the real session"
   * would be describing a door MUON deliberately did not open.
   */
  it("a fork grant renders the LIVE takeover door, labelled as a fork", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        mode: {
          kind: "replay",
          jobId: "job-1",
          label: "Live activity — this agent is working",
          following: true,
        },
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "fork",
        },
      })
    );
    expect(
      screen.getByRole("button", { name: "Fork into Codex" })
    ).toBeTruthy();
    expect(
      screen.getByText(/Take over this job's Codex session now/)
    ).toBeTruthy();
    // The copy must state BOTH halves of what a fork is.
    expect(screen.getByText(/opens a FORK of its session/)).toBeTruthy();
    expect(screen.getByText(/keeps its own session/)).toBeTruthy();
    // …and must not offer the door the running-job rule forbids.
    expect(
      screen.queryByRole("button", { name: "Open Codex session" })
    ).toBeNull();
  });

  it("the opened fork pane says it is a fork and that typing cannot steer the agent", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "fork",
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Fork into Codex" }));
    // The FORK slot, never the resume one.
    expect(previewMounts).toEqual(["terminal-job-1.fork"]);
    expect(screen.getByText(/forked/)).toBeTruthy();
    expect(
      screen.getByText(/nothing you type here steers it or passes through/)
    ).toBeTruthy();
  });

  /**
   * F1(a) — A PANE MUST DESCRIBE THE DOOR IT OPENED, not the door that is
   * authorized now.
   *
   * Reproduced: open a fork on a running job, let the job finish. The probe
   * re-fires, the grant flips to `resume`, and the SAME pty — no remount, the
   * human still typing into a fork — re-rendered as "This is the Codex session
   * MUON dispatched, reopened … typing here continues the session as you".
   */
  it("a fork pane stays a fork when the job finishes and the grant flips to resume", () => {
    const { rerender } = render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "fork",
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Fork into Codex" }));
    expect(previewMounts).toEqual(["terminal-job-1.fork"]);

    // The job finishes: same mounted pane, new grant.
    rerender(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "resume",
        },
      })
    );

    expect(screen.getByText(/forked/)).toBeTruthy();
    expect(
      screen.queryByText(/typing here continues the session as you/i)
    ).toBeNull();
    expect(
      screen.queryByText(/session MUON dispatched, reopened/)
    ).toBeNull();
    // …and the pty under it never changed either.
    expect(previewMounts).toEqual(["terminal-job-1.fork"]);
  });

  /**
   * F4 — the shared worktree is not just "you will see each other's edits".
   * This job's handoff evidence and its review gate are `git diff HEAD` over
   * this very tree (packages/core/src/handoff-evidence.ts → worktree.ts), so a
   * human typing here edits the evidence they will later approve — and a
   * commit from that terminal empties the diff, deleting the agent's own
   * uncommitted work from its own evidence packet.
   */
  it("both takeover surfaces say that what you type lands in this job's evidence", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "fork",
        },
      })
    );
    // …before the click.
    expect(
      screen.getByText(/lands in this job's diff and in the evidence you approve/)
    ).toBeTruthy();
    expect(
      screen.getByText(/committing from that terminal drops the agent's own work/)
    ).toBeTruthy();

    // …and inside the opened pane.
    fireEvent.click(screen.getByRole("button", { name: "Fork into Codex" }));
    expect(
      screen.getByText(/becomes part of this job's diff/)
    ).toBeTruthy();
    expect(screen.getByText(/Do not commit from this terminal/)).toBeTruthy();
  });

  /**
   * F2 — "NOT YET" IS NOT "CANNOT".
   *
   * A running job whose vendor has not written its session to disk yet (a
   * `codex exec` rollout appeared 3 seconds into a 30-second run) refuses the
   * probe. Wording that as a permanent impossibility was false one second
   * later — and the human's only escape was switching workspace tabs.
   */
  it("a pending refusal is worded as a wait, with an explicit re-check", () => {
    const recheck = vi.fn();
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        onRecheckTakeover: recheck,
        resumeProbe: {
          status: "unavailable",
          pending: true,
          reason:
            "Codex has not saved this job's session (019fa2c4…) to its own rollout store yet.",
        },
      })
    );
    expect(screen.getByText(/session can't be opened yet/)).toBeTruthy();
    expect(screen.queryByText(/can't be reopened/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  /**
   * F2 — A FINISHED JOB THAT NEVER RECORDED A SESSION IS A DEAD END, NOT A
   * WAIT.
   *
   * `session-workspace.tsx` only starts the probe once a vendor session id is
   * stamped, so this job produces NO probe answer at all: `resumeProbe` stays
   * null, `resumeRefusedReason` is null, and `resumeAvailability` fell all the
   * way through to `"pending"`. The pane told the human MUON was waiting for
   * Codex to save a session for a job that had already ended — with nothing in
   * the app that could ever contradict it. First killed dispatch, first lie.
   */
  it("a finished job with no recorded session says there is nothing to reopen", () => {
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        // The state the parent actually passes for this job: no stamped id, so
        // no probe was ever run.
        vendorSessionId: null,
        resumeProbe: null,
      })
    );
    expect(
      screen.getByText(/holds no Codex session id for this job/)
    ).toBeTruthy();
    expect(screen.queryByText(/waiting for Codex to save/)).toBeNull();
    // …and still no button, and still no callout claiming a refusal reason it
    // does not have.
    expect(
      screen.queryByRole("button", { name: "Open Codex session" })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("a RUNNING job with no recorded session yet is still an honest wait", () => {
    // The same missing id, the other tense: this one really does get stamped
    // seconds later, so it must keep the wait — and name the FORK door it will
    // actually open, not the resume copy it used to promise.
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        mode: {
          kind: "replay",
          jobId: "job-1",
          label: "Live activity — this agent is working",
          following: true,
        },
        vendorSessionId: null,
        resumeProbe: null,
      })
    );
    expect(
      screen.getByText(/waiting for Codex to save this job's session/)
    ).toBeTruthy();
    expect(
      screen.getByText(/FORKS that session into Codex's own terminal/)
    ).toBeTruthy();
    expect(screen.queryByText(/holds no Codex session id/)).toBeNull();
  });

  it("a HARD refusal keeps the permanent wording and offers no re-check", () => {
    // The button that changes nothing is its own small lie: asking again about
    // a foreign mission, or a vendor with no fork, answers the same way.
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        onRecheckTakeover: vi.fn(),
        resumeProbe: {
          status: "unavailable",
          reason: "this job belongs to a different mission.",
        },
      })
    );
    expect(
      screen.getByText(/real Codex session can't be reopened/)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  /**
   * A REFUSAL MUST HAVE A WAY BACK. The host refuses to respawn a session id
   * whose child died on startup, and only an EXPLICIT close clears that record
   * — but no close call site in the app names a `.resume` id, so one transient
   * failure (`claude` not yet on the PATH the app was launched with) refused
   * this job's resume for the rest of the app's life. The retry is that close.
   */
  it("a resume that failed to start can be retried — the close clears the record, and the pane remounts", async () => {
    const closed: string[] = [];
    render(
      React.createElement(JobStreamTerminal, {
        ...base,
        resumeProbe: {
          status: "ready",
          vendor: "codex",
          sessionId: SESSION_ID,
          mode: "resume",
        },
        closeTerminalSession: async (sessionId: string) => {
          closed.push(sessionId);
        },
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Codex session" }));
    expect(previewMounts).toEqual(["terminal-job-1.resume"]);

    // The host refuses the spawn; the pane says so instead of going blank.
    fireEvent.click(
      screen.getByRole("button", { name: "simulate a refused spawn" })
    );
    expect(screen.getByText(/This session could not be reopened/)).toBeTruthy();
    expect(screen.getByText(/exited immediately/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // Torn down by the resume pane's OWN id — that is what forgets the
    // fast-exit record host-side — and only then remounted.
    await waitFor(() => expect(previewMounts).toHaveLength(2));
    expect(closed).toEqual(["terminal-job-1.resume"]);
    expect(previewMounts[1]).toBe("terminal-job-1.resume");
    expect(screen.queryByText(/This session could not be reopened/)).toBeNull();
  });
});
