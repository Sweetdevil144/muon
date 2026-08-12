// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitNexusIndexStatus,
  GitNexusReindexResult,
} from "../src/shared/ipc.js";
import {
  GitNexusColumn,
  MANUAL_REINDEX_COMMAND,
  reindexAffordance,
} from "../src/renderer/gitnexus-status.js";

afterEach(cleanup);

const show = (status: GitNexusIndexStatus | null) =>
  render(<GitNexusColumn status={status} onOpenGraph={vi.fn()} />);

/** The pill text (phase label) and the detail line under it. */
const readout = () => ({
  pill: screen.getByRole("group").querySelector(".gnx-pill")?.textContent ?? "",
  detail:
    screen.getByRole("group").querySelector(".gnx-detail")?.textContent ?? "",
});

describe("GitNexusColumn — every idle reason renders its OWN copy", () => {
  // The founder saw "NOT INDEXED · will index this workspace" and could not tell
  // whether to wait, open a repo, or report a bug. One line for four situations
  // is what made a silent stall unreportable — each now says which one it is.
  it("no-repo: says there is nothing here to index, not 'not indexed'", () => {
    show({ status: "idle", reason: "no-repo", note: "No git repository found here to index" });
    const { pill, detail } = readout();
    expect(pill).toBe("no git repo");
    expect(detail).toMatch(/no git repository here/i);
    expect(detail).not.toMatch(/will index this workspace/i);
  });

  it("never-indexed: says the first index is queued", () => {
    show({ status: "idle", reason: "never-indexed" });
    const { pill, detail } = readout();
    expect(pill).toBe("not indexed");
    expect(detail).toMatch(/no local graph yet/i);
    expect(detail).toMatch(/queued/i);
  });

  it("rate-limited: says it is cooling down and WILL retry", () => {
    show({ status: "idle", reason: "rate-limited" });
    const { pill, detail } = readout();
    expect(pill).toBe("retrying");
    expect(detail).toMatch(/cooling down/i);
    expect(detail).toMatch(/will retry/i);
  });

  it("queued (multi-repo): prefers the concrete x/N progress note", () => {
    show({ status: "idle", reason: "queued", note: "1/3 repos indexed" });
    const { pill, detail } = readout();
    expect(pill).toBe("queued");
    expect(detail).toBe("1/3 repos indexed");
  });

  it("queued with no note: still says WHY it is waiting", () => {
    show({ status: "idle", reason: "queued" });
    expect(readout().detail).toMatch(/queued behind the other repos/i);
  });

  it("an idle status with no reason keeps the old copy (never blank)", () => {
    show({ status: "idle" });
    expect(readout().detail).toBe("will index this workspace");
  });

  it("the four idle reasons never render the same line", () => {
    const lines = (["no-repo", "never-indexed", "rate-limited", "queued"] as const).map(
      (reason) => {
        const view = render(
          <GitNexusColumn status={{ status: "idle", reason }} onOpenGraph={vi.fn()} />
        );
        const text =
          view.container.querySelector(".gnx-detail")?.textContent ?? "";
        view.unmount();
        return text;
      }
    );
    expect(new Set(lines).size).toBe(4);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });
});

describe("GitNexusColumn — failure and unavailable states", () => {
  it("error: names the reason AND points at the retry the operator can click", () => {
    show({ status: "error", reason: "last-attempt-failed", note: "GitNexus analyze exited (code 1)" });
    const { pill, detail } = readout();
    expect(pill).toBe("error");
    expect(detail).toMatch(/code 1/);
    // This line used to read "— will retry": true, and useless. The background
    // retry sits behind a five-minute cooldown, so the founder watched a failed
    // index with nothing to do. Now it names the action that is one click away.
    expect(detail).toMatch(/retry now/i);
  });

  it("error with no note still explains itself", () => {
    show({ status: "error" });
    expect(readout().detail).toBe("indexing failed — retry now");
  });

  it("cli-missing: explains indexing is unavailable, not merely 'unknown'", () => {
    show({
      status: "unknown",
      reason: "cli-missing",
      note: "GitNexus CLI not found; indexing unavailable",
    });
    const { pill, detail } = readout();
    expect(pill).toBe("unavailable");
    expect(detail).toMatch(/indexing unavailable/i);
  });

  it("no status at all (pre-bind) renders a reason, never a blank line", () => {
    show(null);
    const { pill, detail } = readout();
    expect(pill).toBe("unavailable");
    expect(detail.length).toBeGreaterThan(0);
  });
});

