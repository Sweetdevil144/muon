import { useMemo } from "react";
import type { JSX } from "react";
import type { DispatchJobRecord } from "@muon/client";
import { VendorIcon } from "./vendor-icon.js";
import {
  buildCrewTopology,
  edgePath,
  layoutCrewTopology,
  roleLabel,
  selectMissionRootId,
  vendorLabel,
  type CrewTopology as CrewTopologyModel,
  type TopologyNode,
} from "./lib/crew-topology-model.js";
import { useCrewTopologyData } from "./lib/crew-topology-state.js";
import type { AgentRoleIpc, PeerMessageIpc } from "../shared/ipc.js";

/**
 * CREW TOPOLOGY — the live org chart of one mission.
 *
 * MUON sits at the center; every vendor lane hangs off it; each lane's own
 * subagents hang off the lane by real `parentJobId`/`rootJobId` lineage; peer
 * edges appear only where agents actually messaged each other. It is a CENTER
 * workspace tab (`panel:topology`), never an overlay.
 *
 * DEGRADATION IS THE DESIGN. The diagram is built from the desktop's OWN
 * dispatch-job state, which always exists. The two newer brain reads (role plan
 * + A2A coordination) only ADD to it — role badges, claim conflicts, peer
 * edges. When they are absent the chart still renders in full and says so in
 * one quiet line. There is no state in which this tab is blank or throws.
 */

const KIND_LABEL: Record<PeerMessageIpc["kind"], string> = {
  question: "Question",
  answer: "Answer",
  review_request: "Review request",
  review_verdict: "Review verdict",
  constraint: "Constraint",
  status: "Status",
  blocked: "Blocked",
};

function RoleBadge(props: {
  role: AgentRoleIpc | null;
  source: TopologyNode["roleSource"];
  /**
   * The plan this role came from is a PREVIEW, not a decision. Only meaningful
   * with `source: "plan"` — a coordination-reported or authority-implied role
   * describes a dispatch that already happened.
   */
  proposed?: boolean;
}): JSX.Element | null {
  if (!props.role) {
    return <span className="topo-role topo-role-unset">no role</span>;
  }
  const proposed = props.proposed === true && props.source === "plan";
  return (
    <span
      className={`topo-role role-${props.role}${proposed ? " proposed" : ""}`}
      title={
        props.source === "plan"
          ? proposed
            ? "Proposed — MUON will assign this role when work is dispatched. Nothing is bound yet."
            : "Role assigned by the crew role plan"
          : props.source === "coordination"
            ? "Role reported by the live coordination snapshot"
            : "Role implied by this dispatch's authority"
      }
    >
      {roleLabel(props.role)}
      {proposed ? <span className="topo-role-proposed-mark"> ·&nbsp;proposed</span> : null}
    </span>
  );
}

