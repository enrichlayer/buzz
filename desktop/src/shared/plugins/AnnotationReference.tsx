import type { CodeFenceRendererProps } from "./codeFences";

/** Read-only source receipt; untrusted metadata never executes or navigates. */
export default function AnnotationReference({
  code,
  fallback,
}: CodeFenceRendererProps) {
  let data: {
    sourceId?: unknown;
    sourceRevision?: unknown;
    selectedText?: unknown;
  };
  try {
    data = JSON.parse(code);
  } catch {
    return <>{fallback}</>;
  }
  if (
    !data ||
    typeof data.sourceId !== "string" ||
    typeof data.sourceRevision !== "string" ||
    typeof data.selectedText !== "string"
  )
    return <>{fallback}</>;
  return (
    <details className="my-2 text-sm" data-testid="annotation-reference">
      <summary className="cursor-pointer text-muted-foreground">
        Source details
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        Captured when this feedback was written. Later edits do not change this
        quote.
      </p>
      <blockquote className="whitespace-pre-wrap break-words border-l border-border pl-3">
        {data.selectedText}
      </blockquote>
      <dl className="mt-2 text-xs text-muted-foreground">
        <dt>Source</dt>
        <dd className="break-all">{data.sourceId}</dd>
        <dt>Revision</dt>
        <dd className="break-all">{data.sourceRevision}</dd>
      </dl>
    </details>
  );
}
