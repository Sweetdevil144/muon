import { MuonApiHttpError } from "./api-client.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type RunnerLeaseAuthority = {
  apiBase: string;
  operatorToken?: string;
};

/** Operator-authorize one narrow, per-launch runner capability. */
export async function authorizeRunnerLease(
  authority: RunnerLeaseAuthority,
  host: string,
  leaseToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const requestedHost = host.trim();
  if (requestedHost.length === 0 || requestedHost.length > 200) {
    throw new Error("Runner host must contain 1–200 characters.");
  }
  if (leaseToken.length < 32 || leaseToken.length > 512) {
    throw new Error("Runner lease token must contain 32–512 characters.");
  }

  const base = new URL(authority.apiBase);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !LOOPBACK_HOSTS.has(base.hostname)
  ) {
    throw new Error("Runner lease authorization requires a loopback API base.");
  }
  const url = new URL("/api/runner/lease", base);
  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authority.operatorToken
        ? { Authorization: `Bearer ${authority.operatorToken}` }
        : {}),
    },
    body: JSON.stringify({ host: requestedHost, leaseToken }),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (response.ok && !response.redirected) {
    return;
  }

  let detail = response.statusText || "request failed";
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      detail = payload.message;
    }
  } catch {
    // Preserve the status text when a proxy or old backend returns non-JSON.
  }
  // A TYPED error, not a formatted string: `isAuthorizationFailure` recognizes
  // MuonApiHttpError 401/403, and callers honor the documented exit-2 contract
  // only when the classification survives this boundary. A plain Error here
  // made every lease refusal exit 1 as an ordinary failure.
  throw new MuonApiHttpError(
    response.status,
    response.statusText || "request failed",
    `Runner lease authorization failed (${response.status}): ${detail}`
  );
}
