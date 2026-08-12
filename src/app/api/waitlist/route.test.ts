import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the durable store so the route test never touches a real database.
const saveSignup = vi.fn();
vi.mock("@/lib/waitlist-store", () => ({
  saveSignup: (email: string, name: string | null) => saveSignup(email, name),
}));

import { POST } from "./route";

let ipCounter = 0;

function makeRequest(
  body: unknown,
  { rawBody }: { rawBody?: string } = {}
): Request {
  // Unique IP per request so the per-instance rate limiter never bleeds
  // between test cases.
  ipCounter += 1;
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${ipCounter}`,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

describe("POST /api/waitlist", () => {
  beforeEach(() => {
    saveSignup.mockReset();
  });

  it("validates and stores a well-formed email (normalized to lowercase)", async () => {
    saveSignup.mockResolvedValue("inserted");

    const res = await POST(makeRequest({ email: "Builder@Example.com" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(saveSignup).toHaveBeenCalledTimes(1);
    expect(saveSignup).toHaveBeenCalledWith("builder@example.com", null);
  });

  it("passes an optional name through, trimmed", async () => {
    saveSignup.mockResolvedValue("inserted");

    const res = await POST(
      makeRequest({ email: "a@b.co", name: "  Ada Lovelace  " })
    );
    await res.json();

    expect(saveSignup).toHaveBeenCalledWith("a@b.co", "Ada Lovelace");
  });

  it("dedupes: a duplicate signup succeeds with an OPAQUE response (no enumeration oracle)", async () => {
    saveSignup.mockResolvedValue("duplicate");

    const res = await POST(makeRequest({ email: "dupe@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    // Identical to a fresh insert, the client cannot tell whether the email
    // was already registered.
    expect(json).toEqual({ ok: true });
    expect(saveSignup).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized body before parsing (413)", async () => {
    const huge = JSON.stringify({ email: "a@b.co", name: "x".repeat(5000) });
    const res = await POST(makeRequest(undefined, { rawBody: huge }));

    expect(res.status).toBe(413);
    expect(saveSignup).not.toHaveBeenCalled();
  });

  it("rejects an invalid email without touching the store", async () => {
    const res = await POST(makeRequest({ email: "not-an-email" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(saveSignup).not.toHaveBeenCalled();
  });

  it("rejects a missing email", async () => {
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(400);
    expect(saveSignup).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body", async () => {
    const res = await POST(makeRequest(undefined, { rawBody: "{not json" }));

    expect(res.status).toBe(400);
    expect(saveSignup).not.toHaveBeenCalled();
  });

  it("silently accepts a bot that fills the honeypot, without storing", async () => {
    const res = await POST(
      makeRequest({ email: "bot@example.com", website: "http://spam.example" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(saveSignup).not.toHaveBeenCalled();
  });

  it("returns 502 when the store fails", async () => {
    saveSignup.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest({ email: "fail@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.ok).toBe(false);
  });
});
