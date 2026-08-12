import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VendorConfigRoots } from "@muon/client/mcp-vendor-config";
import { discoverCompatibilityInventory } from "../src/lib/compatibility-discovery.js";

// ADR-0038 D1 slice 1 — the source enumerator.
//
// SAFETY RULE (the same one `packages/client/tests/mcp-vendor-config-*.test.ts`
// follows): every call below passes an explicit `roots` under a fresh temp
// directory. Nothing in this file may reach `discoverCompatibilityInventory()`
// with no argument — that resolves `~` from `os.homedir()` and would read the
// developer's real ~/.claude.json.

const tempRoots: string[] = [];

function makeRoots(): VendorConfigRoots {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "muon-compat-"));
  tempRoots.push(base);
  const home = path.join(base, "home");
  const configHome = path.join(base, "config");
  const cwd = path.join(base, "repo");
  for (const dir of [home, configHome, cwd]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return { home, configHome, cwd, redirectVendorConfigDirs: false };
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

function claudeConfig(roots: VendorConfigRoots): string {
  return path.join(roots.home, ".claude.json");
}
function codexConfig(roots: VendorConfigRoots): string {
  return path.join(roots.home, ".codex", "config.toml");
}
function cursorConfig(roots: VendorConfigRoots): string {
  return path.join(roots.home, ".cursor", "mcp.json");
}
function opencodeConfig(roots: VendorConfigRoots): string {
  return path.join(roots.configHome, "opencode", "opencode.json");
}

function sourceFor(
  inventory: ReturnType<typeof discoverCompatibilityInventory>,
  vendor: string
) {
  return inventory.sources.find((entry) => entry.vendor === vendor)!;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("the enumerator reads a FIXED table of paths and nothing else", () => {
  it("looks at exactly the four user-scope vendor configs, resolved by the shared table", () => {
    const roots = makeRoots();
    const inventory = discoverCompatibilityInventory(roots);

    // If this list ever grows a path that is not `vendorConfigPath(spec,
    // "user", roots)`, a second path table has appeared — which is the drift
    // this whole design exists to prevent.
    expect(
      inventory.sources.map((entry) => `${entry.vendor}:${entry.sourcePath}`)
    ).toEqual([
      `claude-code:${claudeConfig(roots)}`,
      `codex:${codexConfig(roots)}`,
      `cursor:${cursorConfig(roots)}`,
      `opencode:${opencodeConfig(roots)}`,
    ]);
    expect(inventory.sources.every((entry) => entry.scope === "user")).toBe(true);
  });

  it("reports a config that is not there rather than omitting it", () => {
    const roots = makeRoots();
    write(
      claudeConfig(roots),
      JSON.stringify({ mcpServers: { linear: { command: "npx", args: ["-y"] } } })
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(sourceFor(inventory, "claude-code")).toMatchObject({
      status: "read",
      items: 1,
    });
    // The other three were never written. "Not present" is a fact the human is
    // told; a missing row would read as "MUON found nothing there".
    for (const vendor of ["codex", "cursor", "opencode"]) {
      expect(sourceFor(inventory, vendor)).toMatchObject({
        status: "absent",
        items: 0,
      });
    }
  });

  it("reports an oversized config instead of reading it", () => {
    const roots = makeRoots();
    // One byte over the 8MiB cap, and valid JSON, so the ONLY thing that can
    // refuse it is the size check.
    const filler = "x".repeat(8 * 1024 * 1024);
    write(
      claudeConfig(roots),
      JSON.stringify({ note: filler, mcpServers: { linear: { command: "npx" } } })
    );

    const claude = sourceFor(discoverCompatibilityInventory(roots), "claude-code");
    expect(claude.status).toBe("unreadable");
    expect(claude.reason).toMatch(/over MUON's \d+-byte read cap/);
    expect(claude.items).toBe(0);
  });

  it("reports a directory (or any non-regular file) at a config path", () => {
    const roots = makeRoots();
    fs.mkdirSync(claudeConfig(roots), { recursive: true });

    const claude = sourceFor(discoverCompatibilityInventory(roots), "claude-code");
    expect(claude.status).toBe("unreadable");
    expect(claude.reason).toContain("is not a regular file");
  });

  it("never puts the file's own bytes in the failure reason", () => {
    const roots = makeRoots();
    // Malformed JSON whose first offending token IS the credential. V8's
    // JSON.parse message quotes ~10 characters of source either side of the
    // failure ("Unexpected token 'L', ...\"Servers\": LEAKED}\" is not valid
    // JSON"), so echoing that message puts the file's own bytes in an inventory
    // field. The canary is short for exactly that reason — a longer one is
    // truncated by V8 and the assertion stops detecting the leak.
    write(claudeConfig(roots), '{"mcpServers": LEAKED}');

    const inventory = discoverCompatibilityInventory(roots);
    const claude = sourceFor(inventory, "claude-code");
    expect(claude.status).toBe("unreadable");
    expect(claude.reason).toContain("is not valid JSON");
    expect(JSON.stringify(inventory)).not.toContain("LEAKED");
  });
});

describe("what the enumerator hands to discoverMcpServers", () => {
  it("inventories claude's mcpServers with the exact source path as provenance", () => {
    const roots = makeRoots();
    write(
      claudeConfig(roots),
      JSON.stringify({
        mcpServers: {
          linear: {
            command: "npx",
            args: ["-y", "linear-mcp"],
            env: { LINEAR_API_KEY: "lin_api_REAL_SECRET_VALUE" },
          },
        },
      })
    );

    const inventory = discoverCompatibilityInventory(roots);
    const linear = inventory.items.find((item) => item.name === "linear")!;
    expect(linear.provenance).toEqual({
      vendor: "claude-code",
      sourcePath: claudeConfig(roots),
    });
    expect(linear.shape.command).toBe("npx");
    expect(linear.shape.envKeys).toEqual(["LINEAR_API_KEY"]);
    expect(linear.secretsRefused).toContain("LINEAR_API_KEY");
    // D5: the value never enters MUON, at any level of the response.
    expect(JSON.stringify(inventory)).not.toContain("lin_api_REAL_SECRET_VALUE");
  });

  it("every discovered item is `discovered`, and nothing carries an enabled flag", () => {
    const roots = makeRoots();
    write(
      claudeConfig(roots),
      JSON.stringify({
        mcpServers: {
          linear: { command: "npx" },
          docs: { type: "http", url: "https://docs.example.com/mcp" },
        },
      })
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(inventory.items).toHaveLength(2);
    for (const item of inventory.items) {
      expect(item.state).toBe("discovered");
    }
    // ADR-0038 D1: discovery grants nothing. There is no field an enable could
    // be written into, and no id to enable BY.
    expect(JSON.stringify(inventory)).not.toMatch(/"enabled"|"lane"|"laneId"/);
  });

  it("reads cursor's own mcp.json through the same path table", () => {
    const roots = makeRoots();
    write(
      cursorConfig(roots),
      JSON.stringify({ mcpServers: { grep: { command: "grep-mcp" } } })
    );

    const inventory = discoverCompatibilityInventory(roots);
    const grep = inventory.items.find((item) => item.name === "grep")!;
    expect(grep.provenance.vendor).toBe("cursor");
    expect(grep.provenance.sourcePath).toBe(cursorConfig(roots));
  });
});

describe("opencode's own entry shape", () => {
  it("translates a `type: local` entry into command + args + env NAMES", () => {
    const roots = makeRoots();
    write(
      opencodeConfig(roots),
      JSON.stringify({
        mcp: {
          notes: {
            type: "local",
            command: ["notes-mcp", "--stdio"],
            enabled: true,
            environment: { NOTES_TOKEN: "REAL_TOKEN_VALUE" },
          },
        },
      })
    );

    const inventory = discoverCompatibilityInventory(roots);
    const notes = inventory.items.find((item) => item.name === "notes")!;
    expect(notes.shape.transport).toBe("stdio");
    expect(notes.shape.command).toBe("notes-mcp");
    expect(notes.shape.args).toEqual(["--stdio"]);
    expect(notes.shape.envKeys).toEqual(["NOTES_TOKEN"]);
    expect(JSON.stringify(inventory)).not.toContain("REAL_TOKEN_VALUE");
  });

  it("REPORTS an entry shape MUON has not verified instead of guessing at it", () => {
    const roots = makeRoots();
    write(
      opencodeConfig(roots),
      JSON.stringify({
        mcp: { remote: { type: "remote", url: "https://mcp.example.com/mcp" } },
      })
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(inventory.items).toHaveLength(0);
    expect(inventory.unreadable).toEqual([
      {
        vendor: "opencode",
        sourcePath: opencodeConfig(roots),
        name: "remote",
        reason: expect.stringContaining('type: "local"'),
      },
    ]);
  });
});

describe("codex's TOML tables", () => {
  it("reads a server across a multi-line args array and an env sub-table", () => {
    const roots = makeRoots();
    write(
      codexConfig(roots),
      [
        'model = "gpt-5"',
        "approval_policy = \"on-request\"",
        "",
        "[mcp_servers.linear]",
        'command = "npx"   # the launcher',
        "args = [",
        '  "-y",',
        '  "linear-mcp",',
        "]",
        "startup_timeout_ms = 20_000",
        "",
        "[mcp_servers.linear.env]",
        'LINEAR_API_KEY = "lin_api_REAL_SECRET_VALUE"',
        'LINEAR_WORKSPACE = "acme"',
        "",
        "[shell_environment_policy]",
        'exclude = ["AWS_*"]',
      ].join("\n")
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(sourceFor(inventory, "codex")).toMatchObject({ status: "read", items: 1 });
    const linear = inventory.items.find((item) => item.name === "linear")!;
    expect(linear.provenance).toEqual({
      vendor: "codex",
      sourcePath: codexConfig(roots),
    });
    expect(linear.shape.transport).toBe("stdio");
    expect(linear.shape.command).toBe("npx");
    // The multi-line array is the reason this reader has a value scanner at all
    // — a line-at-a-time reader drops every element after the first.
    expect(linear.shape.args).toEqual(["-y", "linear-mcp"]);
    expect(linear.shape.envKeys.sort()).toEqual([
      "LINEAR_API_KEY",
      "LINEAR_WORKSPACE",
    ]);
    expect(linear.secretsRefused).toContain("LINEAR_API_KEY");
    expect(JSON.stringify(inventory)).not.toContain("lin_api_REAL_SECRET_VALUE");
  });

  it("reads a remote codex server, a quoted name, and codex's `http_headers` spelling", () => {
    const roots = makeRoots();
    write(
      codexConfig(roots),
      [
        '[mcp_servers."my docs"]',
        'url = "https://docs.example.com/mcp"',
        "",
        "[mcp_servers.\"my docs\".http_headers]",
        'Authorization = "Bearer REAL_BEARER_VALUE"',
        'X-Team = "acme"',
      ].join("\n")
    );

    const inventory = discoverCompatibilityInventory(roots);
    const docs = inventory.items.find((item) => item.name === "my docs")!;
    expect(docs.shape.transport).toBe("http");
    expect(docs.shape.url).toBe("https://docs.example.com/mcp");
    // codex spells it `http_headers`. Without the alias the server reports zero
    // refused credentials while its config really does carry a bearer token.
    expect(docs.shape.headerKeys.sort()).toEqual(["Authorization", "X-Team"]);
    expect(docs.secretsRefused).toContain("Authorization");
    expect(JSON.stringify(inventory)).not.toContain("REAL_BEARER_VALUE");
  });

  it("ignores a table nested below a server instead of deleting the server", () => {
    const roots = makeRoots();
    write(
      codexConfig(roots),
      [
        "[mcp_servers.linear]",
        'command = "npx"',
        "",
        // Real codex, found in a live ~/.codex/config.toml: per-server tool
        // renaming. MUON models none of it, and refusing the server over it
        // would lose a server the user actually has.
        "[mcp_servers.linear.tools.rename]",
        'create_issue = "issue_new"',
        "",
        "[mcp_servers.other]",
        'command = "other-mcp"',
      ].join("\n")
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(inventory.unreadable).toEqual([]);
    expect(inventory.items.map((item) => item.name).sort()).toEqual([
      "linear",
      "other",
    ]);
    const linear = inventory.items.find((item) => item.name === "linear")!;
    expect(linear.shape.command).toBe("npx");
    // The ignored table contributed nothing — in particular it did not become
    // an env/header name on the server above it.
    expect(linear.shape.envKeys).toEqual([]);
    expect(linear.shape.headerKeys).toEqual([]);
  });

  it("refuses ONE server it cannot read and keeps the rest of the file", () => {
    const roots = makeRoots();
    write(
      codexConfig(roots),
      [
        "[mcp_servers.good]",
        'command = "good-mcp"',
        "",
        "[mcp_servers.weird]",
        'command = "weird-mcp"',
        // A TOML offset date-time: legal TOML, outside this reader's subset.
        "started = 1979-05-27T07:32:00Z",
      ].join("\n")
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(inventory.items.map((item) => item.name)).toEqual(["good"]);
    expect(inventory.unreadable).toEqual([
      {
        vendor: "codex",
        sourcePath: codexConfig(roots),
        name: "weird",
        reason: expect.stringContaining("could not read the value of `started`"),
      },
    ]);
  });

  it("does not let syntax OUTSIDE mcp_servers break the servers inside it", () => {
    const roots = makeRoots();
    write(
      codexConfig(roots),
      // `good` comes FIRST so this also pins that a non-mcp_servers header ENDS
      // the current server table. Without that reset the `notice` lines below
      // are read as keys of `good`, and `good` is refused for syntax that has
      // nothing to do with it.
      [
        "[mcp_servers.good]",
        'command = "good-mcp"',
        "",
        "[shell_environment_policy]",
        // A multi-line basic string — outside this reader's value subset, and
        // outside mcp_servers, so it must never be parsed in the first place.
        'notice = """',
        "line one",
        'line two"""',
        "",
        "[[profiles]]",
        'name = "fast"',
      ].join("\n")
    );

    const inventory = discoverCompatibilityInventory(roots);
    expect(inventory.unreadable).toEqual([]);
    expect(inventory.items.map((item) => item.name)).toEqual(["good"]);
  });
});
