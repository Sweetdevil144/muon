import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("browser-safe client exports", () => {
  it("publishes renderer projections without routing through the Node aggregate", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    const browserSubpaths = [
      "./approval-review",
      "./audit-trail",
      "./dispatch-view",
      "./loop-status",
      "./types",
    ];

    for (const subpath of browserSubpaths) {
      expect(manifest.exports[subpath]).toBeTruthy();
      const source = fs.readFileSync(
        path.join(root, "src", `${subpath.slice(2)}.ts`),
        "utf8"
      );
      expect(source).not.toMatch(/from ["']node:/);
    }
  });

  it("run-bundle and run-resume stay browser-safe (hashers are injected)", () => {
    for (const name of ["run-bundle", "run-resume"]) {
      const source = fs.readFileSync(
        path.join(root, "src", `${name}.ts`),
        "utf8"
      );
      expect(source).not.toMatch(/from ["']node:/);
    }
  });
});
