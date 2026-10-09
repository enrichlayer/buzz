import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationRegistry,
  resolveAnnotationSelection,
} from "./annotationRegistry.ts";

function fixture() {
  const root = document.createElement("div");
  root.innerHTML =
    '<section id="channel"><p id="human">A human message</p><section id="thread"><p id="tool">Tool output: tests passed</p><p id="code">const result = true;</p></section><div contenteditable="true" id="draft">Private unsent draft</div></section><article id="file">File preview content</article>';
  document.body.append(root);
  const registry = createAnnotationRegistry();
  const channel = {
    root: root.querySelector("#channel"),
    scope: { id: "channel-a", label: "#general", channelId: "a", priority: 10 },
    submit: async () => {},
  };
  const thread = {
    root: root.querySelector("#thread"),
    scope: {
      id: "thread-a",
      label: "this thread",
      channelId: "a",
      priority: 20,
    },
    submit: async () => {},
  };
  registry.scopes.add(channel);
  registry.scopes.add(thread);
  function select(start, end = start) {
    const range = document.createRange();
    const first = root.querySelector(start).firstChild;
    const last = root.querySelector(end).firstChild;
    range.setStart(first, 0);
    range.setEnd(last, last.textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return resolveAnnotationSelection(registry, selection);
  }
  return {
    root,
    registry,
    channel,
    thread,
    select,
    close() {
      root.remove();
      window.getSelection().removeAllRanges();
    },
  };
}

test("human text, tools and selections spanning multiple blocks do not need source wrappers", () => {
  const f = fixture();
  try {
    assert.equal(f.select("#human").scope, f.channel);
    const tool = f.select("#tool");
    assert.equal(tool.anchor.selectedText, "Tool output: tests passed");
    assert.equal(tool.scope, f.thread);
    const multiple = f.select("#tool", "#code");
    assert.match(multiple.anchor.selectedText, /tests passed.*const result/s);
    assert.equal(multiple.scope, f.thread);
  } finally {
    f.close();
  }
});

test("outside previews use the active conversation, with source provenance preserved", () => {
  const f = fixture();
  try {
    f.select("#tool");
    const file = f.select("#file");
    assert.equal(file.scope, f.thread);
    assert.equal(file.anchor.originalSourceText, "File preview content");
    const source = {
      sourceId: "file:readme",
      text: "File preview content",
      channelId: "source-channel",
    };
    const root = f.root.querySelector("#file");
    f.registry.sources.set(root, { root, read: () => source });
    const registered = f.select("#file");
    assert.equal(registered.anchor.sourceId, "file:readme");
    assert.equal(registered.anchor.channelId, "source-channel");
    assert.equal(registered.scope.scope.channelId, "a");
    f.registry.scopes.delete(f.thread);
    assert.equal(
      f.select("#file").scope,
      f.channel,
      "removed destinations cannot be selected",
    );
  } finally {
    f.close();
  }
});

test("editable drafts and ranges crossing them are excluded, but text without a conversation can be captured", () => {
  const f = fixture();
  try {
    assert.equal(f.select("#draft"), null);
    assert.equal(f.select("#human", "#file"), null);
    f.registry.scopes.clear();
    const selection = f.select("#file");
    assert.equal(selection.scope, null);
    assert.equal(selection.anchor.selectedText, "File preview content");
  } finally {
    f.close();
  }
});

test("paragraph selections ending at a parent boundary retain the message source", () => {
  const f = fixture();
  try {
    const human = f.root.querySelector("#human");
    const source = {
      sourceId: "human-message",
      text: human.textContent,
      channelId: "a",
    };
    f.registry.sources.set(human, { root: human, read: () => source });
    const range = document.createRange();
    range.setStart(human.firstChild, 0);
    range.setEnd(human.parentNode, 1);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const result = resolveAnnotationSelection(f.registry, selection);
    assert.equal(result.anchor.sourceId, "human-message");
    assert.equal(result.anchor.selectedText, "A human message");
    assert.equal(result.scope, f.channel);
    assert.equal(result.root, human);
    range.setEnd(f.root.querySelector("#tool").firstChild, 0);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.equal(
      resolveAnnotationSelection(f.registry, selection).anchor.sourceId,
      "human-message",
      "an empty endpoint in the next paragraph does not capture that paragraph",
    );
  } finally {
    f.close();
  }
});
