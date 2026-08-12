import { describe, expect, it, vi } from "vitest";
import { MuonApiClient } from "../src/api-client.js";

describe("MuonApiClient active dispatch listing", () => {
  it("requests only un-interrupted active jobs with an explicit page size", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jobs: [] }),
    })) as unknown as typeof fetch;
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    await client.listDispatchJobs({ activeOnly: true, limit: 200 });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch?activeOnly=true&limit=200",
      expect.any(Object)
    );
  });

  it("requests the newest exact active root for restart recovery", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ jobs: [] }),
    })) as unknown as typeof fetch;
    const client = new MuonApiClient(
      "http://127.0.0.1:4000",
      fetcher,
      "operator-token"
    );

    await client.listDispatchJobs({
      chatId: "chat-1",
      activeRootOnly: true,
      latest: true,
      limit: 1,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/dispatch?chatId=chat-1&activeRootOnly=true&latest=true&limit=1",
      expect.any(Object)
    );
  });
});
