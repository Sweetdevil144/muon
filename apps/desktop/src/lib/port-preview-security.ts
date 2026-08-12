/**
 * ROADMAP P6 — opt-in localhost preview allowlist.
 *
 * The preview pane is a NEW egress surface: it may load ONLY
 * `http://127.0.0.1:<port>/` — never arbitrary hosts, credentials, paths,
 * query strings, or non-http schemes. Main re-validates independently of the
 * renderer (same posture as terminal-link-validate.ts).
 */

export function buildLocalhostPreviewUrl(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return `http://127.0.0.1:${port}/`;
}

export function isAllowedPortPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      return false;
    }
    if (
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    const port = url.port ? Number(url.port) : 80;
    return Number.isInteger(port) && port >= 1 && port <= 65535;
  } catch {
    return false;
  }
}

/** Accept only the canonical builder output for a numeric port. */
export function resolvePortPreviewUrl(port: number): string | null {
  const url = buildLocalhostPreviewUrl(port);
  return url && isAllowedPortPreviewUrl(url) ? url : null;
}
