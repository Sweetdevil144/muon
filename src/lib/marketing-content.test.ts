import { describe, expect, it } from "vitest";
import {
  faqItems,
  forbiddenPublicTerms,
  homeStory,
  integrationStatus,
  surfaceProof,
} from "./marketing-content";

function collectMarketingText(): string {
  return JSON.stringify({
    homeStory,
    faqItems,
    integrationStatus,
    surfaceProof,
  });
}

describe("marketing-content", () => {
  it("does not use forbidden overclaim or internal jargon on public surfaces", () => {
    const text = collectMarketingText().toLowerCase();
    for (const term of forbiddenPublicTerms) {
      expect(text, `forbidden term leaked: ${term}`).not.toContain(term);
    }
  });

  it("avoids em dashes, semicolons, and eng jargon in buyer copy", () => {
    const text = collectMarketingText();
    expect(text).not.toContain("—");
    expect(text).not.toContain(";");
    expect(text.toLowerCase()).not.toContain("managed lane");
    expect(text.toLowerCase()).not.toContain("dispatch-ready");
    expect(text.toLowerCase()).not.toContain("worktree");
    expect(text.toLowerCase()).not.toContain("preflight");
    expect(text.toLowerCase()).not.toContain("deny-first");
  });

  it("explains MUON in plain language a non-technical reader can follow", () => {
    const questions = faqItems.map((item) => item.question.toLowerCase());
    const answers = faqItems.map((item) => item.answer.toLowerCase()).join("\n");

    expect(questions.some((q) => q.includes("what is muon"))).toBe(true);
    expect(questions.some((q) => q.includes("stay in control"))).toBe(true);
    expect(homeStory.intro.toLowerCase()).toContain("work together");
    expect(answers).toContain("coding tools");
    expect(answers).toContain("safe copies");
    expect(surfaceProof.some((s) => s.name === "Your AI chat")).toBe(true);
    expect(
      integrationStatus.every((lane) =>
        ["Claude Code", "Codex", "Cursor", "OpenCode"].includes(lane.name)
      )
    ).toBe(true);
  });
});
