import React from "react";

/**
 * The renderer's last line of defence.
 *
 * WHY THIS EXISTS, measured: `createRoot(...).render(<App />)` had no error
 * boundary anywhere in the tree, and React unmounts the ENTIRE tree when a
 * render throws. So one unguarded dereference in any panel — a chat deleted
 * while its tab is open, a vendor terminal tab mounting against state that has
 * moved — turned MUON into a permanently blank window with no message, no
 * recovery, and nothing in any log (the founder hit exactly this opening a
 * vendor terminal on 2026-08-05). A blank window is also indistinguishable
 * from a native renderer crash, so it cost a diagnosis every time.
 *
 * The boundary does not make the underlying throw correct. It makes it
 * VISIBLE (the message and component stack are on screen and copyable),
 * RECOVERABLE (re-mount without losing the app), and REPORTED (console.error,
 * which the debug sink tees into desktop.log). A caught error is a defect to
 * fix, never a state to live in — the panel says so.
 */
type Props = { children: React.ReactNode };

type State = {
  error: Error | null;
  componentStack: string | null;
  /** Bumped on "Try again" so the subtree remounts from scratch. */
  attempt: number;
};

function describe(error: Error, componentStack: string | null): string {
  return [
    `${error.name}: ${error.message}`,
    error.stack ? `\n${error.stack}` : "",
    componentStack ? `\nComponent stack:${componentStack}` : "",
  ].join("");
}

export class RendererErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      error:
        error instanceof Error ? error : new Error(String(error ?? "unknown")),
    };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    const normalized =
      error instanceof Error ? error : new Error(String(error ?? "unknown"));
    this.setState({ componentStack: info?.componentStack ?? null });
    // The audit sink: main tees renderer console output into desktop.log under
    // MUON_DEBUG, so a founder can paste the real cause instead of "it went
    // blank". Never throws itself.
    try {
      console.error(
        "[renderer] unhandled render error",
        describe(normalized, info?.componentStack ?? null)
      );
    } catch {
      // A logging failure must not replace the error being reported.
    }
  }

  private retry = () => {
    this.setState((current) => ({
      error: null,
      componentStack: null,
      attempt: current.attempt + 1,
    }));
  };

  private copy = () => {
    const { error, componentStack } = this.state;
    if (!error) return;
    try {
      void navigator.clipboard?.writeText(describe(error, componentStack));
    } catch {
      // Clipboard is a convenience; the text is already on screen.
    }
  };

  render() {
    const { error, componentStack, attempt } = this.state;
    if (!error) {
      return (
        <React.Fragment key={attempt}>{this.props.children}</React.Fragment>
      );
    }
    return (
      <div className="renderer-error" role="alert">
        <h1>MUON hit an unexpected error in its interface</h1>
        <p>
          Your work is safe: the local brain, the runner, and every running
          agent are separate processes and keep going. This is a defect in the
          window only — please report it with the detail below.
        </p>
        <pre className="renderer-error-detail">
          {describe(error, componentStack)}
        </pre>
        <div className="renderer-error-actions">
          <button type="button" onClick={this.retry}>
            Try again
          </button>
          <button type="button" onClick={this.copy}>
            Copy details
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload MUON
          </button>
        </div>
      </div>
    );
  }
}
