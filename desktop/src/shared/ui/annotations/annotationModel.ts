export type AnnotationDestination = {
  channelId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
};

export type AnnotationSource = AnnotationDestination & {
  /** Stable identity from the source system (for example an ACP message id). */
  sourceId: string;
  /** The exact source bytes shown when the selection is captured. */
  text: string;
  /** Optional upstream revision. A content digest is used when this is absent. */
  revision?: string | null;
};

export type AnnotationCodeRange = {
  blockId: string;
  startLine: number;
  endLine: number;
};

export type AnnotationAnchor = AnnotationDestination & {
  sourceId: string;
  sourceRevision: string;
  originalSourceText: string;
  selectedText: string;
  codeRange?: AnnotationCodeRange;
};

export type AnnotationSubmitRequest = {
  anchor: AnnotationAnchor;
  /** Ready-to-send user text containing both the quote and feedback. */
  message: string;
};

export function annotationSourceRevision(source: AnnotationSource): string {
  return source.revision || `fnv1a64:${fnv1a64(source.text)}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function quoteSelection(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatAnnotationMessage(
  anchor: AnnotationAnchor,
  comment: string,
): string {
  const codeLocation = anchor.codeRange
    ? `, code block \`${anchor.codeRange.blockId}\` lines ${anchor.codeRange.startLine}-${anchor.codeRange.endLine}`
    : "";
  return [
    "Feedback on the selected part of your response:",
    "",
    quoteSelection(anchor.selectedText),
    "",
    `Source: \`${anchor.sourceId}\` at revision \`${anchor.sourceRevision}\`${codeLocation}`,
    "",
    comment.trim(),
  ].join("\n");
}
