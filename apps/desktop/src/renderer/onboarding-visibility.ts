type OnboardingVisibilityInput = {
  stateReady: boolean;
  online: boolean;
  firstTaskRunning: boolean;
  chatCount: number;
  readinessKnown: boolean;
  anyVendorReady: boolean;
  pendingApprovalCount: number;
  /** The human has started the first task once — never re-show the wizard
   *  (kills the "same doctor panel twice" and takes them straight to the mission). */
  dismissed: boolean;
};

export function shouldShowOnboarding(
  input: OnboardingVisibilityInput
): boolean {
  if (!input.stateReady || !input.online) {
    return false;
  }
  // Once dismissed (the user ran their first task), the wizard is done for good —
  // the mission takes over immediately, even while the task is still running.
  if (input.dismissed) {
    return false;
  }
  if (input.firstTaskRunning && input.pendingApprovalCount > 0) {
    return false;
  }
  return (
    input.firstTaskRunning ||
    input.chatCount === 0 ||
    (input.readinessKnown && !input.anyVendorReady)
  );
}

export function firstTaskApprovalId(
  firstTaskRunning: boolean,
  approvals: Array<{ id: string }>
): string | null {
  return firstTaskRunning ? (approvals[0]?.id ?? null) : null;
}
