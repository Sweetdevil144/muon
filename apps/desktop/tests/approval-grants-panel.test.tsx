// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ApprovalGrantsPanel,
  expiryLabel,
  grantIsLive,
  grantStatusLabel,
} from "../src/renderer/approval-grants-panel.js";
import type { ApprovalGrant } from "@muon/client";

afterEach(cleanup);

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function grant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    id: "grant-1",
    approvalId: "appr-1",
    taskId: "chat-9",
    workspacePath: "/Users/x/repo",
    actionClass: "edit",
    toolName: "Bash",
    payloadDigest: "abcdef0123456789abcdef",
    resolvedTarget: "npm test",
    policyFingerprint: "fp-1",
    originJobId: "job-1",
    expiresAt: new Date(NOW + 6 * 3600_000).toISOString(),
    revokedAt: null,
    useCount: 3,
    lastUsedAt: null,
    createdAt: new Date(NOW - 3600_000).toISOString(),
    ...overrides,
  };
}

/**
 * ADR-0056 D8: "a grant that resolves something invisibly is the failure mode."
 * The desktop mints `always`, so these are about the desktop being able to show
 * and take back what that click is still spending.
 */
describe("liveness matches what the server would actually redeem", () => {
  it("a revoked grant is never live, even before its expiry", () => {
    const g = grant({ revokedAt: new Date(NOW - 60_000).toISOString() });
    expect(grantIsLive(g, NOW)).toBe(false);
    expect(grantStatusLabel(g, NOW)).toBe("revoked");
  });

  it("an expired grant is never live, even though it was never revoked", () => {
    const g = grant({ expiresAt: new Date(NOW - 1000).toISOString() });
    expect(grantIsLive(g, NOW)).toBe(false);
    expect(grantStatusLabel(g, NOW)).toBe("expired");
  });

  it("only an unrevoked, unexpired grant reads as live", () => {
    expect(grantIsLive(grant(), NOW)).toBe(true);
    expect(grantStatusLabel(grant(), NOW)).toBe("live");
  });

  it("expiry reads as remaining time, never a bare timestamp", () => {
    expect(expiryLabel(grant(), NOW)).toBe("in 6h");
    expect(
      expiryLabel(grant({ expiresAt: new Date(NOW + 20 * 60_000).toISOString() }), NOW)
    ).toBe("in 20m");
    expect(
      expiryLabel(grant({ expiresAt: new Date(NOW + 7 * 86_400_000).toISOString() }), NOW)
    ).toBe("in 7d");
    expect(
      expiryLabel(grant({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)
    ).toBe("expired");
  });
});

describe("the panel", () => {
  it("names the exact action a grant binds to, never the agent", async () => {
    render(
      <ApprovalGrantsPanel
        listGrants={async () => [grant()]}
        revokeGrant={async () => grant()}
        now={() => NOW}
      />
    );
    expect(await screen.findByText("Bash")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText(/chat chat-9/)).toBeTruthy();
    expect(screen.getByText(/digest abcdef012345…/)).toBeTruthy();
    expect(screen.getByText(/used 3 times/)).toBeTruthy();
    // The sentence the whole grade depends on.
    expect(
      screen.getByText(/None of them approves an agent/i)
    ).toBeTruthy();
  });

  it("revokes through the callback and re-reads the list afterwards", async () => {
    const revokeGrant = vi.fn(async () => grant({ revokedAt: new Date().toISOString() }));
    let call = 0;
    const listGrants = vi.fn(async () => {
      call += 1;
      return call === 1
        ? [grant()]
        : [grant({ revokedAt: new Date(NOW).toISOString() })];
    });
    render(
      <ApprovalGrantsPanel
        listGrants={listGrants}
        revokeGrant={revokeGrant}
        now={() => NOW}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith("grant-1"));
    // Re-read, not a local mutation: the server is the authority on liveness.
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("revoked")).toBeTruthy());
  });

  it("offers no revoke button for a grant that is already inert", async () => {
    render(
      <ApprovalGrantsPanel
        listGrants={async () => [grant({ revokedAt: new Date(NOW).toISOString() })]}
        revokeGrant={async () => grant()}
        now={() => NOW}
      />
    );
    await screen.findByText("revoked");
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("surfaces a listing failure instead of showing an empty list", async () => {
    render(
      <ApprovalGrantsPanel
        listGrants={async () => {
          throw new Error("brain unreachable");
        }}
        revokeGrant={async () => grant()}
        now={() => NOW}
      />
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("brain unreachable");
  });

  it("surfaces a revoke failure and leaves the grant listed", async () => {
    render(
      <ApprovalGrantsPanel
        listGrants={async () => [grant()]}
        revokeGrant={async () => {
          throw new Error("revoke refused");
        }}
        now={() => NOW}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("revoke refused");
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("defaults to live grants only, and can widen to the whole history", async () => {
    const listGrants = vi.fn(async () => [grant()]);
    render(
      <ApprovalGrantsPanel
        listGrants={listGrants}
        revokeGrant={async () => grant()}
        now={() => NOW}
      />
    );
    await waitFor(() =>
      expect(listGrants).toHaveBeenCalledWith({ activeOnly: true })
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() =>
      expect(listGrants).toHaveBeenCalledWith({ activeOnly: false })
    );
  });

  it("says why the list is empty rather than showing nothing", async () => {
    render(
      <ApprovalGrantsPanel
        listGrants={async () => []}
        revokeGrant={async () => grant()}
        now={() => NOW}
      />
    );
    expect(
      await screen.findByText(/No live grants\./)
    ).toBeTruthy();
  });
});
