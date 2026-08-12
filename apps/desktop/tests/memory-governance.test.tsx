// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryGovernancePanel } from "../src/renderer/memory-governance.js";
import type { MemoryGovernanceState } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * Parity item 6. The properties that matter are all about a bulk action never
 * running against numbers nobody saw, and about the two bulk actions being
 * DIFFERENT: a sweep hides and reverts, a compaction does not come back.
 */
function governance(
  overrides: Partial<MemoryGovernanceState> = {}
): MemoryGovernanceState {
  return {
    ttl: { days: 30, trustCeiling: "low" },
    lifecycleSource: "legacy_global",
    daysByKind: null,
    compactionRetentionDays: 90,
    memoryMining: true,
    ...overrides,
  };
}

function sweepResult(overrides: Record<string, unknown> = {}) {
  return {
    ttlDays: 30,
    policySource: "legacy_global" as const,
    daysByKind: null,
    scanned: 340,
    expired: 12,
    noteIds: [],
    skipped: false,
    dryRun: true,
    batchId: null,
    reason: null,
    previewDigest: "a".repeat(64),
    ...overrides,
  } as never;
}

function compactResult(overrides: Record<string, unknown> = {}) {
  return {
    retentionDays: 90,
    cutoff: "2026-05-13T00:00:00.000Z",
    scanned: 200,
    tombstoned: 8,
    noteIds: [],
    dryRun: true,
    batchId: null,
    reason: null,
    previewDigest: "b".repeat(64),
    ...overrides,
  } as never;
}

function panel(props: Record<string, unknown> = {}) {
  return (
    <MemoryGovernancePanel
      load={vi.fn(async () => governance())}
      saveTtl={vi.fn(async (policy) => policy)}
      saveMining={vi.fn(async (enabled) => enabled)}
      saveRetention={vi.fn(async (days) => days)}
      sweep={vi.fn(async () => sweepResult())}
      compact={vi.fn(async () => compactResult())}
      revert={vi.fn(async (batchId) => ({
        batchId,
        reverted: 12,
        noteIds: [],
      }))}
      {...props}
    />
  );
}

