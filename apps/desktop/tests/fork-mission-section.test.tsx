// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionSlug } from "@muon/client/session-slug";
import { vendorLabel } from "@muon/client/vendors";
import {
  ForkMissionSection,
  type ForkMissionProps,
} from "../src/renderer/fork-mission-section.js";
import { RightPanel } from "../src/renderer/right-panel.js";

/**
 * ADR-0044/0071 — the fork gesture on screen (the third surface of one verb).
 *
 * The desk names the step, the brief and the lane, NOTHING more; the
 * latest-settled-step guard and every other rule are the fork route's, so a
 * refusal must reach the operator VERBATIM, and a success must name the NEW
 * mission and its root job — "forked" without those names is exactly the
 * unverifiable claim this section exists to end.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function panel(overrides: Partial<ForkMissionProps> = {}) {
  const onFork = vi.fn(
    async () =>
      ({
        ok: true,
        chatId: "chat-fork",
        chatTitle: "Fork: probe the flake",
        jobId: "job-fork-root",
        vendor: "codex",
      }) as const
  );
  const props: ForkMissionProps = {
    sourceJobId: "job-settled-1",
    sourceVendor: "codex",
    vendors: ["claude-code", "codex"],
    laneLabel: (vendor) => vendorLabel(vendor as never),
    slugOf: sessionSlug,
    onFork,
    ...overrides,
  };
  const view = render(
    React.createElement(ForkMissionSection, { forkMission: props })
  );
  return { onFork: props.onFork, view, props };
}

function briefBox(): HTMLTextAreaElement {
  return document.querySelector(
    "[data-fork-mission-brief]"
  ) as HTMLTextAreaElement;
}

function laneSelect(): HTMLSelectElement {
  return document.querySelector(
    "[data-fork-mission-lane]"
  ) as HTMLSelectElement;
}

function submitButton(): HTMLButtonElement {
  return document.querySelector(
    "[data-fork-mission-submit]"
  ) as HTMLButtonElement;
}

describe("ADR-0044/0071 — Fork a new mission, in the review dock", () => {
  it("names the source step and defaults the lane to the one that produced it", () => {
    panel();
    expect(
      screen.getByText(`${sessionSlug("job-settled-1")}'s recorded state`)
    ).toBeTruthy();
    expect(laneSelect().value).toBe("codex");
    // The submit button says which lane it will queue the root on.
    expect(submitButton().textContent).toContain(vendorLabel("codex" as never));
  });

  it("an empty brief is refused CLIENT-SIDE without calling the bridge", async () => {
    const { onFork } = panel();
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "A fork carries a brief"
      );
    });
    expect(onFork).not.toHaveBeenCalled();
  });

  it("submits the trimmed brief + chosen lane, omitting an empty title, and names the new mission and root", async () => {
    const { onFork } = panel();
    fireEvent.change(briefBox(), {
      target: { value: "  probe the flake in isolation  " },
    });
    fireEvent.change(laneSelect(), { target: { value: "claude-code" } });
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(
        document.querySelector("[data-fork-mission-outcome='forked']")
      ).toBeTruthy();
    });
    expect(onFork).toHaveBeenCalledWith({
      vendor: "claude-code",
      brief: "probe the flake in isolation",
    });
    const outcome = document.querySelector(
      "[data-fork-mission-outcome='forked']"
    ) as HTMLElement;
    // The claim is verifiable: mission title, root slug, root id, lane.
    expect(outcome.textContent).toContain("Fork: probe the flake");
    expect(outcome.textContent).toContain(sessionSlug("job-fork-root"));
    expect(outcome.textContent).toContain("job-fork-root");
    expect(outcome.textContent).toContain(vendorLabel("codex" as never));
    // The form is gone: a landed fork cannot be double-pressed.
    expect(submitButton()).toBeNull();
  });

  it("a route refusal renders VERBATIM, and Try again restores the form", async () => {
    const reason =
      "sourceJobId 'job-settled-1' is not the task's latest settled step — later or live work has since reshaped its worktree, and the ledger holds only the latest recorded state. Fork the task's most recent settled job instead.";
    const { onFork } = panel({
      onFork: vi.fn(async () => ({ ok: false as const, reason })),
    });
    fireEvent.change(briefBox(), { target: { value: "branch it" } });
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(reason);
    });
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(
      document.querySelector("[data-fork-mission-retry]") as HTMLButtonElement
    );
    expect(document.querySelector("[role='alert']")).toBeNull();
    expect(submitButton()).toBeTruthy();
  });

  it("a chosen lane that leaves the readiness set can never be submitted — the lane re-derives", async () => {
    // The readiness snapshot changes while the section stays mounted (the
    // source-job key does not change with it). An explicit choice must hold
    // only while its lane is still offered; afterwards the submit must carry
    // a CURRENT lane, never the stale one and never "".
    const { onFork, view, props } = panel();
    fireEvent.change(laneSelect(), { target: { value: "claude-code" } });
    view.rerender(
      React.createElement(ForkMissionSection, {
        forkMission: { ...props, vendors: ["codex"] },
      })
    );
    expect(laneSelect().value).toBe("codex");
    fireEvent.change(briefBox(), { target: { value: "branch it" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onFork).toHaveBeenCalledTimes(1));
    expect(onFork).toHaveBeenCalledWith({ vendor: "codex", brief: "branch it" });
  });

  it("no dispatch-ready lane renders NOTHING — never a dead button", () => {
    panel({ vendors: [] });
    expect(document.querySelector(".fork-mission-section")).toBeNull();
  });

  it("readiness-unknown is stated, not implied green", () => {
    panel({ readinessUnknown: true });
    expect(screen.getByText(/readiness could not be checked/i)).toBeTruthy();
  });

  it("RightPanel places it on the Review tab, keyed by source step; omitted renders nothing", () => {
    const { rerender } = render(
      React.createElement(RightPanel, {
        activeTab: "review",
        onTabChange: () => undefined,
        workspacePath: "/work/MUON-LABS",
        workspaceReview: null,
        forkMission: {
          sourceJobId: "job-settled-1",
          sourceVendor: "codex",
          vendors: ["codex"],
          laneLabel: (vendor: string) => vendor,
          slugOf: sessionSlug,
          onFork: vi.fn(async () => ({
            ok: false as const,
            reason: "unused",
          })),
        },
        reviewContent: null,
      })
    );
    expect(document.querySelector(".fork-mission-section")).toBeTruthy();
    rerender(
      React.createElement(RightPanel, {
        activeTab: "review",
        onTabChange: () => undefined,
        workspacePath: "/work/MUON-LABS",
        workspaceReview: null,
        reviewContent: null,
      })
    );
    expect(document.querySelector(".fork-mission-section")).toBeNull();
  });
});
