/**
 * Diagnostic pipe loss must never cancel parent-loss cleanup or lease fencing.
 * Electron owns the runner's stdout/stderr readers; a hard parent crash closes
 * them and Node otherwise treats the resulting EPIPE as an unhandled error.
 */
export function guardRunnerOutput(
  ...streams: NodeJS.WritableStream[]
): () => void {
  const swallow = (_error: Error): void => undefined;
  for (const stream of streams) {
    stream.on("error", swallow);
  }
  return () => {
    for (const stream of streams) {
      stream.removeListener("error", swallow);
    }
  };
}
