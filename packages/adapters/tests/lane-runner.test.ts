import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaneEvent } from "@muon/protocol";
import {
  buildLaneEnvironment,
  buildProviderAwareLaneEnvironment,
  runLaneCommand,
} from "../src/lane-runner.js";

describe("runLaneCommand", () => {
  it("emits started, output, and completed events for a successful command", async () => {
    const events: LaneEvent[] = [];

    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-1",
      command: "echo",
      args: ["hello from lane"],
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello from lane");

    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe("task.started");
    expect(kinds).toContain("task.progress");
    expect(kinds[kinds.length - 1]).toBe("task.completed");
    expect(events.every((event) => event.laneId === "codex")).toBe(true);
    expect(events.every((event) => event.taskId === "task-1")).toBe(true);
  });

  it("emits task.blocked when the command fails", async () => {
    const events: LaneEvent[] = [];

    const result = await runLaneCommand({
      laneId: "claude-code",
      taskId: "task-2",
      command: "sh",
      args: ["-c", "echo boom >&2; exit 3"],
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(3);
    expect(events[events.length - 1]?.kind).toBe("task.blocked");
  });

  it("surfaces child stderr LIVE, before the child exits, without changing errorOutput", async () => {
    // The defect this closes: a provider that rejects on quota/billing can take
    // MINUTES to answer, and errorOutput only exists at close — long after the
    // runner's 90s startup watchdog has already fired and reported a cause it
    // never observed. onDiagnostic hands the same bytes over while the child
    // still runs, which is the only window the watchdog has.
    const controller = new AbortController();
    const chunks: string[] = [];
    let markDiagnostic!: () => void;
    const sawDiagnostic = new Promise<void>((resolve) => {
      markDiagnostic = resolve;
    });

    const command = runLaneCommand({
      laneId: "codex",
      taskId: "task-live-stderr",
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('You hit your spend cap'); setInterval(() => undefined, 1000)",
      ],
      signal: controller.signal,
      onEvent: () => undefined,
      onDiagnostic: (chunk) => {
        chunks.push(chunk);
        markDiagnostic();
      },
    });

    // Resolving here proves liveness: the child is still running (it never
    // exits on its own), so the diagnostic did NOT come from the close path.
    await sawDiagnostic;
    controller.abort();
    const result = await command;

    expect(chunks.join("")).toContain("You hit your spend cap");
    // errorOutput keeps collecting exactly what it collected before.
    expect(result.errorOutput).toContain("You hit your spend cap");
  });

  it("collects stderr identically when no diagnostic sink is supplied", async () => {
    const result = await runLaneCommand({
      laneId: "codex",
      taskId: "task-no-sink",
      command: "sh",
      args: ["-c", "echo vendor-warning >&2; exit 0"],
      onEvent: () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorOutput).toContain("vendor-warning");
  });

  it("rejects when the binary does not exist", async () => {
    await expect(
      runLaneCommand({
        laneId: "cursor",
        taskId: "task-3",
        command: "definitely-not-a-real-binary-xyz",
        args: [],
        onEvent: () => {},
      })
    ).rejects.toThrow();
  });

  it("terminates a running vendor command when its execution signal is aborted", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const command = runLaneCommand({
      laneId: "codex",
      taskId: "task-abort",
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      signal: controller.signal,
      onEvent: (event) => {
        if (event.kind === "task.started") {
          markStarted();
        }
      },
    });

    await started;
    controller.abort();
    const result = await command;
    expect(result.exitCode).not.toBe(0);
  });

  it("rejects a pre-aborted signal before spawning a vendor command", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: LaneEvent[] = [];

    await expect(
      runLaneCommand({
        laneId: "codex",
        taskId: "task-pre-aborted",
        command: process.execPath,
        args: ["-e", "process.stdout.write('must-not-run')"],
        signal: controller.signal,
        onEvent: (event) => events.push(event),
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(events).toEqual([]);
  });

  it("exposes only the selected vendor credential and strips runner control authority", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      MUON_API_BASE: "http://127.0.0.1:4000",
      MUON_AGENT_TOKEN: "agent-token",
      MUON_RUNNER_HOST: "desktop-mac",
      MUON_RUNNER_LEASE_TOKEN: "runner-lease",
      MUON_OPERATOR_TOKEN: "operator-token",
      MUON_GITHUB_TOKEN: "github-user-token",
      MUON_GITHUB_REFRESH_TOKEN: "github-refresh-token",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      CURSOR_API_KEY: "cursor-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
    };

    const claude = buildLaneEnvironment("claude-code", parent, {
      CUSTOM_SETTING: "enabled",
      OPENAI_API_KEY: "profile-cross-vendor-secret",
    });
    expect(claude).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      MUON_API_BASE: "http://127.0.0.1:4000",
      ANTHROPIC_API_KEY: "anthropic-secret",
      CUSTOM_SETTING: "enabled",
    });
    expect(claude).not.toHaveProperty("MUON_AGENT_TOKEN");
    expect(claude).not.toHaveProperty("OPENAI_API_KEY");
    expect(claude).not.toHaveProperty("CURSOR_API_KEY");
    expect(claude).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(claude).not.toHaveProperty("MUON_OPERATOR_TOKEN");
    expect(claude).not.toHaveProperty("MUON_GITHUB_TOKEN");
    expect(claude).not.toHaveProperty("MUON_GITHUB_REFRESH_TOKEN");
    expect(claude).not.toHaveProperty("MUON_RUNNER_HOST");
    expect(claude).not.toHaveProperty("MUON_RUNNER_LEASE_TOKEN");

    expect(buildLaneEnvironment("codex", parent)).toMatchObject({
      OPENAI_API_KEY: "openai-secret",
    });
    expect(buildLaneEnvironment("codex", parent)).not.toHaveProperty(
      "ANTHROPIC_API_KEY"
    );
    expect(buildLaneEnvironment("cursor", parent)).toMatchObject({
      CURSOR_API_KEY: "cursor-secret",
    });

    expect(
      buildLaneEnvironment("codex", parent, {
        MUON_API_TOKEN: "job-bound-token",
      })
    ).toMatchObject({
      MUON_API_TOKEN: "job-bound-token",
    });
  });

  it("adds only the active Codex provider credential through the additive environment seam", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-codex-home-"));
    try {
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n")
      );
      const parent = {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        CODEX_HOME: codexHome,
        AZURE_OPENAI_API_KEY: "azure-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        CURSOR_API_KEY: "cursor-secret",
        MUON_OPERATOR_TOKEN: "operator-secret",
        MUON_RUNNER_LEASE_TOKEN: "lease-secret",
      };

      const codex = buildProviderAwareLaneEnvironment("codex", parent);
      expect(codex.AZURE_OPENAI_API_KEY).toBe("azure-secret");
      expect(codex).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(codex).not.toHaveProperty("CURSOR_API_KEY");
      expect(codex).not.toHaveProperty("MUON_OPERATOR_TOKEN");
      expect(codex).not.toHaveProperty("MUON_RUNNER_LEASE_TOKEN");

      const claude = buildProviderAwareLaneEnvironment("claude-code", parent);
      expect(claude.ANTHROPIC_API_KEY).toBe("anthropic-secret");
      expect(claude).not.toHaveProperty("AZURE_OPENAI_API_KEY");

      const cursor = buildProviderAwareLaneEnvironment("cursor", parent);
      expect(cursor.CURSOR_API_KEY).toBe("cursor-secret");
      expect(cursor).not.toHaveProperty("AZURE_OPENAI_API_KEY");

      expect(buildLaneEnvironment("codex", parent)).not.toHaveProperty(
        "AZURE_OPENAI_API_KEY"
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps task-scoped provider configuration and credentials ahead of ambient state", () => {
    const ambientCodexHome = mkdtempSync(
      join(tmpdir(), "muon-codex-home-ambient-")
    );
    const taskCodexHome = mkdtempSync(
      join(tmpdir(), "muon-codex-home-task-")
    );
    try {
      writeFileSync(
        join(ambientCodexHome, "config.toml"),
        [
          'model_provider = "ambient"',
          "",
          "[model_providers.ambient]",
          'env_key = "AMBIENT_AUTH_TOKEN"',
        ].join("\n")
      );
      writeFileSync(
        join(taskCodexHome, "config.toml"),
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n")
      );

      const child = buildProviderAwareLaneEnvironment(
        "codex",
        {
          CODEX_HOME: ambientCodexHome,
          AMBIENT_AUTH_TOKEN: "ambient-provider-secret",
          AZURE_OPENAI_API_KEY: "ambient-azure-secret",
        },
        {
          CODEX_HOME: taskCodexHome,
          AZURE_OPENAI_API_KEY: "task-scoped-azure-secret",
        }
      );

      expect(child.CODEX_HOME).toBe(taskCodexHome);
      expect(child.AZURE_OPENAI_API_KEY).toBe("task-scoped-azure-secret");
      expect(child).not.toHaveProperty("AMBIENT_AUTH_TOKEN");

      const explicitlyWithheld = buildProviderAwareLaneEnvironment(
        "codex",
        {
          CODEX_HOME: taskCodexHome,
          AZURE_OPENAI_API_KEY: "ambient-azure-secret",
        },
        {
          AZURE_OPENAI_API_KEY: "",
        }
      );
      expect(explicitlyWithheld.AZURE_OPENAI_API_KEY).toBe("");
    } finally {
      rmSync(ambientCodexHome, { recursive: true, force: true });
      rmSync(taskCodexHome, { recursive: true, force: true });
    }
  });

  it("forwards an arbitrary safe provider key but omits missing and unsafe nominations", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-codex-home-"));
    try {
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "acme"',
          "",
          "[model_providers.acme]",
          'env_key = "ACME_AUTH_TOKEN"',
        ].join("\n")
      );
      const configured = buildProviderAwareLaneEnvironment("codex", {
        CODEX_HOME: codexHome,
        ACME_AUTH_TOKEN: "acme-secret",
      });
      expect(configured.ACME_AUTH_TOKEN).toBe("acme-secret");

      const missing = buildProviderAwareLaneEnvironment("codex", {
        CODEX_HOME: codexHome,
      });
      expect(missing).not.toHaveProperty("ACME_AUTH_TOKEN");

      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "unsafe"',
          "",
          "[model_providers.unsafe]",
          'env_key = "NODE_OPTIONS"',
        ].join("\n")
      );
      const unsafe = buildProviderAwareLaneEnvironment("codex", {
        CODEX_HOME: codexHome,
        NODE_OPTIONS: "--require=/tmp/inject.js",
      });
      expect(unsafe).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("uses the provider-aware environment for an actual one-shot Codex child", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "muon-codex-home-"));
    const previousHome = process.env.CODEX_HOME;
    const previousKey = process.env.AZURE_OPENAI_API_KEY;
    try {
      writeFileSync(
        join(codexHome, "config.toml"),
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n")
      );
      process.env.CODEX_HOME = codexHome;
      process.env.AZURE_OPENAI_API_KEY = "azure-one-shot-sentinel";

      const result = await runLaneCommand({
        laneId: "codex",
        taskId: "task-provider-env",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.AZURE_OPENAI_API_KEY ?? 'missing')",
        ],
        onEvent: () => undefined,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("azure-one-shot-sentinel");
    } finally {
      if (previousHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousHome;
      }
      if (previousKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = previousKey;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
