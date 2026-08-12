import { NextResponse } from "next/server";
import { saveSignup } from "@/lib/waitlist-store";

// Runs on Vercel's serverless (Node.js) runtime, never at the edge, so the
// Postgres connection stays server-side and is never shipped to the browser.
export const runtime = "nodejs";

// Permissive email shape check. The real uniqueness guarantee lives in Postgres
// (unique index); this just rejects obvious garbage early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
// An email + optional name is tiny; reject anything larger before parsing.
const MAX_BODY_BYTES = 4096;

// Best-effort per-instance rate limit. Serverless instances are ephemeral, so
// this caps abuse from a single warm instance; the honeypot + the Postgres
// unique index do the heavier lifting.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const recentHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  // Bound memory: evict fully-stale IP buckets before the map can grow without
  // limit on a long-lived instance.
  if (recentHits.size > 10_000) {
    for (const [key, times] of recentHits) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) {
        recentHits.delete(key);
      }
    }
  }
  const hits = (recentHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  hits.push(now);
  recentHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  // Cap the buffered body before parsing. Measuring the actual text guards even
  // when Content-Length is absent or spoofed.
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonError("Invalid request body.", 400);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return jsonError("Request body too large.", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const { email, name, website } =
    (body as { email?: unknown; name?: unknown; website?: unknown }) ?? {};

  // Honeypot: real users never fill the hidden "website" field. Silently accept
  // so bots don't learn they were filtered.
  if (typeof website === "string" && website.trim() !== "") {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const candidateEmail = typeof email === "string" ? email.trim() : "";
  if (
    !candidateEmail ||
    candidateEmail.length > MAX_EMAIL_LENGTH ||
    !EMAIL_RE.test(candidateEmail)
  ) {
    return jsonError("Please enter a valid email address.", 400);
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (isRateLimited(ip)) {
    return jsonError("Too many requests. Please try again in a minute.", 429);
  }

  const normalizedEmail = candidateEmail.toLowerCase();
  const cleanName =
    typeof name === "string" && name.trim()
      ? name.trim().slice(0, MAX_NAME_LENGTH)
      : null;

  try {
    // Opaque success for both a fresh insert and a duplicate, never reveal
    // whether the email was already on the list (that is an account-enumeration
    // oracle). Dedupe is still enforced in Postgres; the client just can't probe it.
    await saveSignup(normalizedEmail, cleanName);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("Waitlist signup failed", err);
    return jsonError("Could not save your email. Please try again.", 502);
  }
}
