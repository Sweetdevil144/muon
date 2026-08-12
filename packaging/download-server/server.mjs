#!/usr/bin/env node
// MUON download host — download.getmuon.com
//
// A dependency-free static file server for release artifacts, designed for a
// Railway service with a mounted volume. It serves exactly what the founder
// uploads to the volume (DMG, update zip, latest-mac.yml, blockmaps,
// SHA256SUMS, muon-cli-*.tgz) and nothing else: no directory listing beyond
// the curated index, no writes, no auth (these are public artifacts).
//
// Env:
//   PORT          — injected by Railway (default 8080)
//   MUON_DATA_DIR — artifact directory (default /data, the volume mount)
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.MUON_DATA_DIR || "/data";

const TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".tgz": "application/gzip",
  ".yml": "text/yaml; charset=utf-8",
  ".blockmap": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  // Curated index: name + size only, so a browser hit on the bare host is
  // useful without exposing anything beyond what is already public.
  if (url.pathname === "/") {
    try {
      const names = (await readdir(DATA_DIR)).filter(
        (n) => !n.startsWith(".")
      );
      const rows = [];
      for (const n of names.sort()) {
        const s = await stat(join(DATA_DIR, n));
        if (s.isFile()) rows.push(`${n}\t${s.size}`);
      }
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end(`MUON releases — https://getmuon.com/download\n\n${rows.join("\n")}\n`);
    } catch {
      res.writeHead(200, { "content-type": "text/plain" }).end("MUON releases\n");
    }
    return;
  }

  // One flat directory of artifacts: reject anything that is not a plain
  // filename (no subpaths, no traversal, no hidden files).
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    normalize(name) !== name
  ) {
    res.writeHead(404).end("not found");
    return;
  }

  const file = join(DATA_DIR, name);
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }

  const headers = {
    "content-type": TYPES[extname(name)] || "application/octet-stream",
    "content-length": info.size,
    // Versioned artifacts are immutable; the feed + "latest" aliases must
    // revalidate so a new release is visible immediately.
    "cache-control":
      name === "latest-mac.yml" || name.includes("latest")
        ? "no-cache"
        : "public, max-age=86400, immutable",
  };
  if (method === "HEAD") {
    res.writeHead(200, headers).end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`[muon-downloads] serving ${DATA_DIR} on :${PORT}`);
});
