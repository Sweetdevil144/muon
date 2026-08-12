import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_LEVEL,
  requestLogFields,
  requestLogLevel,
  resolveLogLevel,
} from "../src/lib/request-log.js";

describe("brain request logging policy", () => {
  it("demotes read/poll traffic to debug so 2s polling cannot bury real events", () => {
    expect(requestLogLevel("GET", 200)).toBe("debug");
    expect(requestLogLevel("get", 304)).toBe("debug");
    expect(requestLogLevel("HEAD", 200)).toBe("debug");
    expect(requestLogLevel("OPTIONS", 204)).toBe("debug");
  });

  it("keeps every state-changing request at info", () => {
    expect(requestLogLevel("POST", 201, "/api/dispatch")).toBe("info");
    expect(requestLogLevel("PATCH", 200, "/api/tasks/t1")).toBe("info");
    expect(requestLogLevel("DELETE", 204, "/api/chats/c1")).toBe("info");
    // A launch-time write stays visible; only the recurring heartbeat is hidden.
    expect(requestLogLevel("POST", 200, "/api/runner/lease")).toBe("info");
  });

  it("demotes the runner heartbeat — a write by method, a poll in fact", () => {
    expect(requestLogLevel("POST", 200, "/api/runner/heartbeat")).toBe("debug");
    // …but never hides a FAILING heartbeat, which is real diagnostic evidence.
    expect(requestLogLevel("POST", 409, "/api/runner/heartbeat")).toBe("warn");
  });

  it("never hides a failure, whatever the method", () => {
    expect(requestLogLevel("GET", 401)).toBe("warn");
    expect(requestLogLevel("GET", 404)).toBe("warn");
    expect(requestLogLevel("GET", 500)).toBe("error");
    expect(requestLogLevel("POST", 409)).toBe("warn");
    expect(requestLogLevel("POST", 503)).toBe("error");
  });

  it("logs coordinates only — never headers, never a query string", () => {
    expect(
      requestLogFields({
        method: "GET",
        url: "/api/streams?taskId=abc&token=should-not-be-logged",
        statusCode: 200,
        durationMs: 12.7,
      })
    ).toEqual({ method: "GET", url: "/api/streams", status: 200, ms: 13 });
  });

  it("takes the level from MUON_LOG_LEVEL and ignores a bogus value", () => {
    expect(resolveLogLevel({})).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel({ MUON_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ MUON_LOG_LEVEL: " TRACE " })).toBe("trace");
    // A typo must never silence the brain — fall back to the default.
    expect(resolveLogLevel({ MUON_LOG_LEVEL: "verbose" })).toBe(
      DEFAULT_LOG_LEVEL
    );
  });
});
