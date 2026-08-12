import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalCodeGraphProvider } from "../src/provider.js";

// LocalCodeGraphProvider end-to-end over a real fixture repo in a temp dir:
// reverse-import closure, the canonical workspace-relative POSIX namespace,
// the whole degrade-to-null matrix, no-egress, and a perf sanity check.

let root: string;

function write(rel: string, content: string) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-provider-")));
  // Root marker for findRoot().
  write("package.json", JSON.stringify({ name: "fixture" }));
  // Import chain: d → c → b → a (each imports the previous). Editing a ripples up.
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "import { a } from './a.js';\nexport const b = a + 1;");
  write("src/c.ts", "import { b } from './b.js';\nexport const c = b + 1;");
  write("src/d.ts", "import { c } from './c.js';\nexport const d = c + 1;");
  // A file nobody imports (a leaf importer).
  write("src/orphan.ts", "export const orphan = true;");
  // A non-TS file (unsupported language).
  write("notes.md", "# not code");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Default validator resolves the root via cwd=root, so no env needed. */
function provider(overrides = {}) {
  return new LocalCodeGraphProvider({ cwd: root, env: {}, ...overrides });
}

describe("LocalCodeGraphProvider.impact, reverse-import closure", () => {
  it("editing a LEAF surfaces its transitive importers in depth order, canonical POSIX", async () => {
    const radius = await provider().impact({ module: "src/a.ts" });
    expect(radius).not.toBeNull();
    expect(radius!.source).toBe("codegraph");
    // Workspace-relative POSIX, no leading "./", no absolute path (the #1 risk).
    expect(radius!.modules).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(radius!.modules.every((m) => !m.startsWith("/") && !m.startsWith("."))).toBe(true);
    expect(radius!.depth).toBe(3);
  });

  it("editing a mid-chain file surfaces only its upstream importers", async () => {
    const radius = await provider().impact({ module: "src/c.ts" });
    expect(radius!.modules).toEqual(["src/d.ts"]);
    expect(radius!.depth).toBe(1);
  });

  it("a file NOBODY imports → empty modules (codegraph ran, no neighbours)", async () => {
    const radius = await provider().impact({ module: "src/orphan.ts" });
    expect(radius).not.toBeNull();
    expect(radius!.modules).toEqual([]);
    expect(radius!.source).toBe("codegraph");
  });

  it("respects an injected depth cap", async () => {
    const radius = await provider({ maxDepth: 1 }).impact({ module: "src/a.ts" });
    expect(radius!.modules).toEqual(["src/b.ts"]);
    expect(radius!.depth).toBe(1);
  });

  it("caps the module set and truncates the farthest neighbours", async () => {
    const radius = await provider({ maxModules: 2 }).impact({ module: "src/a.ts" });
    expect(radius!.modules).toEqual(["src/b.ts", "src/c.ts"]);
  });
});

