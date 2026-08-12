// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_PRESETS } from "../src/lib/presets.js";
import { PresetsBar } from "../src/renderer/presets-bar.js";

afterEach(cleanup);

describe("PresetsBar", () => {
  it("applies a configured preset in one click", () => {
    const onApply = vi.fn();
    render(
      <PresetsBar
        onApply={onApply}
        onSave={vi.fn()}
        presets={DEFAULT_DESKTOP_PRESETS}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /apply balanced preset/i,
      })
    );
    expect(onApply).toHaveBeenCalledWith("balanced");
  });

  it("saves a validated vendor/model/effort/permission preset", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetsBar
        onApply={vi.fn()}
        onSave={onSave}
        presets={DEFAULT_DESKTOP_PRESETS}
      />
    );

    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Deep review" },
    });
    fireEvent.change(screen.getByLabelText("Vendor"), {
      target: { value: "codex" },
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-5-codex" },
    });
    fireEvent.change(screen.getByLabelText("Effort"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText("Permission"), {
      target: { value: "strict" },
    });

    expect(
      screen.queryByRole("option", { name: "full-auto" })
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save preset" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        ...DEFAULT_DESKTOP_PRESETS,
        {
          id: "deep-review",
          name: "Deep review",
          vendor: "codex",
          model: "gpt-5-codex",
          effort: "high",
          permission: "strict",
        },
      ])
    );
  });
});
