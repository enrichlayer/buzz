import * as React from "react";
import { MessageSquarePlus } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { Textarea } from "@/shared/ui/textarea";

import {
  type AnnotationAnchor,
  type AnnotationSource,
  type AnnotationSubmitRequest,
  annotationSourceRevision,
  formatAnnotationMessage,
} from "./annotationModel";
import { captureSelectionAnchor } from "./selectionAnchor";

type AnnotationSubmitContextValue = {
  onSubmit: (request: AnnotationSubmitRequest) => Promise<void>;
};

const AnnotationSubmitContext =
  React.createContext<AnnotationSubmitContextValue | null>(null);

export function AnnotationSubmitProvider({
  children,
  onSubmit,
}: {
  children: React.ReactNode;
  onSubmit: AnnotationSubmitContextValue["onSubmit"];
}) {
  const value = React.useMemo(() => ({ onSubmit }), [onSubmit]);
  return (
    <AnnotationSubmitContext.Provider value={value}>
      {children}
    </AnnotationSubmitContext.Provider>
  );
}

export function SourceAnnotation({
  children,
  className,
  source,
}: {
  children: React.ReactNode;
  className?: string;
  source: AnnotationSource;
}) {
  const submitContext = React.useContext(AnnotationSubmitContext);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = React.useState<AnnotationAnchor | null>(null);
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const captureSelection = React.useCallback(() => {
    const root = rootRef.current;
    if (!submitContext || !root || open) return null;
    const next = captureSelectionAnchor(root, source, window.getSelection());
    if (next) setAnchor(next);
    return next;
  }, [open, source, submitContext]);

  const beginComment = React.useCallback(
    (nextAnchor = anchor) => {
      if (!nextAnchor) return;
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : rootRef.current;
      setAnchor(nextAnchor);
      setError(null);
      setOpen(true);
    },
    [anchor],
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.key.toLowerCase() === "m" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        const next = captureSelection();
        if (next) {
          event.preventDefault();
          beginComment(next);
        }
      }
    },
    [beginComment, captureSelection],
  );

  const handleSubmit = React.useCallback(async () => {
    if (!submitContext || !anchor || !comment.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitContext.onSubmit({
        anchor,
        message: formatAnnotationMessage(anchor, comment),
      });
      setComment("");
      setAnchor(null);
      setOpen(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not send feedback. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [anchor, comment, submitContext, submitting]);

  const sourceChanged =
    anchor !== null &&
    anchor.sourceRevision !== annotationSourceRevision(source);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this region observes native text selection; the actual action is a semantic button
    <div
      className={cn("group/annotation relative", className)}
      data-annotation-source-id={source.sourceId}
      onKeyDown={handleKeyDown}
      onKeyUp={captureSelection}
      onMouseUp={captureSelection}
      ref={rootRef}
    >
      {children}
      {submitContext ? (
        <Popover
          onOpenChange={(nextOpen) => {
            if (nextOpen && !anchor) return;
            setOpen(nextOpen);
          }}
          open={open}
        >
          <PopoverTrigger asChild>
            <Button
              aria-label="Comment on selected text"
              className={cn(
                "absolute right-0 top-0 h-7 w-7 bg-background/90 text-muted-foreground shadow-xs ring-1 ring-border/60 backdrop-blur-sm transition-opacity hover:text-foreground",
                anchor
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/annotation:opacity-40 group-focus-within/annotation:opacity-40",
              )}
              disabled={!anchor}
              onClick={() => beginComment()}
              ref={triggerRef}
              size="icon"
              title="Comment on selection (Command/Ctrl+Shift+M)"
              type="button"
              variant="ghost"
            >
              <MessageSquarePlus />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 space-y-3"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              restoreFocusRef.current?.focus();
            }}
            sideOffset={8}
          >
            <div className="space-y-1">
              <div className="text-sm font-medium">Comment on selection</div>
              <blockquote className="line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground">
                {anchor?.selectedText}
              </blockquote>
            </div>
            {sourceChanged ? (
              <p className="text-xs text-muted-foreground" role="status">
                The response changed after selection. Your comment keeps the
                original revision.
              </p>
            ) : null}
            <Textarea
              aria-label="Feedback"
              autoFocus
              onChange={(event) => setComment(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="What should the agent change or clarify?"
              value={comment}
            />
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                disabled={submitting}
                onClick={() => setOpen(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={!comment.trim() || submitting}
                onClick={() => void handleSubmit()}
                size="sm"
                type="button"
              >
                {submitting ? "Sending…" : error ? "Retry" : "Send feedback"}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

export type {
  AnnotationAnchor,
  AnnotationSource,
  AnnotationSubmitRequest,
} from "./annotationModel";