function expiresIn(iso: string, now: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s left`;
  return `${Math.ceil(ms / 60_000)}m left`;
}

function NodeCard(props: {
  node: TopologyNode;
  left: number;
  top: number;
  /** The chat's role plan is a preview — see RoleBadge. */
  planProposed: boolean;
  onOpenJob: (jobId: string) => void;
}): JSX.Element {
  const node = props.node;
  const roleProposed = props.planProposed && node.roleSource === "plan";
  const conflicted = node.conflictPaths.length > 0;
  const className = [
    "topo-node",
    `topo-node-${node.kind}`,
    node.attention ? "attention" : "",
    conflicted ? "conflicted" : "",
    node.jobId ? "" : "idle",
  ]
    .filter(Boolean)
    .join(" ");
  const style = { left: `${props.left}px`, top: `${props.top}px` };
  // ONE source for the state line, so the accessible name says exactly what the
  // pixels say. The MODEL owns that sentence now: a seat that was never
  // dispatched has no liveness to report (it is not "Queued", nothing is
  // queued), and the hub reports the mission rather than only its own job.
  const stateText = node.stateText;
  const laneHealthText =
    !node.jobId && node.laneHealth && node.laneHealth !== "healthy"
      ? ` · ${node.laneHealth}`
      : "";
  const summary =
    `${node.label} · ${vendorLabel(node.vendor)}` +
    // The accessible name has to make the same distinction the badge does: a
    // proposed role is not a seat anyone holds.
    (node.role
      ? ` · ${roleLabel(node.role)}${roleProposed ? " (proposed)" : ""}`
      : "") +
    ` · ${stateText}${laneHealthText}` +
    (conflicted ? ` · file conflict on ${node.conflictPaths.join(", ")}` : "");

  const body = (
    <>
      <span className="topo-node-head">
        <span className={`activity-dot ${node.liveness}`} aria-hidden="true" />
        <VendorIcon vendor={node.vendor} />
        <strong className="topo-node-name">{node.label}</strong>
      </span>
      <span className="topo-node-meta">
        <span className="topo-node-vendor">{vendorLabel(node.vendor)}</span>
        <RoleBadge
          proposed={roleProposed}
          role={node.role}
          source={node.roleSource}
        />
      </span>
      <span className="topo-node-state">
        {stateText}
        {laneHealthText}
        {node.unreadMessages ? ` · ${node.unreadMessages} unread` : ""}
        {node.claimedPaths ? ` · ${node.claimedPaths} claimed` : ""}
      </span>
      {conflicted ? (
        <span className="topo-node-conflict">
          ⚠ contested: {node.conflictPaths[0]}
          {node.conflictPaths.length > 1
            ? ` +${node.conflictPaths.length - 1}`
            : ""}
        </span>
      ) : null}
    </>
  );

  if (!node.jobId) {
    // Seated but never dispatched. Deliberately NOT a button: a click here
    // would be a dead end, and the app's standing rule is no fake liveness.
    // It still needs a ROLE, though — `aria-label` on a bare <div> names
    // nothing, so assistive tech would drop the label entirely and read the
    // fragments instead. `img` is the right one for a diagram node: it exposes
    // the summary as the node's single accessible name.
    return (
      <div
        aria-label={summary}
        className={className}
        role="img"
        style={style}
        title={summary}
      >
        {body}
      </div>
    );
  }
  return (
    <button
      aria-label={`${summary} — open this agent's workspace tab`}
      className={className}
      onClick={() => props.onOpenJob(node.jobId!)}
      style={style}
      title={node.brief ?? summary}
      type="button"
    >
      {body}
    </button>
  );
}

