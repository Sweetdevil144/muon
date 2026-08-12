import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/lib/api-client.js";
import { registerPolicyCommand } from "../src/commands/policy.js";

// `muon policy explain` stays offline/dry-run by default; `--workspace` is the
// one opt-in brain read (the stored, enforced profile). We register it on a bare
// Command (no preAction hook), capture stdout/stderr, and assert on the render.

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => payload,
  } as Response;
}

async function runExplain(
  args: string[],
  createClient?: () => MuonApiClient
): Promise<{
  out: string;
  err: string;
  exitCode: number;
}> {
  const program = new Command();
  program.exitOverride();
  registerPolicyCommand(program, createClient);
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "muon", "policy", "explain", ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  return { out: out.join(""), err: err.join(""), exitCode };
}

let workDir: string | null = null;
afterEach(() => {
  process.exitCode = 0;
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

describe("muon policy explain", () => {
  it("renders the default posture for every action class", async () => {
    const { out, exitCode } = await runExplain([]);
    expect(exitCode).toBe(0);
    expect(out).toContain('profile "default"');
    for (const cls of ["read", "test", "edit", "network", "merge", "ship"]) {
      expect(out).toContain(cls);
    }
    // Default posture: read/test allow, edit + dangerous classes ask.
    expect(out).toMatch(/read\s+allow/);
    expect(out).toMatch(/test\s+allow/);
    expect(out).toMatch(/edit\s+gate/);
    expect(out).toMatch(/network\s+gate/);
    expect(out).toMatch(/merge\s+gate/);
    expect(out).toMatch(/ship\s+gate/);
    expect(out).toContain("Dry-run only");
  });

  it("limits output to a single class with --action", async () => {
    const { out, exitCode } = await runExplain(["--action", "merge"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/merge\s+gate/);
    expect(out).not.toMatch(/read\s+allow/);
  });

  it("rejects an unknown action class", async () => {
    const { err, exitCode } = await runExplain(["--action", "deploy"]);
    expect(exitCode).toBe(1);
    expect(err).toContain("Unknown action class 'deploy'");
  });

  it("emits machine-readable JSON with --json", async () => {
    const { out, exitCode } = await runExplain(["--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.profile.label).toBe("default");
    expect(parsed.profile.version).toBe(1);
    expect(parsed.simulations).toHaveLength(6);
    const merge = parsed.simulations.find(
      (s: { actionClass: string }) => s.actionClass === "merge"
    );
    expect(merge.decision).toBe("gate");
  });

  it("loads and explains a supplied profile file", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-policy-"));
    const file = path.join(workDir, "profile.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        label: "locked-down",
        postures: {
          read: "deny",
          test: "allow",
          edit: "gate",
          network: "deny",
          merge: "deny",
          ship: "deny",
        },
      }),
      "utf8"
    );
    const { out, exitCode } = await runExplain(["--profile", file]);
    expect(exitCode).toBe(0);
    expect(out).toContain('profile "locked-down"');
    expect(out).toMatch(/read\s+deny/);
    expect(out).toMatch(/network\s+deny/);
  });

  it("refuses a profile that tries to allow an always-ask class", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "muon-policy-"));
    const file = path.join(workDir, "bad.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        label: "unsafe",
        postures: {
          read: "allow",
          test: "allow",
          edit: "allow",
          network: "allow", // forbidden by the schema
          merge: "gate",
          ship: "gate",
        },
      }),
      "utf8"
    );
    const { err, exitCode } = await runExplain(["--profile", file]);
    expect(exitCode).toBe(1);
    expect(err).toContain("Invalid policy profile");
  });

  // ---- P0.4 slice 3: --workspace fetches the stored, ENFORCED profile ----

  const storedProfile = {
    version: 1,
    label: "repo-policy",
    postures: {
      read: "allow",
      test: "allow",
      edit: "gate",
      network: "gate",
      merge: "deny",
      ship: "gate",
    },
    editInRadius: "allow",
    taskRadius: ["src"],
  };

  it("explains the stored workspace profile and says it is enforced", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ profile: storedProfile, scope: "workspace", version: 2 })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runExplain(
      ["--workspace", "/repo"],
      () => client
    );

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/api/policy/profile?workspacePath=%2Frepo"),
      expect.anything()
    );
    expect(out).toContain('profile "repo-policy"');
    expect(out).toContain("stored workspace profile");
    expect(out).toContain(
      "Enforced for interactive sessions in this workspace"
    );
    expect(out).not.toContain("Dry-run only");
    expect(out).toMatch(/merge\s+deny/);
  });

  it("falls back to the dry-run default when no profile is stored", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ profile: null, scope: null, version: 0 })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runExplain(
      ["--workspace", "/repo"],
      () => client
    );

    expect(exitCode).toBe(0);
    expect(out).toContain('profile "default"');
    expect(out).toContain("no stored profile");
    expect(out).toContain("Dry-run only");
    expect(out).not.toContain("Enforced for interactive sessions");
  });

  it("degrades to the dry-run fallback when the brain is unreachable", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runExplain(
      ["--workspace", "/repo"],
      () => client
    );

    expect(exitCode).toBe(0);
    expect(out).toContain('profile "default"');
    expect(out).toContain("Dry-run only");
  });

  it("reports the stored source in --json output", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockResponse({ profile: storedProfile, scope: "task", version: 5 })
    );
    const client = new MuonApiClient("http://localhost:4000", fetcher);

    const { out, exitCode } = await runExplain(
      ["--workspace", "/repo", "--json"],
      () => client
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.profile.label).toBe("repo-policy");
    expect(parsed.source).toContain("stored task profile");
    expect(parsed.enforced).toBe(true);
  });

  it("errors cleanly when the profile file is missing", async () => {
    const { err, exitCode } = await runExplain([
      "--profile",
      "/no/such/policy-profile.json",
    ]);
    expect(exitCode).toBe(1);
    expect(err).toContain("Could not read policy profile");
  });
});
