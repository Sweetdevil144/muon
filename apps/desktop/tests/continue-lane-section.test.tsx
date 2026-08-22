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
import { RightPanel, type ContinueOnLaneProps } from "../src/renderer/right-panel.js";

/**
 * H12 — the gesture on screen.
 *
 * One button per OTHER dispatch-ready execution lane; the composer's refusal
 * shown VERBATIM where the press happened; and a success that names the
 * successor by its slug AND the packet it cites — because "continued" without a
 * packet id is exactly the unverifiable claim this feature exists to end.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel(props: ContinueOnLaneProps) {
  return React.createElement(RightPanel, {
    activeTab: "review",
    onTabChange: () => undefined,
    workspacePath: "/work/MUON-LABS",
    workspaceReview: null,
    continueOnLane: props,
    reviewContent: null,
  });
}

function panel(overrides: Partial<ContinueOnLaneProps> = {}) {
  const onContinue = vi.fn(
    async () =>
      ({ ok: true, jobId: "job-successor", packetId: "handoff-typed", vendor: "codex" }) as const
  );
  const props: ContinueOnLaneProps = {
    taskId: "task-1",
    currentVendor: "claude-code",
    vendors: ["claude-code", "codex"],
    laneLabel: (vendor) => vendorLabel(vendor as never),
    slugOf: sessionSlug,
    onContinue,
    ...overrides,
  };
  const view = render(renderPanel(props));
  return { onContinue: props.onContinue, view, props };
}

describe("H12 — Continue on <lane>, in the review dock", () => {
  it("offers one button per OTHER dispatch-ready lane", () => {
    panel();
    expect(
      document.querySelector('[data-continue-lane="codex"]')
    ).toBeTruthy();
    // The lane that ran the work is not offered: continuing on itself is a
    // re-run, not a hand-off.
    expect(
      document.querySelector('[data-continue-lane="claude-code"]')
    ).toBeNull();
  });

  it("names the lane it will continue on, from the registry label", () => {
    panel();
    expect(screen.getByRole("button", { name: /Continue on Codex/ })).toBeTruthy();
  });

  it("frames the act honestly — including the authority it DOES carry", () => {
    // Adversarial review, 2026-08-17: this copy used to claim "an ordinary
    // dispatch … no wider budget", which was false. Naming the chat (which the
    // packet-citation guard requires) files the successor as this mission's
    // chat root, with the standard root turn budget and delegation allowance.
    // Not a new tier, not a raised ceiling — but not a plain worker either, and
    // the surface has to say which.
    panel();
    const section = document.querySelector(".continue-lane-section");
    // What it does.
    expect(section?.textContent).toMatch(/cite that packet/i);
    // What it costs — stated, not hidden.
    expect(section?.textContent).toMatch(/coordinator turn/i);
    expect(section?.textContent).toMatch(/same standard turn budget/i);
    expect(section?.textContent).toMatch(/one turn at a time/i);
    // What it still does NOT do.
    expect(section?.textContent).toMatch(/no approval is filed/i);
    expect(section?.textContent).toMatch(/no ceiling is raised/i);
    // And the discarded lie must not creep back.
    expect(section?.textContent).not.toMatch(/grants nothing/i);
  });

  it("shows the composer's refusal VERBATIM and files nothing", async () => {
    const refusal =
      "'codex' did not report dispatch-ready in this machine's latest readiness check — it may be missing a seat or its login may simply be unverified right now. Re-check with muon doctor (it names exactly what is missing), or continue on a lane that reports ready.";
    panel({
      onContinue: vi.fn(async () => ({ ok: false as const, reason: refusal })),
    });

    fireEvent.click(screen.getByRole("button", { name: /Continue on Codex/ }));
    expect(await screen.findByText(refusal)).toBeTruthy();
    // The control stays on screen, disabled, attached to its own reason.
    await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-continue-lane="codex"]'
      );
      expect(button?.hasAttribute("disabled")).toBe(true);
      expect(button?.getAttribute("title")).toBe(refusal);
    });
    // …and never a dead end: the operator can fix the machine and retry.
    expect(
      document.querySelector('[data-continue-lane-retry="codex"]')
    ).toBeTruthy();
  });

  it("a refusal is recoverable — Try again restores the control", async () => {
    panel({
      onContinue: vi.fn(async () => ({ ok: false as const, reason: "no typed wrap packet exists" })),
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue on Codex/ }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-continue-lane="codex"]'
      );
      expect(button?.hasAttribute("disabled")).toBe(false);
    });
  });

  it("a thrown refusal (brain rejected the dispatch) is shown, not swallowed", async () => {
    panel({
      onContinue: vi.fn(async () => {
        throw new Error("Dispatch refused: the mission cost cap is reached.");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue on Codex/ }));
    expect(
      await screen.findByText(/the mission cost cap is reached/i)
    ).toBeTruthy();
  });

  it("success names the successor's slug AND the packet it cites", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: /Continue on Codex/ }));

    const outcome = await waitFor(() => {
      const found = document.querySelector(".continue-lane-outcome");
      if (!found?.textContent?.includes("continued")) {
        throw new Error("no outcome yet");
      }
      return found;
    });
    expect(outcome.textContent).toContain(sessionSlug("job-successor"));
    expect(outcome.textContent).toContain("job-successor");
    expect(outcome.textContent).toContain("handoff-typed");
    // A second press cannot fire the same continuation twice.
    expect(document.querySelector('[data-continue-lane="codex"]')).toBeNull();
  });

  it("no other ready lane: says why, and offers no dead button", () => {
    panel({ vendors: ["claude-code"] });
    expect(document.querySelector('[data-continue-lane="codex"]')).toBeNull();
    const section = document.querySelector(".continue-lane-section");
    // "REPORTED as dispatch-ready", not "is": a lane MUON could not probe is
    // dropped from the ready set by the same rule as one that is missing, so
    // this must not assert a fact about the machine that MUON never observed.
    expect(section?.textContent).toMatch(/reported as dispatch-ready/i);
    expect(section?.textContent).toMatch(/could not probe reads the same/i);
    expect(section?.textContent).toMatch(/Claude Code/);
  });

  it("unreadable readiness says so instead of implying a green check", () => {
    panel({ readinessUnknown: true });
    expect(
      document.querySelector(".continue-lane-section")?.textContent
    ).toMatch(/readiness could not be checked/i);
    // The lanes are still offered — MUON re-checks on the press.
    expect(document.querySelector('[data-continue-lane="codex"]')).toBeTruthy();
  });

  it("renders nothing at all when the dock has no mission task", () => {
    panel({ taskId: null });
    expect(document.querySelector(".continue-lane-section")).toBeNull();
  });

  it("a continuation never carries over to the NEXT mission", async () => {
    // One mission's "continued as …, citing packet h-1" describing a different
    // mission is the same class of lie as a stale cap under a new name.
    const { view, props } = panel();
    fireEvent.click(screen.getByRole("button", { name: /Continue on Codex/ }));
    await waitFor(() =>
      expect(
        document.querySelector(".continue-lane-outcome")?.textContent
      ).toContain("handoff-typed")
    );

    view.rerender(renderPanel({ ...props, taskId: "task-2" }));
    expect(
      document.querySelector(".continue-lane-outcome")?.textContent ?? ""
    ).not.toContain("handoff-typed");
    // …and the lane is offerable again for the new mission.
    expect(document.querySelector('[data-continue-lane="codex"]')).toBeTruthy();
  });
});