function TopologyStage(props: {
  topology: CrewTopologyModel;
  onOpenJob: (jobId: string) => void;
}): JSX.Element {
  const layout = useMemo(
    () => layoutCrewTopology(props.topology),
    [props.topology]
  );
  const positions = layout.positions;
  const edges = props.topology.edges.filter(
    (edge) => positions.has(edge.from) && positions.has(edge.to)
  );
  return (
    <div
      className="topology-stage"
      style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
    >
      <svg
        aria-hidden="true"
        className="topology-edges"
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {edges.map((edge) => {
          const from = positions.get(edge.from)!;
          const to = positions.get(edge.to)!;
          const bow = edge.kind === "a2a" ? 0.24 : 0.1;
          return (
            <g className={`topo-edge topo-edge-${edge.kind}`} key={edge.id}>
              <path d={edgePath(from, to, bow)} />
              {edge.kind === "a2a" && edge.count ? (
                <text
                  className="topo-edge-count"
                  x={(from.x + to.x) / 2 - (to.y - from.y) * 0.24}
                  y={(from.y + to.y) / 2 + (to.x - from.x) * 0.24}
                >
                  {edge.count}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {props.topology.nodes.map((node) => {
        const point = positions.get(node.id);
        if (!point) return null;
        return (
          <NodeCard
            key={node.id}
            left={point.x}
            node={node}
            onOpenJob={props.onOpenJob}
            planProposed={props.topology.rolePlanStatus === "proposed"}
            top={point.y}
          />
        );
      })}
    </div>
  );
}

function TopologyRail(props: {
  topology: CrewTopologyModel;
  loading: boolean;
  now: number;
}): JSX.Element {
  const topology = props.topology;
  const proposedPlan = topology.rolePlanStatus === "proposed";
  return (
    <aside className="topology-rail" aria-label="Crew roles and coordination">
      <section className="topology-rail-section">
        <h3>Legend</h3>
        <ul className="topology-legend">
          <li>
            <span className="topo-legend-line dispatch" aria-hidden="true" />
            MUON → lane · dispatch
          </li>
          <li>
            <span className="topo-legend-line delegation" aria-hidden="true" />
            lane → subagent · delegation
          </li>
          <li>
            <span className="topo-legend-line seat" aria-hidden="true" />
            MUON → seat · no dispatch yet
          </li>
          <li>
            <span className="topo-legend-line a2a" aria-hidden="true" />
            peer ↔ peer · A2A coordination
          </li>
          <li>
            <span className="topo-legend-swatch conflict" aria-hidden="true" />
            contested file claim
          </li>
        </ul>
      </section>

      <section className="topology-rail-section">
        {/* THE HEADING IS THE CLAIM. The rows underneath are byte-identical for
            a stored crew and a preview, so the distinction lives where it
            cannot be scrolled past — in the section title, in a badge next to
            it, and in one sentence above the first row. */}
        <h3>
          {proposedPlan ? "Proposed roles" : "Role assignments"}
          {proposedPlan ? (
            <span className="topology-rail-tag proposed">proposed</span>
          ) : null}
          {topology.roleBindings.length > 0 ? (
            <span className="topology-rail-count">
              {topology.roleBindings.length}
            </span>
          ) : null}
        </h3>
        {props.loading && topology.roleBindings.length === 0 ? (
          <p className="topology-note loading-line">Reading role assignments…</p>
        ) : topology.roleBindings.length === 0 ? (
          <p className="topology-note">
            No role plan for this mission yet. Lanes below show the authority
            MUON already granted each dispatch.
          </p>
        ) : (
          <>
            {proposedPlan ? (
              <p className="topology-note proposed">
                Proposed — MUON will assign these when work is dispatched.
                Nothing is bound yet; assignment is deterministic, so this is
                the crew you will get from the lanes available now.
              </p>
            ) : null}
          <ul className="topology-roles">
            {/* Keys carry the row INDEX because nothing upstream promises
                uniqueness: the loader does not dedupe, and the desktop must not
                depend on a backend unique index. Two identical bindings must
                render as two rows, not silently collapse into one. */}
            {topology.roleBindings.map((binding, index) => (
              <li
                className={binding.blocked ? "blocked" : undefined}
                key={`${index}:${binding.role}:${binding.vendor}`}
              >
                <div className="topology-role-head">
                  <RoleBadge
                    proposed={proposedPlan}
                    role={binding.role}
                    source="plan"
                  />
                  <VendorIcon vendor={binding.vendor} />
                  <span className="topology-role-vendor">
                    {vendorLabel(binding.vendor)}
                  </span>
                  <span className="topology-role-fit" title="Assignment fit">
                    fit {Math.round(binding.fit * 100)}%
                  </span>
                </div>
                <p className="topology-role-reason">{binding.reason}</p>
                {/* PROVENANCE, per row. "assigned by MUON" on a preview would
                    be the exact false claim this feature exists to avoid. */}
                <small className="topology-role-by">
                  {proposedPlan
                    ? "would be assigned by MUON"
                    : `assigned by ${binding.assignedBy === "human" ? "you" : "MUON"}`}
                </small>
                {binding.blocked ? (
                  <p className="topology-role-blocked" role="alert">
                    Blocked: {binding.blockedReason ?? "this lane cannot hold that role."}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          </>
        )}
        {topology.unfilledRoles.length > 0 ? (
          <p className="topology-note warn">
            Unfilled: {topology.unfilledRoles.map(roleLabel).join(", ")} — no
            available lane can hold {topology.unfilledRoles.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
      </section>

      <section className="topology-rail-section">
        <h3>
          File-claim conflicts
          {topology.conflicts.length > 0 ? (
            <span className="topology-rail-count danger">
              {topology.conflicts.length}
            </span>
          ) : null}
        </h3>
        {topology.conflicts.length === 0 ? (
          <p className="topology-note">
            No two agents are claiming the same file for edit.
          </p>
        ) : (
          <ul className="topology-conflicts">
            {topology.conflicts.map((conflict) => (
              <li key={conflict.path}>
                <code className="topology-conflict-path">{conflict.path}</code>
                {conflict.holders.map((holder, index) => (
                  <span
                    className="topology-conflict-holder"
                    key={`${index}:${holder.heldByJobId}`}
                  >
                    held by {holder.heldByName ?? holder.heldByJobId} ·{" "}
                    {vendorLabel(holder.heldByVendor)} · {roleLabel(holder.heldByRole)}
                    {expiresIn(holder.expiresAt, props.now)
                      ? ` · ${expiresIn(holder.expiresAt, props.now)}`
                      : ""}
                  </span>
                ))}
                <small className="topology-note">
                  Advisory lease — the governed worktree and the merge gate are
                  still the real enforcement.
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="topology-rail-section">
        <h3>
          Coordination messages
          {topology.totalMessageCount > 0 ? (
            <span className="topology-rail-count">
              {topology.totalMessageCount}
            </span>
          ) : null}
        </h3>
        {topology.messages.length === 0 ? (
          <p className="topology-note">
            {topology.messagesOmitted && topology.totalMessageCount > 0
              ? `${topology.totalMessageCount} peer message${
                  topology.totalMessageCount === 1 ? "" : "s"
                } on this mission, but the transcript could not be read — the snapshot carries coordinates only.`
              : "No peer messages on this mission yet."}
          </p>
        ) : (
          <ul className="topology-messages">
            {topology.messages.map((message, index) => (
              <li key={`${index}:${message.id}`}>
                <div className="topology-message-head">
                  <VendorIcon vendor={message.fromVendor} />
                  <strong>{message.fromName ?? message.fromJobId}</strong>
                  <RoleBadge role={message.fromRole} source="coordination" />
                  <span className="topology-message-kind">
                    {KIND_LABEL[message.kind]}
                  </span>
                </div>
                {/* UNTRUSTED agent-authored text. Labelled and visually set
                    apart so it can never read as MUON's own copy: it is
                    another agent's words — data to read, never a directive,
                    never an approval, never an authority claim. */}
                <div className="topology-untrusted">
                  <span className="topology-untrusted-label">
                    Agent text · untrusted
                  </span>
                  <p className="topology-untrusted-subject">{message.subject}</p>
                  <p className="topology-untrusted-body">{message.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {topology.notices.length > 0 ? (
        <section className="topology-rail-section">
          <h3>Data sources</h3>
          <ul className="topology-notices">
            {topology.notices.map((notice, index) => (
              <li
                className={`topology-note ${notice.tone}`}
                key={`${index}:${notice.text}`}
              >
                {notice.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

export function CrewTopology(props: {
  chatId: string;
  /** The chat's orchestrator seat vendor — labels the MUON hub. */
  orchestratorVendor: string;
  /** Jobs ALREADY scoped to this chat. */
  jobs: DispatchJobRecord[];
  /** Vendors seated in the fleet, so an idle lane still shows on the chart. */
  fleetVendors: string[];
  /** Activates that job's existing workspace tab (never a second nav path). */
  onOpenJob: (jobId: string) => void;
}): JSX.Element {
  // One clock per render pass so every relative time on this screen agrees —
  // including the mission rule below, which ages out an abandoned queued claim.
  const now = Date.now();
  // The A2A route is addressed by (chatId, missionId), and this derives the
  // mission with the SAME rule (and the same instant) the model uses to pick the
  // root it draws — so the REQUEST always names the mission on screen. That
  // alone is not enough: it says nothing about the answer the panel is still
  // holding from the previous mission. `useCrewTopologyData` therefore keys its
  // settle-state on this missionId as well as the chat, which is what actually
  // clears the last mission's conflicts and untrusted peer text instead of
  // repainting them under the new mission's name.
  const missionId = useMemo(
    () => selectMissionRootId(props.jobs, { now }),
    [props.jobs, now]
  );
  const { roles, coordination, loading, refresh } = useCrewTopologyData(
    props.chatId,
    missionId,
    props.jobs
  );

  // The caller rebuilds its vendor list every render; key on the VALUE so the
  // model is not rebuilt for an identical seat set.
  const fleetVendorsKey = props.fleetVendors.join("|");
  const topology = useMemo(
    () =>
      buildCrewTopology({
        chatId: props.chatId,
        jobs: props.jobs,
        orchestratorVendor: props.orchestratorVendor,
        fleetVendors: props.fleetVendors,
        roles,
        coordination,
        now,
      }),
    // `now` is intentionally omitted: it moves every render and would rebuild
    // the whole model on each tick. Liveness is recomputed whenever the jobs
    // poll changes, which is the same cadence the crew tree already uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      props.chatId,
      props.jobs,
      props.orchestratorVendor,
      fleetVendorsKey,
      roles,
      coordination,
    ]
  );

  const subagentCount = topology.lanes.reduce(
    (total, lane) => total + lane.children.length,
    0
  );
  const rolesOut = roles?.status === "unavailable";
  const coordinationOut = coordination?.status === "unavailable";
  // Name what is actually missing — a banner that says "coordination" while the
  // ROLE plan is the thing that failed would send the operator hunting in the
  // wrong place.
  const degradedLabel =
    rolesOut && coordinationOut
      ? "Roles and coordination unavailable"
      : rolesOut
        ? "Role plan unavailable"
        : coordinationOut
          ? "Coordination unavailable"
          : null;

  return (
    <div className="topology-workspace" role="region" aria-label="Crew topology">
      <div className="topology-masthead">
        <div className="topology-title">
          <span className="topology-title-mark" aria-hidden="true">
            ◆
          </span>
          <strong>Crew topology</strong>
          <span className="topology-count">
            {topology.lanes.length} lane{topology.lanes.length === 1 ? "" : "s"}
            {subagentCount > 0
              ? ` · ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`
              : ""}
            {topology.conflicts.length > 0
              ? ` · ${topology.conflicts.length} contested file${
                  topology.conflicts.length === 1 ? "" : "s"
                }`
              : ""}
          </span>
        </div>
        <div className="topology-actions">
          {loading ? (
            <span
              className="topology-live loading-line"
              // A LIVE REGION only for the first read, when there is nothing on
              // screen yet. A live mission re-reads on a 5s bucket (that is what
              // makes peer edges light up), and announcing "Refreshing…" to a
              // screen reader every five seconds would be noise about
              // housekeeping — the chart underneath never goes away while it
              // happens. The text still shows, it just stops interrupting.
              role={roles === null && coordination === null ? "status" : undefined}
            >
              Refreshing…
            </span>
          ) : null}
          <button
            className="graph-btn"
            onClick={refresh}
            title="Re-read roles and coordination now"
            type="button"
          >
            Refresh
          </button>
        </div>
      </div>

      {degradedLabel ? (
        // Quiet, never alarming: the chart above is fully usable without these
        // reads, so this says what is missing, and NAMES the way out. The panel
        // makes one bounded auto-retry after a transient failure; after that
        // the only thing that moves is Refresh, so the copy points at it rather
        // than leaving the operator to hunt for the control.
        <p className="topology-degraded" role="status">
          {degradedLabel} — showing this mission from local dispatch state only.
          Use Refresh above to read them again.
        </p>
      ) : null}

      <div className="topology-body">
        <div className="topology-stage-scroll">
          {topology.lanes.length === 0 ? (
            <div className="topology-empty">
              <TopologyStage topology={topology} onOpenJob={props.onOpenJob} />
              <p className="topology-note">
                No lanes on this mission yet. MUON dispatches work to a vendor
                lane, and each lane's own subagents appear beneath it here as
                soon as they launch.
              </p>
            </div>
          ) : (
            <TopologyStage topology={topology} onOpenJob={props.onOpenJob} />
          )}
        </div>
        <TopologyRail topology={topology} loading={loading} now={now} />
      </div>
    </div>
  );
}
