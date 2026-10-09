import { Portal as PopoverPortal } from "@radix-ui/react-popover";
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
  annotationSourceRevision,
  formatAnnotationMessage,
} from "./annotationModel";
import type {
  AnnotationRegistry,
  AnnotationSelection,
} from "./annotationRegistry";

export function SelectionAnnotationEditor({
  selection,
  registry,
  open,
  onOpenChange,
}: {
  selection: AnnotationSelection;
  registry: AnnotationRegistry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(
    selection.restoreFocus,
  );
  const positionRef = React.useRef(selection.position);
  positionRef.current = selection.position;
  const [triggerPosition, setTriggerPosition] = React.useState({
    left: 0,
    top: 0,
  });
  const titleId = React.useId();
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const { anchor } = selection;
  const portalContainer =
    selection.root.closest<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]',
    ) ?? document.body;
  React.useLayoutEffect(() => {
    const root = selection.root;
    if (!anchor || !root) return;
    const update = () => {
      const rect = selection.position.getBoundingClientRect();
      if (!rect) return;
      const width = triggerRef.current?.offsetWidth ?? 100;
      const height = triggerRef.current?.offsetHeight ?? 32;
      const containerRect =
        portalContainer === document.body
          ? { left: 0, top: 0 }
          : portalContainer.getBoundingClientRect();
      const offsetLeft =
        portalContainer === document.body
          ? 0
          : containerRect.left -
            portalContainer.scrollLeft +
            portalContainer.clientLeft;
      const offsetTop =
        portalContainer === document.body
          ? 0
          : containerRect.top -
            portalContainer.scrollTop +
            portalContainer.clientTop;
      setTriggerPosition({
        left:
          Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) -
          offsetLeft,
        top:
          (rect.bottom + height + 8 < window.innerHeight
            ? rect.bottom + 4
            : rect.top - height - 4) - offsetTop,
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
  }, [selection, anchor, portalContainer]);

  const handleSubmit = async () => {
    if (!comment.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const request = {
        anchor,
        destination: { channelId: selection.scope?.scope.channelId },
        message: formatAnnotationMessage(anchor, comment),
      };
      if (selection.scope) {
        if (!registry.scopes.has(selection.scope))
          throw new Error(
            "This conversation is no longer open. Select the content again.",
          );
        await selection.scope.submit(request);
      } else {
        await navigator.clipboard.writeText(request.message);
      }
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not send feedback. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  const currentSource = registry.sources.get(selection.root)?.read();
  const sourceChanged =
    currentSource &&
    anchor.sourceRevision !== annotationSourceRevision(currentSource);
  return (
    <Popover modal={false} onOpenChange={onOpenChange} open={open}>
      <PopoverAnchor virtualRef={positionRef} />
      {createPortal(
        <PopoverTrigger asChild>
          <Button
            aria-label="Comment on selected text"
            className={cn(
              "fixed z-50 h-8 gap-1.5 bg-background px-2 text-foreground shadow-sm ring-1 ring-border",
              !open ? "opacity-100" : "invisible pointer-events-none",
            )}
            disabled={!!open}
            onClick={() => onOpenChange(true)}
            onMouseDown={(event) => event.preventDefault()}
            ref={triggerRef}
            size="sm"
            style={{
              ...triggerPosition,
              position:
                portalContainer === document.body ? "fixed" : "absolute",
            }}
            title="Comment on selection (Command/Ctrl+Shift+M)"
            type="button"
            variant="ghost"
          >
            <MessageSquarePlus />
            Comment
          </Button>
        </PopoverTrigger>,
        portalContainer,
      )}
      <PopoverPortal container={portalContainer}>
        <PopoverContent
          portalled={false}
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
              : selection.root
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
          <p
            className="text-xs text-muted-foreground"
            data-testid="annotation-destination"
          >
            {selection.scope
              ? `Send to ${selection.scope.scope.label}`
              : "No conversation is open. Copy this annotation to use it anywhere."}
          </p>
          {sourceChanged ? (
            <p className="text-xs text-muted-foreground" role="status">
              The content changed after selection. Your comment keeps the
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
            placeholder="Add a comment about this selection…"
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
              onClick={() => onOpenChange(false)}
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
              {submitting
                ? "Sending…"
                : error
                  ? "Retry"
                  : selection.scope
                    ? "Send feedback"
                    : "Copy annotation"}
            </Button>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
