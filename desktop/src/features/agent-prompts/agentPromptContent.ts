/**
 * `buzz.agent_prompt` content (docs/plans/question-card.md). The content is
 * untrusted relay text: every field is validated here and anything malformed
 * yields null, so the card falls back to the artifact title.
 */

export type AgentPromptOption = {
  label: string;
  description: string | null;
  preview: string | null;
};

export type AgentPromptQuestion = {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  allowOther: boolean;
  options: AgentPromptOption[];
};

/** Question id -> chosen option labels and/or one typed "Other" answer. */
export type AgentPromptAnswer = Record<string, string[]>;

export type AgentPrompt = {
  /** `cancelled`: the asking agent withdrew it (turn cancelled or ended). */
  state: "open" | "answered" | "cancelled";
  questions: AgentPromptQuestion[];
  answer: AgentPromptAnswer | null;
  answeredBy: string | null;
  /** The parsed JSON object, kept so an answer preserves unfamiliar fields. */
  raw: Record<string, unknown>;
};

export const MAX_QUESTIONS = 4;
/** Options plus "Other" stay within the 1-9 number-key shortcuts. */
export const MAX_OPTIONS = 8;
const MAX_ID = 64;
const MAX_HEADER = 40;
const MAX_QUESTION = 2000;
const MAX_LABEL = 200;
const MAX_DESCRIPTION = 1000;
const MAX_PREVIEW = 10_000;
export const MAX_OTHER_ANSWER = 2000;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function optionalText(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null) return null;
  return text(value, max) ?? false;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

function parseOption(value: unknown): AgentPromptOption | null {
  if (!isObject(value)) return null;
  const label = text(value.label, MAX_LABEL);
  const description = optionalText(value.description, MAX_DESCRIPTION);
  // Previews are preformatted (code, mockups): keep their whitespace.
  const preview =
    value.preview === undefined || value.preview === null
      ? null
      : typeof value.preview === "string" &&
          value.preview.trim().length > 0 &&
          value.preview.length <= MAX_PREVIEW
        ? value.preview
        : false;
  if (!label || description === false || preview === false) return null;
  return { label, description, preview };
}

function parseQuestion(value: unknown): AgentPromptQuestion | null {
  if (!isObject(value)) return null;
  const id = text(value.id, MAX_ID);
  const header = text(value.header, MAX_HEADER);
  const question = text(value.question, MAX_QUESTION);
  const multiSelect = optionalBoolean(value.multiSelect, false);
  const allowOther = optionalBoolean(value.allowOther, true);
  if (!id || !header || !question || multiSelect === null) return null;
  if (allowOther === null || !Array.isArray(value.options)) return null;
  if (value.options.length < 1 || value.options.length > MAX_OPTIONS) {
    return null;
  }
  const options: AgentPromptOption[] = [];
  for (const raw of value.options) {
    const option = parseOption(raw);
    if (!option || options.some((o) => o.label === option.label)) return null;
    options.push(option);
  }
  return { id, header, question, multiSelect, allowOther, options };
}

/** Whether `choices` is a complete, valid answer to `question`. */
export function isValidQuestionAnswer(
  question: AgentPromptQuestion,
  choices: readonly string[],
): boolean {
  if (choices.length === 0) return false;
  if (!question.multiSelect && choices.length !== 1) return false;
  if (new Set(choices).size !== choices.length) return false;
  const labels = new Set(question.options.map((o) => o.label));
  const others = choices.filter((choice) => !labels.has(choice));
  if (others.length === 0) return true;
  return (
    question.allowOther &&
    others.length === 1 &&
    text(others[0], MAX_OTHER_ANSWER) === others[0]
  );
}

function parseAnswer(
  value: unknown,
  questions: AgentPromptQuestion[],
): AgentPromptAnswer | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== questions.length) return null;
  const entries: [string, string[]][] = [];
  for (const question of questions) {
    const choices = value[question.id];
    if (
      !Array.isArray(choices) ||
      !choices.every((choice) => typeof choice === "string") ||
      !isValidQuestionAnswer(question, choices)
    ) {
      return null;
    }
    entries.push([question.id, choices]);
  }
  return Object.fromEntries(entries);
}

/**
 * Parse prompt content from a revision signed by `signer`. An answered
 * revision must name its own signer as `answeredBy`: content is
 * writer-controlled, so the signature is the only proof of who answered.
 */
export function parseAgentPrompt(
  content: string,
  signer: string,
): AgentPrompt | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== 1 || raw.kind !== "question") {
    return null;
  }
  if (
    raw.state !== "open" &&
    raw.state !== "answered" &&
    raw.state !== "cancelled"
  ) {
    return null;
  }
  if (!Array.isArray(raw.questions)) return null;
  if (raw.questions.length < 1 || raw.questions.length > MAX_QUESTIONS) {
    return null;
  }
  const questions: AgentPromptQuestion[] = [];
  for (const value of raw.questions) {
    const question = parseQuestion(value);
    if (!question || questions.some((q) => q.id === question.id)) return null;
    questions.push(question);
  }
  if (raw.state === "open" || raw.state === "cancelled") {
    return { state: raw.state, questions, answer: null, answeredBy: null, raw };
  }
  const answer = parseAnswer(raw.answer, questions);
  const answeredBy =
    typeof raw.answeredBy === "string" &&
    PUBKEY_RE.test(raw.answeredBy) &&
    raw.answeredBy === signer.toLowerCase()
      ? raw.answeredBy
      : null;
  if (!answer || !answeredBy) return null;
  return { state: "answered", questions, answer, answeredBy, raw };
}

/** Content of the answered revision: the open content plus the answer. */
export function buildAnsweredContent(
  prompt: AgentPrompt,
  answer: AgentPromptAnswer,
  answeredBy: string,
): string {
  return JSON.stringify({
    ...prompt.raw,
    state: "answered",
    answer,
    answeredBy,
  });
}
