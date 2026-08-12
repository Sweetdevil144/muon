import { Box, Text } from "ink";
import {
  buildOnboardingState,
  type VendorOnboardingStep,
  type VendorReadiness,
} from "@muon/client";
import { hub } from "../lib/theme.js";

type Props = {
  readiness: VendorReadiness[] | null;
  hasCompletedTask?: boolean;
  width?: number;
};

const STEP_GLYPH: Record<VendorOnboardingStep["step"], { glyph: string; color?: string }> = {
  ready: { glyph: "✓", color: hub.accent },
  login: { glyph: "◐", color: hub.warn },
  install: { glyph: "○" },
};

/**
 * First-run / empty-state onboarding panel (P2b). Renders the SHARED
 * readiness→step machine, so it shows the same truth as the desktop wizard and
 * `muon onboard`: which vendors are installed / logged in, the exact command to
 * fix each gap, and the path to the first dispatch.
 *
 * MUON never sees or stores a vendor token, it only reads readiness booleans +
 * the probe's fix hints and points the user at the vendor's own login.
 */
export function OnboardingPanel({
  readiness,
  hasCompletedTask = false,
  width = 72,
}: Props) {
  const state = buildOnboardingState(readiness);
  const awaitingProof = state.canDispatch && !hasCompletedTask;

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Text>
        {awaitingProof
          ? "FIRST RUN, prove the loop"
          : "GET STARTED, connect a coding agent"}
      </Text>
      <Text color={state.canDispatch ? undefined : hub.warn}>
        {state.headline}
      </Text>
      <Text dimColor wrap="truncate-end">
        {state.subhead}
      </Text>

      {state.degraded ? (
        <Box flexDirection="column" marginTop={1}>
          {state.manualSteps.map((step, index) => (
            <Text key={index} wrap="truncate-end">
              {index + 1}. {step}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {state.vendors.map((vendor) => {
            // A connected lane that is managed for only part of the role
            // taxonomy is ready FOR THOSE ROLES. A green ✓ and a bare ", ready"
            // claimed it could take the next dispatch, which the route refuses.
            const scoped =
              vendor.step === "ready" && vendor.roleScope.scoped;
            const g = scoped
              ? { glyph: "◑", color: undefined }
              : STEP_GLYPH[vendor.step];
            return (
              <Box flexDirection="column" key={vendor.vendor}>
                <Text color={g.color}>
                  {g.glyph} {vendor.label}
                  {scoped
                    ? ", ready · role-scoped"
                    : vendor.step === "ready"
                      ? ", ready"
                      : ""}
                </Text>
                {scoped ? (
                  // `managedFor` (not `summary`): the label-free fragment fits
                  // a narrow panel without truncating away the role list, which
                  // is the whole point of the line.
                  <Text dimColor wrap="truncate-end">
                    {"    managed for "}
                    {vendor.roleScope.managedFor}
                  </Text>
                ) : null}
                {vendor.fixHint ? (
                  <Text dimColor wrap="truncate-end">
                    {"    → "}
                    {vendor.fixHint}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        {awaitingProof ? (
          <Box flexDirection="column">
            <Text color={hub.focus}>
              Ctrl+K → Run first task
            </Text>
            <Text dimColor wrap="truncate-end">
              Onboarding ends after a completed task + captured memory, not a
              connection check.
            </Text>
          </Box>
        ) : state.canDispatch ? (
          <Text color={hub.accent}>
            First task complete, press / and tell the crew what to do.
          </Text>
        ) : (
          <Text dimColor>
            Run the fix above, then it re-checks automatically.
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {state.trustNotice}
      </Text>
    </Box>
  );
}
