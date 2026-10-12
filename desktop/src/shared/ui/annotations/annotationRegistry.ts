import type {
  AnnotationSource,
  AnnotationSubmitRequest,
} from "./annotationModel";
import { captureSelectionAnchor } from "./selectionAnchor";
import { selectionPosition } from "./selectionPosition";

export type AnnotationScope = {
  id: string;
  label: string;
  channelId?: string | null;
};

export type AnnotationScopeRegistration = {
  root: HTMLElement;
  scope: AnnotationScope;
  submit: (request: AnnotationSubmitRequest) => Promise<void>;
};

export type AnnotationSourceRegistration = {
  root: HTMLElement;
  read: () => AnnotationSource;
};

/** One registry per mounted community; never shared between workspaces. */
export function createAnnotationRegistry() {
  return {
    navigationGeneration: 0,
    scopes: new Set<AnnotationScopeRegistration>(),
    sources: new Map<HTMLElement, AnnotationSourceRegistration>(),
    changed: (_root: HTMLElement) => {},
  };
}

export type AnnotationRegistry = ReturnType<typeof createAnnotationRegistry>;

function elementFor(node: Node): HTMLElement | null {
  return node instanceof HTMLElement ? node : node.parentElement;
}

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-annotation-editor]';

function nextOutsideSubtree(walker: TreeWalker) {
  let node = walker.nextSibling();
  while (!node && walker.parentNode()) node = walker.nextSibling();
  return node;
}

/**
 * Browser paragraph selection may end at the next sibling or its parent.
 * Visits only nodes the range intersects and stops after its end; also
 * collects editable elements the range touches.
 */
function textBoundedRange(original: Range) {
  const range = original.cloneRange();
  const editables: Element[] = [];
  const common = original.commonAncestorContainer;
  if (common.nodeType === Node.TEXT_NODE) return { range, editables };
  const walker = document.createTreeWalker(
    common,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  let first: Text | null = null;
  let last: Text | null = null;
  let node = walker.firstChild();
  while (node) {
    if (!original.intersectsNode(node)) {
      // Document order: once a node starts after the range, nothing later intersects.
      if (original.comparePoint(node, 0) > 0) break;
      node = nextOutsideSubtree(walker);
      continue;
    }
    if (node instanceof Element) {
      if (node.matches(EDITABLE)) editables.push(node);
    } else {
      const from = node === original.startContainer ? original.startOffset : 0;
      const to =
        node === original.endContainer
          ? original.endOffset
          : node.textContent?.length;
      if (node.textContent?.slice(from, to).trim()) {
        first ??= node as Text;
        last = node as Text;
      }
    }
    node = walker.nextNode();
  }
  if (first && last) {
    range.setStart(
      first,
      first === original.startContainer ? original.startOffset : 0,
    );
    range.setEnd(
      last,
      last === original.endContainer ? original.endOffset : last.length,
    );
  }
  return { range, editables };
}

/** Resolve the whole selection, including unregistered text and multi-block ranges. */
export function resolveAnnotationSelection(
  registry: AnnotationRegistry,
  selection: Selection | null,
) {
  if (
    selection?.rangeCount !== 1 ||
    selection.isCollapsed ||
    !selection.toString().trim()
  )
    return null;
  const { range, editables } = textBoundedRange(selection.getRangeAt(0));
  const start = elementFor(range.startContainer);
  const end = elementFor(range.endContainer);
  if (
    !start ||
    !end ||
    !start.isConnected ||
    !end.isConnected ||
    start.closest(EDITABLE) ||
    end.closest(EDITABLE)
  )
    return null;
  // A range that crosses a composer must not capture a private, unsent draft.
  const common = elementFor(range.commonAncestorContainer);
  if (!common || editables.some((node) => range.intersectsNode(node)))
    return null;

  // Only a conversation that contains the whole selection may receive it. Text
  // outside every conversation (modals, profiles, previews) can only be copied,
  // so it can never be posted into a conversation the user did not select in.
  let scope: AnnotationScopeRegistration | null = null;
  for (const entry of registry.scopes) {
    if (
      entry.root.isConnected &&
      entry.root.contains(start) &&
      entry.root.contains(end) &&
      (!scope || scope.root.contains(entry.root))
    )
      scope = entry;
  }

  let registered: AnnotationSourceRegistration | null = null;
  for (const entry of registry.sources.values()) {
    if (
      entry.root.contains(start) &&
      entry.root.contains(end) &&
      (!registered || registered.root.contains(entry.root))
    )
      registered = entry;
  }
  const root = registered?.root ?? common;
  const source = registered?.read() ?? {
    sourceId: `selection:${scope?.scope.id ?? window.location.pathname}:${root.id || root.dataset.testid || root.tagName.toLowerCase()}`,
    // For unregistered UI, retain exactly the visible selection, not unrelated page/draft contents.
    text: selection.toString().trim(),
    channelId: scope?.scope.channelId,
  };
  const anchor = captureSelectionAnchor(root, source, selection, range);
  if (!anchor) return null;
  return {
    root,
    source,
    anchor,
    scope,
    registered,
    restoreFocus:
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : root,
    position: selectionPosition(root, selection, range),
  };
}

export type AnnotationSelection = NonNullable<
  ReturnType<typeof resolveAnnotationSelection>
>;
