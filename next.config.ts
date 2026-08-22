import type { NextConfig } from "next";

/**
 * The documentation lives at docs.getmuon.com but is BUILT here, as
 * `src/app/docs/*`, and served to that host by the rewrite below.
 *
 * It used to be a second Vercel project with no git link, whose last deploy was
 * twelve days old and whose source existed nowhere on disk — so it could not be
 * rebuilt, only replaced. Folding it into this app means the docs share this
 * site's shell, components and design tokens instead of a second copy of the
 * design system that drifts the moment either side changes.
 */
/**
 * Configurable, with production as the default. A preview deployment or a
 * staging host can point the docs elsewhere by setting DOCS_HOST, without a
 * code change — but an unset variable still resolves to the real host, so
 * forgetting to set it cannot silently unroute production.
 */
const DOCS_HOST = process.env.DOCS_HOST ?? "docs.getmuon.com";
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://getmuon.com";

/**
 * The docs pages, by slug. A POSITIVE list: anything not named here is not a
 * docs page, so on the docs host it belongs back on the marketing site. Adding
 * a docs page means adding it here — the failure mode of forgetting is a
 * redirect to a working marketing URL, not a 404.
 */
const DOCS_SLUGS = [
  "install",
  "quickstart",
  "cli",
  "mcp",
  "governance",
  "troubleshooting",
] as const;

const nextConfig: NextConfig = {
  devIndicators: false,

  async rewrites() {
    return {
      // `beforeFiles` is required, not stylistic: on `beforeFiles` a request for
      // `/` on the docs host is rewritten before the marketing homepage claims
      // it. Under `afterFiles` the homepage would match first and docs.getmuon.com
      // would serve the marketing site.
      beforeFiles: [
        {
          source: "/",
          has: [{ type: "host", value: DOCS_HOST }],
          destination: "/docs",
        },
        {
          // Everything else on that host maps onto /docs/*, EXCEPT the three
          // things that must resolve at the root or the site breaks:
          //   _next/  — the JS/CSS chunks; rewriting them 404s every asset
          //   api/    — the live contact + waitlist routes
          //   *.*     — real files (favicon, install.sh, og image, manifest)
          //   docs    — the rule's OWN destination. Without this exclusion the
          //             root rewrite above produced `/docs`, which this rule
          //             then matched and rewrote again to `/docs/docs`, so the
          //             docs home 404'd while every child page worked.
          source: "/:path((?!_next/|api/|docs|.*\\.).*)",
          has: [{ type: "host", value: DOCS_HOST }],
          destination: "/docs/:path",
        },
      ],
    };
  },

  /**
   * The five product sub-pages were folded into /product and
   * /product/shared-memory in the revamp. They are redirected rather than
   * deleted: they have been live and linked, and a 404 for someone who
   * bookmarked one is a worse outcome than a hop. Permanent, so search engines
   * consolidate onto the surviving pages.
   */
  async redirects() {
    return [
      {
        // The docs pages render the SAME shell as the rest of the site, so the
        // navbar on docs.getmuon.com links to /product, /pricing and so on.
        // Those are host-relative: they stayed on the docs host, where the
        // rewrite below turned /product into /docs/product and 404'd. Sending
        // them to the marketing origin is what makes one shared shell work
        // across two hosts. Temporary, not permanent — these URLs are canonical
        // on getmuon.com and should not be cached against the docs host.
        // The leading `$|` excludes the EMPTY path, i.e. `/` itself: the docs
        // home lives on this host and must not be redirected away from it.
        source: `/:path((?!$|${DOCS_SLUGS.join("$|")}$|_next/|api/|.*\\.).*)`,
        has: [{ type: "host", value: DOCS_HOST }],
        destination: `${SITE_ORIGIN}/:path`,
        permanent: false,
      },
      { source: "/product/agent-lanes", destination: "/product", permanent: true },
      { source: "/product/approvals", destination: "/product", permanent: true },
      { source: "/product/command-center", destination: "/product", permanent: true },
      { source: "/product/handoffs", destination: "/product", permanent: true },
      { source: "/product/human-control", destination: "/product", permanent: true },
    ];
  },
};

export default nextConfig;
