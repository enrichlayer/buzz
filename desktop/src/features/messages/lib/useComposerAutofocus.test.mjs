import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const frames = new Map();
let nextFrame = 0;
const editors = [];
before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    window: dom.window,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame = (
    fn,
  ) => {
    const id = ++nextFrame;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame = (id) =>
    frames.delete(id);
});
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  frames.clear();
  document.body.replaceChildren();
});
after(() => dom.window.close());

async function fixture({ disabled = false } = {}) {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { Editor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { useComposerAutofocus } = await import("./useComposerAutofocus.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit],
    content: "<p>draft</p>",
  });
  editors.push(editor);
  function Harness({ currentDisabled = disabled, draftKey = "huddle" }) {
    useComposerAutofocus(editor, draftKey, currentDisabled);
    return null;
  }
  const view = render(React.createElement(Harness));
  return {
    editor,
    view,
    rerender: (props) => view.rerender(React.createElement(Harness, props)),
    flush: async () => {
      await React.act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    },
  };
}
function focusControl(role) {
  const overlay = document.createElement("div");
  overlay.setAttribute("role", role);
  const button = document.createElement("button");
  button.textContent = "Voice setting";
  overlay.append(button);
  document.body.append(overlay);
  button.focus();
  return button;
}
test("mount autofocus reaches the real editor and the end of its draft", async () => {
  const f = await fixture();
  await f.flush();
  assert.equal(
    document.activeElement === f.editor.view.dom,
    true,
    "composer owns focus",
  );
  assert.equal(f.editor.state.selection.from, 6);
  assert.equal(frames.size, 0, "no second unguarded focus frame remains");
});
for (const role of ["dialog", "menu", "listbox"]) {
  test(`a ${role} opened after autofocus was queued retains focus`, async () => {
    const f = await fixture();
    const button = focusControl(role);
    await f.flush();
    assert.equal(
      document.activeElement === button,
      true,
      "overlay keeps focus",
    );
    assert.equal(f.editor.view.hasFocus(), false);
  });
}
test("an expanded trigger retains focus before its overlay mounts", async () => {
  const f = await fixture();
  const button = document.createElement("button");
  button.setAttribute("aria-expanded", "true");
  document.body.append(button);
  button.focus();
  await f.flush();
  assert.equal(document.activeElement === button, true, "overlay keeps focus");
});
test("a search input focused after scheduling retains focus", async () => {
  const f = await fixture();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await f.flush();
  assert.equal(document.activeElement === input, true, "search keeps focus");
});
test("disabled state is read at execution without scheduling on re-enable", async () => {
  const f = await fixture();
  f.rerender({ currentDisabled: true });
  await f.flush();
  assert.equal(f.editor.view.hasFocus(), false);
  f.rerender({ currentDisabled: false });
  assert.equal(frames.size, 0);
});
test("unmount cancels pending autofocus", async () => {
  const f = await fixture();
  f.view.unmount();
  await f.flush();
  assert.equal(f.editor.view.hasFocus(), false);
});

test("channel navigation still focuses the new draft after a navigation button", async () => {
  const f = await fixture();
  await f.flush();
  const channel = document.createElement("button");
  document.body.append(channel);
  channel.focus();
  f.rerender({ draftKey: "another-channel" });
  await f.flush();
  assert.equal(
    document.activeElement === f.editor.view.dom,
    true,
    "composer owns focus",
  );
});
