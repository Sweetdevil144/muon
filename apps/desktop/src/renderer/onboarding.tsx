import { useState } from "react";
// Pure subpath (no node built-ins) so the browser renderer bundle stays clean.
import {
  buildOnboardingState,
  ONBOARDING_VENDOR_LABELS,
  type VendorOnboardingStep,
  type VendorReadiness,
} from "@muon/client/onboarding";
import type { FirstTaskResult, ReadinessSnapshotMeta } from "../shared/ipc.js";
import { VendorIcon } from "./vendor-icon.js";

/**
 * First-run onboarding wizard (P2b + P6). Renders the SHARED readiness→step
 * machine (`buildOnboardingState`) so it shows the same truth as the CLI and TUI:
 *  - not installed → the install hint (we never auto-install)
 *  - installed, not logged in → the EXACT native login command the user runs
 *    themselves + a "Re-check" button
 *  - ≥1 vendor ready → "Run your first task": P6 seeds a SAFE, additive sample
 *    task into a folder you pick and dispatches it, so you watch the whole loop
 *    run (dispatch → agent works → memory captured → hero context), no bare
 *    folder-pick, no task to invent.
 *
 * INVARIANT: MUON never sees or stores a vendor token. The wizard only reads
 * readiness booleans + the probe's fix hints and points the user at the
 * vendor's own login, the trust line makes that explicit; the sample task is
 * additive + workspace-scoped and never handles a vendor token.
 */
