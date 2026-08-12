// Quiet UI — resizable workspace panels (Task 3). The sidebar and the
// context-dock are both draggable: this module owns the pure width math
// (clamp + localStorage persistence) so it is testable without mounting any
// component, plus a thin React hook the frame/panels consume. Purely a
// renderer-local ergonomic — it never touches governed state or IPC.

import { useCallback, useState } from "react";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 248;

export const DOCK_MIN_WIDTH = 260;
export const DOCK_MAX_WIDTH = 520;
export const DOCK_DEFAULT_WIDTH = 320;

const STORAGE_PREFIX = "muon:panel-width:";

/** Clamp a candidate width into [min, max]. Non-finite input falls back to min. */
export function clampPanelWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a persisted panel width. Falls back to `fallback` (already clamped by
 * the caller's own default) whenever storage is unavailable, empty, or holds
 * a corrupt value — this can never throw or return a value outside [min, max].
 */
export function loadPanelWidth(
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof window === "undefined" || !window.localStorage) {
    return clampPanelWidth(fallback, min, max);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) {
      return clampPanelWidth(fallback, min, max);
    }
    const parsed = Number(raw);
    // A corrupt/non-numeric stored value degrades to the caller's fallback,
    // not to `min` — `min` would silently masquerade as a deliberate choice.
    if (!Number.isFinite(parsed)) {
      return clampPanelWidth(fallback, min, max);
    }
    return clampPanelWidth(parsed, min, max);
  } catch {
    // Storage unavailable (private mode, quota, disabled) — degrade to the
    // in-memory default rather than throwing.
    return clampPanelWidth(fallback, min, max);
  }
}

/** Persist a panel width. Silently no-ops if storage is unavailable. */
export function savePanelWidth(key: string, value: number): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(value)));
  } catch {
    // Width just won't persist across launches; the session still works.
  }
}

export interface PanelWidthState {
  width: number;
  min: number;
  max: number;
  /** Set + clamp + persist a new width in one call. */
  setWidth: (next: number) => void;
}

/**
 * One resizable panel's width, read from localStorage on mount and persisted
 * on every change. `key` scopes storage per panel ("sidebar" / "dock") so the
 * two never collide.
 */
export function usePanelWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number
): PanelWidthState {
  const [width, setWidthState] = useState(() =>
    loadPanelWidth(key, defaultWidth, min, max)
  );
  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, min, max);
      setWidthState(clamped);
      savePanelWidth(key, clamped);
    },
    [key, min, max]
  );
  return { width, min, max, setWidth };
}
