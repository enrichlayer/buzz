import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnsweredContent,
  isValidQuestionAnswer,
  parseAgentPrompt,
} from "./agentPromptContent";
import {
  buildDraftAnswer,
  draftChoices,
  EMPTY_DRAFT,
  toggleOption,
  toggleOther,
} from "./questionDraft";

const ANSWERER = "c".repeat(64);
const AGENT = "a".repeat(64);

function question(overrides = {}) {
  return {
    id: "question_0",
    header: "Auth method",
    question: "Which auth method should the endpoint use?",
    multiSelect: false,
    allowOther: true,
    options: [
      { label: "API key (Recommended)", description: "Matches v2" },
      {
        label: "OAuth",
        description: "Third-party apps",
        preview: "Authorization: Bearer ...",
      },
    ],
    ...overrides,
  };
}

function content(overrides = {}) {
  return JSON.stringify({
    version: 1,
    kind: "question",
    state: "open",
    questions: [question()],
    ...overrides,
  });
}

test("parses the plan's example prompt", () => {
  const prompt = parseAgentPrompt(content(), AGENT);
  assert.equal(prompt?.state, "open");
  assert.equal(prompt.questions[0].options[0].label, "API key (Recommended)");
  assert.equal(prompt.questions[0].options[0].preview, null);
  assert.equal(
    prompt.questions[0].options[1].preview,
    "Authorization: Bearer ...",
  );
  assert.equal(prompt.answer, null);
});

test("defaults: single-select, Other allowed", () => {
  const { multiSelect: _m, allowOther: _a, ...bare } = question();
  const prompt = parseAgentPrompt(content({ questions: [bare] }), AGENT);
  assert.equal(prompt?.questions[0].multiSelect, false);
  assert.equal(prompt?.questions[0].allowOther, true);
});

test("malformed content yields null", () => {
  const cases = {
    "not json": "{",
    array: "[]",
    "wrong version": content({ version: 2 }),
    "wrong kind": content({ kind: "approval" }),
    "unknown state": content({ state: "closed" }),
    "no questions": content({ questions: [] }),
    "five questions": content({
      questions: [0, 1, 2, 3, 4].map((i) => question({ id: `q${i}` })),
    }),
    "duplicate question ids": content({ questions: [question(), question()] }),
    "blank header": content({ questions: [question({ header: " " })] }),
    "non-boolean multiSelect": content({
      questions: [question({ multiSelect: "yes" })],
    }),
    "no options": content({ questions: [question({ options: [] })] }),
    "nine options": content({
      questions: [
        question({
          options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })),
        }),
      ],
    }),
    "duplicate labels": content({
      questions: [question({ options: [{ label: "A" }, { label: "A" }] })],
    }),
    "non-string description": content({
      questions: [question({ options: [{ label: "A", description: 3 }] })],
    }),
    "answered without answer": content({ state: "answered" }),
    "answered by non-pubkey": content({
      state: "answered",
      answer: { question_0: ["OAuth"] },
      answeredBy: "bob",
    }),
    "answer for unknown question": content({
      state: "answered",
      answer: { question_0: ["OAuth"], extra: ["x"] },
      answeredBy: ANSWERER,
    }),
    "two answers to single-select": content({
      state: "answered",
      answer: { question_0: ["OAuth", "API key (Recommended)"] },
      answeredBy: ANSWERER,
    }),
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(parseAgentPrompt(value, AGENT), null, name);
  }
});

test("an answer only counts when its signer is the named answerer", () => {
  const answered = (answeredBy) =>
    content({
      state: "answered",
      answer: { question_0: ["OAuth"] },
      answeredBy,
    });
  assert.equal(
    parseAgentPrompt(answered(ANSWERER), ANSWERER)?.state,
    "answered",
  );
  // A channel writer signing with their own key cannot credit someone else.
  assert.equal(parseAgentPrompt(answered(ANSWERER), AGENT), null);
  assert.equal(
    parseAgentPrompt(answered(ANSWERER), ANSWERER.toUpperCase())?.answeredBy,
    ANSWERER,
  );
});