describe("LocalCodeGraphProvider.impact, symbol targets (ADR-0012 + ADR-0015)", () => {
  it("a symbol id resolves to its module closure AND returns the transitive REFERENCING symbols", async () => {
    const radius = await provider().impact({ symbol: "src/a.ts#a" });
    expect(radius).not.toBeNull();
    expect(radius!.source).toBe("codegraph");
    // The defining module's transitive importers, canonical POSIX (the #1 invariant).
    expect(radius!.modules).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    // ADR-0015: the target symbol PLUS the symbols that transitively reference it
    // (`b` uses `a`, `c` uses `b`, `d` uses `c`), not the old echo-only `[#a]`.
    expect(radius!.symbols).toEqual([
      "src/a.ts#a",
      "src/b.ts#b",
      "src/c.ts#c",
      "src/d.ts#d",
    ]);
  });

  it("NEVER WIDEN (gate 2): every referencer's module is inside the module closure", async () => {
    const radius = await provider().impact({ symbol: "src/a.ts#a" });
    const modSet = new Set(radius!.modules);
    // The echo target's own module is the anchor (not a widening); every OTHER
    // symbol (the referencers) must derive a module already in the closure.
    const referencerModules = radius!.symbols!
      .filter((s) => s !== "src/a.ts#a")
      .map((s) => s.slice(0, s.indexOf("#")));
    for (const mod of referencerModules) {
      expect(modSet.has(mod)).toBe(true);
    }
  });

  it("closes the bare-symbol-null GAP: a resolvable symbol no longer returns null", async () => {
    expect(await provider().impact({ symbol: "src/c.ts#c" })).not.toBeNull();
  });

  it("a module target that ALSO carries a symbol returns the referencer symbols", async () => {
    const radius = await provider().impact({
      module: "src/a.ts",
      symbol: "src/a.ts#a",
    });
    expect(radius!.symbols).toEqual([
      "src/a.ts#a",
      "src/b.ts#b",
      "src/c.ts#c",
      "src/d.ts#d",
    ]);
    expect(radius!.modules).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("NO-REGRESSION (gate 3): symbol layer DISABLED ⇒ byte-for-byte today's echo-only", async () => {
    // `maxSymbolScanMs: 0` deterministically disables the symbol layer; the output
    // must be exactly today's, modules unchanged, symbols === [target.symbol].
    const echoOnly = provider({ budget: { maxSymbolScanMs: 0 } });
    const radius = await echoOnly.impact({ symbol: "src/a.ts#a" });
    expect(radius!.modules).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(radius!.symbols).toEqual(["src/a.ts#a"]);
  });

  it("a mid-chain symbol returns only its upstream referencers", async () => {
    const radius = await provider().impact({ symbol: "src/c.ts#c" });
    expect(radius!.symbols).toEqual(["src/c.ts#c", "src/d.ts#d"]);
    expect(radius!.modules).toEqual(["src/d.ts"]);
  });

  it("a symbol whose module is unresolvable / unsupported degrades to null", async () => {
    expect(await provider().impact({ symbol: "src/ghost.ts#x" })).toBeNull();
    expect(await provider().impact({ symbol: "notes.md#x" })).toBeNull();
  });
});

describe("LocalCodeGraphProvider.impact, degrade-to-null", () => {
  it("BARE symbol with no '#' (no derivable module) → null (degrade)", async () => {
    expect(await provider().impact({ symbol: "someFn" })).toBeNull();
  });

  it("UNSUPPORTED language target → null", async () => {
    expect(await provider().impact({ module: "notes.md" })).toBeNull();
  });

  it("UNRESOLVABLE target (not on disk) → null", async () => {
    expect(await provider().impact({ module: "src/ghost.ts" })).toBeNull();
  });

  it("OVER-BUDGET scan (maxFiles) → null", async () => {
    const radius = await provider({ budget: { maxFiles: 1 } }).impact({
      module: "src/a.ts",
    });
    expect(radius).toBeNull();
  });

  it("OVER-BUDGET scan (maxEntries) → null, and NEGATIVE-CACHED (F-2: no rebuild)", async () => {
    const p = provider({ budget: { maxEntries: 1 } });
    expect(await p.impact({ module: "src/a.ts" })).toBeNull();
    // A second call degrades from the sentinel, still null, and cheap (the
    // budget failure is remembered rather than re-walked).
    const started = Date.now();
    expect(await p.impact({ module: "src/a.ts" })).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("root OUTSIDE the P3-B allowlist → null (default validator)", async () => {
    // cwd + env point nowhere near the fixture; the absolute target still locates,
    // but the resolved root fails the allowlist → degrade.
    const outside = new LocalCodeGraphProvider({
      cwd: join(tmpdir(), "definitely-not-the-fixture"),
      env: {},
    });
    expect(await outside.impact({ module: join(root, "src/a.ts") })).toBeNull();
  });

  it("an injected validateRoot that rejects → null", async () => {
    const rejected = provider({ validateRoot: () => false });
    expect(await rejected.impact({ module: "src/a.ts" })).toBeNull();
  });

  it("impact() NEVER throws (returns null on any internal error)", async () => {
    const boom = provider({
      validateRoot: () => {
        throw new Error("kaboom");
      },
    });
    expect(await boom.impact({ module: "src/a.ts" })).toBeNull();
  });
});

describe("LocalCodeGraphProvider, monorepo namespace (F-1)", () => {
  let mono: string;

  beforeAll(() => {
    // A monorepo: root package.json AND a nested backend/package.json (each a
    // root marker). The nearest-marker heuristic would wrongly re-base to
    // `<mono>/backend`; the caller-namespace root must stay `<mono>`.
    mono = realpathSync(mkdtempSync(join(tmpdir(), "cg-mono-")));
    writeFileSync(join(mono, "package.json"), JSON.stringify({ name: "mono" }));
    mkdirSync(join(mono, "backend/src"), { recursive: true });
    writeFileSync(
      join(mono, "backend/package.json"),
      JSON.stringify({ name: "inner" })
    );
    writeFileSync(join(mono, "backend/src/a.ts"), "export const a = 1;");
    writeFileSync(
      join(mono, "backend/src/b.ts"),
      "import { a } from './a.js';\nexport const b = a + 1;"
    );
  });

  afterAll(() => rmSync(mono, { recursive: true, force: true }));

  it("keeps the sub-package prefix so the emitted namespace == the anchor namespace", async () => {
    const p = new LocalCodeGraphProvider({ cwd: mono, env: {} });
    const radius = await p.impact({ module: "backend/src/a.ts" });
    expect(radius).not.toBeNull();
    // The importer KEEPS `backend/`, matching a memory anchored to
    // `backend/src/b.ts`. Under the old nearest-marker logic this was `src/b.ts`.
    expect(radius!.modules).toEqual(["backend/src/b.ts"]);
    expect(radius!.depth).toBe(1);
  });

  it("round-trips a files-only target into the same namespace", async () => {
    const p = new LocalCodeGraphProvider({ cwd: mono, env: {} });
    const radius = await p.impact({ files: ["backend/src/a.ts"] });
    expect(radius!.modules).toEqual(["backend/src/b.ts"]);
  });
});

describe("LocalCodeGraphProvider, invariants", () => {
  it("NO EGRESS: impact() opens no socket (pure filesystem)", async () => {
    const netConnect = vi.spyOn(net, "connect");
    const netSocketConnect = vi.spyOn(net.Socket.prototype, "connect");
    const httpsRequest = vi.spyOn(https, "request");
    try {
      await provider().impact({ module: "src/a.ts" });
      expect(netConnect).not.toHaveBeenCalled();
      expect(netSocketConnect).not.toHaveBeenCalled();
      expect(httpsRequest).not.toHaveBeenCalled();
    } finally {
      netConnect.mockRestore();
      netSocketConnect.mockRestore();
      httpsRequest.mockRestore();
    }
  });

  it("PERF SANITY: indexing a few-hundred-file repo is well under budget", async () => {
    const perfRoot = realpathSync(mkdtempSync(join(tmpdir(), "cg-perf-")));
    try {
      writeFileSync(join(perfRoot, "package.json"), "{}");
      mkdirSync(join(perfRoot, "src"), { recursive: true });
      const count = 300;
      // A linear import chain of `count` files.
      writeFileSync(join(perfRoot, "src/f0.ts"), "export const v0 = 0;");
      for (let i = 1; i < count; i += 1) {
        writeFileSync(
          join(perfRoot, `src/f${i}.ts`),
          `import { v${i - 1} } from './f${i - 1}.js';\nexport const v${i} = v${i - 1} + 1;`
        );
      }
      const perfProvider = new LocalCodeGraphProvider({ cwd: perfRoot, env: {} });
      const started = Date.now();
      const radius = await perfProvider.impact({ module: "src/f0.ts" });
      const elapsed = Date.now() - started;
      expect(radius).not.toBeNull();
      // f0 is imported (transitively) by f1..f_{D} within depth D=3.
      expect(radius!.modules).toEqual(["src/f1.ts", "src/f2.ts", "src/f3.ts"]);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(perfRoot, { recursive: true, force: true });
    }
  });
});
