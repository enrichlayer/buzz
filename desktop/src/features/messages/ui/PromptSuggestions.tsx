import type {
  PromptSuggestion,
  PromptSuggestionSource,
} from "../lib/promptSuggestions";

/** Optional draft shortcuts. Mounting never focuses a control or submits a form. */
export function PromptSuggestions({
  source,
  onInsert,
  onDismiss,
}: {
  source: PromptSuggestionSource;
  onInsert: (suggestion: PromptSuggestion) => boolean;
  onDismiss: () => void;
}) {
  return (
    <fieldset
      className="mb-2 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
      aria-label="Suggested next prompts"
      data-testid="prompt-suggestions"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      <span className="text-xs text-muted-foreground">
        Continue with {source.author}
      </span>
      {source.suggestions.map((suggestion) => (
        <button
          key={suggestion.prompt}
          type="button"
          title={suggestion.prompt}
          className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            if (onInsert(suggestion)) onDismiss();
          }}
        >
          {suggestion.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Dismiss suggestions"
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onDismiss()}
      >
        Dismiss
      </button>
    </fieldset>
  );
}
