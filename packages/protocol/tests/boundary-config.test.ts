import { describe, expect, it } from "vitest";
import {
  boundaryHookEntrySchema,
  cursorHooksBoundarySchema,
  serializeCursorHooksBoundary,
} from "../src/boundary-config.js";

describe("boundaryHookEntrySchema — failClosed is required", () => {
  const base = {
    type: "command" as const,
    command: "true",
    matcher: "^Task$",
  };

  it("accepts an entry that names failClosed explicitly", () => {
    expect(
      boundaryHookEntrySchema.parse({ ...base, failClosed: true })
    ).toMatchObject({ failClosed: true });
  });

  it("refuses an entry that omits failClosed (Cursor's default is fail-open)", () => {
    expect(() => boundaryHookEntrySchema.parse(base)).toThrow();
  });

  it("refuses an entry that sets failClosed to fail-open", () => {
    const parsed = boundaryHookEntrySchema.safeParse({
      ...base,
      failClosed: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.failClosed).toBe(false);
  });
});

describe("cursorHooksBoundarySchema", () => {
  it("refuses a hooks document when any preToolUse entry omits failClosed", () => {
    expect(() =>
      cursorHooksBoundarySchema.parse({
        version: 1,
        hooks: {
          preToolUse: [
            { type: "command", command: "true", matcher: "Task" },
          ],
        },
      })
    ).toThrow();
  });

  it("serializes with trailing newline through serializeCursorHooksBoundary", () => {
    const out = serializeCursorHooksBoundary({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            command: "cat >/dev/null; printf '%s' '{\"permission\":\"deny\"}'",
            matcher: "^Task$",
            failClosed: true,
          },
        ],
      },
    });
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trimEnd()) as {
      hooks: { preToolUse: { failClosed: boolean }[] };
    };
    expect(parsed.hooks.preToolUse[0]?.failClosed).toBe(true);
  });
});
