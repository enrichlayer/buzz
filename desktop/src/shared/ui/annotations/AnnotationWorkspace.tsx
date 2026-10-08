import * as React from "react";
import {
  createAnnotationRegistry,
  resolveAnnotationSelection,
  type AnnotationRegistry,
  type AnnotationSelection,
} from "./annotationRegistry";
import { SelectionAnnotationEditor } from "./SelectionAnnotationEditor";

export const AnnotationRegistryContext =
  React.createContext<AnnotationRegistry | null>(null);

/** A single selection controller covers every readable surface in this community. */
export function AnnotationWorkspace({
  children,
}: {
  children: React.ReactNode;
}) {
  const [registry] = React.useState(createAnnotationRegistry);
  const [selection, setSelection] = React.useState<AnnotationSelection | null>(
    null,
  );
  const [open, setOpen] = React.useState(false);
  const [, refresh] = React.useReducer((value: number) => value + 1, 0);
  const state = React.useRef({ selection, open });
  state.current = { selection, open };

  React.useEffect(() => {
    registry.changed = (root) => {
      const current = state.current.selection;
      if (!current) return;
      if (
        !current.root.isConnected ||
        (current.registered && !registry.sources.has(current.root)) ||
        (current.scope && !registry.scopes.has(current.scope))
      ) {
        setSelection(null);
        setOpen(false);
      } else if (root === current.root) refresh();
    };
    const capture = () => {
      if (state.current.open) return;
      setSelection(resolveAnnotationSelection(registry, window.getSelection()));
    };
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        state.current.open ||
        event.key.toLowerCase() !== "m" ||
        !event.shiftKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return;
      const next = resolveAnnotationSelection(registry, window.getSelection());
      if (!next) return;
      event.preventDefault();
      setSelection(next);
      setOpen(true);
    };
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(capture);
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("keyup", schedule);
    document.addEventListener("keydown", onShortcut);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("keydown", onShortcut);
      registry.changed = () => {};
    };
  }, [registry]);

  React.useEffect(() => {
    if (!selection) return;
    const observer = new MutationObserver(() => {
      if (!selection.root.isConnected) {
        setSelection(null);
        setOpen(false);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selection]);

  return (
    <AnnotationRegistryContext.Provider value={registry}>
      {children}
      {selection ? (
        <SelectionAnnotationEditor
          key={`${selection.scope?.scope.id}:${selection.source.sourceId}:${selection.anchor.sourceRevision}:${selection.anchor.selectedText}`}
          selection={selection}
          registry={registry}
          open={open}
          onOpenChange={(next) => {
            // A late send from an unmounted editor cannot dismiss a newer draft.
            if (state.current.selection !== selection) return;
            setOpen(next);
            if (!next) setSelection(null);
          }}
        />
      ) : null}
    </AnnotationRegistryContext.Provider>
  );
}
