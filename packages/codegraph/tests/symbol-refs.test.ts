import net from "node:net";
import https from "node:https";
import { describe, expect, it, vi } from "vitest";
import { moduleOfSymbol, toWorkspaceRelativePosix } from "../src/paths.js";
import type { Resolver } from "../src/resolver.js";
import { extractSymbolReferences } from "../src/symbol-refs.js";

// ADR-0015 CG-1, the name-based, import-resolved reverse SYMBOL-reference
// extractor. Attribution correctness (true edges), the WHOLE §4 degrade matrix
// (every ambiguity → NO symbol edge, module edge stands), never-throws, F-1
// round-trip, and no-egress. Pure, a fake in-memory resolver, no fs, no network.

const ROOT = "/repo";

/** A fake intra-repo resolver: `specToModule` maps a specifier to a known module
 *  file; everything else (bare/external) resolves to null. */
function resolver(specToModule: Record<string, string>): Resolver {
  return {
    resolve(_fromFile, specifier) {
      const mod = specToModule[specifier];
      return mod ? `${ROOT}/${mod}` : null;
    },
  };
}

/** Run the extractor for a file `module` and return its edges as `callee -> caller`
 *  strings (order-independent comparison via sets). */
function edgesOf(
  module: string,
  text: string,
  specToModule: Record<string, string> = {}
): Set<string> {
  const { edges } = extractSymbolReferences(
    text,
    module,
    resolver(specToModule),
    `${ROOT}/${module}`,
    ROOT
  );
  return new Set(edges.map((e) => `${e.callee} -> ${e.caller}`));
}

describe("extractSymbolReferences, attribution (§3 a–c)", () => {
  it("attributes an imported binding usage to its ENCLOSING top-level decl", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ return foo(); }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#bar"]));
  });

  it("resolves `import { foo as f }` to the IMPORTED name (M#foo)", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo as f } from './m';\nexport const bar = () => f();",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#bar"]));
  });

  it("resolves a DEFAULT import to M#default", () => {
    const e = edgesOf(
      "b.ts",
      "import main from './m';\nexport function bar(){ return main(); }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#default -> b.ts#bar"]));
  });

  it("attributes a NESTED usage to the enclosing TOP-LEVEL decl (not the inner fn)", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ function inner(){ return foo(); } return inner; }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#bar"]));
  });

  it("counts a TYPE-only reference (safe over-inclusion)", () => {
    const e = edgesOf(
      "b.ts",
      "import { Foo } from './m';\nexport function bar(p: Foo){ return p; }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#Foo -> b.ts#bar"]));
  });

  it("counts object SHORTHAND `{ foo }` as a value reference", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ return { foo }; }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#bar"]));
  });

  it("attributes per-declarator: `const a = foo, b = bar` splits correctly", () => {
    const e = edgesOf(
      "b.ts",
      "import { x, y } from './m';\nexport const a = x, b = y;",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#x -> b.ts#a", "m.ts#y -> b.ts#b"]));
  });

  it("does NOT emit an edge for an import that is never referenced", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ return 42; }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });
});

describe("extractSymbolReferences, precision-critical positions (regression pins, ADR-0015 review LOW-1)", () => {
  // These positions must NEVER attribute a false edge, pin them so a future edit to
  // `isReferencePosition`/`isDeclarationNameAny` can't silently reintroduce a wrong edge.
  it("a method named like the import on an UNRELATED object → no edge (property-access name side)", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nconst o = { foo(){} };\nexport function bar(){ return o.foo(); }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("property access `obj.foo` skipped but a BARE `foo()` in the same decl still counts", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\ndeclare const obj: any;\nexport function bar(){ return obj.foo + foo(); }",
      { "./m": "m.ts" }
    );
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#bar"]));
  });

  it("an object-literal KEY `{ foo: 1 }` → no edge", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport const bar = { foo: 1 };",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("a qualified-type RIGHT side `Ns.foo` → no `foo` edge (member, not the import)", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nimport { Ns } from './n';\nexport function bar(): Ns.foo { return null as any; }",
      { "./m": "m.ts", "./n": "n.ts" }
    );
    expect([...e].some((x) => x.startsWith("m.ts#foo"))).toBe(false);
  });

  it("a CLASS METHOD named like the import does not poison it; a bare use attributes to the class", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport class C { foo(){} bar(){ return foo() + this.foo(); } }",
      { "./m": "m.ts" }
    );
    // bare `foo()` is the import (→ the class C); `this.foo` is the method (skipped).
    expect(e).toEqual(new Set(["m.ts#foo -> b.ts#C"]));
  });
});

