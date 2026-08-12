import { describe, expect, it } from "vitest";
import {
  AGENT_CODENAMES,
  agentCodename,
  agentCodenames,
} from "../src/lib/agent-codename.js";

describe("agentCodename", () => {
  it("is deterministic — the same id always maps to the same codename", () => {
    const id = "agent_01H8XYZ";
    const first = agentCodename(id);
    for (let i = 0; i < 100; i += 1) {
      expect(agentCodename(id)).toBe(first);
    }
  });

  it("is stable per id across distinct ids (no shared mutable state)", () => {
    const a = agentCodename("agent-a");
    const b = agentCodename("agent-b");
    // Reading b must not disturb a's mapping.
    expect(agentCodename("agent-a")).toBe(a);
    expect(agentCodename("agent-b")).toBe(b);
  });

  it("only ever returns a name from the curated pool", () => {
    const pool = new Set<string>(AGENT_CODENAMES);
    for (let i = 0; i < 500; i += 1) {
      expect(pool.has(agentCodename(`job_${i}`))).toBe(true);
    }
  });

  it("falls back to the first pool entry for an empty/absent id", () => {
    expect(agentCodename("")).toBe(AGENT_CODENAMES[0]);
    expect(agentCodename(null)).toBe(AGENT_CODENAMES[0]);
    expect(agentCodename(undefined)).toBe(AGENT_CODENAMES[0]);
  });

  it("spreads a realistic crew across distinct codenames", () => {
    const ids = ["a1", "b2", "c3", "d4"].map((s) => `agent_${s}`);
    const names = ids.map(agentCodename);
    // Not a strict guarantee for arbitrary input, but the pool is large enough
    // that a 4-agent crew of these ids lands on 4 distinct base codenames.
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("agentCodenames (crew collision handling)", () => {
  it("keeps bare codenames when there is no collision", () => {
    const ids = ["agent_a1", "agent_b2", "agent_c3"];
    const map = agentCodenames(ids);
    for (const id of ids) {
      // No suffix — the crew-level name equals the bare per-id codename.
      expect(map.get(id)).toBe(agentCodename(id));
    }
  });

  it("suffixes only genuine collisions, first-wins keeps the bare name", () => {
    // Find two ids that hash to the same base codename to force a collision.
    const base = agentCodename("seed");
    const colliders: string[] = ["seed"];
    for (let i = 0; colliders.length < 2 && i < 100000; i += 1) {
      const candidate = `collide_${i}`;
      if (agentCodename(candidate) === base) colliders.push(candidate);
    }
    expect(colliders.length).toBe(2);

    const map = agentCodenames(colliders);
    expect(map.get(colliders[0]!)).toBe(base); // first-wins: bare
    expect(map.get(colliders[1]!)).toBe(`${base} 2`); // collider: suffixed
  });

  it("is deterministic for the same id list in the same order", () => {
    const ids = ["x", "y", "z", "x"]; // dup id collapses to one entry
    const a = agentCodenames(ids);
    const b = agentCodenames(ids);
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.size).toBe(3);
  });
});
