import assert from "node:assert/strict";
import test from "node:test";

import { fireEvent } from "@testing-library/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { RuntimePluginHostProvider } from "./RuntimePluginHost.tsx";
import { RuntimePluginRenderer } from "./RuntimePluginRenderer.tsx";

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function manifest(blocks) {
  return {
    schemaVersion: 1,
    id: "example.renderer-test",
    name: "Renderer test",
    version: "1.0.0",
    fenceLanguage: "buzz-renderer-test",
    contentType: "json",
    blocks,
  };
}

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a required checkbox blocks compose, announces the error, then submits exactly once when checked", async () => {
  const composed = [];
  const plugin = manifest([
    {
      type: "form",
      id: "approval",
      fields: [
        {
          id: "confirmed",
          label: "I reviewed this change",
          type: "checkbox",
          required: true,
        },
      ],
      submit: {
        kind: "compose",
        label: "Prepare feedback",
        template: "confirmed={{form.confirmed}}",
      },
    },
  ]);
  const view = await mount(
    React.createElement(
      RuntimePluginHostProvider,
      { onCompose: (text) => composed.push(text) },
      React.createElement(RuntimePluginRenderer, {
        code: "{}",
        fallback: null,
        manifest: plugin,
      }),
    ),
  );

  try {
    const submit = view.container.querySelector(
      '[data-runtime-action="compose"]',
    );
    const checkbox = view.container.querySelector('[role="checkbox"]');
    assert.ok(submit);
    assert.ok(checkbox);

    await act(async () => fireEvent.click(submit));
    assert.deepEqual(composed, []);
    assert.match(
      view.container.querySelector('[role="alert"]')?.textContent ?? "",
      /I reviewed this change is required/,
    );
    assert.equal(checkbox.getAttribute("aria-invalid"), "true");

    await act(async () => fireEvent.click(checkbox));
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    await act(async () => fireEvent.click(submit));
    assert.deepEqual(composed, ["confirmed=true"]);
  } finally {
    await view.cleanup();
  }
});

test("the same required checkbox gate prevents clipboard actions", async () => {
  const priorInternals = window.__TAURI_INTERNALS__;
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push([command, args]);
    },
  };
  const plugin = manifest([
    {
      type: "form",
      id: "copy-approval",
      fields: [
        {
          id: "confirmed",
          label: "Confirm copy",
          type: "checkbox",
          required: true,
        },
      ],
      submit: {
        kind: "copy",
        label: "Copy result",
        template: "copy={{form.confirmed}}",
      },
    },
  ]);
  const view = await mount(
    React.createElement(RuntimePluginRenderer, {
      code: "{}",
      fallback: null,
      manifest: plugin,
    }),
  );

  try {
    const submit = view.container.querySelector('[data-runtime-action="copy"]');
    const checkbox = view.container.querySelector('[role="checkbox"]');
    assert.ok(submit);
    assert.ok(checkbox);
    await act(async () => fireEvent.click(submit));
    assert.equal(calls.length, 0);
    assert.match(
      view.container.querySelector('[role="alert"]')?.textContent ?? "",
      /Confirm copy is required/,
    );

    await act(async () => fireEvent.click(checkbox));
    await act(async () => {
      fireEvent.click(submit);
      await Promise.resolve();
    });
    assert.deepEqual(calls, [
      ["copy_text_to_clipboard", { html: undefined, text: "copy=true" }],
    ]);
  } finally {
    window.__TAURI_INTERNALS__ = priorInternals;
    await view.cleanup();
  }
});

test("compose actions remain disabled when no thread host is present", async () => {
  const plugin = manifest([
    {
      type: "action",
      action: { kind: "compose", label: "Reply", template: "hello" },
    },
    {
      type: "form",
      id: "reply-form",
      fields: [{ id: "note", label: "Note", type: "text" }],
      submit: { kind: "compose", label: "Prepare", template: "{{form.note}}" },
    },
  ]);
  const view = await mount(
    React.createElement(RuntimePluginRenderer, {
      code: "{}",
      fallback: null,
      manifest: plugin,
    }),
  );

  try {
    const actions = view.container.querySelectorAll(
      '[data-runtime-action="compose"]',
    );
    assert.equal(actions.length, 2);
    for (const action of actions) {
      assert.equal(action.disabled, true);
      assert.match(action.title, /Open this content in a thread/);
    }
  } finally {
    await view.cleanup();
  }
});

test("segmented selects preserve initial and submitted values without composing on selection", async () => {
  const widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 500,
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: this.tagName === "SPAN" ? this.textContent.length * 7 + 20 : 500,
    };
  };
  const composed = [];
  const plugin = manifest([
    {
      type: "form",
      id: "decision",
      fields: [
        {
          id: "choice",
          label: "Decision",
          type: "select",
          presentation: "segmented",
          options: ["Approve", "Needs changes"],
          initial: "Needs changes",
          required: true,
        },
      ],
      submit: {
        kind: "compose",
        label: "Add to composer",
        template: "{{form.choice}}",
      },
    },
  ]);
  const view = await mount(
    React.createElement(
      RuntimePluginHostProvider,
      { onCompose: (text) => composed.push(text) },
      React.createElement(RuntimePluginRenderer, {
        code: "{}",
        fallback: null,
        manifest: plugin,
      }),
    ),
  );
  try {
    const group = view.container.querySelector("fieldset");
    assert.ok(group);
    assert.equal(
      group.querySelector('[aria-pressed="true"]').textContent,
      "Needs changes",
    );
    await act(async () => fireEvent.click(group.querySelector("button")));
    assert.deepEqual(composed, []);
    await act(async () =>
      fireEvent.click(
        view.container.querySelector('[data-runtime-action="compose"]'),
      ),
    );
    assert.deepEqual(composed, ["Approve"]);
  } finally {
    await view.cleanup();
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (widthDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        widthDescriptor,
      );
    else delete HTMLElement.prototype.clientWidth;
  }
});
