"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import { frameAt } from "./frame";
import { BEATS, RESUME_T, RUN_END } from "./script";
import type { Decision, Frame, MemoryDecision } from "./types";
import { useReducedMotion } from "./use-reduced-motion";

type State = {
  t: number;
  playing: boolean;
  decision: Decision | null;
  attested: boolean;
  acked: boolean;
  gateLog: Decision[];
  wrapFiled: boolean;
  memory: Record<string, MemoryDecision>;
  selected: string | null;
  started: boolean;
};

const INITIAL: State = {
  t: 0,
  playing: false,
  decision: null,
  attested: false,
  acked: false,
  gateLog: [],
  wrapFiled: false,
  memory: {},
  selected: null,
  started: false,
};

type Action =
  | { type: "tick"; dt: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "step"; dir: 1 | -1 }
  | { type: "scrub"; t: number }
  | { type: "replay" }
  | { type: "reduced" }
  | { type: "attest" }
  | { type: "ack" }
  | { type: "decide"; decision: Decision }
  | { type: "wrap" }
  | { type: "continue" }
  | { type: "memory"; id: string; decision: MemoryDecision }
  | { type: "select"; id: string | null };

function halted(s: State) {
  return s.t >= RUN_END && s.decision === null;
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "tick": {
      if (!s.playing || halted(s)) return s;
      const t = Math.min(RUN_END, s.t + a.dt);
      return { ...s, t, playing: t >= RUN_END ? false : s.playing };
    }
    case "play":
      return halted(s) ? s : { ...s, playing: true, started: true };
    case "pause":
      return { ...s, playing: false };
    case "toggle":
      return halted(s) ? s : { ...s, playing: !s.playing, started: true };
    case "step": {
      const times = BEATS.map((b) => b.t);
      const next =
        a.dir === 1
          ? (times.find((x) => x > s.t) ?? RUN_END)
          : ([...times].reverse().find((x) => x < s.t) ?? 0);
      return { ...s, t: next, playing: false, started: true };
    }
    case "scrub":
      return { ...s, t: Math.max(0, Math.min(RUN_END, a.t)), playing: false, started: true };
    case "replay":
      return { ...INITIAL, started: true, playing: true };
    case "reduced":
      return { ...INITIAL, t: RUN_END, attested: true, acked: true, started: true, playing: false };
    case "attest":
      return { ...s, attested: true };
    case "ack":
      return { ...s, acked: true };
    case "decide":
      return {
        ...s,
        decision: a.decision,
        playing: false,
        gateLog: [...s.gateLog, a.decision],
      };
    case "wrap":
      return { ...s, wrapFiled: true };
    case "continue":
      return { ...s, t: RESUME_T, decision: null, attested: false, acked: false, playing: true };
    case "memory":
      return { ...s, memory: { ...s.memory, [a.id]: a.decision } };
    case "select":
      return { ...s, selected: a.id };
    default:
      return s;
  }
}

type Ctx = {
  state: State;
  frame: Frame;
  reduced: boolean;
  dispatch: (a: Action) => void;
  sectionRef: (el: HTMLElement | null) => void;
};

const DemoRunContext = createContext<Ctx | null>(null);

export function DemoRunProvider({
  children,
  autoplay = false,
}: {
  children: ReactNode;
  autoplay?: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const reduced = useReducedMotion();
  const elRef = useRef<HTMLElement | null>(null);
  const visibleRef = useRef(false);
  const autoplayedRef = useRef(false);

  useEffect(() => {
    if (reduced) dispatch({ type: "reduced" });
  }, [reduced]);

  const sectionRef = useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el;
      if (!el) return;
      const io = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          visibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting && autoplay && !reduced && !autoplayedRef.current) {
            autoplayedRef.current = true;
            dispatch({ type: "play" });
          }
        },
        { threshold: 0.25 },
      );
      io.observe(el);
      return () => io.disconnect();
    },
    [autoplay, reduced],
  );

  useEffect(() => {
    if (reduced || !state.playing) return;
    const step = 100;
    const id = window.setInterval(() => {
      if (!visibleRef.current && elRef.current) return;
      dispatch({ type: "tick", dt: step });
    }, step);
    return () => window.clearInterval(id);
  }, [state.playing, reduced]);

  // Wrap proposals are filed shortly after an approval.
  useEffect(() => {
    if (state.decision !== "approved" || state.wrapFiled) return;
    const id = window.setTimeout(() => dispatch({ type: "wrap" }), 1200);
    return () => window.clearTimeout(id);
  }, [state.decision, state.wrapFiled]);

  const frame = useMemo(() => frameAt(state.t, state.decision), [state.t, state.decision]);

  const value = useMemo<Ctx>(
    () => ({ state, frame, reduced, dispatch, sectionRef }),
    [state, frame, reduced, sectionRef],
  );

  return <DemoRunContext.Provider value={value}>{children}</DemoRunContext.Provider>;
}

export function useDemoRun() {
  const ctx = useContext(DemoRunContext);
  if (!ctx) throw new Error("useDemoRun must be used inside DemoRunProvider");
  return ctx;
}