describe("MemoryGovernancePanel", () => {
  it("states the retention posture in words, including OFF", async () => {
    render(panel({ load: vi.fn(async () => governance()) }));
    expect(await screen.findByText(/hides after 30 day/)).toBeTruthy();
    cleanup();
    render(
      panel({
        load: vi.fn(async () =>
          governance({ ttl: { days: 0, trustCeiling: "low" } })
        ),
      })
    );
    // Zero is MEANINGFUL here (unlike a cost cap): it disables expiry, and
    // saying "hides after 0 days" would read as the opposite.
    expect(await screen.findByText(/Expiry is OFF/)).toBeTruthy();
  });

  it("an unreadable policy is reported, never rendered as 'nothing expires'", async () => {
    render(
      panel({
        load: vi.fn(async () => {
          throw new Error("brain unreachable");
        }),
      })
    );
    expect(await screen.findByText(/brain unreachable/)).toBeTruthy();
    expect(screen.queryByText(/Expiry is OFF/)).toBeNull();
  });

  it("refuses a TTL outside the policy range, before any write", async () => {
    const saveTtl = vi.fn();
    render(panel({ saveTtl }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.change(screen.getByLabelText("Retention days"), {
      target: { value: "9999" },
    });
    fireEvent.click(screen.getAllByText("Save")[0]!);
    expect(await screen.findByText(/whole number from 0 to 3650/)).toBeTruthy();
    expect(saveTtl).not.toHaveBeenCalled();
  });

  it("will NOT sweep until a dry run has been seen", async () => {
    const sweep = vi.fn(async () => sweepResult());
    render(panel({ sweep }));
    await screen.findByText(/hides after 30 day/);
    const apply = screen.getByText("Expire (preview first)");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(apply);
    expect(sweep, "a disabled apply must not reach the brain").not.toHaveBeenCalled();
  });

  it("previews first, then applies with dryRun false", async () => {
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(sweepResult())
      .mockResolvedValueOnce(
        sweepResult({ dryRun: false, batchId: "batch-7" })
      );
    render(panel({ sweep }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    expect(await screen.findByText(/Would hide 12 of 340/)).toBeTruthy();
    fireEvent.click(await screen.findByText("Expire 12 notes"));
    expect(await screen.findByText(/Hid 12 of 340/)).toBeTruthy();
    expect(sweep).toHaveBeenNthCalledWith(1, { dryRun: true, maxForget: 50 });
    // The apply carries the digest of the preview it followed (see the
    // binding tests below).
    expect(sweep).toHaveBeenNthCalledWith(2, {
      dryRun: false,
      maxForget: 50,
      previewDigest: "a".repeat(64),
    });
  });

  it("a changed bound INVALIDATES the preview — it measured a different run", async () => {
    render(panel());
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    await screen.findByText(/Would hide 12 of 340/);
    fireEvent.change(screen.getByLabelText("Maximum notes per run"), {
      target: { value: "10" },
    });
    const apply = screen.getByText("Expire (preview first)");
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a one-click revert for the batch it just swept", async () => {
    const revert = vi.fn(async () => ({
      batchId: "batch-7",
      reverted: 12,
      noteIds: [],
    }));
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(sweepResult())
      .mockResolvedValueOnce(
        sweepResult({ dryRun: false, batchId: "batch-7" })
      );
    render(panel({ sweep, revert }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    fireEvent.click(await screen.findByText("Expire 12 notes"));
    fireEvent.click(await screen.findByText("Revert this batch"));
    expect(await screen.findByText(/Restored 12 note/)).toBeTruthy();
    expect(revert).toHaveBeenCalledWith("batch-7");
  });

  it("says a sweep with no batch id cannot be reverted, instead of a dead button", async () => {
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(sweepResult())
      .mockResolvedValueOnce(sweepResult({ dryRun: false, batchId: null }));
    render(panel({ sweep }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    fireEvent.click(await screen.findByText("Expire 12 notes"));
    expect(await screen.findByText(/cannot be reverted here/)).toBeTruthy();
    expect(screen.queryByText("Revert this batch")).toBeNull();
  });

  it("warns on the COMPACT button itself that it does not come back", async () => {
    render(panel());
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[1]!);
    expect(
      await screen.findByText(/Compact 8 versions — not reversible/)
    ).toBeTruthy();
  });

  it("does not offer a lifecycle migration it cannot preview", async () => {
    render(panel());
    // Activating the kind table needs the exact digest of a dry run; a
    // half-control here could apply a table nobody previewed.
    expect(
      await screen.findByText(/muon memory lifecycle-policy/)
    ).toBeTruthy();
  });

  it("renders nothing on a preload without the governance bridge", () => {
    const prior = (window as unknown as { muon?: unknown }).muon;
    (window as unknown as { muon: Record<string, unknown> }).muon = {};
    try {
      const { container } = render(<MemoryGovernancePanel />);
      expect(container.innerHTML).toBe("");
    } finally {
      (window as unknown as { muon?: unknown }).muon = prior;
    }
  });

  it("says what mining IS, including that it proposes rather than vouches", async () => {
    render(panel());
    expect(await screen.findByText(/UNCONFIRMED until a human vouches/)).toBeTruthy();
  });

  it("adopts the STORED mining value, not the click", async () => {
    // A rejected write must not leave a toggle claiming a posture the brain
    // does not hold. §C: this setter had a route and a reader and no surface
    // at all — it could only be flipped by hand against the HTTP API.
    const saveMining = vi.fn(async () => true);
    render(panel({ saveMining }));
    await screen.findByText(/UNCONFIRMED until a human vouches/);
    const toggle = screen.getByLabelText(
      "Mine memory from finished runs"
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(saveMining).toHaveBeenCalledWith(false);
    // The brain kept it ON; the UI must follow the brain.
    expect(await screen.findByText("Mining setting saved.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Mine memory from finished runs") as HTMLInputElement)
        .checked
    ).toBe(true);
  });

  it("states plainly when mining is OFF", async () => {
    render(panel({ load: vi.fn(async () => governance({ memoryMining: false })) }));
    expect(await screen.findByText(/Mining is OFF/)).toBeTruthy();
  });
});

describe("an older preload", () => {
  it("REFUSES in words rather than making a button do nothing", async () => {
    // The panel mounted (governance reads fine) but the bridge has no sweep.
    // Silently returning made "Expire 12 notes" a no-op the operator would
    // read as success.
    const prior = (window as unknown as { muon?: unknown }).muon;
    (window as unknown as { muon: Record<string, unknown> }).muon = {
      memoryGovernance: async () => ({
        ttl: { days: 30, trustCeiling: "low" as const },
        lifecycleSource: "legacy_global" as const,
        compactionRetentionDays: 90,
        memoryMining: true,
      }),
    };
    try {
      render(<MemoryGovernancePanel />);
      await screen.findByText(/hides after 30 day/);
      fireEvent.click(screen.getAllByText("Preview")[0]!);
      expect(
        await screen.findByText(/bridge is older than this panel/)
      ).toBeTruthy();
    } finally {
      (window as unknown as { muon?: unknown }).muon = prior;
    }
  });
});

describe("the policy that is actually in force", () => {
  it("does not die when lifetimes are set PER KIND", async () => {
    // The flat-TTL endpoints 409 by design under a kind table ("use
    // /settings/memory-lifecycle"). Reading it unconditionally rejected the
    // whole governance read, so the panel reported the policy as unreadable on
    // exactly the machines running the newer posture (cubic P1).
    render(
      panel({
        load: vi.fn(async () =>
          governance({
            ttl: null,
            lifecycleSource: "kind_table",
            daysByKind: { decision: 0, constraint: 180, question: 30 },
          })
        ),
      })
    );
    expect(await screen.findByText(/no single TTL in force/)).toBeTruthy();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    // And it shows the lifetimes that ARE in force.
    expect(screen.getByText("constraint")).toBeTruthy();
    expect(screen.getByText("180 day(s)")).toBeTruthy();
    expect(screen.getByText("never expires")).toBeTruthy();
  });

  it("offers no flat-TTL control it could not save", async () => {
    render(
      panel({
        load: vi.fn(async () =>
          governance({
            ttl: null,
            lifecycleSource: "kind_table",
            daysByKind: { decision: 0 },
          })
        ),
      })
    );
    await screen.findByText(/no single TTL in force/);
    // Hidden, not greyed: a disabled field invites "why can't I edit this",
    // and the sentence above already answers it.
    const days = screen.getByLabelText("Retention days");
    expect(days.closest("[hidden]")).toBeTruthy();
  });
});

describe("an apply is bound to the preview on screen", () => {
  it("sends the previewed digest, so the brain can refuse a moved policy", async () => {
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(sweepResult({ previewDigest: "c".repeat(64) }))
      .mockResolvedValueOnce(
        sweepResult({ dryRun: false, batchId: "batch-9" })
      );
    render(panel({ sweep }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    fireEvent.click(await screen.findByText("Expire 12 notes"));
    await screen.findByText(/Hid 12 of 340/);
    expect(sweep).toHaveBeenNthCalledWith(2, {
      dryRun: false,
      maxForget: 50,
      previewDigest: "c".repeat(64),
    });
  });

  it("binds a compaction too — the one that cannot be undone", async () => {
    const compact = vi
      .fn()
      .mockResolvedValueOnce(compactResult({ previewDigest: "d".repeat(64) }))
      .mockResolvedValueOnce(compactResult({ dryRun: false }));
    render(panel({ compact }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[1]!);
    fireEvent.click(await screen.findByText(/Compact 8 versions/));
    expect(compact).toHaveBeenNthCalledWith(2, {
      dryRun: false,
      maxForget: 50,
      previewDigest: "d".repeat(64),
    });
  });

  it("surfaces the brain's refusal instead of pretending it ran", async () => {
    const sweep = vi
      .fn()
      .mockResolvedValueOnce(sweepResult())
      .mockRejectedValueOnce(
        new Error("The policy changed since that preview. Preview again.")
      );
    render(panel({ sweep }));
    await screen.findByText(/hides after 30 day/);
    fireEvent.click(screen.getAllByText("Preview")[0]!);
    fireEvent.click(await screen.findByText("Expire 12 notes"));
    expect(await screen.findByText(/Preview again/)).toBeTruthy();
  });
});
