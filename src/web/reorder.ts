import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

// Drag-to-reorder for a vertical list, driven by a handle. Pointer events (not HTML5 drag and drop)
// so it works with mouse, pen and touch alike.

interface Drag {
  id: number;
  from: number;
  to: number;
  dy: number;
  /** Height of the dragged row plus the list gap: how far the others slide aside. */
  shift: number;
}

export function useDragReorder<T extends { id: number }>(items: T[], onMove: (id: number, toIndex: number) => void) {
  const [drag, setDragState] = useState<Drag | null>(null);
  // The live value: a fast flick can deliver move and up before React re-renders, so handlers must
  // not read the drag from their render's closure.
  const live = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    live.current = d;
    setDragState(d);
  };
  // Order to show right after a drop, until the server's new order arrives.
  const [optimistic, setOptimistic] = useState<number[] | null>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const start = useRef<{ y: number; mids: number[]; fromMid: number } | null>(null);

  useEffect(() => setOptimistic(null), [items]);

  const shown = optimistic
    ? (optimistic.map((id) => items.find((i) => i.id === id)).filter(Boolean) as T[])
    : items;

  const rowRef = (id: number) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  };

  const handleProps = (id: number, index: number) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rects = shown.map((it) => rows.current.get(it.id)?.getBoundingClientRect());
      const own = rects[index];
      if (!own) return;
      const below = rects[index + 1];
      const above = rects[index - 1];
      const gap = below ? below.top - own.bottom : above ? own.top - above.bottom : 0;
      start.current = {
        y: e.clientY,
        fromMid: own.top + own.height / 2,
        // Midpoints of the other rows, in list order without the dragged one.
        mids: rects.filter((_, i) => i !== index).map((r) => (r ? r.top + r.height / 2 : 0)),
      };
      setDrag({ id, from: index, to: index, dy: 0, shift: own.height + gap });
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      const d = live.current;
      if (!s || !d || d.id !== id) return;
      const dy = e.clientY - s.y;
      const center = s.fromMid + dy;
      const to = s.mids.filter((m) => m < center).length;
      if (to !== d.to || dy !== d.dy) setDrag({ ...d, dy, to });
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      // The release point counts too, in case no move event arrived before it.
      const s = start.current;
      const d = live.current;
      if (s && d && d.id === id) {
        const center = s.fromMid + (e.clientY - s.y);
        live.current = { ...d, to: s.mids.filter((m) => m < center).length };
      }
      finish(true);
    },
    onPointerCancel: () => finish(false),
    // Arrow keys on the focused handle move one place, like the up/down buttons.
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : null;
      if (to === null || to < 0 || to >= shown.length) return;
      e.preventDefault();
      commit(id, index, to);
    },
  });

  function finish(drop: boolean) {
    const d = live.current;
    start.current = null;
    setDrag(null);
    if (drop && d && d.to !== d.from) commit(d.id, d.from, d.to);
  }

  function commit(id: number, from: number, to: number) {
    const ids = shown.map((i) => i.id);
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    setOptimistic(ids);
    onMove(id, to);
  }

  /** Inline style for a row: the dragged one follows the pointer, the others make room. */
  const rowStyle = (id: number, index: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, zIndex: 2, transition: "none" };
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return { transform: `translateY(${-drag.shift}px)` };
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return { transform: `translateY(${drag.shift}px)` };
    return { transform: "translateY(0)" };
  };

  return { items: shown, draggingId: drag?.id ?? null, rowRef, rowStyle, handleProps };
}
