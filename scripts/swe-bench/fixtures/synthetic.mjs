// MUON SWE-bench harness, the SYNTHETIC fixture suite.
//
// This proves the harness END-TO-END without any real vendor: it uses the
// deterministic dev/test `fake` vendor (MUON_FAKE_VENDOR=1). The fake makes a
// known additive edit in the prepared workspace; the acceptance `check` (run
// through the SAME argv-safe check path the real loop uses, @muon/core
// `runShellCheck`) verifies that edit landed. It runs GREEN in CI and gates a
// spine regression, but it is NOT a real benchmark number, see docs/swe-bench.md.

import {
  FAKE_ARTIFACT_FILENAME,
  FAKE_MEMORY_SENTINEL,
} from "../../../packages/adapters/dist/index.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

const syntheticSuite = {
  name: "synthetic",
  // The dev/test fake vendor, swap for "claude-code" / "codex" / "cursor" with a
  // real logged-in vendor to produce a real number (docs/swe-bench.md).
  vendor: "fake",
  tasks: [
    {
      id: "synthetic-additive-edit",
      // A repair brief. With a real vendor + kind:"loop"/harness:"repair" the
      // agent would iterate against `check`; the fake makes a single deterministic
      // additive edit, which the check below then accepts.
      brief:
        "The workspace is missing its required marker file. Add it back so the " +
        "acceptance check passes. Make only an additive edit.",
      kind: "oneshot",
      // Prepare the starting repo state. `repoSetup` may be a function (given the
      // workspace dir) OR a directory path to copy in. Here we seed a tiny README
      // so the workspace is a realistic non-empty repo before the agent runs.
      repoSetup: (workspaceDir) => {
        writeFileSync(
          path.join(workspaceDir, "README.md"),
          `# synthetic bench task\n\nThe marker file is missing; the agent must add it.\n`
        );
      },
      // The acceptance check, a BARE argv (no shell), exactly the P3-B contract.
      // grep exits 0 iff the fake's additive edit landed with its marker.
      check: {
        name: "marker-present",
        command: "grep",
        args: ["-q", FAKE_MEMORY_SENTINEL, FAKE_ARTIFACT_FILENAME],
      },
    },
  ],
};

export default syntheticSuite;
