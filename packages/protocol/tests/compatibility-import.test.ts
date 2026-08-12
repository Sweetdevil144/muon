import { describe, expect, it } from "vitest";
import {
  describeImportedItem,
  discoverMcpServers,
  importItemEvidence,
  IMPORT_STATE_DISCOVERED,
} from "../src/index.js";

// ADR-0038, slice 1. This module is the DISCOVER half of feature #12 and must
// stay incapable of the ENABLE half. Every assertion here is either about
// reading a config faithfully, or about the two things that must never happen:
// a secret entering MUON, and an item arriving enabled.

const CLAUDE_CONFIG = {
  mcpServers: {
    linear: {
      command: "npx",
      args: ["-y", "linear-mcp"],
      env: {
        LINEAR_API_KEY: "lin_api_REAL_SECRET_VALUE",
        LINEAR_WORKSPACE: "acme",
      },
    },
    docs: {
      type: "http",
      url: "https://docs.example.com/mcp",
      headers: { Authorization: "Bearer REAL_BEARER_VALUE" },
    },
  },
};

function discover(config: unknown = CLAUDE_CONFIG) {
  return discoverMcpServers({
    vendor: "claude",
    sourcePath: "/home/dev/.claude.json",
    config,
  });
}

describe("ADR-0038 D5 — a credential never enters MUON", () => {
  it("carries env NAMES and never a value", () => {
    const serialized = JSON.stringify(discover());
    expect(serialized).not.toContain("lin_api_REAL_SECRET_VALUE");
    expect(serialized).not.toContain("REAL_BEARER_VALUE");
    expect(serialized).toContain("LINEAR_API_KEY");
  });

  it("names WHICH credential the server wants, without advising a fix", () => {
    // The name said "must supply through the vendor", which is advice a review
    // proved false — MUON generates the lane's own server config, so the
    // vendor copy is never read. The assertion was always about naming the
    // credential; only the title claimed more than that.
    const linear = discover().items.find((item) => item.name === "linear")!;
    expect(linear.secretsRefused).toContain("LINEAR_API_KEY");
    // A non-credential env key is recorded but not reported as a secret the
    // user has to go and fetch.
    expect(linear.shape.envKeys).toContain("LINEAR_WORKSPACE");
    expect(linear.secretsRefused).not.toContain("LINEAR_WORKSPACE");
  });

  it("refuses a header value the same way it refuses an env value", () => {
    const docs = discover().items.find((item) => item.name === "docs")!;
    expect(docs.shape.headerKeys).toEqual(["Authorization"]);
    expect(docs.secretsRefused).toContain("Authorization");
    expect(JSON.stringify(docs)).not.toContain("Bearer");
  });

  it("keeps no value even for a key nobody would guess is a secret", () => {
    // Every env VALUE is dropped, not just the ones matching the credential
    // pattern. The pattern only decides what is REPORTED to the human.
    const result = discover({
      mcpServers: {
        odd: {
          command: "run",
          env: { HARMLESS_LOOKING: "actually-a-password-1234" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("actually-a-password-1234");
    expect(result.items[0]!.shape.envKeys).toEqual(["HARMLESS_LOOKING"]);
  });

  it("tells the human, in words, which credentials were refused", () => {
    const linear = discover().items.find((item) => item.name === "linear")!;
    const described = describeImportedItem(linear);
    expect(described).toContain("LINEAR_API_KEY");
    expect(described).toMatch(/MUON does not carry/);
    // THIS ASSERTION USED TO PIN A SENTENCE THAT WAS NOT TRUE. It required the
    // text to say the human could "supply them through claude's own
    // configuration" — and a review traced it: MUON hands a lane its OWN
    // generated server config, so the vendor's copy of those values is never
    // consulted, and a credential in a url or an argument is redacted to a
    // marker so the endpoint would not even exist. The honest sentence says
    // the item cannot be enabled, and the backend refuses it.
    expect(described).toMatch(/cannot be enabled/);
    expect(described).not.toMatch(/own configuration/);
  });
});

describe("ADR-0038 D1 — discovered means denied, and nothing here can enable", () => {
  it("gives every item the discovered state, by construction", () => {
    for (const item of discover().items) {
      expect(item.state).toBe(IMPORT_STATE_DISCOVERED);
    }
  });

  it("exports nothing that could enable, bind, or grant an item", async () => {
    // The second half of the feature is an authority act waiting on ADR-0038's
    // open questions. This is a NAME check and therefore weak on its own — the
    // real guarantee is the one below, that the record has no field an enable
    // could be written into. Kept as the cheap tripwire, not as the proof.
    const module = await import("../src/compatibility-import.js");
    const suspicious = Object.keys(module).filter((name) =>
      /enable|activate|apply|install|grant|bind|allow|trust/i.test(name)
    );
    expect(suspicious).toEqual([]);
  });

  it("produces no field that could carry an enabled flag", () => {
    // Shape-level: the record has exactly one state and it is a literal.
    for (const item of discover().items) {
      expect(Object.keys(item).sort()).toEqual([
        "kind",
        "name",
        "provenance",
        "secretsRefused",
        "shape",
        "state",
      ]);
    }
  });
});

describe("reading the two config spellings MUON has to handle", () => {
  it("reads claude's mcpServers", () => {
    expect(discover().items.map((item) => item.name).sort()).toEqual([
      "docs",
      "linear",
    ]);
  });

  it("reads codex's mcp_servers", () => {
    const result = discoverMcpServers({
      vendor: "codex",
      sourcePath: "/home/dev/.codex/config.toml",
      config: { mcp_servers: { graph: { command: "gitnexus-mcp" } } },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.provenance.vendor).toBe("codex");
    expect(result.items[0]!.shape.transport).toBe("stdio");
  });

  it("infers the transport when the config does not declare one", () => {
    const stdio = discover({ mcpServers: { a: { command: "x" } } }).items[0]!;
    const http = discover({ mcpServers: { b: { url: "https://x" } } }).items[0]!;
    expect(stdio.shape.transport).toBe("stdio");
    expect(http.shape.transport).toBe("http");
  });

  it("returns nothing for a config with no servers, rather than throwing", () => {
    // Deliberately NOT via the `discover` helper: its default parameter turns
    // an explicit `undefined` back into the full fixture, which made an
    // earlier version of this test assert against the wrong input entirely.
    for (const config of [null, undefined, {}, [], "nonsense", 42]) {
      const result = discoverMcpServers({
        vendor: "claude",
        sourcePath: "/home/dev/.claude.json",
        config,
      });
      expect(result.items, String(config)).toEqual([]);
      expect(result.unreadable, String(config)).toEqual([]);
    }
  });
});

describe("an unreadable entry is REPORTED, never silently dropped", () => {
  it("reports a server it cannot interpret, and still reads the others", () => {
    // Showing 1 of 2 servers with no explanation is how an import surface
    // lies about what the user has.
    const result = discover({
      mcpServers: {
        good: { command: "x" },
        broken: "not-an-object",
        ambiguous: { description: "names neither a command nor a url" },
      },
    });
    expect(result.items.map((item) => item.name)).toEqual(["good"]);
    expect(result.unreadable.map((entry) => entry.name).sort()).toEqual([
      "ambiguous",
      "broken",
    ]);
    for (const entry of result.unreadable) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the fingerprint identifies the ITEM, not where it was found", () => {
  it("is stable across a moved config file", () => {
    // D3 re-attests to catch a server that CHANGED. A user moving
    // ~/.claude.json must not read as every item having changed.
    const here = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: CLAUDE_CONFIG,
    }).items[0]!;
    const there = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/Users/dev/other/.claude.json",
      config: CLAUDE_CONFIG,
    }).items[0]!;
    expect(importItemEvidence(here)).toBe(importItemEvidence(there));
  });

  it("changes when what the server LAUNCHES changes", () => {
    const before = discover({ mcpServers: { a: { command: "npx", args: ["x"] } } })
      .items[0]!;
    const after = discover({ mcpServers: { a: { command: "npx", args: ["y"] } } })
      .items[0]!;
    expect(importItemEvidence(before)).not.toBe(importItemEvidence(after));
  });

  it("changes when a new credential requirement appears", () => {
    // A server that starts demanding an API key is a different item from the
    // one the human approved, even though its command is identical.
    const before = discover({ mcpServers: { a: { command: "x" } } }).items[0]!;
    const after = discover({
      mcpServers: { a: { command: "x", env: { NEW_API_KEY: "v" } } },
    }).items[0]!;
    expect(importItemEvidence(before)).not.toBe(importItemEvidence(after));
  });

  it("is order-independent for env keys, so a rewritten config is not a change", () => {
    const one = discover({
      mcpServers: { a: { command: "x", env: { A: "1", B: "2" } } },
    }).items[0]!;
    const two = discover({
      mcpServers: { a: { command: "x", env: { B: "2", A: "1" } } },
    }).items[0]!;
    expect(importItemEvidence(one)).toBe(importItemEvidence(two));
  });
});

describe("ADR-0038 D4 — provenance informs, it never concludes", () => {
  it("records where an item came from", () => {
    const item = discover().items[0]!;
    expect(item.provenance).toEqual({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
    });
  });

  it("never renders a recommendation, a score, or a safety claim", () => {
    // "It was already in your ~/.claude.json" is exactly what a drifted or
    // compromised config also shows. A surface that says "this one looks fine"
    // is one an importer learns to trust instead of reading.
    for (const item of discover().items) {
      const described = describeImportedItem(item);
      expect(described).not.toMatch(
        /safe|trusted|verified|recommended|low risk|looks fine|score/i
      );
      // It must say the thing that IS true and load-bearing.
      expect(described).toContain("Not enabled.");
    }
  });
});

describe("ADR-0038 D5 — the leak paths a review found: url and args", () => {
  // These three shapes are how remote MCP is actually configured, and an
  // earlier revision copied `url` and `args` VERBATIM while computing
  // `secretsRefused` only from env/header NAMES. So all three carried a live
  // credential into MUON's store AND told the user zero credentials were
  // needed — worse than the leak, because the surface actively reassured.
  const LEAKY = {
    mcpServers: {
      zapier: {
        url: "https://mcp.zapier.com/api/mcp/s/SUPER_SECRET_KEY_abc123XYZ0987654321/mcp",
      },
      basic: { url: "https://alice:hunter2@internal.example.com/mcp" },
      gh: {
        command: "npx",
        args: [
          "mcp-remote",
          "https://api.githubcopilot.com/mcp",
          "--header",
          "Authorization: Bearer ghp_REALTOKEN1234567890abcd",
        ],
      },
    },
  };

  it("carries no secret from a url path, url userinfo, or an arg", () => {
    const serialized = JSON.stringify(discover(LEAKY));
    for (const secret of [
      "SUPER_SECRET_KEY_abc123XYZ0987654321",
      "hunter2",
      "ghp_REALTOKEN1234567890abcd",
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it("REPORTS each one as a refused credential, naming where it was", () => {
    const items = discover(LEAKY).items;
    const byName = new Map(items.map((item) => [item.name, item]));
    expect(byName.get("zapier")!.secretsRefused).toContain("url.path");
    expect(byName.get("basic")!.secretsRefused).toContain("url.userinfo");
    expect(byName.get("gh")!.secretsRefused.some((k) => k.startsWith("args["))).toBe(
      true
    );
    // And the human-readable line says so, rather than "Not enabled." alone.
    for (const item of items) {
      expect(describeImportedItem(item), item.name).toMatch(
        /MUON does not carry/
      );
    }
  });

  it("refuses a query string, which on an MCP endpoint is usually a key", () => {
    const item = discover({
      mcpServers: { q: { url: "https://mcp.example.com/mcp?api_key=SECRETVALUE12345" } },
    }).items[0]!;
    expect(JSON.stringify(item)).not.toContain("SECRETVALUE12345");
    expect(item.secretsRefused).toContain("url.query");
  });

  it("leaves an ordinary url and ordinary args alone", () => {
    // Over-refusing costs a manual step and under-refusing leaks a token, but
    // a scanner that redacts everything is one nobody can read.
    const item = discover({
      mcpServers: {
        plain: {
          command: "npx",
          args: ["-y", "some-mcp", "--port", "8080"],
          url: undefined,
        },
      },
    }).items[0]!;
    expect(item.secretsRefused).toEqual([]);
    expect(item.shape.args).toEqual(["-y", "some-mcp", "--port", "8080"]);
  });
});

describe("a config MUON cannot read says so", () => {
  it("reports a malformed mcpServers instead of silently showing zero", () => {
    // The review's finding 8: `{items: [], unreadable: []}` for a present but
    // unreadable servers key is "0 of N with no explanation" — the exact lie
    // the `unreadable` field exists to prevent one level down.
    for (const bad of [[], "oops", 42, true]) {
      const result = discover({ mcpServers: bad });
      expect(result.items, JSON.stringify(bad)).toEqual([]);
      expect(result.unreadable.length, JSON.stringify(bad)).toBe(1);
      expect(result.unreadable[0]!.reason).toMatch(/no servers could be read/);
    }
  });

  it("still says nothing when there is genuinely no servers key", () => {
    expect(discover({ other: true }).unreadable).toEqual([]);
  });

  it("keeps a server whose env key or arg is over-long, truncating instead", () => {
    // The review's finding 9: capping the COUNT but not the LENGTH made one
    // 129-char env key fail safeParse and discard the ENTIRE server with an
    // unactionable "configuration did not fit MUON's record".
    const result = discover({
      mcpServers: {
        long: {
          command: "x",
          args: ["a".repeat(900)],
          env: { ["K".repeat(200)]: "v" },
        },
      },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.shape.envKeys[0]!.length).toBeLessThanOrEqual(128);
  });
});

describe("evidence identifies the item, including which vendor it came from", () => {
  it("does NOT collide across vendors", () => {
    // The review's finding 10. Excluding sourcePath is deliberate (a moved
    // file is not a change); excluding the vendor was not, and it let a second
    // config inherit an approval the human gave against a screen that said
    // "from claude".
    const config = { mcpServers: { linear: { command: "npx", args: ["-y", "linear-mcp"] } } };
    const fromClaude = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config,
    }).items[0]!;
    const fromCodex = discoverMcpServers({
      vendor: "codex",
      sourcePath: "/tmp/attacker/.codex/config.toml",
      config,
    }).items[0]!;
    expect(importItemEvidence(fromClaude)).not.toBe(
      importItemEvidence(fromCodex)
    );
  });
});

describe("ADR-0038 D5 — a credential named by its FLAG, not by its shape", () => {
  // THE HALF SHAPE DETECTION CANNOT DO. `looksSecret` catches a value that
  // announces itself (`ghp_…`, a JWT, a long opaque run). It cannot catch
  // `["--api-key", "abc123"]`, because `abc123` looks like every other short
  // argument in the world — and an adversarial review found exactly that
  // surviving into a stored capability shape. MUON was then holding a
  // credential it had promised never to carry, while reporting zero refused.
  function shapeOf(args: unknown) {
    const result = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: { mcpServers: { s: { command: "npx", args } } },
    });
    return result.items[0]!;
  }

  // camelCase, which an adversarial review found the delimiter-based pattern
  // could not see at all. `--accessToken abc123` was kept, reported as
  // credential-free, persisted into ImportedCapability and handed to the
  // runner. camelCase is the ordinary spelling for a large share of CLIs, so
  // this was not an edge case — it was most of the surface.
  it.each([
    ["--accessToken", "abc123"],
    ["--clientSecret", "s3cret"],
    ["--apiKey", "k1"],
    ["--authToken", "t1"],
    ["--sessionId", "sid"],
    ["--privateKey", "pk"],
    ["--AccessToken", "pascal"],
  ])("refuses the value after camelCase %s", (flag, value) => {
    const item = shapeOf(["mcp-remote", flag, value]);
    expect(item.shape.args, `${flag} value must not be carried`).not.toContain(value);
    expect(item.shape.args, "the FLAG stays, so a human knows what is needed").toContain(flag);
    expect(item.secretsRefused.some((key) => key.startsWith("args["))).toBe(true);
  });

  it.each([
    ["--accessToken=abc123", "abc123"],
    ["--clientSecret:s3cret", "s3cret"],
  ])("refuses the inline value in %s", (arg, value) => {
    const item = shapeOf(["mcp-remote", arg]);
    expect(item.shape.args.join(" ")).not.toContain(value);
    expect(item.secretsRefused.some((key) => key.startsWith("args["))).toBe(true);
  });

  it("does NOT refuse ordinary flags that merely contain a sensitive substring", () => {
    // A false positive costs a refused argument, which is cheap. It is still
    // not free, and a rule that refused everything would be useless.
    const item = shapeOf(["mcp-remote", "--passthrough", "on", "--keystore", "/tmp/ks"]);
    expect(item.shape.args).toContain("on");
    expect(item.shape.args).toContain("/tmp/ks");
  });

  it.each([
    ["--api-key", "abc123"],
    ["--token", "short"],
    ["--secret", "x1"],
    ["--password", "hunter2"],
    ["--auth", "letmein"],
    ["-H", "Authorization: Bearer aa"],
    ["--header", "X-Api-Key: nope"],
  ])("refuses the value after %s", (flag, value) => {
    const item = shapeOf(["mcp-remote", flag, value]);
    expect(item.shape.args, `${flag} value must not be carried`).not.toContain(
      value
    );
    expect(item.shape.args, "but the FLAG stays, so the human knows what is needed").toContain(
      flag
    );
    expect(item.secretsRefused.some((key) => key.startsWith("args["))).toBe(true);
  });

  it.each(["--token=abc123", "--api-key:short", "--Authorization=zz"])(
    "refuses the value inside %s and keeps the name",
    (arg) => {
      const item = shapeOf([arg]);
      const [rendered] = item.shape.args;
      expect(rendered).not.toContain("abc123");
      expect(rendered).not.toContain("short");
      expect(rendered).not.toContain("zz");
      expect(rendered, "the flag name survives").toMatch(/^--/);
      expect(item.secretsRefused).toContain("args[0]");
    }
  );

  it("does NOT eat an ordinary argument that merely follows an ordinary flag", () => {
    // Over-refusal costs a human one manual step, but refusing everything
    // would make the shape useless for saying what the server launches.
    const item = shapeOf(["-y", "linear-mcp", "--port", "8080"]);
    expect(item.shape.args).toEqual(["-y", "linear-mcp", "--port", "8080"]);
    expect(item.secretsRefused).toEqual([]);
  });

  it("refuses only ONE argument per credential flag", () => {
    // The flag arms the next entry and disarms immediately: a run of
    // `--token X --model gpt` must not swallow `gpt` as well.
    const item = shapeOf(["--token", "abc", "--model", "gpt"]);
    expect(item.shape.args).toEqual(["--token", "***", "--model", "gpt"]);
  });

  it("still catches a self-announcing secret with no flag at all", () => {
    const item = shapeOf(["mcp-remote", `ghp_${"a".repeat(36)}`]);
    expect(item.shape.args).not.toContain(`ghp_${"a".repeat(36)}`);
    expect(item.secretsRefused).toContain("args[1]");
  });
});

describe("ADR-0038 D5 — a URL carries credentials in more than one place", () => {
  function urlShape(url: string) {
    const result = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: { mcpServers: { s: { type: "http", url } } },
    });
    return result.items[0]!;
  }

  it("drops the FRAGMENT, which an OAuth implicit flow puts a token in", () => {
    // `…#access_token=…` is the standard shape for an implicit grant, not an
    // exotic one. The query string was already dropped for exactly this
    // reason; the fragment was missed, so the token was returned by discovery
    // and persisted into the stored capability shape.
    const item = urlShape("https://server.example/mcp#access_token=s3cret");
    expect(item.shape.url).not.toContain("s3cret");
    expect(item.shape.url).not.toContain("#");
    expect(item.secretsRefused).toContain("url.fragment");
  });

  it("still drops userinfo and the query string", () => {
    const item = urlShape("https://user:pw@server.example/mcp?api_key=abc");
    expect(item.shape.url).not.toContain("pw");
    expect(item.shape.url).not.toContain("abc");
  });

  it("leaves an ordinary URL alone", () => {
    const item = urlShape("https://server.example/mcp");
    expect(item.shape.url).toBe("https://server.example/mcp");
    expect(item.secretsRefused).toEqual([]);
  });
});

describe("ADR-0038 D5 — a header credential rides more than one argument shape", () => {
  function shapeOf(args: unknown) {
    const result = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: { mcpServers: { s: { command: "npx", args } } },
    });
    return result.items[0]!;
  }

  it.each([
    ["--header=Authorization: Basic dTpw", "dTpw"],
    ["--headers:Cookie=session=abc", "session=abc"],
    ["-H=Authorization: Bearer aa", "aa"],
  ])("refuses the inline header %s", (arg, secret) => {
    // The standalone `-H value` form was already refused; this attached form
    // was not. The values that ride it are exactly the ones shape detection
    // cannot see — a short Basic credential or a session cookie looks like
    // every other argument in the world.
    const item = shapeOf(["mcp-remote", arg]);
    expect(item.shape.args.join(" ")).not.toContain(secret);
    expect(item.secretsRefused.some((key) => key.startsWith("args["))).toBe(true);
  });

  it("keeps the flag NAME, so a human knows which header is wanted", () => {
    const item = shapeOf(["mcp-remote", "--header=Authorization: Basic dTpw"]);
    expect(item.shape.args.join(" ")).toContain("--header");
  });
});

describe("ADR-0038 D5 — a URL passed as an ARGUMENT is still a URL", () => {
  function shapeOf(args: unknown) {
    const result = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: { mcpServers: { s: { command: "npx", args } } },
    });
    return result.items[0]!;
  }

  /**
   * `redactUrl` strips userinfo, query strings and fragments because each one
   * routinely carries a credential — but it was only applied to the `url`
   * FIELD. `mcp-remote https://host/mcp?api_key=…` is how a remote MCP server
   * is usually spelled, and that argument took the generic shape check
   * instead. A short key in a query string looks like nothing, so it was kept,
   * persisted into the stored shape, and handed to the runner.
   */
  it.each([
    ["https://host/mcp?api_key=abc123", "abc123"],
    ["https://user:pw@host/mcp", "pw"],
    ["https://host/mcp#access_token=zz", "zz"],
    ["HTTP://host/mcp?token=q1", "q1"],
  ])("redacts %s", (arg, secret) => {
    const item = shapeOf(["mcp-remote", arg]);
    expect(item.shape.args.join(" ")).not.toContain(secret);
    expect(item.secretsRefused.some((key) => key.startsWith("args["))).toBe(true);
  });

  it("keeps the ENDPOINT, so a human still knows what it dials", () => {
    const item = shapeOf(["mcp-remote", "https://host/mcp?api_key=abc123"]);
    expect(item.shape.args.join(" ")).toContain("host/mcp");
  });

  it("leaves a clean URL argument untouched", () => {
    const item = shapeOf(["mcp-remote", "https://host/mcp"]);
    expect(item.shape.args).toContain("https://host/mcp");
    expect(item.secretsRefused).toEqual([]);
  });
});

