import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { AdaptiveSegmentedControl } from "./adaptive-segmented-control.tsx";

let availableWidth = 500;
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.add(callback);
  }
  observe() {}
  disconnect() {
    observers.delete(this.callback);
  }
};
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => availableWidth,
});
HTMLElement.prototype.getBoundingClientRect = function () {
  return {
    width:
      this.tagName === "SPAN"
        ? this.textContent.length * 7 + 20
        : availableWidth,
  };
};

const options = [
  { label: "Default", value: "" },
  { label: "Low", value: "low" },
  { label: "High", value: "high" },
];
async function mount(props = {}) {
  availableWidth = 500;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes = [];
  function Example() {
    const [value, setValue] = React.useState(props.value ?? "");
    const choose = (next) => {
      changes.push(next);
      setValue(next);
    };
    const choices = props.options ?? options;
    return React.createElement(AdaptiveSegmentedControl, {
      id: "effort",
      legend: "Thinking effort",
      options: choices,
      ...props,
      value,
      onValueChange: choose,
      fallback: React.createElement(
        "select",
        {
          "aria-label": "Thinking effort",
          disabled: props.disabled,
          value,
          onChange: (event) => choose(event.target.value),
        },
        choices.map((option) =>
          React.createElement(
            "option",
            {
              key: option.value,
              value: option.value,
              disabled: option.disabled,
            },
            option.label,
          ),
        ),
      ),
    });
  }
  await act(async () => root.render(React.createElement(Example)));
  return {
    container,
    changes,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("keyboard skips unavailable values, preserves default sentinel and does not submit", async () => {
  const view = await mount({
    options: [options[0], { ...options[1], disabled: true }, options[2]],
    ariaDescribedBy: "help",
  });
  try {
    const group = view.container.querySelector("fieldset");
    assert.equal(group.querySelector("legend").textContent, "Thinking effort");
    assert.equal(group.getAttribute("aria-describedby"), "help");
    const [inherit, low, high] = group.querySelectorAll("button");
    assert.equal(inherit.getAttribute("aria-pressed"), "true");
    assert.equal(low.disabled, true);
    assert.equal(high.type, "button");
    await act(async () => fireEvent.keyDown(inherit, { key: "ArrowRight" }));
    assert.equal(document.activeElement, high);
    assert.equal(high.getAttribute("aria-pressed"), "true");
    await act(async () => fireEvent.keyDown(high, { key: "Home" }));
    assert.deepEqual(view.changes, ["high", ""]);
    await act(async () => fireEvent.click(low));
    assert.deepEqual(view.changes, ["high", ""]);
  } finally {
    await view.cleanup();
  }
});

test("resizing switches presentation while retaining the selected value", async () => {
  const view = await mount({ value: "high" });
  try {
    assert.ok(view.container.querySelector("fieldset"));
    view.container.querySelector('[aria-pressed="true"]').focus();
    availableWidth = 100;
    await act(async () => {
      for (const callback of observers) callback();
    });
    assert.equal(view.container.querySelector("select").value, "high");
    assert.equal(
      document.activeElement,
      view.container.querySelector("select"),
    );
    assert.equal(view.container.querySelector("fieldset"), null);
    availableWidth = 500;
    await act(async () => {
      for (const callback of observers) callback();
    });
    assert.equal(
      view.container.querySelector('[aria-pressed="true"]').textContent,
      "High",
    );
    assert.equal(
      document.activeElement,
      view.container.querySelector('[aria-pressed="true"]'),
    );
    assert.deepEqual(view.changes, []);
  } finally {
    await view.cleanup();
  }
});

test("long labels, large sets and unknown values retain the dropdown", async () => {
  for (const props of [
    { options: [...options, { value: "max", label: "Max" }] },
    {
      options: [
        options[0],
        {
          value: "long",
          label: "A runtime-specific choice with a very long explanatory label",
        },
      ],
    },
    { value: "unavailable" },
  ]) {
    const view = await mount(props);
    try {
      assert.ok(view.container.querySelector("select"));
      assert.equal(view.container.querySelector("fieldset"), null);
      assert.deepEqual(view.changes, []);
    } finally {
      await view.cleanup();
    }
  }
});

test("effort may display four complete choices and locked controls cannot change", async () => {
  const view = await mount({
    maxOptions: 4,
    disabled: true,
    options: [...options, { value: "max", label: "Max" }],
  });
  try {
    assert.equal(view.container.querySelectorAll("button").length, 4);
    assert.equal(view.container.querySelector("fieldset").disabled, true);
    await act(async () =>
      fireEvent.keyDown(view.container.querySelector("button"), { key: "End" }),
    );
    await act(async () =>
      fireEvent.click(view.container.querySelector("button")),
    );
    assert.deepEqual(view.changes, []);
  } finally {
    await view.cleanup();
  }
});
