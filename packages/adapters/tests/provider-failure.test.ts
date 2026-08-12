import { describe, expect, it } from "vitest";
import { boundedProviderFailure } from "../src/provider-failure.js";

describe("boundedProviderFailure", () => {
  it("redacts shell, URL, JSON, compact JSON, and authorization credentials", () => {
    const failure = boundedProviderFailure(
      [
        "AZURE_OPENAI_API_KEY=AZURE_SECRET",
        "AZURE_STORAGE_CONNECTION_STRING='AZURE_CONNECTION_SECRET'",
        "https://example.test?api_key=URL_SECRET",
        '{"accessToken":"ACCESS_SECRET","clientSecret":"CLIENT_SECRET"}',
        "Authorization: Basic BASIC_SECRET",
      ].join(" ")
    );

    for (const secret of [
      "AZURE_SECRET",
      "AZURE_CONNECTION_SECRET",
      "URL_SECRET",
      "ACCESS_SECRET",
      "CLIENT_SECRET",
      "BASIC_SECRET",
    ]) {
      expect(failure).not.toContain(secret);
    }
  });

  it("does not redact unrelated words that happen to end in key", () => {
    expect(
      boundedProviderFailure("monkey=banana hockey=score")
    ).toBe("monkey=banana hockey=score");
  });

  it("bounds hostile values whose string conversion throws", () => {
    const hostile = {
      toString() {
        throw new Error("conversion failed");
      },
    };

    expect(boundedProviderFailure(hostile)).toBe(
      "Unknown provider failure"
    );
  });
});
