export function PresenceStage() {
  return (
    <div
      aria-label="MUON at the center of a coding crew using Claude Code, Codex, Cursor, and OpenCode, with human approval"
      className="presence-stage"
      role="img"
    >
      <div className="presence-topbar">
        <span className="presence-brand">
          <span aria-hidden="true" className="presence-live-dot" />
          MUON / MISSION CONTROL
        </span>
        <span>MISSION 018 / ACTIVE</span>
      </div>

      <div className="presence-orchestration">
        <div className="presence-provider presence-provider-ollama">
          <div className="presence-provider-heading">
            <span className="presence-provider-mark presence-provider-mark-yellow" />
            <strong>OLLAMA</strong>
          </div>
          <span className="presence-provider-role">Optional local recall</span>
          <span className="presence-provider-note">Not a coding worker</span>
        </div>

        <div className="presence-provider presence-provider-claude">
          <div className="presence-provider-heading">
            <span className="presence-provider-mark presence-provider-mark-red" />
            <strong>CLAUDE CODE</strong>
          </div>
          <span className="presence-provider-role">Implementation / review</span>
          <div className="presence-children">
            <span>CHILD 01</span>
            <span>CHILD 02</span>
          </div>
        </div>

        <div className="presence-core">
          <span className="presence-core-kicker">CENTRAL ORCHESTRATION</span>
          <img alt="" height={48} src="/muon-mark-inverse.svg" width={48} />
          <strong>MUON</strong>
          <p>Plans · assigns · coordinates · governs</p>
          <div className="presence-core-memory">
            <span aria-hidden="true" className="presence-memory-node" />
            UNIFIED CREW MEMORY
            <span aria-hidden="true" className="presence-memory-node" />
          </div>
        </div>

        <div className="presence-provider presence-provider-cursor">
          <div className="presence-provider-heading">
            <span className="presence-provider-mark presence-provider-mark-blue" />
            <strong>CURSOR</strong>
          </div>
          <span className="presence-provider-role">Managed read-only</span>
          <span className="presence-provider-note">Scout / review lane</span>
        </div>

        <div className="presence-provider presence-provider-codex">
          <div className="presence-provider-heading">
            <span className="presence-provider-mark presence-provider-mark-blue" />
            <strong>CODEX</strong>
          </div>
          <span className="presence-provider-role">Implementation / review</span>
          <div className="presence-children">
            <span>CHILD 03</span>
            <span>CHILD 04</span>
          </div>
        </div>
      </div>

      <div className="presence-gate">
        <span>HUMAN AUTHORITY</span>
        <strong>Approve fan-out · merge · ship</strong>
        <span className="presence-digest">One mission record</span>
      </div>
    </div>
  );
}