describe("extractSymbolReferences, §4 DEGRADE MATRIX (never a symbol edge)", () => {
  it("NAMESPACE/STAR import `import * as m` → no symbol edge", () => {
    const e = edgesOf(
      "b.ts",
      "import * as m from './m';\nexport function bar(){ return m.foo(); }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("RE-EXPORT / barrel binding → callee keys on the imported module, never the defining one", () => {
    // b imports foo FROM the barrel → edge is barrel#foo, so a query for the
    // defining m#foo finds nothing (degrade to module). We assert the ONLY edge is
    // to the barrel, never to m.ts.
    const e = edgesOf(
      "b.ts",
      "import { foo } from './barrel';\nexport function bar(){ return foo(); }",
      { "./barrel": "barrel.ts" }
    );
    expect(e).toEqual(new Set(["barrel.ts#foo -> b.ts#bar"]));
    expect([...e].some((edge) => edge.startsWith("m.ts#foo"))).toBe(false);
  });

  it("a barrel's own `export {foo} from './m'` yields NO edges (export-from skipped)", () => {
    expect(edgesOf("barrel.ts", "export { foo } from './m';", { "./m": "m.ts" }).size).toBe(0);
  });

  it("DYNAMIC/computed `import(expr)` → no static binding → no symbol edge", () => {
    const e = edgesOf(
      "b.ts",
      "export async function bar(){ const { foo } = await import('./m'); return foo(); }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("COMPUTED member `x['foo']` → no static name → never attributed", () => {
    const e = edgesOf(
      "b.ts",
      "const reg: Record<string, number> = {};\nexport function bar(){ return reg['foo']; }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("SHADOWING: a module-local decl colliding with an import name POISONS it (module-wide)", () => {
    // Even the outer statement's `foo` usage is dropped, coarse but never wrong.
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ const foo = 1; return foo; }\nexport function baz(){ return foo(); }",
      { "./m": "m.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("SAME-NAME across modules: a bare `foo` not imported here fabricates no edge", () => {
    // b imports foo from OTHER; the edge is other#foo, never m#foo.
    const e = edgesOf(
      "b.ts",
      "import { foo } from './other';\nexport function bar(){ return foo(); }",
      { "./other": "other.ts" }
    );
    expect(e).toEqual(new Set(["other.ts#foo -> b.ts#bar"]));
  });

  it("USAGE WITH NO ENCLOSING top-level decl → no symbol edge", () => {
    const e = edgesOf("b.ts", "import { foo } from './m';\nfoo();", {
      "./m": "m.ts",
    });
    expect(e.size).toBe(0);
  });

  it("PROPERTY key / member NAME same as an import is not a reference", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './m';\nexport function bar(){ const o = { foo: 1 }; return o.foo; }",
      { "./m": "m.ts" }
    );
    // `{ foo: 1 }` key and `o.foo` member are both skipped → no edge.
    expect(e.size).toBe(0);
  });

  it("`#` in the CALLER module path → no symbol edges (module-level only)", () => {
    expect(
      edgesOf("weird#name.ts", "import { foo } from './m';\nexport function bar(){ return foo(); }", {
        "./m": "m.ts",
      }).size
    ).toBe(0);
  });

  it("`#` in the CALLEE module path → binding declines (module-level only)", () => {
    const e = edgesOf(
      "b.ts",
      "import { foo } from './weird';\nexport function bar(){ return foo(); }",
      { "./weird": "weird#name.ts" }
    );
    expect(e.size).toBe(0);
  });

  it("EXTERNAL / unresolved import → absent → never attributed", () => {
    const e = edgesOf(
      "b.ts",
      "import { useState } from 'react';\nexport function bar(){ return useState(); }",
      {} // 'react' resolves to null
    );
    expect(e.size).toBe(0);
  });

  it("PARSE ERROR / malformed source → [] (never throws)", () => {
    expect(() =>
      extractSymbolReferences("import { foo } from '((", "b.ts", resolver({}), `${ROOT}/b.ts`, ROOT)
    ).not.toThrow();
    expect(
      extractSymbolReferences("export function (((", "b.ts", resolver({}), `${ROOT}/b.ts`, ROOT).edges
    ).toEqual([]);
    expect(
      extractSymbolReferences("", "b.ts", resolver({}), `${ROOT}/b.ts`, ROOT).edges
    ).toEqual([]);
  });
});

describe("extractSymbolReferences, F-1 round-trip + no-egress", () => {
  it("F-1: every referencer id's prefix round-trips via toWorkspaceRelativePosix", () => {
    const { edges } = extractSymbolReferences(
      "import { foo } from './m';\nexport function bar(){ return foo(); }",
      "src/b.ts",
      resolver({ "./m": "src/m.ts" }),
      `${ROOT}/src/b.ts`,
      ROOT
    );
    expect(edges.length).toBe(1);
    for (const edge of edges) {
      for (const id of [edge.callee, edge.caller]) {
        const mod = moduleOfSymbol(id);
        // No leading `./`, no absolute path, the anchor namespace shape.
        expect(mod.startsWith("/")).toBe(false);
        expect(mod.startsWith(".")).toBe(false);
        // And it is exactly what the canonicalizer produces for that abs file.
        expect(toWorkspaceRelativePosix(ROOT, `${ROOT}/${mod}`)).toBe(mod);
      }
    }
  });

  it("NO EGRESS: extraction opens no socket (pure ts.createSourceFile + fs-free)", () => {
    const netConnect = vi.spyOn(net, "connect");
    const socketConnect = vi.spyOn(net.Socket.prototype, "connect");
    const httpsRequest = vi.spyOn(https, "request");
    try {
      edgesOf(
        "b.ts",
        "import { foo } from './m';\nexport function bar(){ return foo(); }",
        { "./m": "m.ts" }
      );
      expect(netConnect).not.toHaveBeenCalled();
      expect(socketConnect).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      netConnect.mockRestore();
      socketConnect.mockRestore();
      httpsRequest.mockRestore();
    }
  });
});
