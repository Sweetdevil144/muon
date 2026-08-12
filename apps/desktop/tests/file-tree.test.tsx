// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileTree,
  FileTree,
} from "../src/renderer/file-tree.js";

afterEach(cleanup);

describe("A2 FileTree", () => {
  it("groups changed paths into a deterministic folder hierarchy", () => {
    const tree = buildFileTree([
      "apps/desktop/src/renderer/right-panel.tsx",
      "apps/desktop/tests/right-panel.test.tsx",
      "README.md",
      "apps/desktop/src/renderer/right-panel.tsx",
    ]);

    expect(tree.files.map((file) => file.name)).toEqual(["README.md"]);
    expect(tree.folders.map((folder) => folder.name)).toEqual(["apps"]);
    const desktop = tree.folders[0]?.folders[0];
    expect(desktop?.name).toBe("desktop");
    expect(desktop?.folders.map((folder) => folder.name)).toEqual([
      "src",
      "tests",
    ]);
    expect(
      desktop?.folders[0]?.folders[0]?.files.map((file) => file.name)
    ).toEqual(["right-panel.tsx"]);
  });

  it("renders folders with per-file additions/deletions and binary badges", () => {
    render(
      React.createElement(FileTree, {
        files: [
          "src/renderer/app.tsx",
          "src/renderer/styles.css",
          "assets/muon.png",
          "PLAN.md",
        ],
        fileStats: [
          {
            path: "src/renderer/app.tsx",
            additions: 28,
            deletions: 4,
            binary: false,
          },
          {
            path: "src/renderer/styles.css",
            additions: 90,
            deletions: 2,
            binary: false,
          },
          {
            path: "assets/muon.png",
            additions: 0,
            deletions: 0,
            binary: true,
          },
          {
            path: "PLAN.md",
            additions: 1,
            deletions: 0,
            binary: false,
          },
        ],
      })
    );

    expect(screen.getByLabelText("Workspace file tree")).toBeTruthy();
    expect(screen.getByText("src", { selector: "summary span" })).toBeTruthy();
    expect(
      screen.getByText("renderer", { selector: "summary span" })
    ).toBeTruthy();
    expect(screen.getByText("app.tsx").closest("li")?.textContent).toContain(
      "+28"
    );
    expect(screen.getByText("app.tsx").closest("li")?.textContent).toContain(
      "−4"
    );
    expect(screen.getByText("muon.png").closest("li")?.textContent).toContain(
      "binary"
    );
    expect(screen.getByText("PLAN.md").closest("li")?.textContent).toContain(
      "+1"
    );
  });
});
