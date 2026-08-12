import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDesktopRunnerConfig,
  resolveRunnerEntry,
} from "../src/lib/runner-entry-config.js";

describe("desktop runner entry config", () => {
  it("reads the loopback base, agent token, and desktop host from env", () => {
    expect(
      readDesktopRunnerConfig({
        MUON_API_BASE: "http://127.0.0.1:4321",
        MUON_AGENT_TOKEN: "agent-token",
        MUON_RUNNER_HOST: "desktop-mac",
        MUON_RUNNER_LEASE_TOKEN: `lease-${"l".repeat(58)}`,
      })
    ).toEqual({
      apiBase: "http://127.0.0.1:4321",
      agentToken: "agent-token",
      host: "desktop-mac",
      leaseToken: `lease-${"l".repeat(58)}`,
    });
  });

  it("requires an http(s) loopback API base and a host", () => {
    expect(() =>
      readDesktopRunnerConfig({
        MUON_API_BASE: "https://example.com",
        MUON_RUNNER_HOST: "desktop-mac",
      })
    ).toThrow(/loopback/i);
    expect(() =>
      readDesktopRunnerConfig({
        MUON_API_BASE: "http://127.0.0.1:4321",
        MUON_RUNNER_HOST: "desktop-mac",
      })
    ).toThrow(/MUON_RUNNER_LEASE_TOKEN/);
    expect(() =>
      readDesktopRunnerConfig({
        MUON_API_BASE: "http://127.0.0.1:4321",
        MUON_RUNNER_HOST: "x".repeat(201),
        MUON_RUNNER_LEASE_TOKEN: `lease-${"l".repeat(58)}`,
      })
    ).toThrow(/200/);
  });

  it("prefers the explicit dedicated entry override", () => {
    const entry = resolveRunnerEntry({
      env: { MUON_RUNNER_ENTRY: "/override/runner.js" },
      resourcesPath: "/Resources",
      moduleDir: "/app/dist/lib",
      exists: (candidate) => candidate === "/override/runner.js",
    });
    expect(entry).toEqual({ path: "/override/runner.js", kind: "desktop" });
  });

  it("finds the packaged in-asar runner entry before development candidates", () => {
    const packaged = path.join(
      "/Applications/MUON.app/Contents/Resources",
      "app.asar",
      "dist",
      "runner-entry.js"
    );
    const entry = resolveRunnerEntry({
      env: {},
      resourcesPath: "/Applications/MUON.app/Contents/Resources",
      moduleDir: "/repo/apps/desktop/dist/lib",
      exists: (candidate) =>
        candidate === packaged ||
        candidate === "/repo/apps/desktop/dist/runner-entry.js",
    });
    expect(entry).toEqual({ path: packaged, kind: "desktop" });
  });

  it("finds the compiled development entry beside dist/lib", () => {
    const entry = resolveRunnerEntry({
      env: {},
      resourcesPath: "",
      moduleDir: "/repo/apps/desktop/dist/lib",
      exists: (candidate) =>
        candidate === "/repo/apps/desktop/dist/runner-entry.js",
    });
    expect(entry).toEqual({
      path: "/repo/apps/desktop/dist/runner-entry.js",
      kind: "desktop",
    });
  });

  it("retains MUON_CLI_ENTRY as a legacy degrade-safe fallback", () => {
    const entry = resolveRunnerEntry({
      env: { MUON_CLI_ENTRY: "/repo/apps/cli/dist/index.js" },
      resourcesPath: "",
      moduleDir: "/missing",
      exists: (candidate) => candidate === "/repo/apps/cli/dist/index.js",
    });
    expect(entry).toEqual({
      path: "/repo/apps/cli/dist/index.js",
      kind: "legacy-cli",
    });
  });
});