export function Onboarding(props: {
  readiness: VendorReadiness[] | null;
  /**
   * Freshness of the probe behind `readiness`. Absent readiness means two very
   * different things — "the first ~3.8s vendor-CLI probe has not landed yet"
   * and "this control plane cannot check providers at all" — and the wizard
   * used to render the second one's manual fallback for both, so a healthy
   * first run flashed a wall of manual steps before the real cards appeared.
   */
  readinessMeta?: ReadinessSnapshotMeta;
  onRunFirstTask: () => Promise<FirstTaskResult>;
  onRecheck: () => Promise<void>;
  recheckError?: string | null;
}) {
  const [rechecking, setRechecking] = useState(false);
  const [starting, setStarting] = useState(false);
  // Structured tone, never a glyph prefix: copy is presentation, the tone
  // field is the error signal.
  const [firstTaskMsg, setFirstTaskMsg] = useState<{
    text: string;
    tone: "info" | "error";
  } | null>(null);
  const state = buildOnboardingState(props.readiness);
  // The first probe is still running: say so, and hold back BOTH the manual
  // fallback (which implies the check failed) and "Connect an agent to start"
  // (which implies a verdict we do not have yet).
  const checking =
    props.readiness === null &&
    (props.readinessMeta?.state === "probing" ||
      props.readinessMeta?.state === "refreshing");

  const recheck = async () => {
    setRechecking(true);
    try {
      await props.onRecheck();
    } finally {
      setRechecking(false);
    }
  };

  const runFirstTask = async () => {
    setStarting(true);
    setFirstTaskMsg(null);
    try {
      const result = await props.onRunFirstTask();
      if (result.ok) {
        setFirstTaskMsg({
          // The SHARED label map, so a lane the wizard can dispatch to is a lane
          // the wizard can name (a local copy silently printed the raw vendor key).
          text: `First task completed with ${ONBOARDING_VENDOR_LABELS[result.vendor] ?? result.vendor}; memory ${result.memoryId} is captured for review.`,
          tone: "info",
        });
      } else if (result.reason === "canceled") {
        setFirstTaskMsg(null);
      } else if (result.reason === "no-vendor-ready") {
        setFirstTaskMsg({
          text: "Connect a coding agent first (install its CLI and log in), then try again.",
          tone: "info",
        });
      } else {
        setFirstTaskMsg({
          text: `${result.message}${result.fixHint ? `, ${result.fixHint}` : ""}`,
          tone: "error",
        });
      }
    } catch (error) {
      setFirstTaskMsg({
        text:
          error instanceof Error
            ? error.message
            : "could not start your first task",
        tone: "error",
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card wizard">
        <img
          alt=""
          aria-hidden="true"
          className="onboarding-logo"
          src="./assets/logo.png"
        />
        <span className="brand">MUON</span>
        <h1>{state.headline}</h1>
        <p className="onboarding-sub">
          {/* The shared machine's subhead for absent readiness reads "connect
              an agent with the manual steps below" — true when the check is
              unavailable, wrong while it is merely still running. */}
          {checking
            ? "Looking for the agent CLIs you already have installed."
            : state.subhead}
        </p>
        {state.canDispatch ? (
          <p className="onboarding-proof">
            Onboarding ends only after a completed task and captured memory,
            not when a vendor merely connects.
          </p>
        ) : null}

        {checking ? (
          <div className="onboarding-checking" role="status">
            <span className="onboarding-checking-dot" aria-hidden="true" />
            <div>
              <strong>Checking your agents…</strong>
              <span>
                MUON is running each vendor CLI&apos;s own install and sign-in
                check. This takes a few seconds.
              </span>
            </div>
          </div>
        ) : state.degraded ? (
          <ol className="onboarding-steps">
            {state.manualSteps.map((step, index) => (
              <li key={index}>
                <span className="step-num">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="connect-list">
            {state.vendors.map((vendor) => (
              <ConnectCard key={vendor.vendor} step={vendor} />
            ))}
          </div>
        )}

        <div className="onboarding-actions">
          <button
            className="ghost-btn"
            onClick={() => void recheck()}
            disabled={rechecking || starting}
          >
            {rechecking ? "Re-checking…" : "Re-check"}
          </button>
          <button
            className="primary-btn"
            onClick={() => void runFirstTask()}
            disabled={!state.canDispatch || starting}
            title={
              state.canDispatch
                ? "Pick a folder, MUON seeds a tiny sample task and runs it so you see the whole loop"
                : "Connect at least one agent first"
            }
          >
            {starting
              ? "Running task + capturing memory…"
              : state.canDispatch
                ? "Run your first task"
                : checking
                  ? "Checking your agents…"
                  : "Connect an agent to start"}
          </button>
        </div>

        {props.recheckError ? (
          <p className="onboarding-first-task error" role="alert">
            {props.recheckError}
          </p>
        ) : null}

        {firstTaskMsg ? (
          <p
            className={`onboarding-first-task${
              firstTaskMsg.tone === "error" ? " error" : ""
            }`}
          >
            {firstTaskMsg.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// One vendor as a prototype-style connect card: icon tile, name, the real
// shared guidance sentence as the honest status line (verbatim from
// `vendorOnboardingStep`, never a desktop-only paraphrase), the exact fix
// command when one applies, and a right-side badge.
//
// The tile is the app's ONE vendor glyph registry (`VendorIcon`), not a
// wizard-local initials table — that table had no entry for the fourth lane, so it
// rendered as an unbranded `ol` tile while every other surface showed its real
// mark. `VendorIcon` covers each managed lane and falls back to a neutral
// diamond for a future vendor, never a fabricated identity.
//
// The badge is a status indicator, not a button — MUON has no per-vendor
// connect/setup handler to bind (install + login always happen in the user's own
// vendor CLI), so it never pretends to be clickable. It has three states, not
// two: a lane can be CONNECTED and still not unlock a first dispatch because it
// is managed for a limited set of crew roles, and "Ready" would overstate that
// while "Set up" would deny that anything was connected at all.
function ConnectCard(props: { step: VendorOnboardingStep }) {
  const { step } = props;
  const connected = step.step === "ready";
  const dispatchReady = connected && step.roleScope.takesUnplannedWork;
  const badge = dispatchReady
    ? { tone: "ready", text: "Ready" }
    : connected
      ? { tone: "scoped", text: "Role-scoped" }
      : { tone: "setup", text: "Set up" };
  return (
    <div className={`connect-card ${step.step}`}>
      <span className="connect-icon" aria-hidden="true">
        <VendorIcon vendor={step.vendor} size={18} />
      </span>
      <div className="connect-info">
        <div className="connect-name">{step.label}</div>
        <div className="connect-status">{step.guidance}</div>
        {step.fixHint ? (
          <div className="connect-fix">
            {/* The exact command the USER runs themselves, never a token. */}
            <code>{step.fixHint}</code>
          </div>
        ) : null}
      </div>
      <span
        className={`connect-badge ${badge.tone}`}
        title={connected ? step.roleScope.summary : undefined}
      >
        {badge.text}
      </span>
    </div>
  );
}
