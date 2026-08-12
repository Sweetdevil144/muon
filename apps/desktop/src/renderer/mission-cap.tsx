import { useCallback, useEffect, useRef, useState } from "react";
import { parseCostCapInput } from "@muon/client/cost-cap";
import type { MissionCapState } from "../shared/ipc.js";

/**
 * The BRAKE, on the desk (surface-parity audit item 4).
 *
 * The desk already showed what a crew had spent (`mission-usage.tsx`) but had
 * no way to put a limit on it — the cap was storage plus a CLI verb, so the
 * one surface a human watches a mission burn from was the one surface that
 * could not stop it.
 *
 * THREE RULES INHERITED, not restated:
 *  1. NEVER A BARE NUMBER (ADR-0036 D1). The figure and the coverage that
 *     qualifies it travel together, so this renders the backend's `summary`
 *     sentence rather than formatting `observedUsd` itself. In a mixed crew
 *     partial coverage is the NORMAL case — only some vendors report dollars —
 *     and a total presented as *the* cost invites the confident wrong decision
 *     the cap exists to prevent.
 *  2. WHAT COUNTS AS A CAP is `parseCostCapInput`, shared with `muon cost`, so
 *     a `0` typed here means what a `0` typed there means: refused.
 *  3. A CAP REFUSES NEW WORK ONLY. It never interrupts a running lane, and the
 *     copy says so at the moment it matters — capping BELOW today's spend.
 */
export function MissionCapControl(props: {
  /** Bound chat. Null renders nothing: a cap belongs to a mission. */
  chatId: string | null;
  /** Injected so tests drive it without a window bridge. */
  load?: () => Promise<MissionCapState>;
  save?: (capUsd: number | null) => Promise<MissionCapState>;
}) {
  const [view, setView] = useState<MissionCapState | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // The chat an answer must still be about: switching missions mid-read used
  // to be the way one mission's cap got shown under another's name.
  const wantedRef = useRef<string | null>(null);

  const load = props.load;
  const save = props.save;
  const supported =
    (typeof load === "function" || typeof window.muon?.missionCost === "function") &&
    (typeof save === "function" ||
      typeof window.muon?.setMissionCostCap === "function");

  const read = useCallback(
    (chatId: string) => {
      const bridge = load ?? window.muon?.missionCost?.bind(window.muon);
      if (typeof bridge !== "function") return;
      wantedRef.current = chatId;
      setUnavailable(false);
      bridge()
        .then((result) => {
          if (wantedRef.current !== chatId) return;
          // The reading names the mission it is about. Main's bound chat can
          // lag this renderer's selection by one async hop, and a cap shown
          // under the wrong mission's name is worse than no cap shown at all.
          if (result.chatId !== chatId) {
            setUnavailable(true);
            setView(null);
            return;
          }
          setView(result);
        })
        .catch(() => {
          if (wantedRef.current !== chatId) return;
          // An unreadable cap is NOT "no cap" — the difference decides whether
          // a human thinks this mission is braked.
          setUnavailable(true);
          setView(null);
        });
    },
    [load]
  );

  useEffect(() => {
    if (!props.chatId) {
      setView(null);
      wantedRef.current = null;
      return;
    }
    setDraft("");
    setError(null);
    read(props.chatId);
  }, [props.chatId, read]);

  if (!props.chatId || !supported) return null;

  const commit = (raw: string) => {
    const parsed = parseCostCapInput(raw);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const bridge = save ?? window.muon?.setMissionCostCap?.bind(window.muon);
    if (typeof bridge !== "function") return;
    const chatId = props.chatId;
    setSaving(true);
    setError(null);
    Promise.resolve(bridge(parsed.capUsd))
      .then((result) => {
        if (wantedRef.current !== chatId) return;
        if (result.chatId !== chatId) {
          // The write LANDED — on the mission main had bound. Say so; do not
          // paint its result onto the mission now on screen.
          setError(
            "The cap was saved on the mission that was selected when you clicked, not the one shown now. Re-open this mission to see its cap."
          );
          return;
        }
        setView(result);
        setDraft("");
      })
      .catch((cause) => {
        if (wantedRef.current !== chatId) return;
        setError(
          cause instanceof Error ? cause.message : "Could not set the cap."
        );
      })
      .finally(() => {
        // UNCONDITIONAL. Guarding this on "is this still the chat I want"
        // meant that switching missions mid-save left `saving` true forever —
        // the control is not keyed by chat and stays mounted, so the input and
        // both buttons were disabled for the rest of the session. The guards
        // above exist to stop a STALE ANSWER being painted; they must never
        // stop the control being usable again.
        setSaving(false);
      });
  };

  return (
    <section className="mission-cap" aria-label="Mission cost cap">
      <div className="mission-cap-head">
        <strong>Cost cap</strong>
        <span className="mission-cap-state">
          {unavailable
            ? "unreadable"
            : view?.capUsd != null
              ? `$${view.capUsd.toFixed(2)}`
              : "none"}
        </span>
      </div>
      {unavailable ? (
        <p className="mission-cap-error">
          This mission's cap could not be read — showing "no cap" here would be
          a guess. Check the brain connection, or use `muon cost`.
        </p>
      ) : (
        // The ONE rendering (D1): the backend's sentence, never a figure this
        // component formatted out of a raw total.
        <p className="mission-cap-summary">{view?.summary ?? "Reading…"}</p>
      )}
      {view?.refusesDispatch ? (
        <p className="mission-cap-warn">
          This mission has met its cap, so the NEXT dispatch into it is
          refused. Work already running was not stopped.
        </p>
      ) : null}
      <div className="mission-cap-controls">
        <input
          className="mission-cap-input"
          type="text"
          inputMode="decimal"
          aria-label="Cap in dollars"
          placeholder="25"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft);
          }}
        />
        <button
          className="mission-cap-set"
          disabled={saving || draft.trim().length === 0}
          onClick={() => commit(draft)}
        >
          {saving ? "Saving…" : "Set cap"}
        </button>
        <button
          className="mission-cap-clear"
          disabled={saving || (view?.capUsd == null && !unavailable)}
          onClick={() => commit("none")}
        >
          Clear
        </button>
      </div>
      {error ? <p className="mission-cap-error">{error}</p> : null}
      <p className="mission-cap-note">
        A cap refuses NEW dispatch into this mission; it never interrupts a
        lane that is already running. Spend is vendor-reported, so a cap can
        only brake what the crew actually reports.
      </p>
    </section>
  );
}
