import type { DaemonAttachState } from "@muon/protocol";

/**
 * ADR-0040 D3a — "is a human present at this daemon right now?"
 *
 * A LEAF module on purpose: it imports one type and nothing else at runtime.
 * An earlier version lived beside the sweeper, and `app.ts` importing it there
 * pulled the sweeper's whole dependency tree into the request-auth hook, which
 * 401'd every authenticated request. Attendance is touched on a hot path; it
 * must not be able to drag anything in with it.
 *
 * ATTENDANCE IS ASSERTED, NEVER INFERRED — and that is the whole correction
 * D3a makes. The first version counted any operator-tier request, which sounds
 * reasonable and is wrong in both directions:
 *
 *   - the desktop keeps polling with the operator token while every window is
 *     shut, so the daemon read as attended with nobody at the machine;
 *   - an attached coordinator's heartbeat is AGENT-tier, so a human visibly
 *     working at a terminal read as absent and would have been reaped.
 *
 * A poll proves a PROCESS is running. A keystroke, a focused window, a typed
 * command prove a PERSON is there. Only the second kind reaches here.
 *
 * The persistence hook is injected rather than imported for the same
 * leaf-module reason: the caller wires the store, so this file still depends on
 * nothing.
 */

/**
 * How long an assertion keeps the daemon "attended".
 *
 * Surfaces re-assert while a human is demonstrably present (a focused desktop
 * window ticks, a TUI keystroke fires), so this only has to outlast the gap
 * between assertions — not the horizon, which is hours. Generous enough that a
 * minute of stillness or a sleeping laptop is not treated as departure.
 */
export const SURFACE_ATTENDED_FRESH_MS = 90_000;

/** The surfaces that may assert human presence, stated positively. */
export const ATTENDING_SURFACES = ["desktop", "tui", "cli"] as const;
export type AttendingSurface = (typeof ATTENDING_SURFACES)[number];

export function isAttendingSurface(value: unknown): value is AttendingSurface {
  return ATTENDING_SURFACES.includes(value as AttendingSurface);
}

/** Process start — the reference point that makes a NEVER-attended daemon age
 *  rather than read as "zero elapsed" and live forever. */
const processStartedAt = Date.now();

let lastAttendedAt: number | null = null;
let lastSurface: AttendingSurface | null = null;

/** Set once at boot from the persisted value, so a restart does not reset the
 *  clock. A daemon that crash-loops hourly was otherwise immortal. */
export function hydrateAttendance(persistedMs: number | null): void {
  if (persistedMs === null || !Number.isFinite(persistedMs)) return;
  if (persistedMs > Date.now()) return; // a future stamp is a clock to distrust
  if (lastAttendedAt === null || persistedMs > lastAttendedAt) {
    lastAttendedAt = persistedMs;
  }
}

/**
 * A surface asserts that a human is present.
 *
 * Returns true when this moved the clock, so the caller can persist only on a
 * real change rather than writing the database every tick.
 */
export function noteHumanPresent(
  surface: AttendingSurface,
  now = Date.now()
): boolean {
  // Monotonic: a clock jumping backwards must not un-attend a live human.
  if (lastAttendedAt !== null && now <= lastAttendedAt) return false;
  lastAttendedAt = now;
  lastSurface = surface;
  return true;
}

/** Test seam only — this state is process-scoped by design. */
export function resetAttendanceForTests(): void {
  lastAttendedAt = null;
  lastSurface = null;
}

/** Which surface last asserted presence, for the operator-facing status. */
export function lastAttendingSurface(): AttendingSurface | null {
  return lastSurface;
}

export function daemonAttachState(now = Date.now()): DaemonAttachState {
  return {
    detachedAt: processStartedAt,
    lastAttachedAt: lastAttendedAt,
    attached:
      lastAttendedAt !== null && now - lastAttendedAt < SURFACE_ATTENDED_FRESH_MS,
    // This brain is always "detached" in the protocol's sense — a daemon that
    // outlives any one surface. Whether a human is WATCHING is `attached`.
    detached: true,
  };
}
