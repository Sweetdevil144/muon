import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

// Quiet UI — a draggable panel splitter (Task 3). A 1px hairline handle that
// highlights on hover/drag, keyboard-resizable (role="separator", arrow
// keys), and honors prefers-reduced-motion (the CSS transition is dropped
// there; the drag/keyboard math is unaffected either way).
//
// `sign` encodes which direction grows the panel this handle belongs to:
//  +1 — the panel sits to the LEFT of the handle (e.g. the sidebar): dragging
//       right / pressing ArrowRight grows it.
//  -1 — the panel sits to the RIGHT of the handle (e.g. the context dock):
//       dragging right / pressing ArrowRight SHRINKS it (its left edge is
//       moving into the panel), so ArrowLeft grows it instead.

const KEYBOARD_STEP = 16;

export function Splitter(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  sign: 1 | -1;
  onChange: (next: number) => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const deltaX = event.clientX - drag.startX;
      props.onChange(drag.startWidth + props.sign * deltaX);
    },
    [props]
  );

  const endDrag = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
    // FIX 3: clear the grid-transition-suspend flag whenever a drag ends
    // (pointerup, pointercancel, or unmount cleanup below) so the collapse
    // toggle animates again. Deleting an already-absent key is a no-op, so this
    // is safe even when no drag was in flight.
    delete document.documentElement.dataset.resizing;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
  }, [onPointerMove]);

  useEffect(() => () => endDrag(), [endDrag]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Left button (or primary touch) only.
      if (event.button !== 0) return;
      event.preventDefault();
      dragStateRef.current = { startX: event.clientX, startWidth: props.value };
      setDragging(true);
      // FIX 3: mark <html> as actively resizing so `.app.quiet` drops its
      // grid-template-columns transition (styles.css) for the duration of the
      // drag — the splitter writes the width var every pointermove, so a live
      // transition would animate each frame and make the edge rubber-band.
      document.documentElement.dataset.resizing = "1";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    },
    [endDrag, onPointerMove, props.value]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      let delta = 0;
      if (event.key === "ArrowLeft") delta = -KEYBOARD_STEP;
      else if (event.key === "ArrowRight") delta = KEYBOARD_STEP;
      else if (event.key === "Home") {
        props.onChange(props.min);
        event.preventDefault();
        return;
      } else if (event.key === "End") {
        props.onChange(props.max);
        event.preventDefault();
        return;
      } else {
        return;
      }
      event.preventDefault();
      props.onChange(props.value + props.sign * delta);
    },
    [props]
  );

  return (
    <div
      className={`panel-splitter${dragging ? " dragging" : ""}${
        props.className ? ` ${props.className}` : ""
      }`}
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span className="panel-splitter-line" aria-hidden="true" />
    </div>
  );
}
