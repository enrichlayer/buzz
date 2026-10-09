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
  const range = anchor.codeRange;
  const block = range?.blockId.match(/:code:(\d+)$/)?.[1];
  const location = range
    ? `Response · code block ${block ?? "selected"} · ${range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}–${range.endLine}`}`
    : "Response · selected text";
  return [
    location,
    "",
    quoteSelection(anchor.selectedText),
    "",
    comment.trim(),
    "",
    "```buzz-annotation",
    JSON.stringify(annotationMetadata(anchor)).replaceAll("`", "\\u0060"),
    "```",
  ].join("\n");
}

/** Structured source metadata uses a built-in fence so every existing harness receives it. */
export function annotationMetadata(anchor: AnnotationAnchor) {
  return {
    sourceId: anchor.sourceId,
    sourceRevision: anchor.sourceRevision,
    selectedText: anchor.selectedText,
    codeRange: anchor.codeRange,
    channelId: anchor.channelId,
    sessionId: anchor.sessionId,
    turnId: anchor.turnId,
  };
}

/** Recognize our complete annotation envelope; arbitrary Markdown stays untouched. */
export function parseAnnotationMessage(message: string) {
  const match = message.match(
    /^(Response · (?:selected text|code block [^\n]+)|Reply to selection)\n\n([\s\S]*?)\n\n```buzz-annotation\n([^\n]+)\n```\s*$/,
  );
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[3]);
    if (
      typeof metadata?.selectedText !== "string" ||
      typeof metadata.sourceId !== "string" ||
      typeof metadata.sourceRevision !== "string"
    )
      return null;
    const quote = quoteSelection(metadata.selectedText);
    if (!match[2].startsWith(`${quote}\n\n`)) return null;
    return {
      metadata,
      label: match[1],
      comment: match[2].slice(quote.length + 2),
    };
  } catch {
    return null;
  }
}
