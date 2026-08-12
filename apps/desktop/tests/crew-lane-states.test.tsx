// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrewPanel } from "../src/renderer/sidebar.js";
import { DiagnosticsStrip, SystemsStatusButton } from "../src/renderer/cockpit.js";
import { Onboarding } from "../src/renderer/onboarding.js";
import type { CapabilityPreflight } from "@muon/client/capability-preflight";
import type { DesktopState, ReadinessSnapshotMeta } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * What the human actually SEES for each lane situation, on the surfaces the
 * founder called out (Crew, doctor, status).
 *
 * The load-bearing case: `cursor-agent status` EXITS 0 WHEN LOGGED OUT, so no
 * surface may render "ready" for a lane whose verdict is signed-out — and a
 * probe that could not RUN must not be dressed up as a login problem, because
 * those two need different things from the user.
 */

const meta = (
  state: ReadinessSnapshotMeta["state"],
  ageMs: number | null = null
): ReadinessSnapshotMeta => ({ state, checkedAt: null, ageMs, error: null });

function crewState(over: Partial<DesktopState> = {}): DesktopState {
  return {
    chats: [],
    fleet: { counts: {}, agents: [] },
    ...over,
  } as unknown as DesktopState;
}

function renderCrew(state: DesktopState, props: Record<string, unknown> = {}) {
  return render(
    React.createElement(CrewPanel, {
      state,
      taskTitles: new Map(),
      onStepFleet: vi.fn(),
      onOpenAgent: vi.fn(),
      ...props,
    } as never)
  );
}

describe("Crew — the three lane situations read differently", () => {
  it("shows a logged-out Cursor as SIGNED OUT with its real login command", () => {
    renderCrew(
      crewState({
        readiness: [
          {
            vendor: "cursor",
            installed: true,
            authenticated: false,
            authState: "negative",
            detail: "not logged in",
            fixHint: "log into Cursor first: `cursor-agent login`",
          },
        ],
        readinessMeta: meta("fresh", 3_000),
      } as Partial<DesktopState>)
    );

    expect(screen.getByText("signed out")).toBeTruthy();
    expect(
      screen.getByText("log into Cursor first: `cursor-agent login`")
    ).toBeTruthy();
    // The whole point: rc=0 from `cursor-agent status` must never become "ready".
    expect(screen.queryByText("ready")).toBeNull();
    expect(screen.queryByText("ready · role-scoped")).toBeNull();
  });

  it("shows a missing CLI as NOT INSTALLED with the install command", () => {
    renderCrew(
      crewState({
        readiness: [
          {
            vendor: "opencode",
            installed: false,
            authenticated: false,
            detail: "OpenCode CLI not found (expected one of: opencode)",
            fixHint: "install OpenCode (`curl -fsSL https://opencode.ai/install | bash`)",
          },
        ],
        readinessMeta: meta("fresh", 3_000),
      } as Partial<DesktopState>)
    );

    expect(screen.getByText("not installed")).toBeTruthy();
    expect(
      screen.getByText(
        "install OpenCode (`curl -fsSL https://opencode.ai/install | bash`)"
      )
    ).toBeTruthy();
    expect(screen.queryByText("signed out")).toBeNull();
  });

  it("shows a READY lane with the probe's own confirmation line", () => {
    renderCrew(
      crewState({
        readiness: [
          {
            vendor: "claude-code",
            installed: true,
            authenticated: true,
            authState: "confirmed",
            credentialMethod: "vendor-login",
            detail: "logged in as dev@example.com via claude.ai",
          },
        ],
        readinessMeta: meta("fresh", 3_000),
      } as Partial<DesktopState>)
    );

    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("logged in as dev@example.com via claude.ai")).toBeTruthy();
  });

  it("keeps an UNRUNNABLE probe apart from a signed-out one", () => {
    renderCrew(
      crewState({
        readiness: [
          {
            vendor: "codex",
            installed: true,
            authenticated: false,
            authState: "unknown",
            detail: "auth probe could not run (spawn timeout)",
          },
        ],
        readinessMeta: meta("fresh", 3_000),
      } as Partial<DesktopState>)
    );

    expect(screen.getByText("check failed")).toBeTruthy();
    expect(screen.getByText("auth probe could not run (spawn timeout)")).toBeTruthy();
    // Telling this user to "log in" would be a guess dressed as instruction.
    expect(screen.queryByText("signed out")).toBeNull();
  });
});

