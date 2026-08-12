import { describe, expect, it } from "vitest";
import { shouldForceGraphRecoveryAfterExit } from "../src/lib/brain.js";

describe("brain native-crash recovery policy", () => {
  it("requests a derived-graph rebuild for unexpected native signals", () => {
    expect(shouldForceGraphRecoveryAfterExit(null, "SIGSEGV", false)).toBe(true);
    expect(shouldForceGraphRecoveryAfterExit(null, "SIGABRT", false)).toBe(true);
  });

  it("recognizes wrappers that encode a native signal as an exit code", () => {
    expect(shouldForceGraphRecoveryAfterExit(139, null, false)).toBe(true);
    expect(shouldForceGraphRecoveryAfterExit(134, null, false)).toBe(true);
  });

  it("does not rebuild for ordinary failures or the supervisor's own stop", () => {
    expect(shouldForceGraphRecoveryAfterExit(1, null, false)).toBe(false);
    expect(shouldForceGraphRecoveryAfterExit(null, "SIGTERM", true)).toBe(false);
  });
});
