import { describe, expect, it } from "vitest";
import {
  OWNED_PACKAGES,
  buildUninstallPlan,
  confirmPrompt,
  describePlan,
  isAffirmative,
} from "../src/lib/uninstall-plan.js";

const plan = (brainIsLive = false) =>
  buildUninstallPlan({ dataDir: "/home/casey/.local/share/muon", brainIsLive });

describe("what an uninstall removes — and what it must not", () => {
  it("removes the tool and NEVER the data dir", () => {
    // The data dir holds a human-confirmed memory graph. No y/n prompt is
    // informed enough to consent to destroying months of vouched-for
    // decisions, so the plan cannot even express it.
    const result = plan();
    expect(result.remove).toEqual([...OWNED_PACKAGES]);
    expect(result.preserve.map((p) => p.path)).toContain(
      "/home/casey/.local/share/muon"
    );
    // Nothing in the remove list may be a PATH — these are npm package names,
    // and a filesystem path appearing here would mean the plan can delete
    // something on disk.
    for (const target of result.remove) {
      expect(target.startsWith("/"), target).toBe(false);
      expect(target.includes(".."), target).toBe(false);
    }
  });

  it("SAYS what it kept, and why — silence would read as deletion", () => {
    const text = describePlan(plan());
    expect(text).toContain("/home/casey/.local/share/muon");
    expect(text).toMatch(/memory graph/);
    expect(text).toMatch(/separate, manual step/);
  });

  it("stops a LIVE brain first, because it outlives the CLI", () => {
    // The brain is detached. Uninstalling around it strands a process with no
    // supervisor and no `muon shutdown` left to stop it.
    expect(plan(true).stopBrainFirst).toBe(true);
    expect(plan(false).stopBrainFirst).toBe(false);
  });
});

describe("the confirmation defaults to NO", () => {
  it("accepts only an explicit yes", () => {
    for (const yes of ["y", "Y", "yes", "YES", " y ", "Yes"]) {
      expect(isAffirmative(yes), yes).toBe(true);
    }
  });

  it("treats empty, EOF and anything else as no", () => {
    for (const no of ["", " ", "n", "N", "no", "nope", "sure", "1", "yy"]) {
      expect(isAffirmative(no), JSON.stringify(no)).toBe(false);
    }
    expect(isAffirmative(undefined)).toBe(false);
    expect(isAffirmative(null)).toBe(false);
  });

  it("shows the default in the prompt itself", () => {
    // `[y/N]` — the capital is the contract with the reader.
    expect(confirmPrompt()).toContain("[y/N]");
  });
});

// The uninstaller used to print the PLAN as if it were the outcome, so a
// machine that only had `muon-cli` was told `@muon/cli` had been removed too.
// An uninstaller that overstates what it deleted is the last thing anyone can
// independently check.
describe("describePlan reports the real outcome", () => {
  const plan = buildUninstallPlan({
    dataDir: "/tmp/muon-data",
    brainRunning: false,
  });

  it("names only the packages npm actually removed", () => {
    const text = describePlan(plan, ["muon-cli"]);
    expect(text).toContain("Removed: muon-cli");
    expect(text).not.toContain("@muon/cli");
  });

  it("says plainly when npm removed nothing", () => {
    const text = describePlan(plan, []);
    expect(text).toContain("Removed: nothing");
    expect(text).toContain("no MUON package was installed through npm");
  });

  it("still preserves the data dir, and still says why", () => {
    const text = describePlan(plan, ["muon-cli"]);
    expect(text).toContain("Kept:");
    expect(text).toContain("/tmp/muon-data");
  });

  it("defaults to the plan only when no outcome is supplied", () => {
    expect(describePlan(plan)).toContain(plan.remove.join(", "));
  });
});
