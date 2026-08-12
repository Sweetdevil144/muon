import { beforeEach, describe, expect, it, vi } from "vitest";

const saveEnterpriseContact = vi.fn();
vi.mock("@/lib/enterprise-contact-store", () => ({
  saveEnterpriseContact: (input: unknown) => saveEnterpriseContact(input),
}));

import { POST } from "./route";

let ipCounter = 0;

function makeRequest(
  body: unknown,
  { rawBody }: { rawBody?: string } = {}
): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/enterprise-contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${ipCounter}`,
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

const validBody = {
  fullName: "Ada Lovelace",
  role: "CTO",
  company: "Analytical Engines",
  companyEmail: "Ada@Example.com",
  phoneNumber: "+1 555 0100",
  problemDescription: "We need governed multi-agent coordination across teams.",
};

describe("POST /api/enterprise-contact", () => {
  beforeEach(() => {
    saveEnterpriseContact.mockReset();
  });

  it("validates and stores a well-formed inquiry", async () => {
    saveEnterpriseContact.mockResolvedValue(undefined);

    const res = await POST(makeRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(saveEnterpriseContact).toHaveBeenCalledWith({
      fullName: "Ada Lovelace",
      role: "CTO",
      company: "Analytical Engines",
      companyEmail: "ada@example.com",
      phoneNumber: "+1 555 0100",
      problemDescription:
        "We need governed multi-agent coordination across teams.",
    });
  });

  it("allows an omitted phone number", async () => {
    saveEnterpriseContact.mockResolvedValue(undefined);

    const res = await POST(
      makeRequest({ ...validBody, phoneNumber: undefined })
    );

    expect(res.status).toBe(200);
    expect(saveEnterpriseContact).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: null })
    );
  });

  it("rejects missing required fields without touching the store", async () => {
    const res = await POST(
      makeRequest({ ...validBody, company: "", problemDescription: "   " })
    );

    expect(res.status).toBe(400);
    expect(saveEnterpriseContact).not.toHaveBeenCalled();
  });

  it("rejects an invalid company email", async () => {
    const res = await POST(
      makeRequest({ ...validBody, companyEmail: "not-an-email" })
    );

    expect(res.status).toBe(400);
    expect(saveEnterpriseContact).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing (413)", async () => {
    const huge = JSON.stringify({
      ...validBody,
      problemDescription: "x".repeat(20_000),
    });
    const res = await POST(makeRequest(undefined, { rawBody: huge }));

    expect(res.status).toBe(413);
    expect(saveEnterpriseContact).not.toHaveBeenCalled();
  });

  it("silently accepts a bot that fills the honeypot, without storing", async () => {
    const res = await POST(
      makeRequest({ ...validBody, website: "http://spam.example" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(saveEnterpriseContact).not.toHaveBeenCalled();
  });

  it("returns 502 when the store fails", async () => {
    saveEnterpriseContact.mockRejectedValue(new Error("db down"));

    const res = await POST(makeRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.ok).toBe(false);
  });
});
