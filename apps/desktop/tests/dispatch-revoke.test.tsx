// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DispatchTreeItem } from "../src/renderer/cockpit.js";
import type { DispatchTreeNode } from "@muon/client";

afterEach(cleanup);

/**
 * Revoking a lane's credential is NOT interrupting it, and the desk had
 * neither — the parity audit claimed it did. The properties here are about
 * that distinction surviving contact with a hurried operator.
 */
function node(overrides: Partial<DispatchTreeNode> = {}): DispatchTreeNode {
  return {
    id: "job-77",
    vendor: "codex",
    authority: "worker",
    brief: "cap the retries",
    status: "running",
    depth: 0,
    createdAt: "2026-08-11T00:00:00.000Z",
    children: [],
    ...overrides,
  } as unknown as DispatchTreeNode;
}

describe("revoking a lane's credential from the desk", () => {
  it("takes TWO clicks — the first one only states the consequence", async () => {
    const onRevokeGrants = vi.fn(async () => ({ revoked: 2, note: "gone." }));
    render(
      <DispatchTreeItem node={node()} onRevokeGrants={onRevokeGrants} />
    );
    fireEvent.click(screen.getByText("Revoke credential"));
    expect(onRevokeGrants, "the first click cannot revoke").not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Kill credential"));
    expect(onRevokeGrants).toHaveBeenCalledWith("job-77");
  });

  it("lets the operator back out", () => {
    const onRevokeGrants = vi.fn();
    render(
      <DispatchTreeItem node={node()} onRevokeGrants={onRevokeGrants} />
    );
    fireEvent.click(screen.getByText("Revoke credential"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Revoke credential")).toBeTruthy();
    expect(onRevokeGrants).not.toHaveBeenCalled();
  });

  it("says the process may still be running — revoke is not stop", async () => {
    render(
      <DispatchTreeItem
        node={node()}
        onRevokeGrants={vi.fn(async () => ({
          revoked: 2,
          note: "identity killed.",
        }))}
      />
    );
    fireEvent.click(screen.getByText("Revoke credential"));
    fireEvent.click(screen.getByText("Kill credential"));
    // An operator who reads "revoked" as "stopped" walks away from a process
    // that is still going.
    expect(
      await screen.findByText(/process may still be running/)
    ).toBeTruthy();
  });

  it("reports a refusal instead of implying the credential is gone", async () => {
    render(
      <DispatchTreeItem
        node={node()}
        onRevokeGrants={vi.fn(async () => {
          throw new Error("The selected chat changed before the revocation.");
        })}
      />
    );
    fireEvent.click(screen.getByText("Revoke credential"));
    fireEvent.click(screen.getByText("Kill credential"));
    expect(await screen.findByText(/Not revoked:/)).toBeTruthy();
  });

  it("renders NO control at all when the caller cannot revoke", () => {
    render(<DispatchTreeItem node={node()} />);
    expect(screen.queryByText("Revoke credential")).toBeNull();
  });

  it("offers the control on every lane of the tree, not just the root", () => {
    render(
      <DispatchTreeItem
        node={node({ children: [node({ id: "job-child", depth: 1 })] })}
        onRevokeGrants={vi.fn()}
      />
    );
    expect(screen.getAllByText("Revoke credential")).toHaveLength(2);
  });
});
