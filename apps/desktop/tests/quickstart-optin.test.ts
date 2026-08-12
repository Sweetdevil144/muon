import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BUG 2: the quickstart sample task must be OPT-IN ONLY — it may never be seeded
// or dispatched merely because the user opened/chose a directory. The only path
// that seeds it is the explicit "Run your first task" action (muon:runFirstTask).
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

/** Byte span of a single ipcMain handler by its channel name. */
function handlerSpan(channel: string): string {
  const start = source.indexOf(`"${channel}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  // The next handler registration (or end of file) bounds this one.
  const next = source.indexOf("ipcMain.handle(", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("quickstart is opt-in only (BUG 2)", () => {
  it("seeds the sample ONLY inside the explicit muon:runFirstTask handler", () => {
    // Every seed call site lives within the runFirstTask handler's span.
    const runFirstTask = handlerSpan("muon:runFirstTask");
    expect(runFirstTask).toContain("seedQuickstartTask(");

    // There is exactly one seed call site in the whole main process.
    const seedCallSites = source.split("seedQuickstartTask(").length - 1;
    expect(seedCallSites).toBe(1);
  });

  it("does NOT seed a sample when a directory is merely picked or a chat opened", () => {
    // Folder pick and chat creation (the "open a workspace" path) are plain,
    // non-seeding handlers — opening a directory never seeds a sample task.
    expect(handlerSpan("muon:pickFolder")).not.toContain("seedQuickstartTask");
    expect(handlerSpan("muon:createChat")).not.toContain("seedQuickstartTask");
  });

  it("does NOT seed or dispatch a sample on app startup", () => {
    // whenReady bootstraps the app; it must never auto-run the first task.
    const boot = source.slice(source.indexOf("app.whenReady()"));
    expect(boot).not.toContain("seedQuickstartTask");
    expect(boot).not.toContain("runFirstTask(");
    expect(boot).not.toContain("waitForFirstTaskCompletion");
  });
});
