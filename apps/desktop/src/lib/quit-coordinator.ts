export type QuitEvent = {
  preventDefault(): void;
};

export type QuitCoordinatorOptions = {
  stopMonitor(): void;
  onBegin?(): void;
  drainRunner(): Promise<void>;
  stopBrain(): void;
  quit(): void;
  onError?: (error: unknown) => void;
};

/**
 * One shutdown authority: cancel runner recovery and drain it before the brain
 * disappears. The second Electron quit pass is allowed through unchanged.
 */
export function createQuitCoordinator(
  options: QuitCoordinatorOptions
): (event: QuitEvent) => void {
  let phase: "idle" | "draining" | "ready" = "idle";

  return (event) => {
    options.stopMonitor();
    if (phase === "ready") {
      return;
    }
    event.preventDefault();
    if (phase === "draining") {
      return;
    }

    phase = "draining";
    options.onBegin?.();
    void options
      .drainRunner()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        options.stopBrain();
        phase = "ready";
        options.quit();
      });
  };
}
