import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// ADR-0017 R1, the Keychain SEAM (macOS-only, NO native dep). A thin wrapper
// over Apple's `/usr/bin/security` for custodying MUON's OWN loopback operator
// token (never a VENDOR token) as ciphertext at rest in the user's login
// Keychain, instead of the plaintext 0600 `brain.lock`.
//
// STATUS, SEAM ONLY; RELOCATION DEFERRED behind the Developer-ID cert.
//   The adversarial review of Slice C found that ACTUALLY moving the operator
//   token to the login Keychain (R2/R3) is, PRE-CERT, a NET REGRESSION of the
//   two-token containment: the Seatbelt runner profile is `(allow default)` minus
//   only the data-dir file vectors, it deliberately leaves securityd/mach-lookup
//   reachable so the VENDOR CLI can read its OWN Keychain creds. So a confined,
//   prompt-injected agent that today hits EPERM on `cat brain.lock` could instead
//   `security find-generic-password -s dev.muonlabs.muon -a operator -w` and lift
//   the operator token, escalating agent→operator (self-approve gates). The
//   clean close is a per-signed-MUON Keychain ACL, which needs the cert. So this
//   file ships as inert scaffolding (only resolveApiToken's INERT fall-through
//   consults it, never reached while the brain publishes the lockfile token);
//   the CLI/desktop do NOT set MUON_OPERATOR_TOKEN_KEYCHAIN, so relocation is
//   dormant and the token stays in the SANDBOX-BLINDED lockfile (stronger today).
//
// BEFORE ENABLING (the cert milestone, ADR-0017 §"Corrected decision"):
//   (1) create the item with a signed-binary ACL (`-T` to the notarized MUON);
//   (2) key the item PER-DATA-DIR (pass KeychainOptions with a dataDir-derived
//       account), the global singleton below clobbers across concurrent brains;
//   (3) lengthen the READ timeout so a legit keychain-unlock prompt isn't cut off.
//
// INVARIANTS the seam already upholds (a reviewer WILL attack these):
//   • DEGRADE-SAFE: every function degrades to a falsy result and NEVER throws.
//     No macOS / no `security` / any error → the caller falls back to the
//     lockfile exactly as today. Boot never hard-fails on our account.
//   • NO SHELL: we exec `/usr/bin/security` directly via spawnSync with an argv
//     array, never through a shell, so there is no command injection surface.
//   • NO OVER-CLAIM: even once relocation is enabled, unsigned, a same-uid
//     `security find` read is NOT defeated, the item's ACL binds to
//     `/usr/bin/security`, not to MUON. The same-uid closure is the cert-gated
//     signed native read + ACL (deferred, §6).

const SECURITY_BIN = "/usr/bin/security";

// Default login-Keychain coordinates. `service` matches the app's bundle id
// (electron-builder.yml `appId: dev.muonlabs.muon`) so the desktop, CLI, and TUI
// all address ONE shared item; `account` names the credential.
const DEFAULT_SERVICE = "dev.muonlabs.muon";
const DEFAULT_ACCOUNT = "operator";

// A generous ceiling so a wedged `security` (e.g. a GUI keychain-unlock prompt on
// a locked login keychain) is bounded, then degrades, never an indefinite hang.
const SECURITY_TIMEOUT_MS = 5_000;

export type KeychainOptions = {
  /** Keychain item service (defaults to the `dev.muonlabs.muon` bundle id). */
  service?: string;
  /** Keychain item account (defaults to `operator`). */
  account?: string;
};

/** True iff this is macOS and Apple's `security` CLI is present. */
export function isKeychainAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SECURITY_BIN);
}

function coords(opts?: KeychainOptions): { service: string; account: string } {
  return {
    service: opts?.service ?? DEFAULT_SERVICE,
    account: opts?.account ?? DEFAULT_ACCOUNT,
  };
}

/**
 * Store (upsert) the operator token as a generic-password item. Returns true on
 * success, false on any failure (degrade-safe, the caller then leaves the token
 * in the lockfile as today).
 *
 * WRITE-ARGV WINDOW (ADR-0017 §5 / reviewer constraint #6): the token is passed
 * as the `-w <token>` argv value, so it is visible in THIS `security` process's
 * argv for the ~ms the subprocess lives, a per-boot ephemeral secret, strictly
 * narrower than a PERSISTED plaintext lockfile (which is the worst case we ever
 * fall back to). We deliberately do NOT pipe it via stdin: `security … -w` with
 * no argv value prompts for the password TWICE (entry + retype) via
 * readpassphrase(), which reads /dev/tty whenever a controlling terminal exists.
 * So `printf %s "$tok" | security … -w` stores an EMPTY password (the single
 * piped value mismatches the retype), and an interactive CLI would block on the
 * terminal. argv is the one deterministic path across every spawn context; the
 * desktop avoids even the ms window entirely via safeStorage (its own at-rest
 * copy). `-U` updates an existing item so this is idempotent across boots.
 */
export function storeOperatorToken(token: string, opts?: KeychainOptions): boolean {
  if (!isKeychainAvailable() || !token) {
    return false;
  }
  const { service, account } = coords(opts);
  try {
    const result = spawnSync(
      SECURITY_BIN,
      ["add-generic-password", "-U", "-s", service, "-a", account, "-w", token],
      { stdio: ["ignore", "ignore", "ignore"], timeout: SECURITY_TIMEOUT_MS }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Read the operator token back. Returns the token, or undefined when the item is
 * absent / any error (degrade-safe). The value is written to STDOUT (`-w`), NEVER
 * argv, so a read never leaks the token into a visible argv. Only INTERACTIVE
 * operator surfaces (CLI/TUI/desktop) call this; the BACKEND never does, so a
 * headless dispatch can never block on a Keychain prompt (constraint #3).
 */
export function readOperatorToken(opts?: KeychainOptions): string | undefined {
  if (!isKeychainAvailable()) {
    return undefined;
  }
  const { service, account } = coords(opts);
  try {
    const result = spawnSync(
      SECURITY_BIN,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: SECURITY_TIMEOUT_MS,
      }
    );
    if (result.status !== 0) {
      return undefined;
    }
    // `security` prints the password followed by a single newline.
    const value = (result.stdout ?? "").replace(/\r?\n$/, "");
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort delete of the stored operator item (shutdown cleanup, mirroring
 * `removeLockfile`). Degrade-safe; a delete is a WRITE, never a Keychain read.
 */
export function deleteOperatorToken(opts?: KeychainOptions): boolean {
  if (!isKeychainAvailable()) {
    return false;
  }
  const { service, account } = coords(opts);
  try {
    const result = spawnSync(
      SECURITY_BIN,
      ["delete-generic-password", "-s", service, "-a", account],
      { stdio: ["ignore", "ignore", "ignore"], timeout: SECURITY_TIMEOUT_MS }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}
