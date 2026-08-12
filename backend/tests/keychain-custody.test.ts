import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0017, the backend stays ENTIRELY OUT of Keychain custody.
//
// Slice C ships the R1 Keychain SEAM (packages/client/src/keychain.ts) but the
// operator-token RELOCATION (R2/R3) is DEFERRED behind the Developer-ID cert:
// pre-cert, moving the operator token from the sandbox-blinded 0600 brain.lock to
// the login Keychain is a NET REGRESSION, the Seatbelt profile leaves securityd
// reachable (deliberately, for the vendor's OWN auth), so a confined+injected
// agent could `security find` the operator token and escalate agent→operator.
// See docs/adr/0017 §"Corrected decision".
//
// This guard pins the invariant that survives the deferral: the backend NEVER
// references ANY Keychain symbol and NEVER handles the relocation flag, so a
// headless dispatch can never block on a Keychain prompt (constraint #3), and the
// regression cannot sneak back into the backend without tripping this test.

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Strip block + line comments so DOC references (which are encouraged) don't trip
// the check, only real imports/calls count.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const KEYCHAIN_SYMBOLS = [
  "isKeychainAvailable",
  "storeOperatorToken",
  "readOperatorToken",
  "deleteOperatorToken",
  // The relocation flag: the backend must not publish token:"" on its behalf.
  "MUON_OPERATOR_TOKEN_KEYCHAIN",
];

describe("ADR-0017, the backend is entirely out of Keychain custody (relocation deferred)", () => {
  const srcDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src"
  );
  const sources = walk(srcDir).map((file) => ({
    file,
    code: stripComments(readFileSync(file, "utf8")),
  }));

  for (const symbol of KEYCHAIN_SYMBOLS) {
    it(`no backend source references ${symbol} (custody stays out-of-backend)`, () => {
      const offenders = sources
        .filter(({ code }) => code.includes(symbol))
        .map(({ file }) => path.relative(srcDir, file));
      expect(offenders).toEqual([]);
    });
  }
});
