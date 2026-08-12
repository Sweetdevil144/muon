import { describe, expect, it, vi } from "vitest";
import { evasionPayloads, residualDanger } from "@muon/client";
import type { JobTerminalView, MuonApiClient } from "@muon/client";
import { GovernedSession } from "../src/shell/governed-session.js";
import { GovernedPane } from "../src/shell/governed-pane.js";
import { PtySession } from "../src/shell/pty-session.js";

/**
 * The GOVERNED pane — ADR-0046 D1's headline: a dispatched agent's console,
 * read-only because input would bypass the approval gate that makes it
 * governed.
 *
 * The client is a stub here (the attach endpoint's own contract tests live in
 * backend); what these pin is the pane's side: the read-only boundary, and
 * the four ways this surface could lie about liveness.
 */

const esc = String.fromCodePoint(0x1b);

function view(over: Partial<JobTerminalView> = {}): JobTerminalView {
  return {
    sessionId: "sess-1",
    available: true,
    jobStatus: "running",
    frames: [],
    firstSeq: 1,
    lastSeq: 0,
    dropped: 0,
    ...over,
  };
}

function stubClient(views: JobTerminalView[]): MuonApiClient {
  let index = 0;
  return {
    // Emulates the BACKEND's own filter (`frames.filter(f => f.seq >
    // afterSeq)`, job-terminal-store). Without it a stale cursor still
    // "received" every frame, which made the session-rewind rule untestable —
    // the mutation survived until the stub told the truth.
    readJobTerminal: vi.fn(
      async (_jobId: string, options?: { afterSeq?: number }) => {
        const view = views[Math.min(index++, views.length - 1)]!;
        const afterSeq = options?.afterSeq ?? 0;
        return {
          ...view,
          frames: view.frames.filter((frame) => frame.seq > afterSeq),
        };
      }
    ),
  } as unknown as MuonApiClient;
}

function session(views: JobTerminalView[]): GovernedSession {
  return new GovernedSession({
    client: stubClient(views),
    jobId: "job-1",
    title: "codex-1",
    cols: 60,
    rows: 8,
  });
}

function plain(lines: string[]): string {
  const csi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  return lines.join("\n").replace(csi, "");
}

describe("the read-only boundary is STRUCTURAL", () => {
  it("GovernedSession has no write method at all — not one that refuses", () => {
    // An absent method cannot be reached past, and a future edit that adds a
    // bypass has to delete this test to do it.
    const govSession = session([view()]);
    expect(
      (govSession as unknown as Record<string, unknown>).write
    ).toBeUndefined();
    // The contrast is the point: the UNGOVERNED pty session DOES write.
    expect(typeof PtySession.prototype.write).toBe("function");
  });

  it("GovernedPane exposes no handleInput, so the engine never routes keys to it", () => {
    const pane = new GovernedPane(session([view()]));
    expect(
      (pane as unknown as Record<string, unknown>).handleInput
    ).toBeUndefined();
  });

  it("the pane declares itself GOVERNED, and the session agrees", () => {
    const govSession = session([view()]);
    expect(govSession.ungoverned).toBe(false);
    const out = plain(new GovernedPane(govSession).render(100));
    expect(out).toContain("GOVERNED");
    expect(out).not.toContain("UNGOVERNED");
  });
});

