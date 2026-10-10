import type {
  AnnotationAnchor,
  AnnotationCodeRange,
  AnnotationSource,
} from "./annotationModel";
import { annotationSourceRevision } from "./annotationModel";

function containingElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function codeRangeForSelection(
  root: HTMLElement,
  range: Range,
): AnnotationCodeRange | undefined {
  const startElement = containingElement(range.startContainer);
  const endElement = containingElement(range.endContainer);
  const startBlock = startElement?.closest<HTMLElement>("[data-code-block]");
  const endBlock = endElement?.closest<HTMLElement>("[data-code-block]");
  if (!startBlock || startBlock !== endBlock || !root.contains(startBlock)) {
    return undefined;
  }

  const startLine = startElement?.closest<HTMLElement>("[data-code-line]");
  const endLine = endElement?.closest<HTMLElement>("[data-code-line]");
  if (!startLine || !endLine || !startBlock.contains(startLine))
    return undefined;
  const startNumber = Number.parseInt(startLine.dataset.codeLine || "", 10);
  const endNumber = Number.parseInt(endLine.dataset.codeLine || "", 10);
  if (!Number.isFinite(startNumber) || !Number.isFinite(endNumber)) {
    return undefined;
  }

  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>("[data-code-block]"),
  );
  const blockIndex = blocks.indexOf(startBlock);
  if (blockIndex < 0) return undefined;
  return {
    blockId: `${root.dataset.annotationSourceId || "source"}:code:${blockIndex + 1}`,
    startLine: Math.min(startNumber, endNumber),
    endLine: Math.max(startNumber, endNumber),
  };
}

/**
 * Captures only DOM facts. It deliberately does not infer Markdown offsets:
 * rendered Markdown may omit markers or insert interactive elements.
 */
export function captureSelectionAnchor(
  root: HTMLElement,
  source: AnnotationSource,
  selection: Selection | null,
): AnnotationAnchor | null {
  if (selection?.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;

  return {
    sourceId: source.sourceId,
    sourceRevision: annotationSourceRevision(source),
    originalSourceText: source.text,
    selectedText,
    codeRange: codeRangeForSelection(root, range),
    channelId: source.channelId,
    sessionId: source.sessionId,
    turnId: source.turnId,
  };
}
