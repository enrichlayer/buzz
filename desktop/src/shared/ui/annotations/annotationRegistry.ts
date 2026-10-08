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
  /** Default destination when selection is outside a conversation. */
  priority?: number;
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
    scopes: new Set<AnnotationScopeRegistration>(),
    sources: new Map<HTMLElement, AnnotationSourceRegistration>(),
    activeScope: null as AnnotationScopeRegistration | null,
    changed: (_root: HTMLElement) => {},
  };
}

export type AnnotationRegistry = ReturnType<typeof createAnnotationRegistry>;

function elementFor(node: Node): HTMLElement | null {
  return node instanceof HTMLElement ? node : node.parentElement;
}

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-annotation-editor]';

/** Browser paragraph selection may end at the next sibling or its parent. */
function textBoundedRange(original: Range) {
  const range = original.cloneRange();
  const common = original.commonAncestorContainer;
  if (common.nodeType === Node.TEXT_NODE) return range;
  const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  let first: Text | null = null;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!original.intersectsNode(node)) continue;
    const from = node === original.startContainer ? original.startOffset : 0;
    const to =
      node === original.endContainer
        ? original.endOffset
        : node.textContent?.length;
    if (!node.textContent?.slice(from, to).trim()) continue;
    first ??= node as Text;
    last = node as Text;
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
  return range;
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
  const range = textBoundedRange(selection.getRangeAt(0));
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
  if (
    !common ||
    [...common.querySelectorAll(EDITABLE)].some((node) =>
      range.intersectsNode(node),
    )
  )
    return null;

  const scopes = [...registry.scopes].filter((entry) => entry.root.isConnected);
  let scope: AnnotationScopeRegistration | null = null;
  for (const entry of scopes) {
    if (
      entry.root.contains(start) &&
      entry.root.contains(end) &&
      (!scope || scope.root.contains(entry.root))
    )
      scope = entry;
  }
  if (scope) registry.activeScope = scope;
  else {
    scope =
      registry.activeScope && scopes.includes(registry.activeScope)
        ? registry.activeScope
        : (scopes.sort(
            (a, b) => (b.scope.priority ?? 0) - (a.scope.priority ?? 0),
          )[0] ?? null);
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