describe("ADR-0038 D5 — a COMMAND is a sequence of words too", () => {
  function shapeOf(command: string) {
    const result = discoverMcpServers({
      vendor: "claude",
      sourcePath: "/home/dev/.claude.json",
      config: { mcpServers: { s: { command, args: [] } } },
    });
    return result.items[0]!;
  }

  /**
   * `command` was copied verbatim while `args`, `url`, `env` and headers were
   * all redacted. A shell-wrapper entry carried the secret straight into the
   * inventory and into the persisted enabled shape — there is no reason a
   * credential is safer for being on this side of the config.
   */
  it.each([
    ["sh -c curl -H Authorization:Bearer-abc123", "abc123"],
    ["npx mcp-remote --api-key sk-live-1", "sk-live-1"],
    ["node run.js --accessToken tok-9", "tok-9"],
    ["npx mcp-remote https://host/mcp?api_key=zz9", "zz9"],
  ])("redacts a credential inside %s", (command, secret) => {
    const item = shapeOf(command);
    expect(item.shape.command ?? "").not.toContain(secret);
    expect(item.secretsRefused).toContain("command");
  });

  it("leaves an ordinary command untouched", () => {
    const item = shapeOf("npx -y linear-mcp");
    expect(item.shape.command).toBe("npx -y linear-mcp");
    expect(item.secretsRefused).toEqual([]);
  });

  it("keeps the PROGRAM, so a human still knows what would launch", () => {
    const item = shapeOf("npx mcp-remote --api-key sk-live-1");
    expect(item.shape.command ?? "").toContain("npx");
    expect(item.shape.command ?? "").toContain("mcp-remote");
  });
});
