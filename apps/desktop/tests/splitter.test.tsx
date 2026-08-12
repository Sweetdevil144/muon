// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Splitter } from "../src/renderer/splitter.js";

// ── Task 3 (resizable panels) — the splitter's a11y contract + keyboard math.
// Pointer-drag is covered indirectly (jsdom has no real layout/pointer capture
// to assert pixel deltas against); the keyboard path exercises the same
// `sign`-aware math the drag handler shares, so it stands in for both.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Splitter", () => {
  it("exposes the separator a11y contract", () => {
    render(
      React.createElement(Splitter, {
        label: "Resize sidebar",
        value: 300,
        min: 200,
        max: 420,
        sign: 1,
        onChange: vi.fn(),
      })
    );
    const el = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.getAttribute("aria-valuenow")).toBe("300");
    expect(el.getAttribute("aria-valuemin")).toBe("200");
    expect(el.getAttribute("aria-valuemax")).toBe("420");
    expect(el.tabIndex).toBe(0);
  });

  it("sign=+1 (panel to the LEFT, e.g. the sidebar): ArrowRight grows, ArrowLeft shrinks", () => {
    const onChange = vi.fn();
    render(
      React.createElement(Splitter, {
        label: "Resize sidebar",
        value: 300,
        min: 200,
        max: 420,
        sign: 1,
        onChange,
      })
    );
    const el = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(284);
  });

  it("sign=-1 (panel to the RIGHT, e.g. the context dock): ArrowLeft grows, ArrowRight shrinks", () => {
    const onChange = vi.fn();
    render(
      React.createElement(Splitter, {
        label: "Resize panel",
        value: 320,
        min: 260,
        max: 520,
        sign: -1,
        onChange,
      })
    );
    const el = screen.getByRole("separator", { name: "Resize panel" });
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(336);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(304);
  });

  it("Home jumps to min, End jumps to max", () => {
    const onChange = vi.fn();
    render(
      React.createElement(Splitter, {
        label: "Resize sidebar",
        value: 300,
        min: 200,
        max: 420,
        sign: 1,
        onChange,
      })
    );
    const el = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(el, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(200);
    fireEvent.keyDown(el, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(420);
  });

  it("ignores unrelated keys", () => {
    const onChange = vi.fn();
    render(
      React.createElement(Splitter, {
        label: "Resize sidebar",
        value: 300,
        min: 200,
        max: 420,
        sign: 1,
        onChange,
      })
    );
    const el = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(el, { key: "Tab" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
