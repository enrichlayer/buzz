import assert from "node:assert/strict";
import test from "node:test";
import { selectionPosition } from "./selectionPosition.ts";

test("selection geometry follows the focus line and scrolling, then survives replaced text", () => {
  const root = document.createElement("div");
  root.textContent = "first line\nsecond line";
  document.body.append(root);
  let scroll = 0;
  root.getBoundingClientRect = () => new DOMRect(40, 80 - scroll, 600, 400);
  const previous = Range.prototype.getClientRects;
  Range.prototype.getClientRects = () => [
    new DOMRect(60, 180 - scroll, 100, 20),
    new DOMRect(60, 200 - scroll, 120, 20),
  ];
  try {
    const range = document.createRange();
    range.selectNodeContents(root.firstChild);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const forward = selectionPosition(root, selection);
    assert.equal(forward.contextElement, root);
    assert.equal(forward.getBoundingClientRect().top, 200);
    scroll = 40;
    assert.equal(forward.getBoundingClientRect().top, 160);

    selection.setBaseAndExtent(
      root.firstChild,
      root.textContent.length,
      root.firstChild,
      0,
    );
    const backward = selectionPosition(root, selection);
    assert.equal(backward.getBoundingClientRect().top, 140);

    // Focus can clear the real selection without losing the frozen geometry.
    selection.removeAllRanges();
    assert.equal(forward.getBoundingClientRect().top, 160);
    root.textContent = "A streamed replacement";
    scroll = 70;
    assert.equal(forward.getBoundingClientRect().top, 130);
    assert.equal(forward.getBoundingClientRect().width, 120);
  } finally {
    if (previous) Range.prototype.getClientRects = previous;
    else delete Range.prototype.getClientRects;
    root.remove();
    window.getSelection().removeAllRanges();
  }
});
