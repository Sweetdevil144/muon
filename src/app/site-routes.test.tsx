/**
 * The site's structural invariants, after the revamp.
 *
 * These replace three suites that described the previous marketing site
 * (its homepage story, its product submenu, its content module). That site no
 * longer exists, so those tests could only fail or be deleted — deleting them
 * without a replacement would have removed the only check that the navigation
 * actually reaches the pages it advertises, which is exactly what breaks when
 * routes are ported by hand.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APP = path.join(ROOT, "src/app");

/** Every path the top rail and footer link to, internal only. */
function internalLinks(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const fromHref = [...src.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
  const fromData = [...src.matchAll(/to:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
  return [...new Set([...fromHref, ...fromData])];
}

/** A route exists if it has a page, or is redirected by next.config. */
function resolves(route: string): boolean {
  const clean = route.replace(/\/$/, "");
  const dir = clean === "" ? APP : path.join(APP, clean);
  if (existsSync(path.join(dir, "page.tsx"))) return true;
  const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  return config.includes(`source: "${clean}"`);
}

const NAV = "src/components/muon/TopRail.tsx";
const FOOTER = "src/components/muon/StatusRail.tsx";

describe("navigation reaches real pages", () => {
  it("finds links to check (guards against a selector that matches nothing)", () => {
    expect(internalLinks(NAV).length).toBeGreaterThanOrEqual(5);
    expect(internalLinks(FOOTER).length).toBeGreaterThanOrEqual(3);
  });

  for (const file of [NAV, FOOTER]) {
    it(`every internal link in ${path.basename(file)} resolves`, () => {
      const broken = internalLinks(file).filter((r) => !resolves(r));
      expect(broken, `dead links: ${broken.join(", ")}`).toEqual([]);
    });
  }
});

describe("every page states who it is to a crawler", () => {
  const ROUTES = [
    "", "product", "product/shared-memory", "how-it-works", "pricing",
    "enterprise", "security", "faq", "download",
    "docs", "docs/install", "docs/quickstart", "docs/cli", "docs/mcp",
    "docs/governance", "docs/troubleshooting",
    "privacy", "terms", "licenses",
  ];

  for (const route of ROUTES) {
    it(`/${route} has a title and description`, () => {
      const file = path.join(route === "" ? APP : path.join(APP, route), "page.tsx");
      expect(existsSync(file), `missing page: /${route}`).toBe(true);
      const src = readFileSync(file, "utf8");
      expect(src, `/${route} exports no metadata`).toMatch(/export const metadata/);
      expect(src).toMatch(/title:/);
      expect(src).toMatch(/description:/);
    });
  }
});

describe("the superseded product pages are redirected, not 404'd", () => {
  const GONE = [
    "/product/agent-lanes",
    "/product/approvals",
    "/product/command-center",
    "/product/handoffs",
    "/product/human-control",
  ];

  it("each folded-away page still resolves somewhere", () => {
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    for (const route of GONE) {
      expect(config, `${route} would 404`).toContain(`source: "${route}"`);
      expect(existsSync(path.join(APP, route.slice(1), "page.tsx"))).toBe(false);
    }
  });
});

describe("the enterprise form actually submits", () => {
  // The prototype's form was `onSubmit={(e) => e.preventDefault()}` — visually
  // identical to a working one and silently discards every lead. The API route
  // it must reach has been live throughout.
  const body = readFileSync(path.join(APP, "enterprise/page-body.tsx"), "utf8");

  it("posts to the live contact route", () => {
    expect(body).toContain('fetch("/api/enterprise-contact"');
    expect(body).toContain('method: "POST"');
  });

  it("does not swallow the submit", () => {
    // Comments are stripped first: the fix's own comment quotes the broken
    // pattern verbatim, and matching that would fail on correct code.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/onSubmit=\{\([^)]*\)\s*=>\s*\w+\.preventDefault\(\)\s*\}/);
    expect(code).toMatch(/onSubmit=\{onSubmit\}/);
  });

  it("sends the field names the route actually reads", () => {
    const route = readFileSync(path.join(APP, "api/enterprise-contact/route.ts"), "utf8");
    for (const field of ["fullName", "role", "company", "companyEmail", "problemDescription"]) {
      expect(body, `form never names ${field}`).toContain(field);
      expect(route, `route never reads ${field}`).toContain(field);
    }
  });

  it("keeps the honeypot the route checks", () => {
    expect(body).toContain('name="website"');
  });
});

describe(".vercelignore cannot swallow a site directory again", () => {
  // `docs/` (unanchored) was meant for the repo-root markdown folder and also
  // matched `src/app/docs/`, so seven pages built locally and 404'd in
  // production. The build stayed green either way, which is what made it cost
  // a deploy to find. Anchoring is the fix; this is the guard.
  const ignore = readFileSync(path.join(ROOT, ".vercelignore"), "utf8");
  const patterns = ignore
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("has patterns to check", () => {
    expect(patterns.length).toBeGreaterThan(5);
  });

  it("anchors every pattern to the repo root", () => {
    const unanchored = patterns.filter((p) => !p.startsWith("/") && !p.startsWith("!"));
    expect(
      unanchored,
      `these match at any depth and can exclude a src/app directory: ${unanchored.join(", ")}`
    ).toEqual([]);
  });

  it("no UNANCHORED pattern shares a name with a src/app directory", () => {
    // An anchored `/docs/` and a `src/app/docs` can coexist safely — that is
    // the whole point of anchoring. The hazard is only an unanchored rule
    // whose name also exists under src/app, which is the exact shape that
    // deleted the docs pages from the deploy.
    const collisions = patterns
      .filter((p) => !p.startsWith("/") && !p.startsWith("!"))
      .map((p) => p.replace(/\/$/, ""))
      .filter((p) => p && existsSync(path.join(APP, p)));
    expect(
      collisions,
      `src/app/${collisions.join(", src/app/")} would not be uploaded`
    ).toEqual([]);
  });
});

describe("the docs host rewrite", () => {
  // docs.getmuon.com is served by THIS app from src/app/docs. Two things broke
  // while wiring it, and both were silent in a green build:
  //   1. the root rewrite produced /docs, which the catch-all rule then matched
  //      and rewrote again to /docs/docs — the docs home 404'd while every
  //      child page worked, which is the hardest version to notice;
  //   2. without excluding _next/, every asset on that host 404s and the page
  //      renders unstyled.
  const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");

  it("routes the docs host before the marketing homepage claims /", () => {
    expect(config).toContain("beforeFiles");
    expect(config).toMatch(/source:\s*"\/"[\s\S]{0,120}destination:\s*"\/docs"/);
  });

  it("does not rewrite its own destination back onto itself", () => {
    const catchAll = config.match(/source:\s*"\/:path\(\(\?![^"]*\)\.\*\)"/);
    expect(catchAll, "catch-all rewrite not found").not.toBeNull();
    expect(catchAll![0], "must exclude `docs` or /docs becomes /docs/docs").toContain("docs");
  });

  it("lets assets and API routes through untouched", () => {
    const catchAll = config.match(/source:\s*"\/:path\(\(\?![^"]*\)\.\*\)"/)![0];
    for (const exclusion of ["_next/", "api/", "\\\\."]) {
      expect(catchAll, `missing exclusion: ${exclusion}`).toContain(exclusion);
    }
  });

  it("takes the host from the environment but defaults to production", () => {
    // An unset variable must still resolve to the real host — forgetting to set
    // it in some environment cannot be allowed to silently unroute production.
    expect(config).toMatch(/process\.env\.DOCS_HOST\s*\?\?\s*"docs\.getmuon\.com"/);
  });
});

