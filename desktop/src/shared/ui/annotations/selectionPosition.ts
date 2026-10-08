/** A virtual popover anchor that survives focus moving into the comment editor. */
export function selectionPosition(root: HTMLElement, selection: Selection) {
  const range = selection.getRangeAt(0).cloneRange();
  const text = range.toString();
  const atStart =
    selection.focusNode === range.startContainer &&
    selection.focusOffset === range.startOffset;
  const readRange = () => {
    const rects = Array.from(range.getClientRects?.() ?? []).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    return (atStart ? rects[0] : rects.at(-1)) ?? null;
  };
  const initial = readRange() ?? root.getBoundingClientRect();
  const sourceRect = root.getBoundingClientRect();
  const offset = {
    x: initial.left - sourceRect.left,
    y: initial.top - sourceRect.top,
  };

  return {
    contextElement: root,
    getBoundingClientRect: () => {
      // A streaming render may replace the selected nodes. Keep the captured
      // location relative to the source, rather than following a mutated Range.
      if (
        root.contains(range.startContainer) &&
        root.contains(range.endContainer) &&
        range.toString() === text
      ) {
        const current = readRange();
        if (current) return current;
      }
      const current = root.getBoundingClientRect();
      return new DOMRect(
        current.left + offset.x,
        current.top + offset.y,
        initial.width,
        initial.height,
      );
    },
  };
}
