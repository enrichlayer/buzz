import {
  annotationSourceRevision,
  type AnnotationAnchor,
} from "./annotationModel";
import type {
  AnnotationRegistry,
  AnnotationSourceRegistration,
} from "./annotationRegistry";

/** Resolve only a source in the captured channel; never infer cross-channel identity. */
export function findAnnotationSource(
  registry: AnnotationRegistry,
  anchor: AnnotationAnchor,
) {
  return [...registry.sources.values()].find((entry) => {
    const source = entry.read();
    return (
      entry.root.isConnected &&
      source.sourceId === anchor.sourceId &&
      source.channelId === anchor.channelId
    );
  });
}

/** Build an exact rendered range without changing React-owned DOM nodes. */
export function annotationRange(
  entry: AnnotationSourceRegistration,
  anchor: AnnotationAnchor,
): Range | string {
  if (annotationSourceRevision(entry.read()) !== anchor.sourceRevision)
    return "Source has changed since this comment was written.";
  const walker = document.createTreeWalker(entry.root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    text += node.textContent;
  }
  const selection =
    typeof anchor.selectedDomText === "string"
      ? anchor.selectedDomText
      : anchor.selectedText;
  if (selection.replace(/\s/g, "") !== anchor.selectedText.replace(/\s/g, ""))
    return "The selection location does not match its quoted text.";
  if (!selection) return "The selected text is unavailable.";
  const renderedRevision = annotationSourceRevision({
    sourceId: anchor.sourceId,
    text,
  });
  let start =
    anchor.renderedRevision === renderedRevision
      ? anchor.textOffset
      : undefined;
  if (
    !Number.isSafeInteger(start) ||
    start === undefined ||
    start < 0 ||
    text.slice(start, start + selection.length) !== selection
  ) {
    start = text.indexOf(selection);
    if (!selection || start < 0)
      return "The selected text is no longer available in this source.";
    if (text.indexOf(selection, start + 1) >= 0)
      return "This selection occurs more than once; its exact location is unavailable.";
  }
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const end = offset + node.length;
    if (!started && start < end) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && start + selection.length <= end) {
      range.setEnd(node, start + selection.length - offset);
      return range;
    }
    offset = end;
  }
  return "The selected text is unavailable.";
}

/** Wait for route backfill and rendering, bounded to five seconds. */
export function waitForAnnotationSource(
  registry: AnnotationRegistry,
  anchor: AnnotationAnchor,
): Promise<AnnotationSourceRegistration | undefined> {
  const present = findAnnotationSource(registry, anchor);
  if (present) return Promise.resolve(present);
  return new Promise((resolve) => {
    const finish = (entry?: AnnotationSourceRegistration) => {
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve(entry);
    };
    const observer = new MutationObserver(() => {
      const entry = findAnnotationSource(registry, anchor);
      if (entry) finish(entry);
    });
    const timeout = window.setTimeout(() => finish(), 5000);
    observer.observe(document.body, { subtree: true, childList: true });
  });
}

/** Focus a navigation target without adding it to the normal tab order. */
export function focusAnnotationSource(root: HTMLElement) {
  const temporary = !root.hasAttribute("tabindex");
  if (temporary) root.tabIndex = -1;
  root.focus({ preventScroll: true });
  if (temporary)
    root.addEventListener(
      "blur",
      () => {
        if (root.getAttribute("tabindex") === "-1")
          root.removeAttribute("tabindex");
      },
      { once: true },
    );
}
