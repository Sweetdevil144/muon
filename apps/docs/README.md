# MUON docs (docs.getmuon.com)

The user-facing guide site for MUON: what it is, how to install it, the CLI
reference, the MCP server, governance, and troubleshooting. Built as a
self-contained Next.js (App Router) app so it can be developed, built, and
deployed independently of the rest of the monorepo.

- **Dependencies are intentionally minimal**: `next`, `react`, `react-dom`
  only. No Tailwind, no MDX, no content framework — every page is a plain
  React component and `globals.css` is hand-rolled.
- **Static-export-friendly**: `next.config.mjs` sets `output: "export"`, so
  `next build` emits plain HTML/CSS/JS into `out/` with no server runtime
  required. It also deploys fine as an ordinary Next.js app on Vercel without
  relying on that flag.
- **Not part of the root npm workspace.** The root `package.json` has no
  `workspaces` field, so this app's `npm install` is fully independent of the
  root install — nothing here touches root `node_modules` or the root
  lockfile, and nothing in the root touches this app.

## Local development

```bash
cd apps/docs
npm install
npm run dev        # http://localhost:3060
```

## Build

```bash
cd apps/docs
npm install
npm run build       # → apps/docs/out/ (static export)
```

## Deploy to Vercel

This app is meant to be its own Vercel project, pointed at `apps/docs/` as
the project root, deployed to `docs.getmuon.com`.

1. **First-time setup** (from the repo root or from `apps/docs/`, either
   works since the Vercel CLI takes `--cwd`):

   ```bash
   vercel link --cwd apps/docs
   ```

   When prompted, set the project's root directory to `apps/docs` if it
   isn't already inferred from `--cwd`. Framework preset: Next.js.

2. **Deploy a preview:**

   ```bash
   vercel --cwd apps/docs
   ```

3. **Deploy to production:**

   ```bash
   vercel --cwd apps/docs --prod
   ```

4. **Attach the custom domain**, once the project exists on Vercel:

   ```bash
   vercel domains add docs.getmuon.com --cwd apps/docs
   ```

   Then point `docs.getmuon.com`'s DNS at Vercel per the instructions the
   command (or the Vercel dashboard's Domains tab) prints — typically a
   `CNAME` to `cname.vercel-dns.com` for a subdomain.

Because this project has no `workspaces` entanglement with the rest of the
monorepo, Vercel's own root-directory build (`cd apps/docs && npm install &&
npm run build`) is sufficient — no monorepo-aware build settings are
required.

## What this app does *not* do

- It does not touch `apps/desktop`, the root marketing site, or any other
  package in this monorepo.
- It ships no analytics, no tracking script, and no external font/script
  loading — every asset is self-contained, consistent with MUON's own
  local-first, no-egress-by-default posture.
- It is documentation only: no API routes, no server actions, no dynamic
  data. Every page is fully static.
