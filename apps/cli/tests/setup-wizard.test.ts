import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { McpVendorIo } from "@muon/client/mcp-vendor-config";
import { INSTALLABLE_VENDORS } from "@muon/client/mcp-vendor-config";
import { writeEnrolment } from "@muon/client/enrolment";
import { writeIdentityCredential } from "@muon/client/github-identity-gate";
import {
  attachedCoordinatorCapabilityFilePath,
  writeAttachedCoordinatorCapabilityFile,
} from "@muon/client/attached-coordinator-capability";
import {
  chooseVendors,
  confirm,
  defaultPrompter,
  probeSetupPlan,
  readSetupProgress,
  renderPlan,
  writeSetupProgress,
  type SetupPrompter,
} from "../src/lib/setup-wizard.js";

/**
 * The wizard's whole promise is RESUME FROM REALITY: a re-run starts at the
 * first step whose ARTIFACT is missing, so a completed step can never be
 * lost and a stored cursor can never lie. These tests drive the probes with
 * real files in a temp dataDir — the same artifacts the real steps write.
 */

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/** An io whose HOME is a fresh mkdtemp — no operator config is ever read. */
function io(overrides: Partial<McpVendorIo> = {}): McpVendorIo {
  const home = tempDir("muon-wizard-home-");
  return {
    roots: {
      home,
      configHome: path.join(home, ".config"),
      cwd: home,
      redirectVendorConfigDirs: true,
    },
    run: () => {
      throw new Error("the wizard's probes must not spawn a vendor process");
    },
    which: () => null,
    isExecutableFile: () => false,
    ...overrides,
  };
}

function credential(dataDir: string): void {
  writeIdentityCredential(
    {
      github: { id: 1, login: "dev" },
      token: "gho_" + "t".repeat(20),
      grant: {
        token: "a".repeat(64),
        issuedAt: "2026-08-17T00:00:00.000Z",
        version: 1,
      },
    },
    dataDir
  );
}

function scripted(answers: string[]): SetupPrompter {
  const queue = [...answers];
  return {
    isInteractive: true,
    ask: async () => queue.shift() ?? "",
  };
}

