import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PromptSuggestions } from "./PromptSuggestions.tsx";

test("mount preserves free-text focus; selection only calls draft insertion", () => {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.value = "My draft";
  input.focus();
  let calls = 0;
  let dismisses = 0;
  const suggestion = {
    label: "Use name",
    prompt: "Can the label show my name?",
  };
  const view = render(
    React.createElement(PromptSuggestions, {
      source: {
        messageId: "a",
        author: "Agent",
        pubkey: "key",
        suggestions: [suggestion],
      },
      onInsert: (value) => {
        assert.deepEqual(value, suggestion);
        calls++;
        return true;
      },
      onDismiss: () => {
        dismisses++;
      },
    }),
  );
  assert.equal(document.activeElement, input);
  assert.equal(input.value, "My draft");
  assert.equal(calls, 0);
  const button = view.getByRole("button", { name: "Use name" });
  assert.equal(button.type, "button");
  fireEvent.click(button);
  assert.equal(calls, 1);
  assert.equal(dismisses, 1);
  cleanup();
  input.remove();
});
test("dismiss and Escape never select a suggestion", () => {
  let dismisses = 0;
  const view = render(
    React.createElement(PromptSuggestions, {
      source: {
        messageId: "a",
        author: "Agent",
        pubkey: "key",
        suggestions: [{ label: "Use name", prompt: "Show name" }],
      },
      onInsert: () => {
        throw new Error("dismiss selected a prompt");
      },
      onDismiss: () => {
        dismisses++;
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Dismiss suggestions" }));
  fireEvent.keyDown(view.getByRole("group"), { key: "Escape" });
  assert.equal(dismisses, 2);
  cleanup();
});
