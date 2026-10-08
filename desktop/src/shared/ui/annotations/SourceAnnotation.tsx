import * as React from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/shared/ui/popover";
import { Textarea } from "@/shared/ui/textarea";

import {
  type AnnotationAnchor,
  type AnnotationSource,
  type AnnotationSubmitRequest,
  annotationSourceRevision,
  formatAnnotationMessage,
} from "./annotationModel";
import { captureSelectionAnchor } from "./selectionAnchor";
import { selectionPosition } from "./selectionPosition";

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
  const positionRef = React.useRef<ReturnType<typeof selectionPosition> | null>(
    null,
  );
  const [triggerPosition, setTriggerPosition] = React.useState({
    left: 0,
    top: 0,
  });
  const titleId = React.useId();
  const [anchor, setAnchor] = React.useState<AnnotationAnchor | null>(null);
  const [selectionActive, setSelectionActive] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const captureSelection = React.useCallback(() => {
    const root = rootRef.current;
    if (!submitContext || !root || open) return null;
    const selection = window.getSelection();
    const next = captureSelectionAnchor(root, source, selection);
    if (next && selection) {
      positionRef.current = selectionPosition(root, selection);
      setAnchor(next);
      setSelectionActive(true);
      if (anchor?.selectedText !== next.selectedText) setComment("");
    } else if (document.activeElement !== triggerRef.current) {
      setSelectionActive(false);
    }
    return next;
  }, [anchor?.selectedText, open, source, submitContext]);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!anchor || !root) return;
    const update = () => {
      const rect = positionRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = triggerRef.current?.offsetWidth ?? 100;
      const height = triggerRef.current?.offsetHeight ?? 32;
      setTriggerPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top:
          rect.bottom + height + 8 < window.innerHeight
            ? rect.bottom + 4
            : rect.top - height - 4,
      });
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(root);
    return () => {
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [anchor]);

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

  React.useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !open &&
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
    };
    document.addEventListener("keydown", onShortcut);
    document.addEventListener("selectionchange", captureSelection);
    return () => {
      document.removeEventListener("keydown", onShortcut);
      document.removeEventListener("selectionchange", captureSelection);
    };
  }, [beginComment, captureSelection, open]);

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
      setSelectionActive(false);
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
      onKeyUp={captureSelection}
      onMouseUp={captureSelection}
      ref={rootRef}
      tabIndex={-1}
    >
      {children}
      {submitContext ? (
        <Popover
          modal={false}
          onOpenChange={(nextOpen) => {
            if (nextOpen && !anchor) return;
            setOpen(nextOpen);
          }}
          open={open}
        >
          <PopoverAnchor virtualRef={positionRef} />
          {createPortal(
            <PopoverTrigger asChild>
              <Button
                aria-label="Comment on selected text"
                className={cn(
                  "fixed z-50 h-8 gap-1.5 bg-background px-2 text-foreground shadow-sm ring-1 ring-border",
                  selectionActive && !open
                    ? "opacity-100"
                    : "invisible pointer-events-none",
                )}
                disabled={!selectionActive && !open}
                onClick={() => beginComment()}
                onMouseDown={(event) => event.preventDefault()}
                ref={triggerRef}
                size="sm"
                style={triggerPosition}
                title="Comment on selection (Command/Ctrl+Shift+M)"
                type="button"
                variant="ghost"
              >
                <MessageSquarePlus />
                Comment
              </Button>
            </PopoverTrigger>,
            document.body,
          )}
          <PopoverContent
            align="start"
            aria-labelledby={titleId}
            className="w-80 max-w-[calc(100vw-1rem)] space-y-3 overflow-y-auto"
            collisionPadding={8}
            data-annotation-editor=""
            data-testid="selection-annotation-editor"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const previous = restoreFocusRef.current;
              (previous?.isConnected && previous !== document.body
                ? previous
                : rootRef.current
              )?.focus({ preventScroll: true });
            }}
            side="bottom"
            sideOffset={8}
            style={{
              maxHeight: "var(--radix-popover-content-available-height)",
            }}
            updatePositionStrategy="always"
          >
            <div className="space-y-1">
              <div className="text-sm font-medium" id={titleId}>
                Comment on selection
              </div>
              <blockquote className="line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-xs text-muted-foreground">
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
