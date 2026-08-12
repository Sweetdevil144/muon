import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("Home", () => {
  it("tells one focused conversion story without duplicating detail pages", () => {
    const { container } = render(<Home />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /make your coding agents work as one/i,
      })
    ).toBeTruthy();
    expect(
      screen.getAllByText(/multi-agent software teams, under control/i).length
    ).toBeGreaterThan(0);
    expect(screen.getByText("The coordination gap", { exact: true })).toBeTruthy();
    expect(screen.getByText(/^trust$/i)).toBeTruthy();
    expect(screen.getByText(/assign the right work/i)).toBeTruthy();
    expect(screen.getByText(/a role for every tool/i)).toBeTruthy();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cursor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(0);
    expect(screen.queryByText("Gemini CLI")).toBeNull();
    expect(screen.queryByText("Kimi Code")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: /install the app/i }).length
    ).toBeGreaterThan(0);

    expect(screen.queryByText("Frequently asked questions")).toBeNull();
    expect(screen.queryByText("Pricing that grows with your crew")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("routes every primary navigation item to a dedicated page", () => {
    render(<Home />);

    expect(
      screen.getAllByRole("link", { name: "Product" })[0].getAttribute("href")
    ).toBe("/product");
    expect(
      screen
        .getAllByRole("link", { name: "How it works" })[0]
        .getAttribute("href")
    ).toBe("/how-it-works");
    expect(
      screen.getAllByRole("link", { name: "Pricing" })[0].getAttribute("href")
    ).toBe("/pricing");
    expect(
      screen.getAllByRole("link", { name: "Enterprise" })[0].getAttribute("href")
    ).toBe("/enterprise");
    expect(
      screen.getAllByRole("link", { name: "FAQ" })[0].getAttribute("href")
    ).toBe("/faq");
    expect(
      screen
        .getAllByRole("link", { name: "Talk to Founder" })[0]
        .getAttribute("href")
    ).toBe("https://cal.com/abhinavpandey/30min");
  });

  it("routes every product submenu item to its own page", () => {
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /open product menu/i }));

    const expectedRoutes = [
      "/product/command-center",
      "/product/shared-memory",
      "/product/approvals",
      "/product/handoffs",
      "/product/agent-lanes",
      "/product/human-control",
    ];

    for (const href of expectedRoutes) {
      expect(document.querySelector(`a[href="${href}"]`)).toBeTruthy();
    }
  });

  it("opens and closes the mobile navigation", () => {
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
    expect(screen.getByRole("button", { name: /close menu/i })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: /mobile navigation/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close menu/i }));
    expect(screen.queryByRole("navigation", { name: /mobile navigation/i })).toBeNull();
  });

  it("submits the homepage beta form and announces success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    try {
      render(<Home />);

      const input = screen.getByLabelText(/work email/i);
      fireEvent.change(input, { target: { value: "builder@example.com" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);

      expect(await screen.findByText(/you.re on the list/i)).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/waitlist",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
