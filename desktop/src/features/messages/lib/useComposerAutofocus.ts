import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import * as React from "react";

/**
 * Focus the composer editor on mount and whenever the active draft key
 * changes (channel switch, thread open).
 *
 * Matches the behaviour of Slack/Discord/Signal: the composer is ready to
 * accept typing without an explicit click. Wait for the editor and check
 * focus ownership in the frame that actually focuses it. Tiptap's focus
 * command queues another frame, which can steal focus from a menu opened
 * after an earlier ownership check.
 *
 * The effect trigger deliberately excludes `disabled`: callers pass a
 * disabled flag that includes transient state like `isSending`, which would
 * otherwise re-fire autofocus after every send. When the main channel and
 * an open thread panel both have composers mounted, that race let the main
 * composer steal focus from the thread composer post-send. We only autofocus
 * on mount and on real navigation events (draft-key change).
 *
 * Guards:
 *  - Skip if the composer is currently disabled (archived channel, no
 *    channel, or in-flight send at the moment of mount).
 *  - Skip if focus already lives in a text-entry surface or open overlay.
 */
export function useComposerAutofocus(
  editor: Editor | null,
  draftKey: string | null | undefined,
  disabled: boolean,
) {
  // We read `disabled` at execution time but intentionally don't depend on
  // it — see the comment above.
  const disabledRef = React.useRef(disabled);
  disabledRef.current = disabled;

  // biome-ignore lint/correctness/useExhaustiveDependencies: draftKey is the trigger; disabled is read via ref
  React.useEffect(() => {
    if (!editor || typeof document === "undefined") return;
    const frame = requestAnimationFrame(() => {
      if (disabledRef.current || editor.isDestroyed) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) {
        const tag = active.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          active.isContentEditable ||
          active.closest('[role="dialog"], [role="menu"], [role="listbox"]') ||
          active.getAttribute("aria-expanded") === "true"
        ) {
          return;
        }
      }
      // Already in a frame outside React's commit. Focus synchronously so no
      // second queued Tiptap focus can outlive this ownership check.
      editor.view.dispatch(
        editor.state.tr
          .setSelection(TextSelection.atEnd(editor.state.doc))
          .scrollIntoView(),
      );
      editor.view.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [draftKey, editor]);
}
