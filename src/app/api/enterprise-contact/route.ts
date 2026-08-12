import { NextResponse } from "next/server";
import { saveEnterpriseContact } from "@/lib/enterprise-contact-store";

// Runs on Vercel's serverless (Node.js) runtime, never at the edge, so the
// Postgres connection stays server-side and is never shipped to the browser.
export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
const MAX_ROLE_LENGTH = 120;
const MAX_COMPANY_LENGTH = 200;
const MAX_PHONE_LENGTH = 40;
const MAX_PROBLEM_LENGTH = 4000;
const MAX_BODY_BYTES = 12_288;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const recentHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
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

function cleanRequiredString(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

export async function POST(request: Request) {
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

  const {
    fullName,
    role,
    company,
    companyEmail,
    phoneNumber,
    problemDescription,
    website,
  } =
    (body as {
      fullName?: unknown;
      role?: unknown;
      company?: unknown;
      companyEmail?: unknown;
      phoneNumber?: unknown;
      problemDescription?: unknown;
      website?: unknown;
    }) ?? {};

  // Honeypot: real users never fill the hidden "website" field.
  if (typeof website === "string" && website.trim() !== "") {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const cleanFullName = cleanRequiredString(fullName, MAX_NAME_LENGTH);
  const cleanRole = cleanRequiredString(role, MAX_ROLE_LENGTH);
  const cleanCompany = cleanRequiredString(company, MAX_COMPANY_LENGTH);
  const cleanProblem = cleanRequiredString(
    problemDescription,
    MAX_PROBLEM_LENGTH
  );
  const candidateEmail =
    typeof companyEmail === "string" ? companyEmail.trim() : "";

  if (!cleanFullName) {
    return jsonError("Please enter your full name.", 400);
  }
  if (!cleanRole) {
    return jsonError("Please enter your role.", 400);
  }
  if (!cleanCompany) {
    return jsonError("Please enter your company.", 400);
  }
  if (
    !candidateEmail ||
    candidateEmail.length > MAX_EMAIL_LENGTH ||
    !EMAIL_RE.test(candidateEmail)
  ) {
    return jsonError("Please enter a valid company email.", 400);
  }
  if (!cleanProblem) {
    return jsonError("Please describe the problem you are trying to solve.", 400);
  }

  let cleanPhone: string | null = null;
  if (typeof phoneNumber === "string" && phoneNumber.trim()) {
    const trimmed = phoneNumber.trim();
    if (trimmed.length > MAX_PHONE_LENGTH) {
      return jsonError("Phone number is too long.", 400);
    }
    cleanPhone = trimmed;
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (isRateLimited(ip)) {
    return jsonError("Too many requests. Please try again in a minute.", 429);
  }

  try {
    await saveEnterpriseContact({
      fullName: cleanFullName,
      role: cleanRole,
      company: cleanCompany,
      companyEmail: candidateEmail.toLowerCase(),
      phoneNumber: cleanPhone,
      problemDescription: cleanProblem,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("Enterprise contact submit failed", err);
    return jsonError("Could not send your message. Please try again.", 502);
  }
}
