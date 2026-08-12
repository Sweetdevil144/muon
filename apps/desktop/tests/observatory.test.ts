import { appendFileSync, mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OBSERVATORY_UPLOAD_PROVIDER } from "../src/lib/observatory-upload.js";
import {
  coarseCrashReason,
  createObservatory,
  OBSERVATORY_PROVIDER,
} from "../src/lib/observatory.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "muon-observatory-"));
}

const NOW = () => new Date("2026-08-05T00:00:00.000Z");

describe("P0-5 Observatory (local, consent-gated, no egress)", () => {
  it("names the REAL configured destination, not 'none'", () => {
    // This test used to assert `provider === "none"` under the name "no
    // uploader ships until the founder decision". ADR-0031 then landed a real
    // consent-gated PostHog uploader, and this assertion kept the spool — the
    // launch-checklist AUDIT ARTIFACT — stamping "none" on every record while
    // events went to PostHog US. A test that pins a false statement in place is
    // worse than no test: it is evidence for the wrong claim.
    //
    // `provider` names where consented data is CONFIGURED to go. It is not a
    // claim that any given record left the machine — that still requires
    // `settings.telemetryEnabled`, and the MUON_OBSERVATORY_SPOOL audit
    // override records locally while uploading nothing.
    expect(OBSERVATORY_PROVIDER).toBe(OBSERVATORY_UPLOAD_PROVIDER);
    expect(OBSERVATORY_PROVIDER).not.toBe("none");
  });

  it("without consent, record() leaves ZERO footprint — no dir, no file", () => {
    const dataDir = tempDir();
    const observatory = createObservatory({
      dataDir,
      appVersion: "0.9.0",
      enabled: () => false,
      now: NOW,
    });
    observatory.record({ name: "app.launch" });
    observatory.record({ name: "app.crash.renderer", reason: "oom" });
    expect(existsSync(path.join(dataDir, "observatory"))).toBe(false);
  });

  it("with consent, events land as bounded JSONL rows with build coordinates", () => {
    const dataDir = tempDir();
    const observatory = createObservatory({
      dataDir,
      appVersion: "0.9.0",
      enabled: () => true,
      platform: "darwin",
      arch: "arm64",
      now: NOW,
    });
    observatory.record({ name: "app.launch" });
    observatory.record({ name: "app.crash.renderer", reason: "oom" });

    const rows = readFileSync(observatory.spoolPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: "app.launch",
      at: "2026-08-05T00:00:00.000Z",
      appVersion: "0.9.0",
      platform: "darwin",
      arch: "arm64",
      provider: OBSERVATORY_UPLOAD_PROVIDER,
      schema: 1,
    });
    expect(rows[1]!.reason).toBe("oom");
    // PRIVACY BY SHAPE: no row has any field beyond the closed vocabulary.
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(
          ["name", "at", "appVersion", "platform", "arch", "provider", "schema", "reason", "coldStartMs", "updateAvailable"],
          key
        ).toContain(key);
      }
    }
  });

  it("funnel events fire ONCE per profile, ever — the milestone file dedupes", () => {
    const dataDir = tempDir();
    const make = () =>
      createObservatory({
        dataDir,
        appVersion: "0.9.0",
        enabled: () => true,
        now: NOW,
      });
    const first = make();
    first.record({ name: "funnel.first_chat" });
    first.record({ name: "funnel.first_chat" });
    // Even a NEW instance over the same profile (an app restart) stays deduped.
    make().record({ name: "funnel.first_chat" });

    const rows = readFileSync(first.spoolPath, "utf8").trim().split("\n");
    expect(rows).toHaveLength(1);
  });

  it("coarseCrashReason collapses unknown text to 'unknown' — no prose channel", () => {
    expect(coarseCrashReason("oom")).toBe("oom");
    expect(coarseCrashReason("crashed")).toBe("crashed");
    expect(
      coarseCrashReason("/Users/someone/secret-project exploded")
    ).toBe("unknown");
    expect(coarseCrashReason(undefined)).toBe("unknown");
  });

  it("never throws — a read-only disk must not break the app", () => {
    const observatory = createObservatory({
      // A path that cannot be created.
      dataDir: "/dev/null/impossible",
      appVersion: "0.9.0",
      enabled: () => true,
      now: NOW,
    });
    expect(() => observatory.record({ name: "app.launch" })).not.toThrow();
  });

  it("spool files are private (0600) and the dir 0700", () => {
    const dataDir = tempDir();
    const observatory = createObservatory({
      dataDir,
      appVersion: "0.9.0",
      enabled: () => true,
      now: NOW,
    });
    observatory.record({ name: "app.launch" });
    const dir = path.join(dataDir, "observatory");
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(observatory.spoolPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// ── F3: schema stamp, consent event, and the local summary ─────────────────

import {
  OBSERVATORY_SCHEMA_VERSION,
  summarizeObservatory,
  type ObservatoryEvent,
} from "../src/lib/observatory.js";

describe("F3 — schema-stamped records and the local summary", () => {
  it("stamps every row with the frozen schema version", () => {
    const dir = tempDir();
    const obs = createObservatory({ dataDir: dir, appVersion: "0.9.0", enabled: () => true });
    obs.record({ name: "app.launch" });
    const row = JSON.parse(
      readFileSync(obs.spoolPath, "utf8").trim().split("\n")[0]
    ) as Record<string, unknown>;
    expect(row.schema).toBe(OBSERVATORY_SCHEMA_VERSION);
  });

  it("every event branch is free-text-proof: values are enums, numbers, booleans", () => {
    // One representative of EVERY branch in the vocabulary. A new branch that
    // is not listed here fails the completeness assertion below, forcing the
    // author to prove its shape.
    const samples: ObservatoryEvent[] = [
      { name: "app.launch", coldStartMs: 120 },
      { name: "app.crash.renderer", reason: "oom" },
      { name: "app.crash.main", reason: "uncaught-exception" },
      { name: "update.check", updateAvailable: true },
      { name: "update.applied" },
      { name: "consent.granted" },
      { name: "funnel.first_vendor_ready" },
      { name: "funnel.first_chat" },
      { name: "funnel.first_dispatch" },
      { name: "funnel.first_merge" },
    ];
    const KNOWN_ENUMS = new Set([
      "app.launch", "app.crash.renderer", "app.crash.main", "update.check",
      "update.applied", "consent.granted", "funnel.first_vendor_ready",
      "funnel.first_chat",
      "funnel.first_dispatch", "funnel.first_merge",
      "crashed", "oom", "killed", "launch-failed", "integrity-failure",
      "clean-exit", "abnormal-exit", "unknown", "uncaught-exception",
    ]);
    const names = new Set(samples.map((sample) => sample.name));
    expect(names.size).toBe(10); // completeness: one sample per branch
    for (const sample of samples) {
      for (const value of Object.values(sample)) {
        const ok =
          typeof value === "number" ||
          typeof value === "boolean" ||
          (typeof value === "string" && KNOWN_ENUMS.has(value));
        expect(ok, `free-text-capable value in ${sample.name}: ${String(value)}`).toBe(true);
      }
    }
  });

  it("summarize aggregates counts + funnel and carries no row payloads through", () => {
    const dir = tempDir();
    const obs = createObservatory({ dataDir: dir, appVersion: "0.9.0", enabled: () => true });
    obs.record({ name: "consent.granted" });
    obs.record({ name: "app.launch" });
    obs.record({ name: "app.launch" });
    obs.record({ name: "app.crash.renderer", reason: "oom" });
    obs.record({ name: "update.check", updateAvailable: false });
    obs.record({ name: "update.applied" });
    obs.record({ name: "funnel.first_chat" });

    const summary = summarizeObservatory(dir);
    expect(summary.launches).toBe(2);
    expect(summary.crashes.oom).toBe(1);
    expect(summary.updateChecks).toBe(1);
    expect(summary.updatesApplied).toBe(1);
    expect(summary.consentGrantedAt).toBeTruthy();
    expect(summary.funnel.first_chat).toBeTruthy();
    expect(summary.provider).toBe(OBSERVATORY_UPLOAD_PROVIDER);
    // The summary is counts + timestamps only — no names/rows arrays.
    expect(JSON.stringify(summary)).not.toContain("app.launch");
  });

  it("summarize survives a torn tail line and an absent spool", () => {
    const empty = tempDir();
    expect(summarizeObservatory(empty).launches).toBe(0);

    const dir = tempDir();
    const obs = createObservatory({ dataDir: dir, appVersion: "0.9.0", enabled: () => true });
    obs.record({ name: "app.launch" });
    appendFileSync(obs.spoolPath, "{torn");
    expect(summarizeObservatory(dir).launches).toBe(1);
  });
});
