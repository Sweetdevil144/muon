import { useEffect, useRef } from "react";

/**
 * ROADMAP T4 — the minimal find-box for the ACTIVE terminal pane
 * (Cmd/Ctrl+F). A small floating bar rather than a modal: the terminal
 * itself stays fully visible and live underneath it, the same way a
 * browser's own find bar works.
 *
 * Purely a controlled input + three buttons — every actual search call
 * (`findNext`/`findPrevious`/`clear`) goes through the caller's handlers,
 * which look up whichever `TerminalView.search` controller is currently
 * registered for the active pane. This component has no idea an XTerm
 * instance exists.
 */
export function TerminalSearchOverlay(props: {
  query: string;
  onQueryChange: (query: string) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="terminal-search-overlay" role="search">
      <input
        aria-label="Find in terminal"
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
              props.onFindPrevious();
            } else {
              props.onFindNext();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
        placeholder="Find…"
        ref={inputRef}
        type="text"
        value={props.query}
      />
      <button
        aria-label="Find previous"
        disabled={!props.query}
        onClick={props.onFindPrevious}
        type="button"
      >
        ↑
      </button>
      <button
        aria-label="Find next"
        disabled={!props.query}
        onClick={props.onFindNext}
        type="button"
      >
        ↓
      </button>
      <button aria-label="Close find" onClick={props.onClose} type="button">
        ✕
      </button>
    </div>
  );
}
