import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";

import type { AgentPromptQuestion } from "./agentPromptContent";
import type { QuestionDraft } from "./questionDraft";

type QuestionPanelProps = {
  question: AgentPromptQuestion;
  draft: QuestionDraft;
  disabled: boolean;
  onPick: (label: string) => void;
  onToggleOther: () => void;
  onOtherText: (text: string) => void;
};

/**
 * One question: its options as radios (single-select) or checkboxes
 * (multi-select), an optional "Other" answer, and a preview pane when any
 * option carries one. All prompt text renders as plain text.
 */
export function QuestionPanel({
  question,
  draft,
  disabled,
  onPick,
  onToggleOther,
  onOtherText,
}: QuestionPanelProps) {
  const questionId = React.useId();
  const role = question.multiSelect ? "checkbox" : "radio";
  const [previewLabel, setPreviewLabel] = React.useState<string | null>(null);
  const hasPreview = question.options.some((option) => option.preview);
  const previewed =
    question.options.find((option) => option.label === previewLabel) ??
    question.options.find((option) => draft.labels.includes(option.label)) ??
    question.options.find((option) => option.preview);

  const options = (
    <div
      className="flex min-w-0 flex-col gap-1"
      {...(question.multiSelect
        ? { role: "group", "aria-labelledby": questionId }
        : { role: "radiogroup", "aria-labelledby": questionId })}
    >
      {question.options.map((option, index) => (
        <OptionRow
          checked={draft.labels.includes(option.label)}
          disabled={disabled}
          key={option.label}
          number={index + 1}
          onClick={() => onPick(option.label)}
          onPreview={() => setPreviewLabel(option.label)}
          role={role}
        >
          <span className="block text-sm font-medium text-foreground">
            {option.label}
          </span>
          {option.description ? (
            <span className="block whitespace-pre-wrap text-xs text-muted-foreground">
              {option.description}
            </span>
          ) : null}
        </OptionRow>
      ))}
      {question.allowOther ? (
        <div className="flex flex-col gap-1">
          <OptionRow
            checked={draft.otherSelected}
            disabled={disabled}
            number={question.options.length + 1}
            onClick={onToggleOther}
            onPreview={() => setPreviewLabel(null)}
            role={role}
          >
            <span className="block text-sm font-medium text-foreground">
              Other
            </span>
          </OptionRow>
          {draft.otherSelected ? (
            <Input
              aria-label={`Other answer: ${question.header}`}
              className="ml-8 w-auto"
              data-question-other=""
              data-testid="agent-prompt-other-input"
              disabled={disabled}
              maxLength={2000}
              onChange={(event) => onOtherText(event.target.value)}
              placeholder="Type your own answer"
              value={draft.otherText}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div data-question-panel={question.id}>
      <p
        className="whitespace-pre-wrap text-sm text-foreground"
        id={questionId}
      >
        {question.question}
      </p>
      {question.multiSelect ? (
        <p className="text-xs text-muted-foreground">Choose all that apply.</p>
      ) : null}
      <div
        className={cn(
          "mt-2",
          hasPreview && "grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
        )}
      >
        {options}
        {hasPreview ? (
          <section
            aria-label={
              previewed ? `Preview: ${previewed.label}` : "Option preview"
            }
          >
            <pre
              className="max-h-72 min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-background p-3 font-mono text-xs text-foreground"
              data-testid="agent-prompt-preview"
            >
              {previewed?.preview ?? "No preview for this option."}
            </pre>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function OptionRow({
  checked,
  children,
  disabled,
  number,
  onClick,
  onPreview,
  role,
}: {
  checked: boolean;
  children: React.ReactNode;
  disabled: boolean;
  number: number;
  onClick: () => void;
  onPreview: () => void;
  role: "radio" | "checkbox";
}) {
  return (
    <button
      {...(role === "radio"
        ? { role: "radio", "aria-checked": checked }
        : { role: "checkbox", "aria-checked": checked })}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors",
        "hover:bg-muted/70 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
        checked && "border-primary/40 bg-primary/10 hover:bg-primary/15",
      )}
      data-question-option=""
      disabled={disabled}
      onClick={onClick}
      onFocus={onPreview}
      onMouseEnter={onPreview}
      type="button"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center border text-xs tabular-nums",
          role === "radio" ? "rounded-full" : "rounded-md",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        {checked ? <Check className="size-3.5" /> : number}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}
