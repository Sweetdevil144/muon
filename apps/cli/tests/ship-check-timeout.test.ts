import { describe, expect, it } from "vitest";
import { runCheck } from "../src/commands/ship.js";

describe("ship runCheck timeout (Wave 1 no-silent-hang)", () => {
  it("bounds a hung check and resolves as a FAILURE, never blocks forever", async () => {
    // `sleep 30` would block the ship path for 30s; the watchdog must SIGTERM it
    // and resolve exit 1 with an honest "timed out" tail well before then.
    const startedAt = Date.now();
    const result = await runCheck("sleep 30", process.cwd(), 150);
    expect(result.exitCode).toBe(1);
    expect(result.tail).toMatch(/timed out after/i);
    // Resolved at the bound, not after the child's natural 30s lifetime.
    expect(Date.now() - startedAt).toBeLessThan(3000);
  }, 5000);

  it("refuses a shell-operator command loudly instead of running it", async () => {
    const result = await runCheck("echo hi && rm -rf /", process.cwd(), 1000);
    expect(result.exitCode).toBe(1);
    expect(result.tail).toMatch(/refused/i);
  });

  it("passes a fast, clean check through with its real exit code", async () => {
    const result = await runCheck("true", process.cwd(), 5000);
    expect(result.exitCode).toBe(0);
  });
});
