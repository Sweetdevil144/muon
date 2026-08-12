// Wave 4 §2.2/§2.5 — the Electron-MAIN side of the terminal byte relay.
//
// WHAT THIS CLASS IS, AND WHAT MAIN IS. This class is a byte relay: it bridges
// a per-session renderer port to a PtyHost and moves frames, nothing else. Its
// header used to extend that into a claim about the PROCESS — that main "owns
// no operator token on this path and never spawns a vendor", and that "the
// production real-vendor PtyHost lives in the detached, Seatbelt-confined
// runner". Neither is true. Electron main IS the PtyHost for human terminals
// (lib/terminal-host.ts constructs one), it DOES spawn the real vendor CLI on
// a real node-pty, and it does hold the operator token (`settings.apiToken`).
//
// That is the ACCEPTED posture, not an oversight: ADR-0023 §5 records that a
// human-owned terminal spawns from Electron main, unconfined, with the host
// environment minus MUON's own control-plane tokens — the same trust boundary
// as the user opening their own shell. MUON claims no OS confinement for these
// sessions. GOVERNED dispatched children are the opposite case: their ptys live
// inside the runner, no IPC channel can write to them, and their environment is
// allowlist-built.
//
// The relay logic is transport-agnostic so it is fully unit-testable without an
// Electron runtime.

import type { PtyExitEvent, PtyHost, PtySpawnOptions } from "@muon/runner";
import type { TerminalRelayPort } from "../shared/terminal-protocol.js";

export class PtyRelay {
  constructor(private readonly host: PtyHost) {}

  /** Create the session if it does not already exist (idempotent for reconnect). */
  open(sessionId: string, spawn: PtySpawnOptions): void {
    if (!this.host.has(sessionId)) {
      this.host.open(sessionId, spawn);
    }
  }

  /**
   * Bind a renderer port to a session: forward host output (data/exit) to the
   * port, apply renderer input (write/resize/ack/close) to the host, and — when
   * the port closes (window reload/crash) — DETACH so the session's registry +
   * scrollback SURVIVE in the host for reconnect. The pty is never killed on a
   * port close; only an explicit `close` frame (or host drain) destroys it.
   */
  attach(sessionId: string, port: TerminalRelayPort): void {
    port.onFrame((frame) => {
      switch (frame.type) {
        case "write":
          // A late frame after the session was closed is ignored, never a crash.
          if (this.host.has(sessionId)) {
            this.host.write(sessionId, frame.data);
          }
          break;
        case "resize":
          if (this.host.has(sessionId)) {
            this.host.resize(sessionId, frame.cols, frame.rows);
          }
          break;
        case "ack":
          // Drives backpressure: the host resumes the pty when acks drain it.
          this.host.ack(sessionId, frame.seq);
          break;
        case "close":
          this.host.close(sessionId);
          break;
      }
    });

    const consumer = {
      onData: (frame: { seq: number; data: string }) =>
        port.post({ type: "data", seq: frame.seq, data: frame.data }),
      // The host's OWN measurement of the child's life crosses the wire with
      // the exit: the renderer must never re-derive it from a clock of its own
      // (see the exit frame's contract in terminal-protocol.ts).
      onExit: (event: PtyExitEvent) =>
        port.post({
          type: "exit",
          exitCode: event.exitCode,
          lifetimeMs: event.lifetimeMs,
          ...(event.signal !== undefined ? { signal: event.signal } : {}),
        }),
    };
    this.host.attach(sessionId, consumer);

    // Pass the consumer identity: a late close of a SUPERSEDED port must not null
    // the consumer that already reconnected on a newer port (the reconnect race).
    port.onClose(() => this.host.detach(sessionId, consumer));
  }
}
