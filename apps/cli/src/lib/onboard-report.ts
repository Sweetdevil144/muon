import {
  buildOnboardingState,
  type VendorOnboardingStep,
  type VendorReadiness,
} from "@muon/client";

export type OnboardReport = {
  lines: string[];
  /** 0 when ≥1 vendor is ready; 1 otherwise (nothing connected / probe down). */
  exitCode: number;
};

function glyph(step: VendorOnboardingStep): string {
  if (step.step === "ready") return "✓";
  return step.step === "login" ? "◐" : "✗";
}

function statusText(step: VendorOnboardingStep): string {
  if (step.step !== "ready") {
    return step.step === "login"
      ? "installed · setup needed"
      : "not installed";
  }
  // A connected lane that is managed for only part of the role taxonomy
  // (Cursor, OpenCode) is ready FOR THOSE ROLES. Printing a bare "ready" beside
  // the ✓ told the operator it could take the next `muon run`, which the
  // dispatch route then refused.
  const scope = step.roleScope.scoped ? " · role-scoped" : "";
  switch (step.credentialMethod) {
    case "api-key":
      return `ready · API key${scope}`;
    case "custom-provider":
      return `ready · custom provider${scope}`;
    case "local-provider":
      return `ready · local provider${scope}`;
    default:
      return `ready${scope}`;
  }
}

/**
 * Render the guided `muon onboard` flow: the same readiness→step truth the
 * desktop wizard and TUI panel show, as a terminal-friendly table + per-vendor
 * fix hints + the next step. Pure (no I/O) so it tests deterministically with
 * mocked readiness. Never reads or prints a token, only booleans + hints.
 */
export function buildOnboardReport(
  readiness: VendorReadiness[] | null
): OnboardReport {
  const state = buildOnboardingState(readiness);
  const lines: string[] = [];

  lines.push("MUON onboarding, connect your own coding-agent CLIs");
  lines.push(state.headline);
  if (state.subhead) lines.push(state.subhead);
  lines.push("");

  if (state.degraded) {
    lines.push("Readiness check unavailable, manual setup:");
    for (const [index, step] of state.manualSteps.entries()) {
      lines.push(`  ${index + 1}. ${step}`);
    }
    lines.push("");
    lines.push(state.trustNotice);
    return { lines, exitCode: 1 };
  }

  for (const vendor of state.vendors) {
    lines.push(
      `  ${glyph(vendor)} ${vendor.label.padEnd(15)} ${statusText(vendor)}`
    );
    lines.push(`      ${vendor.detail}`);
    if (vendor.step === "ready" && vendor.roleScope.scoped) {
      // Which roles, verbatim from the shared projection of the role model.
      lines.push(`      ${vendor.roleScope.summary}`);
    }
    if (vendor.fixHint) {
      // The command the USER runs themselves, MUON never handles the token.
      lines.push(`      → ${vendor.fixHint}`);
    }
  }

  lines.push("");
  if (state.canDispatch) {
    lines.push(
      'You\'re ready. Try: muon run --lane <vendor> --task <id> "<brief>"'
    );
    lines.push("(or `muon chat` to drive the whole crew)");
  } else {
    lines.push(
      "No agent is ready yet. Run the fix above, then re-check: muon onboard"
    );
  }
  lines.push("");
  lines.push(state.trustNotice);

  return { lines, exitCode: state.canDispatch ? 0 : 1 };
}
