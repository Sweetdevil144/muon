import { describe, expect, it } from "vitest";
import {
  describeRunFailure,
  runDispatchError,
} from "../src/lib/run-dispatcher.js";
import type { VendorReadiness } from "@muon/client";

/**
 * ONE decision, both desks.
 *
 * The stage tags exist so MUON's own control-plane failures stop being
 * diagnosed as vendor login problems. The new desk consumed them and the
 * CLASSIC desk — the one that ships — did not: it inlined its own
 * `classifyVendorFailure` call and ignored the tag entirely. Both now delegate
 * here, so this file is the parity check.
 */

/** The precondition that makes the misdiagnosis happen: readiness says the
 *  vendor is not installed, i.e. a fresh machine. */
const NOT_READY: VendorReadiness[] = [
  {
    vendor: "codex",
    installed: false,
    authenticated: false,
    fixHint: "install the codex CLI",
  } as VendorReadiness,
];

describe("describeRunFailure — MUON's failures are not the vendor's", () => {
  it("keeps the runner hint instead of substituting onboarding copy", () => {
    const line = describeRunFailure({
      error: runDispatchError(
        "runner",
        "No persistent runner is online. Start one with `muon runner`, then retry."
      ),
      vendor: "codex",
      readiness: NOT_READY,
    });
    expect(line).toContain("muon runner");
    expect(line).not.toContain("isn't connected");
  });

  it("reports a POLL failure as MUON's, with the job possibly still running", () => {
    const line = describeRunFailure({
      error: runDispatchError(
        "poll",
        "MUON stopped watching dispatch job-1 after 60000ms — the job may still be running; check the lane."
      ),
      vendor: "codex",
      readiness: NOT_READY,
    });
    expect(line).toContain("may still be running");
    expect(line).not.toContain("isn't installed");
  });

  it("still routes a REAL vendor failure to onboarding", () => {
    // The control must not swallow the case it was built around: an untagged
    // error with a readiness gap is genuinely the vendor's problem.
    const line = describeRunFailure({
      error: new Error("spawn codex ENOENT"),
      vendor: "codex",
      readiness: NOT_READY,
    });
    expect(line).toContain("isn't connected");
    expect(line).toContain("install the codex CLI");
  });

  it("sanitizes a hostile control-plane message", () => {
    const RLO = String.fromCodePoint(0x202e);
    const line = describeRunFailure({
      error: runDispatchError("assign", `MUON refused${RLO}reversed`),
      vendor: "codex",
      readiness: NOT_READY,
    });
    expect(line).not.toContain(RLO);
  });

  it("every stage is honoured, not just the ones a reviewer happened to name", () => {
    // The failure mode this whole thread has been: fixing the members of a set
    // that were reported. Enumerate the set instead.
    for (const stage of ["runner", "assign", "enqueue", "poll"] as const) {
      const line = describeRunFailure({
        error: runDispatchError(stage, `MUON ${stage} failed`),
        vendor: "codex",
        readiness: NOT_READY,
      });
      expect(line, stage).toContain(`MUON ${stage} failed`);
      expect(line, stage).not.toContain("isn't connected");
    }
  });
});
