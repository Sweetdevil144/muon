import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cliGateObservatoryEvent,
  recordCliGateEvent,
} from "../src/lib/observatory.js";
import type { CliIdentityGate } from "../src/lib/identity-gate.js";

/**
 * ADR-0095 — the CLI end of the observatory. The pure mapping is what is
 * pinned hardest: an UNARMED gate records nothing (no gate ran, so neither
 * verdict would be true), an exempt command slipping through a LOCKED gate is
 * NOT a pass, and a refusal carries only the coarse reason.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muon-cli-observatory-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gate(overrides: Partial<CliIdentityGate>): CliIdentityGate {
  return {
    required: true,
    satisfied: true,
    state: "open",
    misconfigured: false,
    doorMissing: false,
    ...overrides,
  };
}

describe("cliGateObservatoryEvent (pure verdict → event mapping)", () => {
  it("an unarmed gate maps to NOTHING — no gate ran on a dev checkout", () => {
    expect(
      cliGateObservatoryEvent(
        gate({ required: false, state: "unarmed" }),
        { allowed: true }
      )
    ).toBeUndefined();
  });

  it("an armed satisfied gate + allowed command maps to gate_passed/cli", () => {
    expect(cliGateObservatoryEvent(gate({}), { allowed: true })).toEqual({
      name: "identity.gate_passed",
      surface: "cli",
      trigger: "command",
    });
  });

  it("an EXEMPT command through a LOCKED gate is not a pass — maps to nothing", () => {
    expect(
      cliGateObservatoryEvent(
        gate({ satisfied: false, state: "locked" }),
        { allowed: true } // e.g. `muon login` while locked
      )
    ).toBeUndefined();
  });

  it("a refusal maps to gate_refused/cli with the coarse reason only", () => {
    expect(
      cliGateObservatoryEvent(gate({ satisfied: false, state: "locked" }), {
        allowed: false,
        commandPath: "muon dispatch",
        refusal: "MUON is locked …",
        exitCode: 12,
      })
    ).toEqual({
      name: "identity.gate_refused",
      surface: "cli",
      reason: "unregistered",
      trigger: "command",
    });
  });
});

describe("recordCliGateEvent (spool + bounded best-effort egress)", () => {
  it("with consent: spools the event and uploads through the injected fetcher", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "cli-dev" })
    );
    const sent: string[] = [];
    await recordCliGateEvent(
      { name: "identity.gate_passed", surface: "cli", trigger: "command" },
      {
        dataDir: dir,
        appVersion: "0.6.1",
        flushBeforeExit: true,
        fetcher: (async (_url: unknown, init?: { body?: string }) => {
          sent.push(String(init?.body ?? ""));
          return { ok: true, status: 200 } as Response;
        }) as unknown as typeof fetch,
      }
    );
    expect(existsSync(join(dir, "observatory", "spool.jsonl"))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"identity.gate_passed"');
  });

  it("without consent: records nothing, sends nothing, resolves anyway", async () => {
    const dir = tempDir();
    await expect(
      recordCliGateEvent(
        {
          name: "identity.gate_refused",
          surface: "cli",
          reason: "unregistered",
          trigger: "command",
        },
        {
          dataDir: dir,
          appVersion: "0.6.1",
          flushBeforeExit: true,
          fetcher: (async () => {
            throw new Error("must not be called");
          }) as unknown as typeof fetch,
        }
      )
    ).resolves.toBeUndefined();
    expect(existsSync(join(dir, "observatory", "spool.jsonl"))).toBe(false);
  });

  it("a hanging uploader cannot hold the process — the bound resolves it", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "cli-dev" })
    );
    const start = Date.now();
    await recordCliGateEvent(
      { name: "identity.gate_passed", surface: "cli", trigger: "command" },
      {
        dataDir: dir,
        appVersion: "0.6.1",
        flushBeforeExit: true,
        fetcher: (() => new Promise(() => undefined)) as unknown as typeof fetch,
        flushBoundMs: 50,
      }
    );
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("the pass path is spool-only (review F1)", () => {
  it("without upload: spools the row, never touches the network, cancels the flush timer", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ telemetryEnabled: true, telemetryDeviceId: "cli-dev" })
    );
    // A fetcher that would fail the test if the pass path ever dialled out —
    // the measured failure was a pooled keep-alive socket holding a finished
    // command open ~28s, so "no network at all" is the pin.
    const fetcher = (async () => {
      throw new Error("the pass path must never open a socket");
    }) as unknown as typeof fetch;
    await recordCliGateEvent(
      { name: "identity.gate_passed", surface: "cli", trigger: "command" },
      { dataDir: dir, appVersion: "0.6.1", fetcher }
    );
    expect(existsSync(join(dir, "observatory", "spool.jsonl"))).toBe(true);
  });
});
