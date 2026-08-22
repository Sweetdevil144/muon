import posthog from "posthog-js";
import {
  marketingEventForClick,
  marketingEventForPath,
} from "./lib/marketing-events";

/**
 * PostHog on the MARKETING SITE ONLY (2026-08-23 appendix B1) — project
 * 546314, the same project the product observatory reports to, so the
 * funnel reads end-to-end: pageview → pricing_viewed → download_clicked →
 * (product) app.launch → funnel.first_dispatch.
 *
 * The write key is a posthog-js PUBLIC key — public-safe by design, same
 * class as the one already shipped inside the desktop binary (ADR-0031).
 * Nothing stronger may ever appear in `src/`.
 *
 * Autocapture, session replay, and heatmaps are appendix-authorized HERE
 * and only here: a marketing page has no user code, no repo names, no
 * prompts on screen. The product surfaces stay on the shape-bounded
 * observatory (ADR-0095 D6) — never this SDK.
 *
 * Named funnel events ride a single delegated click listener through the
 * PURE mappings in `lib/marketing-events` (tested there): a click either
 * maps to a named event with a closed property set, or to nothing. No
 * generic event ever carries an href.
 */
// KEY REUSE, verified per the marketing appendix's condition: the desktop
// observatory's `telemetryDeviceId` never reaches a browser (it lives in the
// machine profile's settings.json and rides only the desktop uploader), and
// this snippet never calls identify() — posthog-js mints its own anonymous
// cookie id. The two id spaces cannot join, so one write-only project key
// serves both and the funnel reads end-to-end.
const POSTHOG_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY ??
  "phc_ChiDyxSmHgS7a5GZ8pAdGenUgGTFZzHDnsvNAAqWMric";

// Everything is window-guarded: the snippet must not load during SSR or in
// the test environment (the honesty/marketing suites import the pure
// mappings from lib/, never this file — and if one ever does, nothing runs).
if (typeof window !== "undefined") {
  posthog.init(POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    // SDK defaults snapshot: history-API pageviews (App Router navigations
    // included), pageleave, sane autocapture.
    defaults: "2025-05-24",
    capture_pageview: "history_change",
    // Appendix §6: exception autocapture FOR THE SITE ONLY. The product
    // surfaces stay on the shape-bounded observatory (ADR-0095 D6) — a
    // marketing page has no user code on screen for an exception to leak.
    capture_exceptions: true,
    session_recording: {
      // Belt-and-braces: replay may only ever see marketing copy, but mask
      // any input that might exist on a future page anyway.
      maskAllInputs: true,
    },
  });

  // pricing_viewed on every pageview that lands on /pricing (initial load and
  // client-side navigations both funnel through the $pageview capture).
  // The callback receives the CaptureResult object (`.event` is the name).
  // Re-entrancy is safe: the capture below emits eventCaptured again with a
  // non-$pageview name and returns immediately.
  posthog.on("eventCaptured", (captured: { event?: string }) => {
    if (captured?.event !== "$pageview") return;
    const viewed = marketingEventForPath(window.location.pathname);
    if (viewed) posthog.capture(viewed.name, viewed.properties);
  });

  // One delegated listener; server components need no client conversion.
  document.addEventListener(
    "click",
    (mouseEvent) => {
      const anchor = (mouseEvent.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const named = marketingEventForClick(anchor.getAttribute("href") ?? "");
      if (named) posthog.capture(named.name, named.properties);
    },
    { capture: true }
  );
}
