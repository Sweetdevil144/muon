import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  vendorSupportsEffortControl,
  vendorSupportsModelControl,
} from "@muon/adapters/vendor-capabilities";
import type { VendorReadiness } from "@muon/client";
import { vendorLabel } from "@muon/client/vendors";
import type { OrchestratorVendor } from "../lib/crew-config.js";
import { ORCHESTRATOR_VENDORS } from "../lib/crew-config.js";
import type { VendorModelCatalog } from "../lib/vendor-models.js";
import type {
  ReadinessSnapshotMeta,
  VendorModelResolutionIpc,
} from "../shared/ipc.js";
import {
  compactModelLabel,
  modelDisplay,
  vendorChoiceLabel,
} from "./lib/model-label.js";
import { buildLaneStatus, type LaneStatus } from "./lib/lane-status.js";
import { formatCostOrdinalLabel } from "./lib/cost-ordinal-label.js";
import type { CrewRoleLaneIpc } from "../shared/ipc.js";
import { VendorIcon } from "./vendor-icon.js";

const EFFORT_LABELS: Record<string, string> = {
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

type Panel = "root" | "provider" | "model" | "effort";

/**
 * Codex-style nested menu: Provider → Model → Effort, each gated by the prior
 * choice. One compact trigger in the Mission composer.
 */
export function AgentConfigMenu(props: {
  vendor: OrchestratorVendor;
  /** Persisted Crew default used when this chat has no explicit override. */
  defaultModel?: string | null;
  model: string | null;
  effort: string;
  disabled?: boolean;
  catalog: VendorModelCatalog | null;
  catalogLoading?: boolean;
  /**
   * What the VENDOR says it will run when no model is chosen. Null until asked;
   * the menu names who picks rather than printing the old dead "vendor default"
   * placeholder.
   */
  modelResolution?: VendorModelResolutionIpc | null;
  modelResolving?: boolean;
  onChangeVendor: (vendor: OrchestratorVendor) => void;
  onChangeModel: (model: string | null) => void;
  onChangeEffort: (effort: string) => void;
  onOpen?: () => void;
  /**
   * Ask for the vendor's model resolution WITHOUT the catalogue fetch that
   * `onOpen` also triggers. Fired on hover/focus so the closed trigger shows a
   * real model by the time the operator looks at it, instead of only after they
   * open the menu. Deliberately separate from `onOpen`: the catalogue probe
   * spawns a CLI every call and must not run on hover, while the resolution is
   * cached and single-flighted in main and is safe to ask for early.
   */
  onRequestModelResolution?: () => void;
  /**
   * TODO 3.9 / 3.10 / 3.12 — install/auth projection for the Provider panel.
   * Read only interpreted readiness (never exit codes): cursor/opencode both
   * exit 0 when signed out.
   */
  readiness?: VendorReadiness[] | null;
  readinessMeta?: ReadinessSnapshotMeta;
  /** Refetch probes when the menu opens (Provider panel authenticity). */
  onRefreshReadiness?: () => void;
  /** TODO 3.14 — permanent escape hatch to Crew settings. */
  onConfigureAgents?: () => void;
  /** TODO 3.11 — relative cost ordinal per lane (not dollars). */
  crewLanes?: CrewRoleLaneIpc[] | null;
  crewCostNotice?: string | null;
  onRefreshCrewLanes?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const models = props.catalog?.models ?? [];
  const effectiveModel = props.model ?? props.defaultModel ?? null;
  const selectedModel =
    models.find((entry) => entry.id === effectiveModel) ??
    (effectiveModel
      ? { id: effectiveModel, label: effectiveModel, efforts: [] as string[] }
      : null);
  const efforts =
    selectedModel && selectedModel.efforts.length > 0
      ? selectedModel.efforts
      : ["low", "medium", "high"];
  // TODO 3.5: the control vanishes when the vendor has no channel for it —
  // greying out would still claim a choice MUON cannot honour.
  const showModelControl = vendorSupportsModelControl(props.vendor);
  const showEffortControl = vendorSupportsEffortControl(props.vendor);

  const providerLanes = useMemo(() => {
    const byVendor = new Map(
      (props.readiness ?? []).map((row) => [row.vendor, row] as const)
    );
    const costByVendor = new Map(
      (props.crewLanes ?? []).map(
        (lane) =>
          [
            lane.vendor,
            lane.costOrdinal ?? lane.cost,
          ] as const
      )
    );
    return ORCHESTRATOR_VENDORS.map((vendor) =>
      buildLaneStatus({
        vendor,
        readiness: byVendor.get(vendor),
        meta: props.readinessMeta,
        costOrdinal: costByVendor.get(vendor),
        costNotice: props.crewCostNotice ?? undefined,
      })
    );
  }, [props.readiness, props.readinessMeta, props.crewLanes, props.crewCostNotice]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPanel("root");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setPanel("root");
      }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No chosen model does NOT mean "Auto". It means the vendor picks, and the
  // vendor is asked. One shared resolver so the trigger, the Model row, the
  // Crew page and the worker Overview can never disagree about what is running.
  const display = modelDisplay({
    explicitModel: selectedModel?.label ?? null,
    vendor: props.vendor,
    resolution: props.modelResolution ?? null,
    ...(props.modelResolving ? { resolving: true } : {}),
  });
  // The "let the vendor choose" row describes what happens when NO model is
  // named, so it is built WITHOUT `explicitModel`. Reusing `display` here was a
  // latent bug: with a model selected it advertised the operator's own pick as
  // the vendor's choice.
  const vendorChoice = modelDisplay({
    vendor: props.vendor,
    resolution: props.modelResolution ?? null,
    ...(props.modelResolving ? { resolving: true } : {}),
  });
  const modelLabel = compactModelLabel(display);
  const effortLabel = EFFORT_LABELS[props.effort] ?? props.effort;
  // The screen-reader label already opens with the vendor, so it must not then
  // read `display.text` verbatim — "Claude Code · Claude Code picks · Medium"
  // says the name twice, the same doubling D2 removed from the menu row.
  const triggerLabel = `${vendorLabel(props.vendor)} · ${
    display.resolved ? display.compact : "model chosen by the provider"
  } · ${effortLabel}`;
  const selectedVendorCost = props.crewLanes?.find(
    (lane) => lane.vendor === props.vendor
  );
  const selectedCostOrdinal =
    selectedVendorCost?.costOrdinal ?? selectedVendorCost?.cost;
  const modelCostFootnote =
    selectedCostOrdinal !== undefined
      ? formatCostOrdinalLabel(
          selectedCostOrdinal,
          props.crewCostNotice ?? undefined
        )
      : null;

  return (
    <div className="agent-config-menu" ref={rootRef}>
      <button
        type="button"
        className="agent-config-trigger"
        disabled={props.disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        title={`Agent provider, model, and effort — ${display.title}`}
        onPointerEnter={() => props.onRequestModelResolution?.()}
        onFocus={() => props.onRequestModelResolution?.()}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setPanel("root");
          if (next) {
            props.onOpen?.();
            // TODO 3.9: refetch on open so "Signed out" is never stale evidence.
            props.onRefreshReadiness?.();
            props.onRefreshCrewLanes?.();
          }
        }}
      >
        <VendorIcon size={13} vendor={props.vendor} />
        <span className="agent-config-trigger-text">
          <span className="agent-config-trigger-model">{modelLabel}</span>
          <span className="agent-config-trigger-meta" aria-hidden="true">
            {effortLabel}
          </span>
        </span>
        <span aria-hidden="true" className="agent-config-chevron">
          ▾
        </span>
        <span className="sr-only">{triggerLabel}</span>
      </button>

      {open ? (
        <div
          className="agent-config-popover"
          id={menuId}
          role="dialog"
          aria-label="Agent configuration"
        >
          {panel === "root" ? (
            <ul className="agent-config-list">
              <li>
                <button
                  type="button"
                  className="agent-config-row"
                  onClick={() => setPanel("provider")}
                >
                  <span>Provider</span>
                  <span className="agent-config-value">
                    {vendorLabel(props.vendor)} <span aria-hidden="true">›</span>
                  </span>
                </button>
              </li>
              {showModelControl ? (
                <li>
                  <button
                    type="button"
                    className="agent-config-row"
                    onClick={() => setPanel("model")}
                  >
                    <span>Model</span>
                    <span className="agent-config-value" title={display.title}>
                      {display.text} <span aria-hidden="true">›</span>
                    </span>
                  </button>
                </li>
              ) : null}
              {showEffortControl ? (
                <li>
                  <button
                    type="button"
                    className="agent-config-row"
                    onClick={() => setPanel("effort")}
                  >
                    <span>Effort</span>
                    <span className="agent-config-value">
                      {EFFORT_LABELS[props.effort] ?? props.effort}{" "}
                      <span aria-hidden="true">›</span>
                    </span>
                  </button>
                </li>
              ) : null}
              {props.catalogLoading ? (
                <li className="agent-config-note">Loading models…</li>
              ) : props.catalog?.source === "cli" ? (
                <li className="agent-config-note">Models from Codex CLI</li>
              ) : null}
              {props.onConfigureAgents ? (
                <li>
                  <button
                    type="button"
                    className="agent-config-row"
                    onClick={() => {
                      props.onConfigureAgents?.();
                      setOpen(false);
                      setPanel("root");
                    }}
                  >
                    <span>Configure agents…</span>
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}

          {panel === "provider" ? (
            <div className="agent-config-sub">
              <header>
                <button type="button" onClick={() => setPanel("root")}>
                  ‹
                </button>
                <strong>Provider</strong>
              </header>
              <ul className="agent-config-list">
                {providerLanes.map((lane) => (
                  <ProviderChoice
                    key={lane.vendor}
                    lane={lane}
                    selected={props.vendor === lane.vendor}
                    onSelect={() => {
                      props.onChangeVendor(lane.vendor as OrchestratorVendor);
                      setPanel("root");
                    }}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {panel === "model" && showModelControl ? (
            <div className="agent-config-sub">
              <header>
                <button type="button" onClick={() => setPanel("root")}>
                  ‹
                </button>
                <strong>Model</strong>
              </header>
              <ul className="agent-config-list">
                <li>
                  <button
                    type="button"
                    className="agent-config-choice"
                    onClick={() => {
                      props.onChangeModel(null);
                      setPanel("root");
                    }}
                  >
                    <span title={vendorChoice.title}>
                      {props.defaultModel
                        ? `Crew default · ${props.defaultModel}`
                        : vendorChoiceLabel(props.vendor, vendorChoice)}
                    </span>
                    {!props.model ? <span>✓</span> : null}
                  </button>
                </li>
                {models.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="agent-config-choice"
                      onClick={() => {
                        props.onChangeModel(entry.id);
                        if (
                          entry.defaultEffort &&
                          entry.efforts.includes(entry.defaultEffort)
                        ) {
                          props.onChangeEffort(entry.defaultEffort);
                        } else if (!entry.efforts.includes(props.effort)) {
                          props.onChangeEffort(entry.efforts[0] ?? "medium");
                        }
                        setPanel("root");
                      }}
                    >
                      <span>{entry.label}</span>
                      {props.model === entry.id ? <span>✓</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {modelCostFootnote ? (
                <p className="agent-config-footnote">{modelCostFootnote}</p>
              ) : null}
            </div>
          ) : null}

          {panel === "effort" && showEffortControl ? (
            <div className="agent-config-sub">
              <header>
                <button type="button" onClick={() => setPanel("root")}>
                  ‹
                </button>
                <strong>Effort</strong>
              </header>
              <ul className="agent-config-list">
                {efforts.map((effort) => (
                  <li key={effort}>
                    <button
                      type="button"
                      className="agent-config-choice"
                      onClick={() => {
                        props.onChangeEffort(effort);
                        setPanel("root");
                      }}
                    >
                      <span>{EFFORT_LABELS[effort] ?? effort}</span>
                      {props.effort === effort ? <span>✓</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="agent-config-footnote">
                Higher effort uses limits faster.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * TODO 3.9 / 3.12 — one provider row with readiness as the heading suffix and
 * the ineligible reason as subtext. Ready rows select; blocked rows keep the
 * probe's fixHint as the only CTA (never a silent disable).
 */
function ProviderChoice(props: {
  lane: LaneStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const { lane } = props;
  const selectable =
    lane.state === "ready" ||
    lane.state === "ready-byok" ||
    // Allow keeping / re-selecting the current seat while setup is unfinished
    // so the menu never traps the operator on an invisible selection.
    props.selected ||
    // Unknown / unchecked: do not invent a block — the probe has not spoken.
    lane.state === "checking" ||
    lane.state === "unchecked";
  const heading = `${lane.label} · ${lane.chip}`;
  return (
    <li>
      <button
        type="button"
        className={
          selectable
            ? "agent-config-choice agent-config-choice-provider"
            : "agent-config-choice agent-config-choice-provider is-blocked"
        }
        disabled={!selectable}
        title={lane.detail}
        onClick={() => {
          if (selectable) props.onSelect();
        }}
      >
        <span className="agent-config-choice-stack">
          <span className="agent-config-choice-heading">{heading}</span>
          {lane.needsAttention || lane.action ? (
            <span className="agent-config-choice-sub">
              {lane.action ?? lane.detail}
            </span>
          ) : lane.costLabel ? (
            <span className="agent-config-choice-sub">{lane.costLabel}</span>
          ) : null}
        </span>
        {props.selected ? <span>✓</span> : null}
      </button>
    </li>
  );
}
