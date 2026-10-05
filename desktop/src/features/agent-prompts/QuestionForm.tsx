import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import type { AgentPrompt, AgentPromptAnswer } from "./agentPromptContent";
import { AgentPromptCardFrame } from "./AgentPromptCardFrame";
import { QuestionPanel } from "./QuestionPanel";
import {
  buildDraftAnswer,
  draftFor,
  isQuestionAnswered,
  type QuestionDraft,
  type QuestionDrafts,
  toggleOption,
  toggleOther,
} from "./questionDraft";

type FocusRequest = "option" | "other" | null;

/**
 * The open question card, modelled on Claude Code's AskUserQuestion:
 * number keys pick, Tab/Shift+Tab move between questions, Enter submits
 * once every question has an answer.
 */
export function QuestionForm({
  canAnswer,
  errorMessage,
  onSubmit,
  prompt,
  submitting,
}: {
  canAnswer: boolean;
  errorMessage: string | null;
  onSubmit: (answer: AgentPromptAnswer) => void;
  prompt: AgentPrompt;
  submitting: boolean;
}) {
  const { questions } = prompt;
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [drafts, setDrafts] = React.useState<QuestionDrafts>({});
  const cardRef = React.useRef<HTMLElement | null>(null);
  const focusRequest = React.useRef<FocusRequest>(null);
  const active = questions[activeIndex];
  const activeDraft = draftFor(drafts, active.id);
  const answer = buildDraftAnswer(questions, drafts);
  const disabled = !canAnswer || submitting;

  React.useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    const panel = cardRef.current?.querySelector<HTMLElement>(
      `[data-question-panel="${CSS.escape(active.id)}"]`,
    );
    focusRequest.current = null;
    if (!panel) return;
    if (request === "other") {
      panel.querySelector<HTMLElement>("[data-question-other]")?.focus();
      return;
    }
    (
      panel.querySelector<HTMLElement>(
        '[data-question-option][aria-checked="true"]',
      ) ?? panel.querySelector<HTMLElement>("[data-question-option]")
    )?.focus();
  });

  const setDraft = (id: string, draft: QuestionDraft) =>
    setDrafts((current) => ({ ...current, [id]: draft }));

  const goTo = (index: number) => {
    setActiveIndex(index);
    focusRequest.current = "option";
  };

  const pick = (label: string) => {
    setDraft(active.id, toggleOption(active, activeDraft, label));
    if (!active.multiSelect && activeIndex < questions.length - 1) {
      goTo(activeIndex + 1);
    }
  };

  const toggleActiveOther = () => {
    const next = toggleOther(active, activeDraft);
    setDraft(active.id, next);
    if (next.otherSelected) focusRequest.current = "other";
  };

  const submitIfReady = () => {
    if (answer && !disabled) onSubmit(answer);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" && !event.shiftKey) {
      if (answer) {
        event.preventDefault();
        submitIfReady();
      }
      return;
    }
    if (event.key === "Tab") {
      // Only between questions: Tab past the last one (or Shift+Tab before
      // the first) leaves the card as usual, so focus is never trapped.
      const next = activeIndex + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < questions.length) {
        event.preventDefault();
        goTo(next);
      }
      return;
    }
    const target = event.target as HTMLElement;
    if (target.hasAttribute("data-question-other")) return;
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < active.options.length) {
        event.preventDefault();
        pick(active.options[index].label);
      } else if (index === active.options.length && active.allowOther) {
        event.preventDefault();
        setDraft(active.id, toggleOther(active, activeDraft, true));
        focusRequest.current = "other";
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!target.hasAttribute("data-question-option")) return;
      const rows = [
        ...(target
          .closest("[data-question-panel]")
          ?.querySelectorAll<HTMLElement>("[data-question-option]") ?? []),
      ];
      const next =
        rows[rows.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    }
  };

  const panelFor = (index: number) => {
    const question = questions[index];
    return (
      <QuestionPanel
        disabled={disabled}
        draft={draftFor(drafts, question.id)}
        onOtherText={(text) =>
          setDraft(question.id, {
            ...toggleOther(question, draftFor(drafts, question.id), true),
            otherText: text,
          })
        }
        onPick={pick}
        onToggleOther={toggleActiveOther}
        question={question}
      />
    );
  };

  return (
    <AgentPromptCardFrame
      aria-label={`Question: ${questions[0].header}`}
      onKeyDown={handleKeyDown}
      ref={cardRef}
      state="open"
    >
      {questions.length > 1 ? (
        <Tabs
          onValueChange={(id) =>
            setActiveIndex(questions.findIndex((q) => q.id === id))
          }
          value={active.id}
        >
          <TabsList aria-label="Questions" className="h-auto flex-wrap">
            {questions.map((question) => {
              const done = isQuestionAnswered(
                question,
                draftFor(drafts, question.id),
              );
              return (
                <TabsTrigger
                  className="gap-1 text-xs"
                  data-testid="agent-prompt-tab"
                  key={question.id}
                  value={question.id}
                >
                  {done ? (
                    <Check aria-label="answered" className="size-3.5" />
                  ) : null}
                  {question.header}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {questions.map((question, index) => (
            // Mounted while hidden so focus can move into the next question
            // in the same commit that selects it.
            <TabsContent
              className="data-[state=inactive]:hidden"
              forceMount
              key={question.id}
              value={question.id}
            >
              {panelFor(index)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <>
          <span className="mb-1.5 inline-flex rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
            {active.header}
          </span>
          {panelFor(0)}
        </>
      )}
      {errorMessage ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p
          className={cn(
            "text-xs text-muted-foreground",
            disabled && "invisible",
          )}
        >
          {questions.length > 1
            ? "Number keys pick · Tab next question · Enter submits"
            : "Number keys pick · Enter submits"}
        </p>
        <Button
          data-testid="agent-prompt-submit"
          disabled={!answer || disabled}
          onClick={submitIfReady}
          size="sm"
          type="button"
        >
          {submitting ? "Sending…" : "Submit"}
        </Button>
      </div>
    </AgentPromptCardFrame>
  );
}
