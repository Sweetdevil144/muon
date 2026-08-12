import { describe, expect, it } from "vitest";
import {
  redactForPack,
  redactMachineIdentity,
  redactSecrets,
} from "../src/run-bundle.js";

// ── The pack's redaction, and the claim it has to earn ───────────────────────
//
// `memory-pack-import.ts` asserted "No absolute path, hostname or username may
// ever ride a pack, in either direction" and `memory-pack.ts` that "the only
// workspace value on the wire is the salted opaque origin fingerprint". Both were
// FALSE: the only filter on exported prose was `redactSecrets`, which matches
// `KEY=value` secret shapes and bearer tokens. A security review exported a
// confirmed note reading "The vault lives at /Users/<name>/SWE/ACME-CLIENT-PRIVATE
// /ops/keys.md on host <machine>.local" — verbatim, into a directory the user is
// told to commit to a team git repo.
//
// A pack is the ONE place MUON's data crosses a machine boundary, so this is the
// one redactor whose gaps are other people's problem, not just the operator's.

describe("redactMachineIdentity", () => {
  it("removes the shapes that identify a MACHINE", () => {
    for (const [input, gone] of [
      ["The vault lives at /Users/casey/SWE/ACME-PRIVATE/ops/keys.md.", "casey"],
      ["Run it from /home/deploy/svc/bin.", "deploy"],
      ["Cache under /var/folders/xy/T/muon-abc.", "muon-abc"],
      ["See C:\\\\Users\\\\Casey\\\\repo\\\\notes.md.", "Casey"],
      ["Mounted from \\\\\\\\fileserver\\\\team\\\\vault.", "fileserver"],
      ["Deployed on casey-mbp.local last week.", "casey-mbp"],
      ["Reachable at build-box.internal only.", "build-box"],
    ] as const) {
      const out = redactMachineIdentity(input);
      expect(out, input).not.toContain(gone);
      // The sentence survives — this is redaction, not deletion.
      expect(out.length, input).toBeGreaterThan(10);
    }
  });

  it("LEAVES repo-relative paths alone, because that is what a note is about", () => {
    // A module anchor means the same thing on both machines and identifies no
    // one. Redacting these would gut the corpus the pack exists to share.
    const text =
      "Charges are idempotent in src/pay/charge.ts, see also packages/graph/src/muon-graph.ts#recallMemory.";
    expect(redactMachineIdentity(text)).toBe(text);
  });

  it("is DETERMINISTIC and machine-independent — the content address depends on it", () => {
    // The pack's `textHash` is computed over the redacted text, and the IMPORTER
    // re-runs this redaction and refuses the record unless it reproduces the same
    // hash. A redaction that consulted this machine's hostname or username would
    // therefore refuse every legitimate pack. Same input, same output, always.
    const text = "Vault at /Users/someone/x on host other-box.local";
    expect(redactMachineIdentity(text)).toBe(redactMachineIdentity(text));
    // And it must not depend on THIS machine's identity: a path naming a user who
    // is not us is redacted exactly the same way.
    expect(redactMachineIdentity("/Users/not-this-user/secret")).toBe(
      redactMachineIdentity("/Users/also-not-us/secret")
    );
  });
});

describe("redactForPack composes both, secrets FIRST", () => {
  it("scrubs a credential embedded in a path as a SECRET, not as a path", () => {
    // Order matters: if the path rule ran first it would swallow the whole span
    // and hide that a credential was ever present. Redacting it as a secret keeps
    // the `[redacted]` marker visible to a reviewing human.
    const out = redactForPack("/Users/x/.config/API_KEY=super-secret-value");
    expect(out).not.toContain("super-secret-value");
    expect(out).toContain("[redacted]");
  });

  it("still does everything redactSecrets did", () => {
    const out = redactForPack("TOKEN=abc123def456 and Bearer aaaabbbbccccdddd");
    expect(out).not.toContain("abc123def456");
    expect(out).not.toContain("aaaabbbbccccdddd");
    expect(out).toBe(redactSecrets("TOKEN=abc123def456 and Bearer aaaabbbbccccdddd"));
  });

  it("THE REVIEW'S EXPORTED NOTE, end to end", () => {
    const out = redactForPack(
      "The vault lives at /Users/casey/SWE/ACME-CLIENT-PRIVATE/ops/keys.md on host casey-mbp.local; run it as user casey."
    );
    expect(out).not.toContain("/Users/casey");
    expect(out).not.toContain("ACME-CLIENT-PRIVATE");
    expect(out).not.toContain("casey-mbp.local");
    // What remains is still a useful sentence for the receiving human.
    expect(out).toContain("The vault lives at");
  });
});
