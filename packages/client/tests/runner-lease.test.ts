import { describe, expect, it, vi } from "vitest";
import { authorizeRunnerLease } from "../src/runner-lease.js";

describe("authorizeRunnerLease", () => {
  it("uses the operator bearer token on the loopback-only lease endpoint", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      redirected: false,
      status: 200,
      statusText: "OK",
      json: async () => ({ runner: { host: "desktop-mac" } }),
    })) as unknown as typeof fetch;

    await authorizeRunnerLease(
      {
        apiBase: "http://127.0.0.1:4321",
        operatorToken: "operator-token",
      },
      "desktop-mac",
      `lease-${"l".repeat(58)}`,
      fetcher
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/runner/lease",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer operator-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          host: "desktop-mac",
          leaseToken: `lease-${"l".repeat(58)}`,
        }),
        redirect: "error",
      })
    );
  });

  it("refuses non-loopback targets before making a request", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      authorizeRunnerLease(
        {
          apiBase: "https://example.com",
          operatorToken: "operator-token",
        },
        "desktop-mac",
        `lease-${"l".repeat(58)}`,
        fetcher
      )
    ).rejects.toThrow(/loopback/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
