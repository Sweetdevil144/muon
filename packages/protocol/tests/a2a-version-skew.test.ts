import { describe, expect, it } from "vitest";
import {
  A2A_PROTOCOL_VERSION,
  detectA2AVersionSkew,
} from "../src/a2a.js";
import { REFUSAL_RULES } from "../src/refusal.js";

describe("detectA2AVersionSkew (round-3 #4)", () => {
  it("detects a skewed version at the top level", () => {
    expect(detectA2AVersionSkew({ version: 2, unread: 0 })).toBe(2);
  });

  it("detects a skewed version one level down — wrapped message and snapshot", () => {
    expect(detectA2AVersionSkew({ message: { version: 99 } })).toBe(99);
    expect(detectA2AVersionSkew({ snapshot: { version: 0 } })).toBe(0);
  });

  it("detects a skewed version on ANY element of a child array — mixed pages included", () => {
    expect(
      detectA2AVersionSkew({ messages: [{ version: 7 }], unread: 1 })
    ).toBe(7);
    // The staged-swap scenario the refusal exists for: the first row is the
    // old, VALID version and a later row is the new one (review finding #11).
    expect(
      detectA2AVersionSkew({
        messages: [
          { version: A2A_PROTOCOL_VERSION },
          { version: A2A_PROTOCOL_VERSION },
          { version: 2 },
        ],
        unread: 3,
      })
    ).toBe(2);
  });

  it("non-integer versions are not skew — a random API's {version: 2.1} stays a parse error", () => {
    expect(detectA2AVersionSkew({ version: 2.1 })).toBeNull();
  });

  it("returns null for the current version — a matching envelope is not skew", () => {
    expect(
      detectA2AVersionSkew({ version: A2A_PROTOCOL_VERSION })
    ).toBeNull();
    expect(
      detectA2AVersionSkew({ message: { version: A2A_PROTOCOL_VERSION } })
    ).toBeNull();
  });

  it("returns null when no numeric version exists anywhere it looks", () => {
    expect(detectA2AVersionSkew({})).toBeNull();
    expect(detectA2AVersionSkew(null)).toBeNull();
    expect(detectA2AVersionSkew("v2")).toBeNull();
    expect(detectA2AVersionSkew({ version: "2" })).toBeNull();
    expect(detectA2AVersionSkew({ version: Number.NaN })).toBeNull();
    // Deliberately shallow: two levels down is agent-produced territory.
    expect(
      detectA2AVersionSkew({ outer: { inner: { version: 5 } } })
    ).toBeNull();
  });

  it("the refusal rule discloses the same three coordinates to both audiences", () => {
    // Versions are coordinates, not secrets. If someone narrows the agent's
    // view, an agent can no longer tell WHICH side to report as stale.
    expect(REFUSAL_RULES["protocol.version_skew"].disclose).toEqual({
      agent: ["surface", "expected", "received"],
      operator: ["surface", "expected", "received"],
    });
  });
});
