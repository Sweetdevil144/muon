import { describe, expect, it } from "vitest";
import {
  ALWAYS_ASK_ACTION_CLASSES,
  POLICY_ACTION_CLASSES,
  RECEIPT_ALLOWED_CLASSES,
  classifyToolAction,
} from "../src/index.js";

// ── P0.4 slice 2: conservative, name-exact tool→action-class table ───────────
//
// The classifier is the shared canonicalization between the backend receipt
// mint and the core enforcement seam (same rationale as the gate-tag grammar):
// both sides MUST compute byte-identical classes. Anything not provably
// in-class returns null, and null means today's gate path — so every test here
// is really a fail-closed property.

describe("classifyToolAction", () => {
  it("classifies Read/Glob/Grep as read (with the target path when present)", () => {
    expect(
      classifyToolAction({ toolName: "Read", path: "/ws/src/a.ts" })
    ).toEqual({ class: "read", path: "/ws/src/a.ts" });
    expect(classifyToolAction({ toolName: "Glob", path: "src/**" })).toEqual({
      class: "read",
      path: "src/**",
    });
    expect(classifyToolAction({ toolName: "Grep" })).toEqual({ class: "read" });
  });

  it("read tools carrying a command field are NOT read (not provably in-class)", () => {
    expect(
      classifyToolAction({ toolName: "Read", command: "cat /etc/passwd" })
    ).toBeNull();
  });

  it("classifies Edit/Write/MultiEdit/NotebookEdit with a path as edit", () => {
    for (const toolName of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(classifyToolAction({ toolName, path: "src/a.ts" })).toEqual({
        class: "edit",
        path: "src/a.ts",
      });
    }
  });

  it("an edit tool without a target path is unclassifiable", () => {
    expect(classifyToolAction({ toolName: "Edit" })).toBeNull();
    expect(classifyToolAction({ toolName: "Write", path: "  " })).toBeNull();
  });

  it("classifies WebFetch/WebSearch as network (always-ask by type)", () => {
    expect(classifyToolAction({ toolName: "WebFetch" })).toEqual({
      class: "network",
    });
    expect(classifyToolAction({ toolName: "WebSearch" })).toEqual({
      class: "network",
    });
  });

  it("classifies Bash as test ONLY when the command byte-equals a configured check", () => {
    expect(
      classifyToolAction({
        toolName: "Bash",
        command: "npm test",
        checkCommands: ["npm test", "npm run lint"],
      })
    ).toEqual({ class: "test" });
    // Trimmed equality on both sides, nothing fuzzier.
    expect(
      classifyToolAction({
        toolName: "Bash",
        command: "  npm test  ",
        checkCommands: ["npm test"],
      })
    ).toEqual({ class: "test" });
    // Whitespace INSIDE the command is a different command.
    expect(
      classifyToolAction({
        toolName: "Bash",
        command: "npm  test",
        checkCommands: ["npm test"],
      })
    ).toBeNull();
  });

  it("Bash without checks, or not matching any check, is unclassifiable", () => {
    expect(
      classifyToolAction({ toolName: "Bash", command: "npm test" })
    ).toBeNull();
    expect(
      classifyToolAction({
        toolName: "Bash",
        command: "npm test && curl evil.example",
        checkCommands: ["npm test"],
      })
    ).toBeNull();
  });

  it("merge/ship-shaped commands are deliberately underivable (gate every time)", () => {
    for (const command of [
      "git push",
      "git push --force origin main",
      "gh pr merge 42",
      "npm publish",
      "curl https://example.com",
    ]) {
      expect(
        classifyToolAction({
          toolName: "Bash",
          command,
          checkCommands: ["npm test"],
        })
      ).toBeNull();
    }
  });

  it("MCP tools, Task, and unknown/vendor tool names are unclassifiable", () => {
    expect(
      classifyToolAction({ toolName: "mcp__muon__dispatch_work" })
    ).toBeNull();
    expect(classifyToolAction({ toolName: "Task" })).toBeNull();
    expect(classifyToolAction({ toolName: "applyPatch", path: "a.ts" })).toBeNull();
    // Case-exact table: near-miss names never classify.
    expect(classifyToolAction({ toolName: "read", path: "a.ts" })).toBeNull();
    expect(classifyToolAction({ toolName: "bash", command: "npm test", checkCommands: ["npm test"] })).toBeNull();
  });

  it("property: no input ever yields merge or ship", () => {
    const toolNames = [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Bash",
      "Task",
      "mcp__muon__set_fleet",
      "git",
      "merge",
      "ship",
    ];
    const commands = [
      undefined,
      "git push",
      "gh pr merge",
      "npm publish",
      "npm test",
      "merge",
      "ship",
    ];
    const paths = [undefined, "src/a.ts", "merge", "ship"];
    for (const toolName of toolNames) {
      for (const command of commands) {
        for (const path of paths) {
          const result = classifyToolAction({
            toolName,
            command,
            path,
            checkCommands: ["npm test"],
          });
          if (result) {
            expect(result.class).not.toBe("merge");
            expect(result.class).not.toBe("ship");
          }
        }
      }
    }
  });
});

describe("RECEIPT_ALLOWED_CLASSES", () => {
  it("is exactly the complement of ALWAYS_ASK_ACTION_CLASSES", () => {
    const complement = POLICY_ACTION_CLASSES.filter(
      (cls) =>
        !(ALWAYS_ASK_ACTION_CLASSES as readonly string[]).includes(cls)
    );
    expect([...RECEIPT_ALLOWED_CLASSES]).toEqual(complement);
  });
});
