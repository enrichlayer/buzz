import * as React from "react";

export type CodeFenceRendererProps = {
  /** The fence body, without the trailing newline. */
  code: string;
  /** The plain code block, for a renderer that cannot draw this source. */
  fallback: React.ReactNode;
};

type CodeFenceRenderer = React.LazyExoticComponent<
  React.ComponentType<CodeFenceRendererProps>
>;

/**
 * Code-fence plugins: a fenced block whose language is registered here
 * renders through its plugin instead of as highlighted source. Renderers are
 * lazy so their libraries load only when a message contains that fence.
 */
const CODE_FENCE_RENDERERS: Readonly<Record<string, CodeFenceRenderer>> = {
  mermaid: React.lazy(() => import("./mermaid/MermaidDiagram")),
};

export function getCodeFenceRenderer(
  language: string,
): CodeFenceRenderer | undefined {
  return Object.hasOwn(CODE_FENCE_RENDERERS, language)
    ? CODE_FENCE_RENDERERS[language]
    : undefined;
}
