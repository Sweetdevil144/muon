import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static-export-friendly: every page here is pre-renderable with no server
  // runtime, no API routes, and no dynamic segments, so `next build` can emit
  // plain HTML/CSS/JS. Works equally well deployed to Vercel directly (which
  // does not require export) or hosted as static files elsewhere.
  output: "export",
  images: {
    unoptimized: true,
  },
  turbopack: {
    // This app lives inside a larger monorepo that has its own root
    // package-lock.json. Pin the workspace root to this directory so
    // Turbopack never infers the monorepo root from the extra lockfile.
    root: __dirname,
  },
};

export default nextConfig;
