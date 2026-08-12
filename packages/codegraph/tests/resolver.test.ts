import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResolver } from "../src/resolver.js";
import { loadTsconfigPaths } from "../src/tsconfig.js";

// The hand-rolled RESOLVER: relative + extension probing + index/barrel + tsconfig
// paths/baseUrl; bare node_modules specifiers dropped. Fixture repo in a temp dir.

let root: string;

function write(rel: string, content = "export {};") {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-resolver-")));
  write("src/a.ts");
  write("src/b.tsx");
  write("src/util/index.ts"); // barrel
  write("src/legacy.js");
  write("src/aliased/foo.ts");
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/aliased/*"] } },
    })
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("createResolver", () => {
  const from = () => join(root, "src", "entry.ts");
  function resolver() {
    return createResolver({ root, tsconfig: loadTsconfigPaths(root) });
  }

  it("resolves a RELATIVE, extensionless specifier by probing extensions", () => {
    expect(resolver().resolve(from(), "./a")).toBe(join(root, "src/a.ts"));
    expect(resolver().resolve(from(), "./b")).toBe(join(root, "src/b.tsx"));
  });

  it("resolves a NodeNext `.js` specifier to the `.ts` source", () => {
    expect(resolver().resolve(from(), "./a.js")).toBe(join(root, "src/a.ts"));
  });

  it("resolves a directory to its index/barrel", () => {
    expect(resolver().resolve(from(), "./util")).toBe(
      join(root, "src/util/index.ts")
    );
  });

  it("resolves a tsconfig `paths` alias to the aliased file", () => {
    expect(resolver().resolve(from(), "@app/foo")).toBe(
      join(root, "src/aliased/foo.ts")
    );
  });

  it("DROPS a bare `node_modules` specifier (external, out of blast-radius)", () => {
    expect(resolver().resolve(from(), "zod")).toBeNull();
    expect(resolver().resolve(from(), "node:fs")).toBeNull();
    expect(resolver().resolve(from(), "@scope/pkg")).toBeNull();
  });

  it("DROPS a relative specifier that escapes the repo root", () => {
    expect(resolver().resolve(from(), "../../../../etc/passwd")).toBeNull();
  });

  it("returns null for an unresolvable relative specifier", () => {
    expect(resolver().resolve(from(), "./does-not-exist")).toBeNull();
  });

  it("F-5: an INSTALLED node_modules package is NOT shadowed by a baseUrl in-root file", () => {
    // A baseUrl-relative file `<root>/utils.ts` AND an installed package `utils`
    // both exist. `import "utils"` means the PACKAGE → no fabricated intra-repo edge.
    write("utils.ts");
    write("node_modules/utils/package.json", JSON.stringify({ name: "utils" }));
    expect(resolver().resolve(from(), "utils")).toBeNull();
    // With no installed package, a baseUrl bare specifier still resolves in-root.
    write("solo.ts");
    expect(resolver().resolve(from(), "solo")).toBe(join(root, "solo.ts"));
  });
});
