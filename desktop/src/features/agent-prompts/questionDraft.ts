import {
  type AgentPromptAnswer,
  type AgentPromptQuestion,
  isValidQuestionAnswer,
} from "./agentPromptContent";

/** The viewer's in-progress choices for one question. */
export type QuestionDraft = {
  labels: string[];
  otherSelected: boolean;
  otherText: string;
};

export type QuestionDrafts = Record<string, QuestionDraft>;

export const EMPTY_DRAFT: QuestionDraft = {
  labels: [],
  otherSelected: false,
  otherText: "",
};

export function draftFor(drafts: QuestionDrafts, id: string): QuestionDraft {
  return Object.hasOwn(drafts, id) ? drafts[id] : EMPTY_DRAFT;
}

/** Pick or toggle an option; single-select replaces any earlier choice. */
export function toggleOption(
  question: AgentPromptQuestion,
  draft: QuestionDraft,
  label: string,
): QuestionDraft {
  if (!question.multiSelect) {
    return { ...draft, labels: [label], otherSelected: false };
  }
  const labels = draft.labels.includes(label)
    ? draft.labels.filter((existing) => existing !== label)
    : [...draft.labels, label];
  return { ...draft, labels };
}

export function toggleOther(
  question: AgentPromptQuestion,
  draft: QuestionDraft,
  selected = !draft.otherSelected,
): QuestionDraft {
  if (!question.multiSelect && selected) {
    return { ...draft, labels: [], otherSelected: true };
  }
  return { ...draft, otherSelected: selected };
}

/** Choices as they will be published: option order, then the typed text. */
export function draftChoices(
  question: AgentPromptQuestion,
  draft: QuestionDraft,
): string[] {
  const labels = question.options
    .map((option) => option.label)
    .filter((label) => draft.labels.includes(label));
  const other = draft.otherText.trim();
  return draft.otherSelected && other ? [...labels, other] : labels;
}

export function isQuestionAnswered(
  question: AgentPromptQuestion,
  draft: QuestionDraft,
): boolean {
  return isValidQuestionAnswer(question, draftChoices(question, draft));
}

/** The full answer map, or null while any question is unanswered. */
export function buildDraftAnswer(
  questions: readonly AgentPromptQuestion[],
  drafts: QuestionDrafts,
): AgentPromptAnswer | null {
  const entries: [string, string[]][] = [];
  for (const question of questions) {
    const draft = draftFor(drafts, question.id);
    if (!isQuestionAnswered(question, draft)) return null;
    entries.push([question.id, draftChoices(question, draft)]);
  }
  // Object.fromEntries creates own keys even for ids such as "__proto__".
  return Object.fromEntries(entries);
}
