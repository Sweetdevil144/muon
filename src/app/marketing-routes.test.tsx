import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DownloadPage from "./download/page";
import EnterprisePage from "./enterprise/page";
import FaqPage from "./faq/page";
import HowItWorksPage from "./how-it-works/page";
import LicensesPage from "./licenses/page";
import PricingPage from "./pricing/page";
import PrivacyPage from "./privacy/page";
import ProductPage from "./product/page";
import SecurityPage from "./security/page";
import TermsPage from "./terms/page";
import AgentLanesPage from "./product/agent-lanes/page";
import ApprovalsPage from "./product/approvals/page";
import CommandCenterPage from "./product/command-center/page";
import HandoffsPage from "./product/handoffs/page";
import HumanControlPage from "./product/human-control/page";
import SharedMemoryPage from "./product/shared-memory/page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/product",
}));

describe("dedicated marketing routes", () => {
  it.each([
    [ProductPage, "One control layer for your AI engineering crew"],
    [HowItWorksPage, "One mission in. One reviewed result out."],
    [PricingPage, "Free for individuals. Team pricing on request."],
    [EnterprisePage, "Scale agent work without scaling coordination overhead"],
    [SecurityPage, "Security and trust boundaries"],
    [FaqPage, "Answers before you evaluate"],
    [CommandCenterPage, "See the mission, the crew, and the decisions"],
    [SharedMemoryPage, "Give every agent memory, and the crew a shared view"],
    [ApprovalsPage, "Make every yes cover one clear action"],
    [HandoffsPage, "Move work forward without rebuilding the brief"],
    [AgentLanesPage, "Give every tool a clear job"],
    [HumanControlPage, "Automate the busywork. Keep the accountability."],
    [DownloadPage, "MUON is a free download."],
    [PrivacyPage, "Your data stays on your machine"],
    [TermsPage, "Terms of use"],
    [LicensesPage, "MUON's license and third-party notices"],
  ])("%s renders intentional page content", (Page, heading) => {
    render(<Page />);

    expect(
      screen.getByRole("heading", { level: 1, name: heading })
    ).toBeTruthy();
  });
});
