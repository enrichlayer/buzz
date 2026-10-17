import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationSourceRevision,
  annotationMetadata,
} from "./annotationModel.ts";
import {
  annotationRange,
  findAnnotationSource,
  focusAnnotationSource,
  waitForAnnotationSource,
} from "./annotationNavigation.ts";
import { captureSelectionAnchor } from "./selectionAnchor.ts";
import { createAnnotationRegistry } from "./annotationRegistry.ts";

function fixture(html = "<p>one <b>selected</b> text</p>") {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  const source = { sourceId: "m", channelId: "c", text: root.textContent };
  const entry = { root, read: () => source };
  const anchor = {
    ...source,
    sourceRevision: annotationSourceRevision(source),
    renderedRevision: annotationSourceRevision(source),
    selectedText: "selected text",
  };
  return { root, source, entry, anchor };
}

test("exact selection spans rendered markup and refuses changed revisions", () => {
  const { root, source, entry, anchor } = fixture();
  try {
    assert.equal(annotationRange(entry, anchor).toString(), "selected text");
    source.text += "edited";
    assert.match(annotationRange(entry, anchor), /changed/);
  } finally {
    root.remove();
  }
});

test("legacy repeated selections fail closed; captured offsets identify the second occurrence", () => {
  const { root, entry, anchor } = fixture("<p>selected text selected text</p>");
  try {
    assert.match(annotationRange(entry, anchor), /more than once/);
    const range = annotationRange(entry, { ...anchor, textOffset: 14 });
    assert.equal(range.startOffset, 14);
    assert.equal(range.toString(), "selected text");
    assert.match(
      annotationRange(entry, { ...anchor, selectedText: "missing" }),
      /no longer available/,
    );
  } finally {
    root.remove();
  }
});

test("source resolution respects channel identity and waits for backfilled DOM", async () => {
  const registry = createAnnotationRegistry();
  const { root, entry, anchor } = fixture();
  try {
    registry.sources.set(root, entry);
    assert.equal(
      findAnnotationSource(registry, { ...anchor, channelId: "other" }),
      undefined,
    );
    root.remove();
    assert.equal(findAnnotationSource(registry, anchor), undefined);
    const waiting = waitForAnnotationSource(registry, anchor);
    document.body.append(root);
    assert.equal(await waiting, entry);
  } finally {
    root.remove();
  }
});

test("captured selection offsets survive the metadata envelope and select the correct occurrence", () => {
  const { root, source, entry } = fixture("<p>selected text selected text</p>");
  try {
    const range = document.createRange();
    range.setStart(root.firstChild.firstChild, 13);
    range.setEnd(root.firstChild.firstChild, 27);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const anchor = captureSelectionAnchor(root, source, selection);
    const metadata = JSON.parse(JSON.stringify(annotationMetadata(anchor)));
    assert.equal(metadata.textOffset, 14);
    assert.equal(annotationRange(entry, metadata).startOffset, 14);
    assert.equal(annotationRange(entry, metadata).toString(), "selected text");
  } finally {
    window.getSelection().removeAllRanges();
    root.remove();
  }
});

test("paragraph separators preserve exact DOM ranges without allowing unrelated quote locations", () => {
  const { root, entry, anchor } = fixture("<p>selected</p><p>text</p>");
  try {
    const multiline = {
      ...anchor,
      selectedText: "selected\ntext",
      selectedDomText: "selectedtext",
      textOffset: 0,
    };
    assert.equal(annotationRange(entry, multiline).toString(), "selectedtext");
    assert.match(
      annotationRange(entry, { ...multiline, selectedDomText: "unrelated" }),
      /does not match/,
    );
  } finally {
    root.remove();
  }
});

test("source navigation temporarily focuses a non-interactive wrapper", () => {
  const { root } = fixture();
  try {
    root.focus();
    assert.notEqual(document.activeElement, root);
    focusAnnotationSource(root);
    assert.equal(document.activeElement, root);
    assert.equal(root.tabIndex, -1);
    root.blur();
    assert.equal(root.hasAttribute("tabindex"), false);
    root.tabIndex = 0;
    focusAnnotationSource(root);
    root.blur();
    assert.equal(root.tabIndex, 0);
  } finally {
    root.remove();
  }
});

test("a changed renderer cannot reuse an offset that now points at a different repeated occurrence", () => {
  const { root, entry, anchor } = fixture("<p>selected text selected text</p>");
  try {
    const captured = { ...anchor, textOffset: 14 };
    assert.equal(annotationRange(entry, captured).startOffset, 14);
    root.insertAdjacentHTML("afterbegin", "<button>selected text </button>");
    assert.match(annotationRange(entry, captured), /more than once/);
  } finally {
    root.remove();
  }
});