describe("Crew — freshness is stated, never implied", () => {
  it("labels the age of the readiness evidence", () => {
    renderCrew(
      crewState({
        readiness: [],
        readinessMeta: meta("fresh", 12_000),
      } as Partial<DesktopState>)
    );
    expect(screen.getByRole("status").textContent).toContain("Checked 12s ago");
  });

  it("says a refresh has stalled rather than showing the old value as live", () => {
    renderCrew(
      crewState({
        readiness: [],
        readinessMeta: {
          state: "stale",
          checkedAt: null,
          ageMs: 300_000,
          error: "brain unreachable",
        },
      } as Partial<DesktopState>)
    );
    expect(screen.getByRole("status").textContent).toContain("refresh stalled");
  });

  it("says CHECKING — not 'needs setup' — while the first probe runs", () => {
    renderCrew(
      crewState({ readiness: null, readinessMeta: meta("probing") } as Partial<DesktopState>)
    );
    expect(screen.getByRole("status").textContent).toContain("Checking providers");
    // Every lane is unverdicted, so none may be accused of needing setup.
    expect(screen.queryByText("signed out")).toBeNull();
    expect(screen.queryByText("not installed")).toBeNull();
    expect(screen.getAllByText("checking").length).toBeGreaterThan(0);
  });

  it("offers an explicit re-check the human controls", () => {
    const onRecheckReadiness = vi.fn();
    renderCrew(
      crewState({ readiness: [], readinessMeta: meta("fresh", 1_000) } as Partial<DesktopState>),
      { onRecheckReadiness }
    );
    screen.getByRole("button", { name: "Re-check" }).click();
    expect(onRecheckReadiness).toHaveBeenCalled();
  });
});

describe("Crew — the roster is the registry's, and Ollama is gone", () => {
  it("renders the four current lanes and never a retired one", () => {
    renderCrew(crewState({ readiness: [] } as Partial<DesktopState>));
    for (const label of ["Claude Code", "Codex", "Cursor", "OpenCode"]) {
      expect(screen.getByLabelText(`Add a ${label} instance`)).toBeTruthy();
    }
    expect(screen.queryByText(/ollama/i)).toBeNull();
  });

  it("says on the lane which vendors cannot hold the coordinator seat", () => {
    renderCrew(
      crewState({
        readiness: [
          {
            vendor: "cursor",
            installed: true,
            authenticated: true,
            detail: "logged in",
          },
        ],
        readinessMeta: meta("fresh", 1_000),
      } as Partial<DesktopState>)
    );
    expect(
      screen.getByText("Cannot hold the coordinator seat — it runs as crew only.")
    ).toBeTruthy();
  });
});

describe("Doctor / Status — a cold start is not a failure", () => {
  const preflight = (source: "probe" | "unavailable"): CapabilityPreflight =>
    ({
      vendors: [],
      degradations:
        source === "unavailable"
          ? [
              {
                surface: "vendor",
                severity: "warning",
                code: "READINESS_UNAVAILABLE",
                reason: "no readiness",
                nextAction: "re-check",
              },
            ]
          : [],
      readiness: { source },
      brainHealth: { state: "ok" },
      runnerHealth: { state: "live", detail: "live" },
    }) as unknown as CapabilityPreflight;

  it("the doctor says 'checking' while the probe runs, not 'unavailable'", () => {
    render(
      React.createElement(DiagnosticsStrip, {
        preflight: preflight("unavailable"),
        readinessMeta: meta("probing"),
      })
    );
    expect(screen.getByText("Checking your agents")).toBeTruthy();
    expect(screen.queryByText("Crew check unavailable")).toBeNull();
  });

  it("the doctor still says 'unavailable' when nothing is running", () => {
    render(
      React.createElement(DiagnosticsStrip, {
        preflight: preflight("unavailable"),
        readinessMeta: meta("unknown"),
      })
    );
    expect(screen.getByText("Crew check unavailable")).toBeTruthy();
  });

  it("the titlebar status pill reads 'Checking', never a bogus setup count", () => {
    render(
      React.createElement(SystemsStatusButton, {
        preflight: preflight("unavailable"),
        readinessMeta: meta("probing"),
        onOpenSettings: vi.fn(),
      })
    );
    expect(screen.getByRole("button").textContent).toContain("Checking");
    expect(screen.getByRole("button").textContent).not.toContain("setup");
  });

  it("the doctor prints how old the lane evidence is", () => {
    render(
      React.createElement(DiagnosticsStrip, {
        preflight: preflight("probe"),
        readinessMeta: meta("fresh", 20_000),
        onRefresh: vi.fn(),
      })
    );
    expect(document.body.textContent).toContain("Checked 20s ago");
  });
});

describe("Onboarding — the first run never flashes a false failure", () => {
  it("shows 'Checking your agents' instead of the manual fallback", () => {
    render(
      React.createElement(Onboarding, {
        readiness: null,
        readinessMeta: meta("probing"),
        onRunFirstTask: vi.fn(),
        onRecheck: vi.fn(),
      })
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Checking your agents"
    );
    // "Connect an agent to start" asserts a verdict the probe has not produced.
    expect(screen.queryByText("Connect an agent to start")).toBeNull();
    // Nor may the subhead tell them to use the manual fallback yet.
    expect(document.body.textContent).not.toContain("manual steps below");
  });

  it("still falls back to manual steps when the check is genuinely unavailable", () => {
    render(
      React.createElement(Onboarding, {
        readiness: null,
        readinessMeta: meta("unknown"),
        onRunFirstTask: vi.fn(),
        onRecheck: vi.fn(),
      })
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Connect an agent to start")).toBeTruthy();
  });
});
