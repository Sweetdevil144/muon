/**
 * Update-all, desktop half (founder, 2026-08-19): after the APP updates, the
 * machine's npm-global CLI is pulled along. The rules that keep this safe:
 * only a PRESENT install, only an OLDER one, and failure is a sentence — never
 * a blocked launch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cliRefreshPlan,
  cliTarballUrl,
  runCliRefresh,
} from "../src/lib/cli-refresh.js";

describe("cliRefreshPlan", () => {
  it("refreshes a present, older global CLI from the download host", () => {
    const plan = cliRefreshPlan({
      appVersion: "0.4.8",
      globalCliVersion: "0.4.7",
    });
    expect(plan).toEqual({
      refresh: true,
      from: "0.4.7",
      argv: ["install", "-g", "https://download.getmuon.com/muon-cli-latest.tgz"],
    });
  });

  it("touches NOTHING on a machine with no global install", () => {
    const plan = cliRefreshPlan({ appVersion: "0.4.8", globalCliVersion: null });
    expect(plan.refresh).toBe(false);
  });

  it("leaves a newer or equal global CLI alone", () => {
    expect(
      cliRefreshPlan({ appVersion: "0.4.8", globalCliVersion: "0.4.8" }).refresh
    ).toBe(false);
    expect(
      cliRefreshPlan({ appVersion: "0.4.8", globalCliVersion: "0.5.0" }).refresh
    ).toBe(false);
  });

  it("does not act on an uncomparable version", () => {
    expect(
      cliRefreshPlan({ appVersion: "0.4.8", globalCliVersion: "not-a-version" })
        .refresh
    ).toBe(false);
  });

  it("is PINNED: the module exposes no way to point the install elsewhere", () => {
    // The plan feeds a promptless `npm install -g`; the pin is structural —
    // no host parameter, no env read — so the only argv this module can ever
    // produce names the canonical https host (cubic pass-4 #1).
    expect(cliTarballUrl()).toBe(
      "https://download.getmuon.com/muon-cli-latest.tgz"
    );
    // Asserted on the SOURCE, not on Function.length — a re-added DEFAULTED
    // `host` parameter also reports length 0 (cubic pass-5 #1). The capture
    // anchors on each function's RETURN-TYPE annotation and spans the WHOLE
    // parameter list (pass-6 #1 missed an untyped default; pass-7 #1 showed a
    // first-param-only capture missed a SECOND parameter), so any parameter,
    // however named, typed, or positioned, lands inside the captured text.
    //
    // TO THE REFACTORER WHOSE RENAME LANDS HERE: this test is the pin on a
    // promptless `npm install -g`. If you changed the declaration form
    // (arrow const, extracted interface), RE-ANCHOR these captures on the new
    // form — do not delete the assertion, and do not give the plan a way to
    // take a host.
    const source = readFileSync(
      join(__dirname, "..", "src", "lib", "cli-refresh.ts"),
      "utf8"
    );
    const tarballSig = source.match(
      /cliTarballUrl\(([\s\S]*?)\): string \{/
    );
    expect(
      tarballSig,
      "cliTarballUrl(): string not found — re-anchor this pin on the new declaration form; the pin itself must survive"
    ).toBeTruthy();
    expect(tarballSig![1].trim()).toBe("");
    const planSig = source.match(
      /cliRefreshPlan\(([\s\S]*?)\): CliRefreshPlan \{/
    );
    expect(
      planSig,
      "cliRefreshPlan(...): CliRefreshPlan not found — re-anchor this pin on the new declaration form; the pin itself must survive"
    ).toBeTruthy();
    expect(planSig![1]).not.toMatch(/host/i);
    expect(source).not.toContain("MUON_DOWNLOAD_HOST");
    expect(source).not.toContain("process.env");
  });
});

describe("runCliRefresh", () => {
  it("skips without spawning when the plan says no", async () => {
    const spawnImpl = vi.fn();
    const outcome = await runCliRefresh(
      { refresh: false, reason: "no npm-global muon-cli on this machine" },
      spawnImpl as never
    );
    expect(outcome).toContain("skipped");
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("reports a clean install as refreshed", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child.handle);
    const promise = runCliRefresh(
      { refresh: true, from: "0.4.7", argv: ["install", "-g", "u"] },
      spawnImpl as never
    );
    child.close(0);
    expect(await promise).toContain("refreshed");
  });

  it("a failing npm resolves to a sentence with the manual remedy — never throws", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child.handle);
    const promise = runCliRefresh(
      { refresh: true, from: "0.4.7", argv: ["install", "-g", "u"] },
      spawnImpl as never
    );
    child.close(243);
    expect(await promise).toContain("muon update");
  });
});

function fakeChild() {
  const listeners = new Map<string, (arg: unknown) => void>();
  return {
    handle: {
      on(event: string, listener: (arg: unknown) => void) {
        listeners.set(event, listener);
        return this;
      },
    },
    close(code: number) {
      listeners.get("close")?.(code);
    },
  };
}
