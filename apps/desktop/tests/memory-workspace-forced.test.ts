import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ── ADR-0026 §9 — VERIFY the desktop's "already fenced" claim ─────────────────
//
// ADR-0026 §1 corrects the reported framing: the desktop Memory panel does NOT span
// workspaces, because `main.ts` refuses without a bound chat and OVERRIDES any caller
// `chatId`. The instruction was to verify that before trusting it, and this is the
// verification — plus the new half, that `workspace` is now forced the same way to
// close §6's foreign-`scope:"global"` hole.
//
// STRUCTURAL, and deliberately so. The desktop's renderer-side tests mock the IPC
// bridge, so they exercise what the RENDERER sends and can never observe main
// overriding it. Spinning Electron's main process up in vitest to assert one object
// spread would cost far more than it proves. What actually matters here is a property
// of the source — the bound values come LAST in the spread, so a renderer value
// cannot win — and that is what is asserted.
//
// The load-bearing detail is ORDER. `{ ...query, chatId }` fences; `{ chatId,
// ...query }` does not, and the two differ by nothing a reviewer's eye catches.

const MAIN = readFileSync(
  path.join(import.meta.dirname, "..", "src", "main.ts"),
  "utf8"
);

function handlerBody(channel: string): string {
  const start = MAIN.indexOf(`"${channel}"`);
  expect(start).toBeGreaterThan(-1);
  // Bounded to the next ipcMain.handle registration, so an assertion below can never
  // be satisfied by a different handler's code.
  const next = MAIN.indexOf("ipcMain.handle(", start);
  return MAIN.slice(start, next === -1 ? MAIN.length : next);
}

describe("ADR-0026 §9: the desktop forces BOTH partition coordinates", () => {
  const library = handlerBody("muon:memoryLibrary");

  it("refuses to read memory at all without a bound chat", () => {
    expect(library).toContain("Select a chat before opening memory.");
  });

  it("reads the workspace from the BOUND state, never from the renderer", () => {
    expect(library).toContain("const workspace = boundWorkspace;");
    // `boundWorkspace` is assigned only by `bindWorkspace`, which the state poll
    // calls with the bound chat's own `workspacePath` — so the label and the fence
    // come from the same place the chat does.
    expect(MAIN).toContain("bindWorkspace(nextBoundChat?.workspacePath)");
  });

  it("puts both bound coordinates AFTER the spread, so a caller value cannot win", () => {
    const spread = library.indexOf("...query,");
    const chat = library.indexOf("chatId,", spread);
    const workspace = library.indexOf("workspace ? { workspace }", spread);
    expect(spread).toBeGreaterThan(-1);
    expect(chat).toBeGreaterThan(spread);
    expect(workspace).toBeGreaterThan(spread);
  });

  it("does the same on the HERO GATE, where an anchor collision would matter most", () => {
    const preedit = handlerBody("muon:preEditContext");
    expect(preedit).toContain("Select a chat before loading pre-edit evidence.");
    expect(preedit).toContain("const workspace = boundWorkspace;");
    const spread = preedit.indexOf("...input,");
    expect(spread).toBeGreaterThan(-1);
    expect(preedit.indexOf("chatId,", spread)).toBeGreaterThan(spread);
    expect(preedit.indexOf("workspace ? { workspace }", spread)).toBeGreaterThan(
      spread
    );
  });

  it("re-authorizes permanent forget against the bound partition in main", () => {
    const deletion = handlerBody("muon:deleteMemoryNote");
    expect(deletion).toContain("Select a chat before forgetting memory.");
    expect(deletion).toContain("client.getMemoryNote(input.noteId, {");
    expect(deletion).toContain("chatId,");
    expect(deletion).toContain("workspace: boundWorkspace ?? undefined,");
    expect(deletion).toContain("note.chatId !== chatId");
    expect(deletion).toContain(
      "selectionVersion !== boundChatSelectionVersion"
    );
    expect(deletion).toContain(
      "client.deleteMemoryNote(input.noteId, { chatId })"
    );
  });
});
