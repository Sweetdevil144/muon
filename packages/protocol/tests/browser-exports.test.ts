import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("browser-safe protocol root", () => {
  it("does not aggregate modules that import Node built-ins", () => {
    const index = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
    const exportedModules = [...index.matchAll(/from\s+["']\.\/(.+?)\.js["']/g)].map(
      (match) => match[1]!
    );

    expect(exportedModules.length).toBeGreaterThan(0);
    for (const moduleName of exportedModules) {
      const source = fs.readFileSync(
        path.join(root, "src", `${moduleName}.ts`),
        "utf8"
      );
      expect(source, `${moduleName} must stay browser-safe`).not.toMatch(
        /from\s+["']node:/
      );
    }
  });

  it("publishes every Node-backed module only as an explicit subpath", () => {
    // `compatibility-digest` joined this list on 2026-08-09. ADR-0038 D3's
    // fingerprint needs `node:crypto`; the RULES that go with it (what may be
    // enabled, what a diff means) stay in the browser-safe root, because a
    // renderer displays a digest and never computes one. The first version put
    // both in one module and the test above caught it — which is the point of
    // having two assertions here rather than one.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    const index = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");

    for (const nodeBacked of ["project-setup", "compatibility-digest"]) {
      expect(manifest.exports[`./${nodeBacked}`], nodeBacked).toBeTruthy();
      expect(index, nodeBacked).not.toContain(
        `export * from "./${nodeBacked}.js"`
      );
    }
  });
});
