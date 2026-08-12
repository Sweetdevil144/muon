import type { ObservatoryRecord } from "./observatory.js";

/**
 * ADR-0031 — the Observatory uploader (PostHog US, consent-gated).
 *
 * Electron-free and io-injected like its siblings: main.ts supplies fetch and
 * the consent/identity readers; tests supply fakes. The INVARIANTS:
 *
 *   - consent is read at SEND time (`enabled()`); a false answer means zero
 *     requests, full stop — including the MUON_OBSERVATORY_SPOOL audit mode,
 *     which is local-only by design and never reaches this module;
 *   - the wire payload is the ObservatoryRecord verbatim (already shape-
 *     bounded: enums/numbers/booleans/version) plus the anonymous per-profile
 *     distinct_id — nothing is added here beyond those two;
 *   - failures are silent-with-retry: events stay buffered (bounded at
 *     MAX_BUFFER, oldest dropped) and never block, throw, or crash;
 *   - an empty key disables egress entirely.
 */

export const OBSERVATORY_UPLOAD_PROVIDER = "posthog" as const;

/** Write-only project token (PostHog documents phc_ keys as safe in public
 *  clients) + US Cloud ingest host. Env-overridable; empty key = no egress. */
const DEFAULT_KEY = "phc_ChiDyxSmHgS7a5GZ8pAdGenUgGTFZzHDnsvNAAqWMric";
const DEFAULT_HOST = "https://us.i.posthog.com";

export const FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_AT_COUNT = 20;
const MAX_BUFFER = 500;

export type ObservatoryUploader = {
  /** Buffer one already-recorded event (call AFTER the local spool append). */
  enqueue(record: ObservatoryRecord): void;
  /** Flush now (timer tick / quit). Never throws. */
  flush(): Promise<void>;
  /** Buffered-not-yet-sent count (tests + diagnostics). */
  pending(): number;
  /**
   * Consent was revoked: drop everything buffered, NOW.
   *
   * `flush` already refuses to send without consent and empties the buffer
   * when it notices — but it only notices on a timer tick or at the batch
   * threshold, so between a revoke and the next flush the rows just sit there.
   * Re-granting inside that window (up to FLUSH_INTERVAL_MS) mints a new
   * consent epoch, and the NEXT flush then finds consent true and a device id
   * present and ships the pre-revocation rows under it.
   *
   * That is precisely the thing `flush`'s own comment says must not happen
   * ("Holding them for a later re-grant would upload events from before the
   * new consent"). Revocation has to be an EVENT the uploader is told about,
   * not a condition it eventually observes.
   */
  discard(): void;
  stop(): void;
};

export function createObservatoryUploader(options: {
  /** Consent, read LIVE at send time (settings.telemetryEnabled). */
  enabled: () => boolean;
  /** The anonymous per-profile id; null = not minted yet (no consent epoch). */
  deviceId: () => string | null;
  fetcher?: typeof fetch;
  key?: string;
  host?: string;
  /** Timer seam so tests never wait. */
  scheduleFlush?: (run: () => void) => () => void;
}): ObservatoryUploader {
  const key = (options.key ?? process.env.MUON_POSTHOG_KEY ?? DEFAULT_KEY).trim();
  const host = (options.host ?? process.env.MUON_POSTHOG_HOST ?? DEFAULT_HOST)
    .trim()
    .replace(/\/$/, "");
  const fetcher = options.fetcher ?? fetch;

  let buffer: ObservatoryRecord[] = [];
  let flushing = false;

  const flush = async (): Promise<void> => {
    if (flushing || buffer.length === 0 || key === "") {
      return;
    }
    if (!options.enabled()) {
      // Consent revoked with rows still buffered: drop them. Holding them for
      // a later re-grant would upload events from before the new consent.
      buffer = [];
      return;
    }
    const deviceId = options.deviceId();
    if (!deviceId) {
      return; // consent epoch not established yet; keep buffering (bounded)
    }
    const batch = buffer;
    buffer = [];
    flushing = true;
    try {
      const response = await fetcher(`${host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          batch: batch.map(({ name, at, ...fields }) => ({
            event: name,
            distinct_id: deviceId,
            timestamp: at,
            properties: fields,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(`posthog ${response.status}`);
      }
    } catch {
      // Offline / 4xx / 5xx: put the batch back (bounded) and try next tick.
      buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
    } finally {
      flushing = false;
    }
  };

  const cancel = (options.scheduleFlush ?? defaultSchedule)(() => {
    void flush();
  });

  return {
    enqueue(record) {
      if (key === "" || !options.enabled()) {
        return; // no consent, no buffering — nothing accumulates pre-consent
      }
      buffer.push(record);
      if (buffer.length > MAX_BUFFER) {
        buffer = buffer.slice(-MAX_BUFFER);
      }
      if (buffer.length >= FLUSH_AT_COUNT) {
        void flush();
      }
    },
    flush,
    pending: () => buffer.length,
    discard() {
      // Synchronous and unconditional. An in-flight `flush` has already taken
      // its batch out of `buffer` (see `const batch = buffer; buffer = []`),
      // so that request is not ours to stop — but it was authorised under the
      // consent that was live when it started, which is the correct reading.
      // What must not survive is anything still waiting.
      buffer = [];
    },
    stop: cancel,
  };
}

function defaultSchedule(run: () => void): () => void {
  const timer = setInterval(run, FLUSH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
