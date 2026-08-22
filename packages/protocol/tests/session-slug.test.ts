import { describe, expect, it } from "vitest";
import { sessionSlug, sessionSlugLine } from "../src/session-slug.js";

// ── H10: the slug is a deterministic display projection, never identity ──────

describe("sessionSlug", () => {
  it("is deterministic: the same id names the same slug on every surface", () => {
    expect(sessionSlug("job-abc123")).toBe(sessionSlug("job-abc123"));
  });

  it("keeps two ids tellable apart even when the words collide", () => {
    // The fragment is the id's TAIL — a cuid's random block, not its
    // timestamp head: 200 same-day cuids share one head but not one tail.
    const a = sessionSlug("one-aaaa");
    const b = sessionSlug("two-bbbb");
    expect(a).not.toBe(b);
    expect(a.endsWith("aaaa")).toBe(true);
    expect(b.endsWith("bbbb")).toBe(true);
  });

  it("same-day cuid-shaped ids with a shared head still get distinct fragments", () => {
    const a = sessionSlug("cmb4k2xw90003r4nd");
    const b = sessionSlug("cmb4k2xw90007q8zx");
    expect(a.endsWith("r4nd")).toBe(true);
    expect(b.endsWith("q8zx")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("is speakable: adjective-noun-fragment, lowercase, no separators to escape", () => {
    expect(sessionSlug("cmb4k2xw90003")).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  });

  it("never throws in a render path: empty id gets an honest placeholder", () => {
    expect(sessionSlug("")).toBe("unnamed-0000");
  });

  it("slug line carries both the name and the coordinate", () => {
    const line = sessionSlugLine("cmb4k2xw90003abcd");
    expect(line).toContain(sessionSlug("cmb4k2xw90003abcd"));
    expect(line).toContain("cmb4k2xw");
  });

  it("the docstring's worked examples are the values the code produces", () => {
    // The docstring used to print a HEAD fragment ("…-cmb4") this function has
    // never produced, which is the kind of confident-but-false doc claim that
    // sends a reader looking for a bug in working code. Pinned so the example
    // and the behaviour cannot drift apart again.
    expect(sessionSlug("cmb4k2xw90003abcd")).toBe("rapid-gale-abcd");
    expect(sessionSlugLine("cmb4k2xw90003abcd")).toBe(
      "rapid-gale-abcd (cmb4k2xw)"
    );
  });
});