test("answers validate against options and Other", () => {
  const q = parseAgentPrompt(content(), AGENT).questions[0];
  assert.ok(isValidQuestionAnswer(q, ["OAuth"]));
  assert.ok(isValidQuestionAnswer(q, ["Session cookies"]));
  assert.ok(!isValidQuestionAnswer(q, []));
  assert.ok(!isValidQuestionAnswer(q, [" padded "]));
  const strict = { ...q, allowOther: false };
  assert.ok(!isValidQuestionAnswer(strict, ["Session cookies"]));
  const multi = { ...q, multiSelect: true };
  assert.ok(isValidQuestionAnswer(multi, ["OAuth", "API key (Recommended)"]));
  assert.ok(isValidQuestionAnswer(multi, ["OAuth", "mTLS"]));
  assert.ok(!isValidQuestionAnswer(multi, ["mTLS", "JWT"]), "one Other only");
  assert.ok(!isValidQuestionAnswer(multi, ["OAuth", "OAuth"]));
});

test("answered content round-trips and keeps unfamiliar fields", () => {
  const prompt = parseAgentPrompt(content({ agentSession: "s-1" }), AGENT);
  const answered = buildAnsweredContent(
    prompt,
    { question_0: ["OAuth"] },
    ANSWERER,
  );
  const parsed = parseAgentPrompt(answered, ANSWERER);
  assert.equal(parsed?.state, "answered");
  assert.deepEqual(parsed.answer, { question_0: ["OAuth"] });
  assert.equal(parsed.answeredBy, ANSWERER);
  assert.equal(JSON.parse(answered).agentSession, "s-1");
});

test("drafts: single-select replaces, Other is exclusive, multi toggles", () => {
  const prompt = parseAgentPrompt(content(), AGENT);
  const q = prompt.questions[0];
  let draft = toggleOption(q, EMPTY_DRAFT, "OAuth");
  draft = toggleOption(q, draft, "API key (Recommended)");
  assert.deepEqual(draftChoices(q, draft), ["API key (Recommended)"]);
  draft = { ...toggleOther(q, draft, true), otherText: "  mTLS " };
  assert.deepEqual(draftChoices(q, draft), ["mTLS"]);

  const multi = { ...q, multiSelect: true };
  let picks = toggleOption(multi, EMPTY_DRAFT, "OAuth");
  picks = toggleOption(multi, picks, "API key (Recommended)");
  picks = { ...toggleOther(multi, picks, true), otherText: "mTLS" };
  // Published in option order, then the typed answer.
  assert.deepEqual(draftChoices(multi, picks), [
    "API key (Recommended)",
    "OAuth",
    "mTLS",
  ]);
  picks = toggleOption(multi, picks, "OAuth");
  assert.deepEqual(draftChoices(multi, picks), [
    "API key (Recommended)",
    "mTLS",
  ]);
});

test("the answer map exists only once every question is answered", () => {
  const second = question({ id: "question_1", header: "Scope" });
  const prompt = parseAgentPrompt(
    content({ questions: [question(), second] }),
    AGENT,
  );
  const [q0, q1] = prompt.questions;
  const drafts = { question_0: toggleOption(q0, EMPTY_DRAFT, "OAuth") };
  assert.equal(buildDraftAnswer(prompt.questions, drafts), null);
  drafts.question_1 = { ...toggleOther(q1, EMPTY_DRAFT, true), otherText: "" };
  assert.equal(buildDraftAnswer(prompt.questions, drafts), null, "empty Other");
  drafts.question_1 = { ...drafts.question_1, otherText: "Read only" };
  assert.deepEqual(buildDraftAnswer(prompt.questions, drafts), {
    question_0: ["OAuth"],
    question_1: ["Read only"],
  });
});