describe("the four ways this pane could lie about liveness", () => {
  it("renders the agent's real console frames", async () => {
    const govSession = session([
      view({ frames: [{ seq: 1, data: "agent-output-here" }], lastSeq: 1 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.renderScreen().join("\n")).toContain("agent-output-here")
      );
    } finally {
      govSession.dispose();
    }
  });

  it("available:false is SAID, not rendered as a blank live pane", async () => {
    const govSession = session([
      view({ available: false, jobStatus: "succeeded", frames: [] }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.snapshot().available).toBe(false)
      );
      const out = plain(new GovernedPane(govSession).render(100));
      expect(out).toContain("no live console held");
      expect(out).toContain("succeeded");
    } finally {
      govSession.dispose();
    }
  });

  it("dropped frames are SAID — a discontinuous console is never shown as continuous", async () => {
    const govSession = session([
      view({ dropped: 7, frames: [{ seq: 1, data: "partial" }], lastSeq: 1 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() => expect(govSession.snapshot().dropped).toBe(7));
      expect(plain(new GovernedPane(govSession).render(100))).toContain(
        "7 frame(s) never reached the brain"
      );
    } finally {
      govSession.dispose();
    }
  });

  it("a ring that trimmed past the cursor is SAID", async () => {
    // First poll advances the cursor to 5; the second answers with a firstSeq
    // ABOVE it — the ring dropped frames 6..49 while we were away.
    const govSession = session([
      view({ frames: [{ seq: 5, data: "early" }], firstSeq: 1, lastSeq: 5 }),
      view({ frames: [{ seq: 50, data: "late" }], firstSeq: 50, lastSeq: 50 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() => expect(govSession.snapshot().gapped).toBe(true));
      expect(plain(new GovernedPane(govSession).render(100))).toContain(
        "trimmed past this viewer"
      );
    } finally {
      govSession.dispose();
    }
  });

  it("an attach error surfaces instead of masquerading as a quiet agent", async () => {
    const client = {
      readJobTerminal: vi.fn(async () => {
        throw new Error("403 forbidden");
      }),
    } as unknown as MuonApiClient;
    const govSession = new GovernedSession({
      client,
      jobId: "job-1",
      title: "codex-1",
      cols: 60,
      rows: 8,
    });
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.snapshot().lastError).toContain("403")
      );
      expect(plain(new GovernedPane(govSession).render(100))).toContain(
        "attach error"
      );
    } finally {
      govSession.dispose();
    }
  });
});

describe("the pane's chrome is sanitized; the console interior is not (D1)", () => {
  it("replays the corpus through the title and status", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const govSession = new GovernedSession({
        client: stubClient([view({ jobStatus: payload.text })]),
        jobId: "job-1",
        title: payload.text,
        cols: 60,
        rows: 4,
      });
      try {
        const out = plain(new GovernedPane(govSession).render(100));
        expect(residualDanger(out, ["\n"]), payload.id).toEqual([]);
      } finally {
        govSession.dispose();
      }
    }
  });

  it("a hostile AGENT console cannot arm modes in the host terminal", async () => {
    // The same class the pty pane closed, on the governed feed: an agent
    // whose recorded frames contain alt-screen and mouse-mode arming must not
    // reach the host through this pane.
    const govSession = session([
      view({
        frames: [
          {
            seq: 1,
            data: `${esc}[2J${esc}[?1049h${esc}[?1002h${esc}[5;5Htrapped`,
          },
        ],
        lastSeq: 1,
      }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.renderScreen().join("\n")).toContain("trapped")
      );
      const frame = new GovernedPane(govSession).render(100).join("\n");
      const nonSgr = frame
        .split(esc)
        .slice(1)
        .filter((chunk) => !/^\[[0-9;]*m/.test(chunk));
      expect(nonSgr, `non-SGR escapes: ${JSON.stringify(nonSgr)}`).toEqual([]);
    } finally {
      govSession.dispose();
    }
  });
});

describe("the review's findings, pinned so they cannot return", () => {
  it("a FIRST-poll ring trim is reported — the common case, previously silent", async () => {
    // Any agent running long enough to exceed the brain's ring has already
    // trimmed, so a fresh attach at cursor 0 receiving seq 100 IS a gap. A
    // `cursor > 0` guard silenced exactly this case.
    const govSession = session([
      view({ frames: [{ seq: 100, data: "mid-stream" }], firstSeq: 100, lastSeq: 100 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() => expect(govSession.snapshot().gapped).toBe(true));
    } finally {
      govSession.dispose();
    }
  });

  it("a contiguous first poll is NOT falsely flagged", async () => {
    const govSession = session([
      view({ frames: [{ seq: 1, data: "from the top" }], firstSeq: 1, lastSeq: 1 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.renderScreen().join("")).toContain("from the top")
      );
      expect(govSession.snapshot().gapped).toBe(false);
    } finally {
      govSession.dispose();
    }
  });

  it("dropped is MONOTONIC — a re-execution cannot un-say a warning", async () => {
    const govSession = session([
      view({ dropped: 4, sessionId: "run-1" }),
      view({ dropped: 0, sessionId: "run-1" }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() => expect(govSession.snapshot().dropped).toBe(4));
      await new Promise((r) => setTimeout(r, 60));
      expect(govSession.snapshot().dropped).toBe(4);
    } finally {
      govSession.dispose();
    }
  });

  it("a NEW execution rewinds the cursor, so its frames are not filtered out", async () => {
    // Without this the store restarts at seq 0, the stale cursor filters every
    // frame, and the pane shows the PREVIOUS run's screen labelled live.
    const govSession = session([
      view({ sessionId: "run-1", frames: [{ seq: 500, data: "old-run" }], firstSeq: 1, lastSeq: 500 }),
      view({ sessionId: "run-2", frames: [{ seq: 1, data: "NEW-RUN-OUTPUT" }], firstSeq: 1, lastSeq: 1 }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.renderScreen().join("\n")).toContain("NEW-RUN-OUTPUT")
      );
    } finally {
      govSession.dispose();
    }
  });

  it("the honesty band survives COMPOSITION — asserted through Shell, not the pane", async () => {
    // Every earlier test rendered the pane in isolation and passed while the
    // shell's row budget clipped three of the four lines off the bottom.
    const { Shell } = await import("../src/shell/shell.js");
    // The session's own viewport (60 rows) EXCEEDS the shell's body budget at
    // 30 terminal rows — otherwise nothing is clipped and the assertion is
    // vacuous, which is exactly how the original bug survived.
    const govSession = new GovernedSession({
      client: stubClient([
        view({
          available: false,
          dropped: 9,
          frames: Array.from({ length: 60 }, (_, i) => ({
            seq: i + 1,
            data: `line-${i}\r\n`,
          })),
          firstSeq: 100,
          lastSeq: 60,
        }),
      ]),
      jobId: "job-1",
      title: "codex-1",
      cols: 60,
      rows: 60,
    });
    try {
      govSession.start(10);
      await vi.waitFor(() => expect(govSession.snapshot().dropped).toBe(9));
      const shell = new Shell({
        sidebar: {
          spaces: [{ key: "w", name: "muon" }],
          agents: [],
          cursor: 0,
          scopes: {
            paletteOpen: false,
            formOpen: false,
            reviewOpen: false,
            memoryOpen: false,
          },
        },
        tabs: { tabs: [{ id: "chat", title: "chat" }], activeId: "chat" },
        rows: 30,
      });
      shell.setCentre(new GovernedPane(govSession));
      const composed = plain(shell.render(100).slice());
      expect(composed, "available:false").toContain("no live console held");
      expect(composed, "dropped").toContain("never reached the brain");
      expect(composed, "ring gap").toContain("trimmed past this viewer");
    } finally {
      govSession.dispose();
    }
  });
});

describe("a re-execution gets a FRESH screen, not a repainted one", () => {
  it("the previous run's output does not survive into the new one", async () => {
    const govSession = session([
      view({
        sessionId: "run-1",
        frames: [{ seq: 1, data: "OUTPUT-FROM-THE-DEAD-RUN\r\n" }],
        firstSeq: 1,
        lastSeq: 1,
      }),
      view({
        sessionId: "run-2",
        frames: [{ seq: 1, data: "output-from-the-new-run\r\n" }],
        firstSeq: 1,
        lastSeq: 1,
      }),
    ]);
    try {
      govSession.start(10);
      await vi.waitFor(() =>
        expect(govSession.renderScreen().join("\n")).toContain(
          "output-from-the-new-run"
        )
      );
      // Rewinding the cursor alone left the dead run's text underneath, with
      // the new run painting over it — one pane showing two executions.
      expect(govSession.renderScreen().join("\n")).not.toContain(
        "OUTPUT-FROM-THE-DEAD-RUN"
      );
    } finally {
      govSession.dispose();
    }
  });
});
