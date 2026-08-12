import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
};

export function CommandPalette(props: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const enabled = props.commands.filter((c) => !c.disabled);
    if (!q) return enabled;
    return enabled.filter((c) => c.label.toLowerCase().includes(q));
  }, [props.commands, query]);

  useEffect(() => {
    if (!props.open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [props.open]);

  useEffect(() => setActive(0), [query]);
  if (!props.open) return null;

  const run = (cmd?: PaletteCommand) => {
    if (!cmd) return;
    props.onClose();
    cmd.run();
  };

  return (
    <div
      className="command-palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(results[active]);
          } else if (e.key === "Tab") {
            // aria-modal="true" promises the rest of the app is inert while
            // this is open — Tab must never leak focus to it. Only the
            // filter input is focusable inside the palette today (the rows
            // are click/arrow-key targets, not tab stops), so this cycles
            // Tab/Shift+Tab back to the same edge instead of letting focus
            // escape the overlay.
            const container = e.currentTarget as HTMLElement;
            const focusable = Array.from(
              container.querySelectorAll<HTMLElement>(
                'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
              )
            );
            const first = focusable[0];
            const last = focusable.at(-1);
            if (!first || !last) return;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          placeholder="Type a command…"
          aria-label="Command palette filter"
          aria-controls="command-palette-list"
          aria-activedescendant={
            results[active] ? `cmd-${results[active].id}` : undefined
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul
          id="command-palette-list"
          className="command-palette-list"
          role="listbox"
          aria-label="Commands"
        >
          {results.length === 0 ? (
            <li className="command-palette-empty" role="presentation">
              No matching command.
            </li>
          ) : (
            results.map((cmd, i) => (
              <li
                key={cmd.id}
                id={`cmd-${cmd.id}`}
                role="option"
                aria-selected={i === active}
                className={
                  "command-palette-item" + (i === active ? " active" : "")
                }
                onMouseMove={() => setActive(i)}
                onClick={() => run(cmd)}
              >
                <span>{cmd.label}</span>
                {cmd.hint ? <kbd>{cmd.hint}</kbd> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
