import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

import { ChannelNavigationProvider } from "@/shared/context/ChannelNavigationContext.tsx";
import { useChannelLinks } from "./useChannelLinks.ts";

afterEach(cleanup);

const channels = ["general", "engineering"].map((name) => ({
  id: name,
  name,
  channelType: "stream",
  archivedAt: null,
}));

function renderChannels() {
  return renderHook(() => useChannelLinks(), {
    wrapper: ({ children }) =>
      React.createElement(ChannelNavigationProvider, { channels }, children),
  });
}

function key(key) {
  return { key, preventDefault: () => assert.fail("stale query consumed key") };
}

for (const [name, text, cursor] of [
  ["replaced text", "Edited, not deleted", 19],
  ["deleted text", "", 0],
  ["caret outside hashtag", "Welcome to #general", 0],
  ["changed query", "#engineering", 12],
]) {
  test(`channel suggestions close immediately for ${name}`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { result, unmount } = renderChannels();
    act(() => result.current.updateChannelQuery("Welcome to #general", 19));
    act(() => t.mock.timers.tick(120));
    assert.equal(result.current.isChannelOpen, true);
    assert.equal(result.current.channelSuggestions[0].name, "general");

    act(() => result.current.updateChannelQuery(text, cursor));
    // No timer advance: neither the pointer list nor the keyboard may use
    // the old query while the new input is still being debounced.
    assert.equal(result.current.isChannelOpen, false);
    assert.deepEqual(result.current.channelSuggestions, []);
    assert.deepEqual(result.current.handleChannelKeyDown(key("Enter")), {
      handled: false,
    });
    assert.deepEqual(result.current.handleChannelKeyDown(key("Tab")), {
      handled: false,
    });
    act(() => t.mock.timers.tick(120));
    assert.equal(result.current.isChannelOpen, name === "changed query");
    unmount();
  });
}

test("same query at a new position uses the current replacement range", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { result, unmount } = renderChannels();
  act(() => result.current.updateChannelQuery("Welcome to #general", 19));
  act(() => t.mock.timers.tick(120));
  act(() => result.current.updateChannelQuery("#general", 8));
  let selected;
  act(() => {
    selected = result.current.handleChannelKeyDown({
      key: "Enter",
      preventDefault() {},
    });
  });
  assert.equal(selected.handled, true);
  let edit;
  act(() => {
    edit = result.current.insertChannel(selected.suggestion, 8);
  });
  assert.deepEqual(edit, {
    replaceFromOffset: 0,
    replaceToOffset: 8,
    insertText: "#general ",
  });
  assert.equal(result.current.isChannelOpen, false);
  unmount();
});
