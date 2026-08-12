import type { RunnerCoords } from "./runner-supervisor.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROBE_TIMEOUT_MS = 1500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Confirm that this desktop's own runner host has a fresh heartbeat.
 *
 * The probe deliberately stays outside MuonApiClient.getRunner(): that shared
 * method keeps its latest-runner contract, while desktop supervision needs an
 * exact-host answer so another runner cannot create a false positive.
 */
export async function probeRunnerHost(
  coords: RunnerCoords,
  host: string,
  expectedPid: number,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const requestedHost = host.trim();
  const agentToken = coords.agentToken?.trim();
  if (
    requestedHost.length === 0 ||
    requestedHost.length > 200 ||
    !Number.isInteger(expectedPid) ||
    expectedPid <= 0
  ) {
    return false;
  }

  let base: URL;
  try {
    base = new URL(coords.apiBase);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !LOOPBACK_HOSTS.has(base.hostname)
  ) {
    return false;
  }
  const url = new URL("/api/runner", base);
  url.searchParams.set("host", requestedHost);
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: agentToken
      ? { Authorization: `Bearer ${agentToken}` }
      : {},
    redirect: "error",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok || response.redirected) {
    throw new Error(
      `Runner heartbeat probe unavailable (${response.status} ${response.statusText})`
    );
  }

  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.live !== "boolean" ||
    (payload.runner !== null && !isRecord(payload.runner))
  ) {
    throw new Error("Runner heartbeat probe returned an invalid payload.");
  }
  if (payload.live !== true || !isRecord(payload.runner)) {
    return false;
  }
  return (
    payload.runner.host === requestedHost &&
    payload.runner.pid === expectedPid
  );
}