describe("the setup plan derives every step from its artifact", () => {
  it("a fresh machine is pending on every step", () => {
    const plan = probeSetupPlan({ io: io(), dataDir: tempDir("muon-wizard-data-") });
    expect(plan.map((step) => step.state.kind)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("each artifact satisfies exactly its own step — the resume order", () => {
    const dataDir = tempDir("muon-wizard-data-");
    const vendorIo = io();

    credential(dataDir);
    let plan = probeSetupPlan({ io: vendorIo, dataDir });
    expect(plan[0]!.state.kind).toBe("satisfied");
    expect(plan[0]!.state.detail).toContain("dev");
    expect(plan[1]!.state.kind).toBe("pending");

    writeEnrolment({ vendors: [{ id: "codex" }] }, dataDir);
    plan = probeSetupPlan({ io: vendorIo, dataDir });
    expect(plan[1]!.state.kind).toBe("satisfied");
    // The install step probes the VENDOR CONFIG, which does not exist yet —
    // an enrolment alone must not read as installed.
    expect(plan[2]!.state.kind).toBe("pending");
    expect(plan[2]!.state.detail).toContain("codex");
  });

  it("a quit between install and attach resumes at attach, not at zero", () => {
    // The founder's scenario verbatim: completed steps remain as they are.
    const dataDir = tempDir("muon-wizard-data-");
    const home = tempDir("muon-wizard-home-");
    const vendorIo = io({
      roots: {
        home,
        configHome: path.join(home, ".config"),
        cwd: home,
        redirectVendorConfigDirs: true,
      },
    });
    credential(dataDir);
    writeEnrolment({ vendors: [{ id: "codex" }] }, dataDir);
    // The install artifact: codex's own config file with a muon entry.
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.muon]\ncommand = "/opt/muon/bin/muon-mcp"\n'
    );

    const plan = probeSetupPlan({ io: vendorIo, dataDir });
    expect(plan.map((step) => step.state.kind)).toEqual([
      "satisfied",
      "satisfied",
      "satisfied",
      "pending",
    ]);
  });

  it("a VALID capability file satisfies the attach step; a leftover does not", () => {
    // Fail-closed like every other consumer: a seat is a session-scoped
    // lease, and an expired or malformed leftover must not read as attached —
    // the first version of this test wrote "{}" and got `satisfied`, which is
    // exactly the recap-reports-a-dead-seat bug the reader exists to prevent.
    const dataDir = tempDir("muon-wizard-data-");
    const file = attachedCoordinatorCapabilityFilePath("codex", dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    expect(probeSetupPlan({ io: io(), dataDir })[3]!.state.kind).toBe("pending");

    writeAttachedCoordinatorCapabilityFile(
      {
        version: 1,
        vendor: "codex",
        jobId: "job-1",
        chatId: "chat-1",
        chatTaskId: "task-1",
        workspacePath: "/repo",
        apiBase: "http://127.0.0.1:4317",
        apiToken: "t".repeat(64),
        delegationToken: "d".repeat(64),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      dataDir
    );
    const plan = probeSetupPlan({ io: io(), dataDir });
    expect(plan[3]!.state.kind).toBe("satisfied");
    expect(plan[3]!.state.detail).toContain("codex");
  });

  it("a journaled skip reads as skipped — but a REAL seat outranks it", () => {
    const dataDir = tempDir("muon-wizard-data-");
    writeSetupProgress({ version: 1, attachSkipped: true }, dataDir);
    expect(probeSetupPlan({ io: io(), dataDir })[3]!.state.kind).toBe("skipped");

    writeAttachedCoordinatorCapabilityFile(
      {
        version: 1,
        vendor: "claude-code",
        jobId: "job-1",
        chatId: "chat-1",
        chatTaskId: "task-1",
        workspacePath: "/repo",
        apiBase: "http://127.0.0.1:4317",
        apiToken: "t".repeat(64),
        delegationToken: "d".repeat(64),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
      dataDir
    );
    expect(probeSetupPlan({ io: io(), dataDir })[3]!.state.kind).toBe("satisfied");
  });

  it("a corrupt journal degrades to an empty one, never a throw", () => {
    const dataDir = tempDir("muon-wizard-data-");
    fs.writeFileSync(path.join(dataDir, "setup-progress.json"), "{not json");
    expect(readSetupProgress(dataDir)).toEqual({ version: 1 });
  });
});

describe("chooseVendors", () => {
  const all = INSTALLABLE_VENDORS;
  const detected = all.filter((spec) => spec.id === "claude-code" || spec.id === "codex");

  it("Enter takes the detected default", async () => {
    const chosen = await chooseVendors(scripted([""]), detected, all);
    expect(chosen.map((spec) => spec.id)).toEqual(["claude-code", "codex"]);
  });

  it("accepts numbers, ids and aliases, deduplicated", async () => {
    const chosen = await chooseVendors(
      scripted(["1, codex, claude"]),
      detected,
      all
    );
    expect(chosen.map((spec) => spec.id)).toEqual([all[0]!.id, "codex"]);
  });

  it("an unknown token is a refusal, never a silent skip", async () => {
    await expect(
      chooseVendors(scripted(["kiro"]), detected, all)
    ).rejects.toThrow(/not an agent CLI/);
  });

  it("allows a vendor that is NOT detected, deliberately", async () => {
    // "I'm installing codex right after this" must not be an error: the
    // config is written for a tool that reads it on arrival.
    const chosen = await chooseVendors(scripted(["opencode"]), [], all);
    expect(chosen.map((spec) => spec.id)).toEqual(["opencode"]);
  });
});

describe("confirm", () => {
  it("Enter takes the stated default, both ways", async () => {
    expect(await confirm(scripted([""]), "q?", true)).toBe(true);
    expect(await confirm(scripted([""]), "q?", false)).toBe(false);
    expect(await confirm(scripted(["y"]), "q?", false)).toBe(true);
    expect(await confirm(scripted(["n"]), "q?", true)).toBe(false);
  });
});

describe("renderPlan", () => {
  it("marks satisfied, skipped and pending distinctly", () => {
    const rendered = renderPlan([
      { id: "login", title: "A", state: { kind: "satisfied", detail: "x" } },
      { id: "attach", title: "B", state: { kind: "skipped", detail: "y" } },
      { id: "install", title: "C", state: { kind: "pending", detail: "z" } },
    ]);
    expect(rendered).toContain("✓ [1/3] A");
    expect(rendered).toContain("· [2/3] B");
    expect(rendered).toContain("○ [3/3] C");
  });
});

describe("the REAL prompter (the P0 the fake prompter hid)", () => {

  it("a typed answer wins over close — real readline, real stream", async () => {
    // Cubic ran the first prompter on a real stdin and every typed answer
    // resolved as "": the close handler beat the question callback, so the
    // vendor multi-select ignored what was typed and both y/N prompts were
    // unanswerable. The fake test prompter could never catch that; this
    // drives the REAL readline path over a real stream.
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const prompter = defaultPrompter({ input, output });
    const pending = prompter.ask("q? ");
    input.write("yes\n");
    input.end();
    expect(await pending).toBe("yes");
  });

  it("EOF with nothing typed resolves empty (the default), not a hang", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const prompter = defaultPrompter({ input, output });
    const pending = prompter.ask("q? ");
    input.end();
    expect(await pending).toBe("");
  });
});
