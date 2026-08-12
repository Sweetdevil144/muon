import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "../src/components/Header.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

describe("Header target reporting", () => {
  it("names the attempted base, source, and data dir on the offline line", () => {
    const snapshot = {
      ...emptyBrainSnapshot(),
      error: "offline",
      target: {
        base: "http://127.0.0.1:4000",
        dataDir: "/tmp/MUON",
        source: "default" as const,
      },
    };

    const { lastFrame } = render(
      <Header snapshot={snapshot} layoutMode="columns" />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("offline");
    expect(frame).toContain("http://127.0.0.1:4000");
    expect(frame).toContain("default");
    expect(frame).toContain("data dir /tmp/MUON");
  });

  it("does not render the target line when the control plane is healthy", () => {
    const snapshot = {
      ...emptyBrainSnapshot(),
      error: null,
      target: {
        base: "http://127.0.0.1:4000",
        dataDir: "/tmp/MUON",
        source: "spawned" as const,
      },
    };

    const { lastFrame } = render(
      <Header snapshot={snapshot} layoutMode="columns" />
    );
    const frame = lastFrame() ?? "";

    // The target detail only surfaces when we have something to explain.
    expect(frame).not.toContain("data dir");
  });
});
