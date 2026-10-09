import * as React from "react";
import { Markdown } from "@/shared/ui/markdown";
import type { parseAnnotationMessage } from "./annotationModel";

export function SelectionFeedback({
  value,
}: {
  value: NonNullable<ReturnType<typeof parseAnnotationMessage>>;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [overflow, setOverflow] = React.useState(false);
  const quote = React.useRef<HTMLQuoteElement>(null);
  const id = React.useId();
  React.useLayoutEffect(() => {
    const element = quote.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      setOverflow(element.scrollHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="selection-feedback space-y-3"
      data-testid="selection-feedback"
    >
      <div className="max-w-[75ch] space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {value.label.includes("code block")
            ? value.label.replace(/^(Response|Selection) ·/, "Reply to")
            : "Reply to selection"}
        </p>
        <blockquote
          id={id}
          ref={quote}
          className={`whitespace-pre-wrap break-words border-l border-border pl-3 text-sm not-italic leading-6 text-muted-foreground ${expanded ? "" : "line-clamp-3"}`}
        >
          {value.metadata.selectedText}
        </blockquote>
        {overflow || expanded ? (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-controls={id}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Show full selection"}
          </button>
        ) : null}
      </div>
      <Markdown content={value.comment} />
      <details
        className="text-xs text-muted-foreground"
        data-testid="annotation-reference"
      >
        <summary className="cursor-pointer">Source details</summary>
        <p className="my-2">Captured when this feedback was written.</p>
        <dl className="space-y-1 break-all">
          <dt>Source</dt>
          <dd>{value.metadata.sourceId}</dd>
          <dt>Revision</dt>
          <dd>{value.metadata.sourceRevision}</dd>
        </dl>
      </details>
    </div>
  );
}
