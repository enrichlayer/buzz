import assert from "node:assert/strict";
import test from "node:test";
import { formatTimelineMessages } from "./formatTimelineMessages.ts";
import {
  isKnownAgentAuthor,
  latestPromptSuggestions,
  parsePromptSuggestions,
  stripPromptSuggestionFooter,
} from "./promptSuggestions.ts";
import { buildSearchResultPreview } from "@/features/search/lib/searchMatch";
import { formatFeedNotification } from "@/features/notifications/lib/feed";
import { buildInboxItems } from "@/features/home/lib/inbox";
import { formatMessageNotification } from "@/features/notifications/lib/notificationFormat";

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
  body: "Done.",
  promptSuggestions: suggestions,
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
      {
        ...agent,
        id: "b",
        body: "New answer",
        promptSuggestions: undefined,
        createdAt: 2,
      },
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
    "\u2028",
    "\u2029",
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

test("rejects an @ at a token start so a suggestion never adds a recipient", () => {
  for (const prompt of [
    "@DeployBot ship it",
    "Ask @DeployBot to ship it",
    "Ship it (@DeployBot)",
    "Ship it **@DeployBot**",
    "Ship it _@DeployBot",
    "Ship it ||@DeployBot||",
    "Ship it\n@DeployBot",
    "Ship it,@DeployBot",
  ]) {
    for (const field of ["label", "prompt"]) {
      const entry = { label: "Ship", prompt: "Ship it", [field]: prompt };
      assert.equal(
        parsePromptSuggestions(footer({ version: 1, suggestions: [entry] })),
        null,
        `${field}: ${prompt}`,
      );
    }
  }
  const email = [{ label: "Email ops", prompt: "Email ops@example.com" }];
  assert.deepEqual(
    parsePromptSuggestions(footer({ version: 1, suggestions: email }))
      .suggestions,
    email,
  );
});

const AGENT_KEY = "a".repeat(64);
const HUMAN_KEY = "b".repeat(64);
const event = (pubkey, content, id = "1".repeat(64)) => ({
  id,
  pubkey,
  kind: 9,
  created_at: 1_700_000_000,
  content,
  tags: [["h", "channel"]],
  sig: "sig",
});
const format = (events) =>
  formatTimelineMessages(events, null, HUMAN_KEY, null, {
    [AGENT_KEY]: { displayName: "Agent", isAgent: true },
  });

test("the shared formatter strips an agent footer and keeps its suggestions", () => {
  const [message] = format([event(AGENT_KEY, footer())]);
  assert.equal(message.body, "Done.");
  assert.deepEqual(message.promptSuggestions, suggestions);
  assert.equal(latestPromptSuggestions([message]).pubkey, AGENT_KEY);

  const invalid = footer({ version: 2, suggestions });
  const [kept] = format([event(AGENT_KEY, invalid)]);
  assert.equal(kept.body, invalid);
  assert.equal(kept.promptSuggestions, undefined);
});

test("human message text keeps a footer and never supplies suggestions", () => {
  const [message] = format([event(HUMAN_KEY, footer())]);
  assert.equal(message.body, footer());
  assert.equal(message.promptSuggestions, undefined);
  assert.equal(latestPromptSuggestions([message]), null);
});

test("raw-content previews drop a valid footer", () => {
  assert.equal(stripPromptSuggestionFooter(footer(), true), "Done.");
  assert.equal(stripPromptSuggestionFooter("plain", true), "plain");
  assert.equal(
    formatMessageNotification({
      source: "dm",
      content: footer(),
      authorIsAgent: true,
    }).body,
    "Done.",
  );
});

test("preview consumers preserve human and unknown authors, hiding only agent metadata", () => {
  const content = footer({ version: 1, suggestions: [] });
  const item = {
    id: "preview",
    pubkey: "author",
    kind: 9,
    content,
    createdAt: 1,
    channelId: "channel",
    channelName: "Trial",
    tags: [["h", "channel"]],
    category: "mention",
  };
  for (const isAgent of [true, false, undefined]) {
    const expected = isAgent === true ? "Done." : content;
    assert.equal(
      stripPromptSuggestionFooter(content, isAgent === true),
      expected,
    );
    assert.equal(
      buildSearchResultPreview(content, "", 1000, isAgent),
      expected,
    );
    assert.equal(
      formatMessageNotification({
        source: "dm",
        content,
        authorIsAgent: isAgent,
      }).body,
      expected,
    );
    assert.equal(
      formatFeedNotification(item, "Author", isAgent).body,
      expected,
    );
    const [inbox] = buildInboxItems({
      channels: [],
      profiles: isAgent === undefined ? undefined : { author: { isAgent } },
      feed: {
        feed: {
          mentions: [item],
          needsAction: [],
          activity: [],
          agentActivity: [],
        },
        meta: {},
      },
    });
    assert.equal(inbox.preview, expected);
  }
});

test("preview agent provenance matches the timeline: known set, profile flag or bot role", () => {
  const content = footer({ version: 1, suggestions: [] });
  assert.equal(isKnownAgentAuthor("ABC", {}), false);
  assert.equal(
    isKnownAgentAuthor("ABC", { agentPubkeys: new Set(["abc"]) }),
    true,
  );
  assert.equal(
    isKnownAgentAuthor("abc", { profiles: { abc: { isAgent: true } } }),
    true,
  );
  assert.equal(
    isKnownAgentAuthor("abc", {
      profiles: { abc: { isAgent: false } },
      members: [{ pubkey: "ABC", role: "bot" }],
    }),
    true,
  );
  assert.equal(
    isKnownAgentAuthor("abc", {
      members: [
        { pubkey: "abc", role: "member" },
        { pubkey: "other", role: "bot" },
      ],
    }),
    false,
  );
  const item = {
    id: "preview",
    pubkey: "relay-agent",
    kind: 9,
    content,
    createdAt: 1,
    channelId: "channel",
    channelName: "Trial",
    tags: [["h", "channel"]],
    category: "mention",
  };
  const feed = {
    feed: {
      mentions: [item],
      needsAction: [],
      activity: [],
      agentActivity: [],
    },
    meta: {},
  };
  // A directory-only agent whose profile lacks the agent flag.
  const [stripped] = buildInboxItems({
    agentPubkeys: new Set(["relay-agent"]),
    channels: [],
    profiles: { "relay-agent": { isAgent: false } },
    feed,
  });
  assert.equal(stripped.preview, "Done.");
  const [kept] = buildInboxItems({
    agentPubkeys: new Set(["someone-else"]),
    channels: [],
    feed,
  });
  assert.equal(kept.preview, content);
});