describe("GitNexusColumn — ready/indexing are unchanged", () => {
  it("ready shows the symbol count", () => {
    show({ status: "ready", symbolCount: 20627 });
    const { pill, detail } = readout();
    expect(pill).toBe("ready");
    expect(detail).toBe("20,627 symbols");
  });

  it("ready + stale is labelled STALE, never a plain green ready", () => {
    show({ status: "ready", symbolCount: 12, stale: true });
    const { pill, detail } = readout();
    // "ready" claims the graph matches the code. It does not: it was built at
    // an older commit, and every impact/review answer inherits that claim.
    expect(pill).toBe("stale");
    expect(detail).toMatch(/behind HEAD/i);
  });

  it("indexing keeps its own line", () => {
    show({ status: "indexing" });
    const { pill, detail } = readout();
    expect(pill).toBe("indexing…");
    expect(detail).toBe("building local code graph");
  });
});

describe("GitNexusColumn — Open Graph affordance", () => {
  it("is enabled only when ready", () => {
    show({ status: "ready", symbolCount: 5 });
    const button = screen.getByRole("button", {
      name: /open graph/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("is disabled and EXPLAINS why for each non-ready state", () => {
    for (const status of [
      { status: "idle", reason: "no-repo" },
      { status: "idle", reason: "never-indexed" },
      { status: "error", note: "boom" },
      { status: "unknown", reason: "cli-missing", note: "GitNexus CLI not found" },
    ] as GitNexusIndexStatus[]) {
      const view = render(
        <GitNexusColumn status={status} onOpenGraph={vi.fn()} />
      );
      const button = view.getByRole("button", {
        name: /open graph/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      // The tooltip carries the SAME honest reason as the detail line.
      const title = button.getAttribute("title") ?? "";
      const detailText =
        view.container.querySelector(".gnx-detail")?.textContent ?? "";
      expect(title).toContain(detailText);
      view.unmount();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honest states + the operator's re-index.
//
// The live failure: GitNexus indexing failed and the header offered no way to
// retry. Governed children then query the graph blind while the masthead reads
// like nothing is wrong. Two rules follow, and both are tested here:
//   1. a failed or drifted index must NEVER render as ready;
//   2. whatever state it is in, the operator can see it and act on it.
// ─────────────────────────────────────────────────────────────────────────────

/** Both labels the one button wears: "Re-index" normally, "Retry index" after a failure. */
const REINDEX = /(re-?index|retry index)/i;

const showWith = (
  status: GitNexusIndexStatus | null,
  onReindex?: () => Promise<GitNexusReindexResult>
) =>
  render(
    <GitNexusColumn
      status={status}
      onOpenGraph={vi.fn()}
      onReindex={onReindex}
    />
  );

const reindexButton = () =>
  screen.getByRole("button", { name: REINDEX }) as HTMLButtonElement;

describe("GitNexusColumn — a failed index never renders as ready", () => {
  it("multi-repo: a failed member degrades the pill to 'partial', not 'ready'", () => {
    show({
      status: "ready",
      symbolCount: 100,
      note: "1 of 2 repos · 1 failed",
      repos: [
        { path: "/q/a", name: "a", status: "ready", symbolCount: 100 },
        { path: "/q/b", name: "b", status: "error", note: "analyze exited (code 1)" },
      ],
    });
    const { pill, detail } = readout();
    expect(pill).toBe("partial");
    expect(pill).not.toBe("ready");
    // The aggregate carried "1 failed" all along; this line used to drop it and
    // render a flat "2 repos" over a repo that never indexed.
    expect(detail).toMatch(/1 failed/);
    expect(detail).toMatch(/retry now/i);
  });

  it("multi-repo: a member behind HEAD is counted, not averaged away", () => {
    show({
      status: "ready",
      repos: [
        { path: "/q/a", name: "a", status: "ready", stale: false },
        { path: "/q/b", name: "b", status: "ready", stale: true },
      ],
    });
    const { pill, detail } = readout();
    expect(pill).toBe("stale");
    expect(detail).toMatch(/1 behind HEAD/);
  });

  it("across EVERY degraded shape, the pill is never the word 'ready'", () => {
    const degraded: GitNexusIndexStatus[] = [
      { status: "ready", symbolCount: 5, stale: true },
      {
        status: "ready",
        repos: [
          { path: "/a", name: "a", status: "ready" },
          { path: "/b", name: "b", status: "error", note: "boom" },
        ],
      },
      { status: "error", note: "GitNexus analyze exited (code 1)" },
      { status: "unknown", reason: "cli-missing", note: "CLI not found" },
    ];
    for (const status of degraded) {
      const view = showWith(status);
      expect(
        view.container.querySelector(".gnx-pill")?.textContent
      ).not.toBe("ready");
      // ...and it never wears the ready fill either.
      expect(
        view.container.querySelector(".gnx-pill")?.className
      ).not.toContain("gnx-tone-ready");
      view.unmount();
    }
  });

  it("a genuinely clean index still reads ready (no false alarms)", () => {
    show({ status: "ready", symbolCount: 25398, stale: false });
    const { pill, detail } = readout();
    expect(pill).toBe("ready");
    expect(detail).toBe("25,398 symbols");
  });
});

describe("GitNexusColumn — indexing tells the truth about progress", () => {
  it("invents no percentage when the indexer reports none", () => {
    show({ status: "indexing" });
    const { pill, detail } = readout();
    expect(pill).toBe("indexing…");
    expect(detail).toBe("building local code graph");
    expect(detail).not.toMatch(/\d+\s*%/);
  });

  it("shows the REAL repo-level progress when there is some", () => {
    show({ status: "indexing", note: "Indexing 2/3 repos" });
    expect(readout().detail).toBe("Indexing 2/3 repos");
  });

  it("names an operator-triggered run as a rebuild, still with no fake bar", () => {
    show({ status: "indexing", trigger: "manual" });
    const { detail } = readout();
    expect(detail).toMatch(/rebuilding/i);
    expect(detail).not.toMatch(/\d+\s*%/);
  });
});

describe("GitNexusColumn — the re-index affordance", () => {
  it("is offered on a healthy index too (the 'I no longer trust it' click)", () => {
    showWith({ status: "ready", symbolCount: 10 });
    expect(reindexButton().disabled).toBe(false);
  });

  it("shouts RETRY when the index actually failed", () => {
    showWith({ status: "error", note: "GitNexus analyze exited (code 1)" });
    const button = reindexButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/retry/i);
    expect(button.className).toContain("gnx-urgent");
  });

  it("is disabled WHILE indexing — no second run, and it says why", () => {
    showWith({ status: "indexing" });
    const button = reindexButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/already in progress/i);
  });

  it("hides only when there is genuinely nothing to index", () => {
    showWith({ status: "idle", reason: "no-repo" });
    expect(screen.queryByRole("button", { name: REINDEX })).toBeNull();
  });

  it("cli-missing: hands over the exact command instead of a dead button", () => {
    showWith({
      status: "unknown",
      reason: "cli-missing",
      note: "GitNexus CLI not found; indexing unavailable",
    });
    const button = reindexButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain(MANUAL_REINDEX_COMMAND);
  });

  it("calls the bridge exactly once per click and shows what came back", async () => {
    const onReindex = vi.fn(
      async (): Promise<GitNexusReindexResult> => ({
        accepted: true,
        targets: ["/ws"],
        forced: true,
        note: "Rebuilding the code graph from scratch.",
      })
    );
    showWith({ status: "error", note: "boom" }, onReindex);
    fireEvent.click(reindexButton());
    await waitFor(() => expect(onReindex).toHaveBeenCalledTimes(1));
    await screen.findByText(/Rebuilding the code graph/i);
  });

  it("mashing the button does not fire a second request while one is in flight", async () => {
    let release: (r: GitNexusReindexResult) => void = () => undefined;
    const onReindex = vi.fn(
      () =>
        new Promise<GitNexusReindexResult>((resolve) => {
          release = resolve;
        })
    );
    showWith({ status: "error", note: "boom" }, onReindex);
    const button = reindexButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(onReindex).toHaveBeenCalledTimes(1);
    release({ accepted: true, targets: ["/ws"], forced: true, note: "ok" });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("a REFUSAL is shown to the operator, never swallowed into a spinner", async () => {
    const onReindex = vi.fn(
      async (): Promise<GitNexusReindexResult> => ({
        accepted: false,
        reason: "already-running",
        note: "An index run is already in progress — waiting for it to finish.",
      })
    );
    showWith({ status: "ready", symbolCount: 1 }, onReindex);
    fireEvent.click(reindexButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/already in progress/i);
    expect(note.className).toContain("gnx-refused");
  });

  it("a rejected bridge call surfaces as text, not an unhandled rejection", async () => {
    const onReindex = vi.fn(async (): Promise<GitNexusReindexResult> => {
      throw new Error("IPC channel closed");
    });
    showWith({ status: "error", note: "boom" }, onReindex);
    fireEvent.click(reindexButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/IPC channel closed/);
  });

  it("clears an ACCEPTED note once indexing really starts (the pill takes over)", async () => {
    const onReindex = vi.fn(
      async (): Promise<GitNexusReindexResult> => ({
        accepted: true,
        targets: ["/ws"],
        forced: true,
        note: "Rebuilding the code graph from scratch.",
      })
    );
    const view = showWith({ status: "ready", symbolCount: 1 }, onReindex);
    fireEvent.click(reindexButton());
    await screen.findByText(/Rebuilding the code graph/i);

    // main pushes the transition; the pill now carries the story.
    view.rerender(
      <GitNexusColumn
        status={{ status: "indexing", trigger: "manual" }}
        onOpenGraph={vi.fn()}
        onReindex={onReindex}
      />
    );
    await waitFor(() =>
      expect(view.queryByText(/Rebuilding the code graph/i)).toBeNull()
    );
  });
});

describe("reindexAffordance (pure)", () => {
  it("never offers an enabled button while an analyze is in flight", () => {
    for (const status of [
      { status: "indexing" },
      { status: "indexing", trigger: "manual" },
      { status: "indexing", note: "Indexing 1/3 repos" },
    ] as GitNexusIndexStatus[]) {
      expect(reindexAffordance(status).enabled).toBe(false);
    }
  });

  it("offers it for every state an operator could want to repair", () => {
    for (const status of [
      { status: "ready", symbolCount: 5 },
      { status: "ready", symbolCount: 5, stale: true },
      { status: "error", note: "boom" },
      { status: "idle", reason: "never-indexed" },
      { status: "idle", reason: "rate-limited" },
      { status: "idle", reason: "last-attempt-failed" },
    ] as GitNexusIndexStatus[]) {
      const a = reindexAffordance(status);
      expect(a.visible).toBe(true);
      expect(a.enabled).toBe(true);
      expect(a.title.length).toBeGreaterThan(0);
    }
  });
});
