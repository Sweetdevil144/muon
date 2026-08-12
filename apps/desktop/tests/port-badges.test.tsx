// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePortBadges } from "../src/renderer/port-badges.js";

afterEach(() => {
  cleanup();
});

describe("WorkspacePortBadges", () => {
  it("renders static badges when preview is off", () => {
    render(
      <WorkspacePortBadges
        ports={[
          {
            pid: 1,
            port: 3000,
            address: "127.0.0.1",
            command: "node",
          },
        ]}
        previewEnabled={false}
      />
    );
    expect(screen.getByLabelText("Listening port 3000")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens preview only for localhost binds when enabled", () => {
    const onPreview = vi.fn();
    render(
      <WorkspacePortBadges
        ports={[
          { pid: 1, port: 3000, address: "127.0.0.1" },
          { pid: 2, port: 8080, address: "0.0.0.0" },
        ]}
        previewEnabled
        onPreview={onPreview}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview localhost port 3000" }));
    expect(onPreview).toHaveBeenCalledWith(3000);
    expect(screen.queryByRole("button", { name: /8080/ })).toBeNull();
  });
});
