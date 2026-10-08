import assert from "node:assert/strict";
import test from "node:test";

import { fireEvent } from "@testing-library/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import {
  AnnotationSubmitProvider,
  SourceAnnotation,
} from "./SourceAnnotation.tsx";
import { captureSelectionAnchor } from "./selectionAnchor.ts";

// jsdom has no animation clock; Floating UI uses it to follow live Ranges.
test.before(() => {
  globalThis.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(performance.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
});
test.after(() => {
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});

function selectText(element, start = 0, end = element.textContent.length) {
  const text = element.firstChild;
  assert.ok(text, "selection target has a text node");
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function buttonNamed(name) {
  return Array.from(document.body.querySelectorAll("button")).find((button) =>
    button.textContent.includes(name),
  );
}

test("captures selected DOM text and reliable code lines without guessing Markdown offsets", () => {
  const root = document.createElement("div");
  root.dataset.annotationSourceId = "message-1";
  root.innerHTML =
    '<p>Rendered prose</p><div data-code-block><code><span data-code-line="1">const one = 1;</span><span data-code-line="2">const two = 2;</span></code></div>';
  document.body.append(root);
  try {
    const secondLine = root.querySelector('[data-code-line="2"]');
    const selection = selectText(secondLine, 6, 9);
    const anchor = captureSelectionAnchor(
      root,
      {
        sourceId: "message-1",
        text: "```ts\nconst one = 1;\nconst two = 2;\n```",
        revision: "stream-revision-3",
      },
      selection,
    );
    assert.equal(anchor.selectedText, "two");
    assert.equal(anchor.sourceRevision, "stream-revision-3");
    assert.equal(anchor.originalSourceText.includes("```ts"), true);
    assert.deepEqual(anchor.codeRange, {
      blockId: "message-1:code:1",
      startLine: 2,
      endLine: 2,
    });
  } finally {
    root.remove();
    window.getSelection().removeAllRanges();
  }
});

test("keyboard submit routes to the provider and a failed send retains the draft for retry", async () => {
  const requests = [];
  let attempts = 0;
  const onSubmit = async (request) => {
    requests.push(request);
    attempts += 1;
    if (attempts === 1) throw new Error("Relay unavailable");
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Tree({ text }) {
    return React.createElement(
      AnnotationSubmitProvider,
      { onSubmit },
      React.createElement(
        SourceAnnotation,
        {
          source: {
            channelId: "channel-4",
            sessionId: "session-9",
            sourceId: "message-2",
            text,
            turnId: "turn-5",
          },
        },
        React.createElement("p", { id: "answer" }, "Keep this exact answer"),
      ),
    );
  }

  try {
    await act(async () =>
      root.render(
        React.createElement(Tree, { text: "Keep this exact answer" }),
      ),
    );
    const answer = container.querySelector("#answer");
    selectText(answer, 5, 15);
    await act(async () =>
      fireEvent.keyDown(document.body, {
        key: "m",
        metaKey: true,
        shiftKey: true,
      }),
    );

    const input = document.body.querySelector(
      'textarea[aria-label="Feedback"]',
    );
    assert.ok(input, "keyboard shortcut opens the feedback popover");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Use the typed result." } });
    });
    await act(async () => {
      fireEvent.click(buttonNamed("Send feedback"));
      await Promise.resolve();
    });

    assert.equal(attempts, 1);
    assert.equal(input.value, "Use the typed result.");
    assert.match(document.body.textContent, /Relay unavailable/);
    assert.deepEqual(
      {
        channelId: requests[0].anchor.channelId,
        sessionId: requests[0].anchor.sessionId,
        turnId: requests[0].anchor.turnId,
      },
      { channelId: "channel-4", sessionId: "session-9", turnId: "turn-5" },
    );
    assert.match(requests[0].message, /> this exact/);
    assert.match(requests[0].message, /Use the typed result\./);

    await act(async () =>
      root.render(
        React.createElement(Tree, { text: "A streamed replacement" }),
      ),
    );
    assert.match(
      document.body.textContent,
      /response changed after selection/i,
      "streaming changes do not rewrite the captured anchor",
    );

    await act(async () => {
      fireEvent.click(buttonNamed("Retry"));
      await Promise.resolve();
    });
    assert.equal(attempts, 2);
    assert.equal(
      requests[1].anchor.originalSourceText,
      "Keep this exact answer",
    );
    assert.equal(
      document.body.querySelector('textarea[aria-label="Feedback"]'),
      null,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.getSelection().removeAllRanges();
  }
});