describe("the docs host sends off-docs paths back to the marketing site", () => {
  // The docs pages render the SAME shell as the rest of the site, so the navbar
  // on docs.getmuon.com links to /product, /pricing and so on. Host-relative,
  // those stayed on the docs host, where the catch-all rewrite turned /product
  // into /docs/product and 404'd. That is the cost of one shared shell across
  // two hosts, and it is paid here.
  const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");

  it("keeps the docs slugs as a POSITIVE list", () => {
    // Forgetting to add a new docs page here redirects it to a working
    // marketing URL; deriving the list by exclusion would 404 it instead.
    expect(config).toMatch(/const DOCS_SLUGS = \[/);
    for (const slug of ["install", "quickstart", "cli", "mcp", "governance", "troubleshooting"]) {
      expect(config, `docs slug missing: ${slug}`).toContain(`"${slug}"`);
    }
  });

  it("every docs slug in the list is a real page", () => {
    const slugs = [...config.matchAll(/^\s{2}"([a-z-]+)",$/gm)].map((m) => m[1]);
    const docsSlugs = slugs.filter((s) =>
      existsSync(path.join(APP, "docs", s, "page.tsx"))
    );
    expect(docsSlugs.length, "DOCS_SLUGS names pages that do not exist").toBeGreaterThanOrEqual(6);
  });

  it("does not redirect the docs home away from its own host", () => {
    // `/` has an EMPTY path param, which matches a naive negative lookahead —
    // the docs home 307'd to the marketing site until `$|` was added.
    const redirect = config.match(/source: `\/:path\(\(\?!\$\|/);
    expect(redirect, "the root must be excluded with a leading `$|`").not.toBeNull();
  });

  it("keeps assets and API routes on the docs host", () => {
    const src = config.match(/source: `\/:path\(\(\?!\$[^`]*`/)![0];
    for (const exclusion of ["_next/", "api/", "\\\\."]) {
      expect(src, `missing exclusion: ${exclusion}`).toContain(exclusion);
    }
  });

  it("sends them to a configurable origin, defaulting to production", () => {
    expect(config).toMatch(/process\.env\.SITE_ORIGIN\s*\?\?\s*"https:\/\/getmuon\.com"/);
  });
});
