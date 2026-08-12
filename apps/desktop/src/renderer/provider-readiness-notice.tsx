import type {
  OrchestratorReadinessIssue,
} from "../lib/orchestrator-readiness.js";
import { vendorLabel } from "@muon/client/vendors";
import type { OrchestratorVendor } from "../lib/crew-config.js";

export function ProviderReadinessNotice(props: {
  issue: OrchestratorReadinessIssue;
  refreshing?: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
  fallbackVendor?: OrchestratorVendor | null;
  onUseFallback?: (vendor: OrchestratorVendor) => void;
}) {
  return (
    <div
      className={`provider-readiness-notice${
        props.issue.blocking ? " blocking" : " unverified"
      }`}
      role={props.issue.blocking ? "alert" : "status"}
    >
      <div className="provider-readiness-copy">
        <strong>
          {props.issue.blocking
            ? `${props.issue.label} needs setup`
            : `${props.issue.label} readiness is unverified`}
        </strong>
        <span>{props.issue.detail}</span>
        <small>{props.issue.fixHint}</small>
        {props.refreshError ? (
          <small className="provider-readiness-error">
            {props.refreshError}
          </small>
        ) : null}
      </div>
      <div className="provider-readiness-actions">
        {props.onRefresh ? (
          <button
            type="button"
            className="secondary-btn"
            disabled={props.refreshing}
            onClick={props.onRefresh}
          >
            {props.refreshing ? "Checking…" : "Re-check"}
          </button>
        ) : null}
        {props.fallbackVendor && props.onUseFallback ? (
          <button
            type="button"
            className="primary-btn"
            onClick={() => props.onUseFallback?.(props.fallbackVendor!)}
          >
            Use {vendorLabel(props.fallbackVendor)} instead
          </button>
        ) : null}
      </div>
    </div>
  );
}
