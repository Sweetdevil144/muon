/**
 * The 2026-08-23 appendix B1 marketing events, as pure href/path mappings.
 *
 * Same discipline as the product observatory (ADR-0095), applied to the
 * site: a click either maps to one of the NAMED events below with a closed
 * property set, or it maps to nothing. There is no generic "link_clicked"
 * that would put arbitrary hrefs into an event property — autocapture
 * already records element-level interactions its own bounded way, and the
 * named funnel events stay clean for insights.
 */

export type MarketingEvent = {
  name: "download_clicked" | "github_clicked" | "pricing_viewed";
  properties: { target?: "dmg" | "checksums" | "page" };
};

const OSS_REPO_PREFIX = "https://github.com/Sweetdevil144/muon";

export function marketingEventForClick(
  href: string | undefined
): MarketingEvent | undefined {
  if (!href) return undefined;
  if (href.startsWith("https://download.getmuon.com/")) {
    return {
      name: "download_clicked",
      properties: {
        target: href.toLowerCase().endsWith(".dmg") ? "dmg" : "checksums",
      },
    };
  }
  // The internal CTA — either the relative link every button uses or the
  // absolute form of the same page.
  const path = href.startsWith("/")
    ? href
    : href.startsWith("https://getmuon.com")
      ? href.slice("https://getmuon.com".length)
      : undefined;
  if (path === "/download" || path === "/download/") {
    return { name: "download_clicked", properties: { target: "page" } };
  }
  if (
    href === OSS_REPO_PREFIX ||
    href.startsWith(`${OSS_REPO_PREFIX}/`) ||
    href.startsWith(`${OSS_REPO_PREFIX}?`)
  ) {
    return { name: "github_clicked", properties: {} };
  }
  return undefined;
}

export function marketingEventForPath(
  pathname: string
): MarketingEvent | undefined {
  if (pathname === "/pricing" || pathname === "/pricing/") {
    return { name: "pricing_viewed", properties: {} };
  }
  return undefined;
}
