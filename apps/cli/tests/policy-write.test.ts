import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPolicyCommand } from "../src/commands/policy.js";
import type { MuonApiClient } from "../src/lib/api-client.js";

const VALID_PROFILE = {
  version: 1,
  label: "test",
  postures: {
    read: "allow",
    test: "allow",
    edit: "gate",
    network: "gate",
    merge: "gate",
    ship: "gate",
  },
  editInRadius: "allow",
  taskRadius: [],
};

function run(argv: string[], client: Partial<MuonApiClient>) {
  const program = new Command();
  program.exitOverride();
  registerPolicyCommand(program, () => client as MuonApiClient);
  return program.parseAsync(["node", "muon", ...argv]);
}

describe("muon policy set/unset/revoke", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs.length = 0;
  });

  it("set loads the profile file and PUTs it to the governed store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "muon-policy-"));
    dirs.push(dir);
    const file = path.join(dir, "p.json");
    writeFileSync(file, JSON.stringify(VALID_PROFILE));
    const putWorkspacePolicy = vi
      .fn()
      .mockResolvedValue({ profile: VALID_PROFILE, scope: "workspace", version: 1 });
    await run(["policy", "set", "--workspace", "/ws", "--profile", file], {
      putWorkspacePolicy,
    } as unknown as Partial<MuonApiClient>);
    expect(putWorkspacePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/ws",
        profile: expect.objectContaining({ label: "test" }),
      })
    );
  });

  it("unset DELETEs the stored profile", async () => {
    const deleteWorkspacePolicy = vi.fn().mockResolvedValue({ deleted: 1 });
    await run(["policy", "unset", "--workspace", "/ws"], {
      deleteWorkspacePolicy,
    } as unknown as Partial<MuonApiClient>);
    expect(deleteWorkspacePolicy).toHaveBeenCalledWith({
      workspacePath: "/ws",
      taskId: undefined,
    });
  });

  it("revoke revokes a live receipt by id", async () => {
    const revokeReceipt = vi
      .fn()
      .mockResolvedValue({ id: "r1", toolName: "Bash" });
    await run(["policy", "revoke", "--receipt-id", "r1"], {
      revokeReceipt,
    } as unknown as Partial<MuonApiClient>);
    expect(revokeReceipt).toHaveBeenCalledWith("r1");
  });
});
