import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One TCP socket in LISTEN state discovered by a bounded host scan. */
export type ListeningPort = {
  pid: number;
  port: number;
  /** Bind address as reported by the OS (`127.0.0.1`, `*`, `::`, …). */
  address: string;
  command?: string;
};

export type PortScanRunner = (
  command: string,
  args: readonly string[]
) => Promise<string>;

const DEFAULT_SCAN_TIMEOUT_MS = 5_000;

export const PORT_SCAN_BASE_INTERVAL_MS = 2_000;
export const PORT_SCAN_MAX_INTERVAL_MS = 30_000;
export const PORT_SCAN_IDLE_BACKOFF = 1.5;

function parsePortFromName(name: string): { address: string; port: number } | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  // lsof `-F n` lines look like `n127.0.0.1:3000`, `n*:8080`, `[::1]:5173`.
  const bracket = trimmed.match(/^\[(.+)\]:(\d+)$/);
  if (bracket) {
    const port = Number(bracket[2]);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? { address: bracket[1]!, port }
      : null;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) {
    return null;
  }
  const address = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { address, port };
}

/**
 * Parse `lsof -nP -F pcn` output. Each record is a run of `p`/`c`/`n` lines.
 * Injectable in tests via fixture strings — no subprocess required.
 */
export function parseLsofListenFieldOutput(output: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      pid = undefined;
      command = undefined;
      continue;
    }
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const next = Number(value);
      pid = Number.isInteger(next) && next > 0 ? next : undefined;
      continue;
    }
    if (tag === "c") {
      command = value || undefined;
      continue;
    }
    if (tag !== "n" || pid === undefined) {
      continue;
    }
    if (!value.includes("LISTEN") && !value.includes("TCP")) {
      // `-F n` for sockets is usually `127.0.0.1:3000`; skip unrelated names.
      if (!/:\d+$/.test(value) && !/\]:\d+$/.test(value)) {
        continue;
      }
    }
    const parsed = parsePortFromName(value.replace(/\s+\(LISTEN\)$/i, ""));
    if (!parsed) {
      continue;
    }
    ports.push({
      pid,
      port: parsed.port,
      address: parsed.address,
      ...(command ? { command } : {}),
    });
  }
  return dedupeListeningPorts(ports);
}

/** Parse `ss -H -ltnp` (Linux) listen rows. */
export function parseSsListenOutput(output: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("LISTEN")) {
      continue;
    }
    const local = trimmed.split(/\s+/)[3];
    if (!local) {
      continue;
    }
    const hostPort = local.includes(":") ? local : `[${local}]`;
    const parsed = parsePortFromName(hostPort.replace(/^\[(.+)\]$/, "$1"));
    if (!parsed) {
      continue;
    }
    const pidMatch = trimmed.match(/pid=(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const commandMatch = trimmed.match(/users:\(\("([^"]+)"/);
    ports.push({
      pid,
      port: parsed.port,
      address: parsed.address,
      ...(commandMatch?.[1] ? { command: commandMatch[1] } : {}),
    });
  }
  return dedupeListeningPorts(ports);
}

/** Stable dedupe key for one bind tuple. */
export function listeningPortKey(port: ListeningPort): string {
  return `${port.pid}:${port.address}:${port.port}`;
}

export function dedupeListeningPorts(
  ports: readonly ListeningPort[]
): ListeningPort[] {
  const seen = new Set<string>();
  const out: ListeningPort[] = [];
  for (const port of ports) {
    const key = listeningPortKey(port);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(port);
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export function portScanSignature(ports: readonly ListeningPort[]): string {
  return dedupeListeningPorts(ports)
    .map((port) => listeningPortKey(port))
    .join("|");
}

export function computePortScanIntervalMs(
  unchangedCycles: number,
  baseMs: number = PORT_SCAN_BASE_INTERVAL_MS,
  maxMs: number = PORT_SCAN_MAX_INTERVAL_MS
): number {
  if (unchangedCycles <= 0) {
    return baseMs;
  }
  const scaled = Math.round(
    baseMs * PORT_SCAN_IDLE_BACKOFF ** Math.min(unchangedCycles, 8)
  );
  return Math.min(maxMs, scaled);
}

async function defaultRunner(
  command: string,
  args: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    timeout: DEFAULT_SCAN_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.toString();
}

/**
 * Bounded listen scan using lsof on macOS/BSD and ss→lsof on Linux.
 * The runner is injectable so tests use fixture output with no network IO.
 */
export async function scanListeningPorts(
  runner: PortScanRunner = defaultRunner
): Promise<ListeningPort[]> {
  if (process.platform === "linux") {
    try {
      const ssOut = await runner("ss", ["-H", "-ltnp"]);
      const parsed = parseSsListenOutput(ssOut);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // fall through to lsof
    }
  }
  const lsofOut = await runner("lsof", [
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-F",
    "pcn",
  ]);
  return parseLsofListenFieldOutput(lsofOut);
}

export type PortScanPollerOptions = {
  scan?: () => Promise<ListeningPort[]>;
  onUpdate: (ports: ListeningPort[]) => void;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  schedule?: (delayMs: number, run: () => void) => void;
  now?: () => number;
};

export type PortScanPoller = {
  start(): void;
  stop(): void;
  /** Force one immediate scan (used after a terminal spawn). */
  poke(): void;
};

/** One shared scan loop with idle backoff when the listen table is unchanged. */
export function createPortScanPoller(
  options: PortScanPollerOptions
): PortScanPoller {
  const scan = options.scan ?? scanListeningPorts;
  const baseIntervalMs = options.baseIntervalMs ?? PORT_SCAN_BASE_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? PORT_SCAN_MAX_INTERVAL_MS;
  const schedule =
    options.schedule ??
    ((delayMs, run) => {
      timer = setTimeout(run, delayMs);
    });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let running = false;
  let lastSignature = "";
  let unchangedCycles = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleNext = (delayMs: number) => {
    clearTimer();
    if (stopped) {
      return;
    }
    schedule(delayMs, () => {
      void tick();
    });
  };

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const ports = await scan();
      const signature = portScanSignature(ports);
      if (signature === lastSignature) {
        unchangedCycles += 1;
      } else {
        unchangedCycles = 0;
        lastSignature = signature;
        options.onUpdate(ports);
      }
    } catch {
      // Fail quiet: keep the last good snapshot; retry on the base interval.
      unchangedCycles = 0;
    } finally {
      running = false;
      if (!stopped) {
        scheduleNext(
          computePortScanIntervalMs(unchangedCycles, baseIntervalMs, maxIntervalMs)
        );
      }
    }
  };

  return {
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      unchangedCycles = 0;
      void tick();
    },
    stop() {
      stopped = true;
      clearTimer();
    },
    poke() {
      if (stopped) {
        return;
      }
      unchangedCycles = 0;
      void tick();
    },
  };
}
