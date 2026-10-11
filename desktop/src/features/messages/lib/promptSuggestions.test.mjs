import assert from "node:assert/strict";
import test from "node:test";
import {
  latestPromptSuggestions,
  parsePromptSuggestions,
} from "./promptSuggestions.ts";

const suggestions = [
  {
    label: "Use the account name",
    prompt: "Can the label use the account's name?",
  },
];
const footer = (value = { version: 1, suggestions }) =>
  `Done.\n\n\`\`\`suggested-prompts\n${JSON.stringify(value)}\n\`\`\``;
const agent = {
  id: "a",
  author: "Agent",
  pubkey: "agent-key",
  isAgent: true,
  createdAt: 1,
  body: footer(),
};

test("consumes only a valid final footer, preserving prose", () => {
  assert.deepEqual(parsePromptSuggestions(footer()), {
    body: "Done.",
    suggestions,
  });
  assert.equal(parsePromptSuggestions(`${footer()}\nMore prose`), null);
  assert.equal(
    parsePromptSuggestions("```suggested-prompts\ninvalid\n```"),
    null,
  );
  assert.equal(parsePromptSuggestions(footer().slice(0, -2)), null);
  assert.equal(
    parsePromptSuggestions(
      footer({
        version: 1,
        suggestions: [
          { label: "Explain field", prompt: "Explain `displayName`." },
        ],
      }),
    ).suggestions[0].prompt,
    "Explain `displayName`.",
  );
});
test("rejects malformed, oversized, duplicate and control-containing output", () => {
  for (const value of [
    null,
    { version: 2, suggestions },
    { version: 1, suggestions: [null] },
    { version: 1, suggestions: [...suggestions, ...suggestions] },
    { version: 1, suggestions: [{ label: "x".repeat(65), prompt: "yes" }] },
    { version: 1, suggestions: [{ label: "name", prompt: "x".repeat(1001) }] },
    { version: 1, suggestions: [{ label: "name", prompt: "\u001b[2J" }] },
    { version: 1, suggestions: [{ label: "name", prompt: "\u009b2J" }] },
    { version: 1, suggestions: [{ label: "name", prompt: "```" }] },
  ])
    assert.equal(parsePromptSuggestions(footer(value)), null);
  assert.deepEqual(
    parsePromptSuggestions(footer({ version: 1, suggestions: [] })).suggestions,
    [],
  );
});
test("only latest settled agent message supplies suggestions; human and newer messages invalidate", () => {
  assert.equal(latestPromptSuggestions([agent]).messageId, "a");
  assert.equal(latestPromptSuggestions([{ ...agent, isAgent: false }]), null);
  assert.equal(latestPromptSuggestions([{ ...agent, pending: true }]), null);
  assert.equal(
    latestPromptSuggestions([{ ...agent, pubkey: undefined }]),
    null,
  );
  assert.equal(
    latestPromptSuggestions([
      agent,
      { ...agent, id: "b", isAgent: false, createdAt: 2 },
    ]),
    null,
  );
  assert.equal(
    latestPromptSuggestions([
      agent,
      { ...agent, id: "b", body: "New answer", createdAt: 2 },
    ]),
    null,
  );
});

test("rejects Unicode format controls in labels and editable prompts", () => {
  for (const control of [
    "\u200B",
    "\u200E",
    "\u202A",
    "\u202E",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    "\uFEFF",
  ]) {
    for (const field of ["label", "prompt"]) {
      assert.equal(
        parsePromptSuggestions(
          footer({
            version: 1,
            suggestions: [
              { ...suggestions[0], [field]: `before${control}after` },
            ],
          }),
        ),
        null,
      );
    }
  }
});
test("retains ordinary multilingual text and permitted prompt whitespace", () => {
  const items = [{ label: "名前 الاسم", prompt: "名前\n\tالاسم" }];
  assert.deepEqual(
    parsePromptSuggestions(footer({ version: 1, suggestions: items }))
      .suggestions,
    items,
  );
});
