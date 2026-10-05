import mermaid from "mermaid";
import * as React from "react";
import type { CodeFenceRendererProps } from "@/shared/plugins/codeFences";
import { CODE_BLOCK_CLASS } from "@/shared/ui/markdown/CodeBlock";
import { useTheme } from "@/shared/theme/ThemeProvider";

type RenderState =
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

/**
 * Renders a ```mermaid fence as a diagram. Message content is untrusted, so
 * mermaid runs at `securityLevel: "strict"` (labels sanitised, click handlers
 * disabled); the app CSP also forbids inline scripts. Invalid source falls
 * back to the raw fence with the parse error.
 */
export default function MermaidDiagram({ code }: CodeFenceRendererProps) {
  const { isDark } = useTheme();
  const id = `mermaid-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = React.useState<RenderState>({
    status: "rendering",
  });

  React.useEffect(() => {
    let cancelled = false;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark ? "dark" : "default",
    });
    // Parse first: a failed render leaves mermaid's error graphic in the DOM.
    mermaid
      .parse(code)
      .then(() => mermaid.render(id, code))
      .then(
        ({ svg }) => {
          if (!cancelled) setState({ status: "ready", svg });
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [code, id, isDark]);

  if (state.status === "error") {
    return (
      <div className="my-2">
        <p className="mb-1 text-xs text-destructive">
          Could not draw this diagram: {state.message}
        </p>
        <pre className="overflow-x-auto">
          <code className={CODE_BLOCK_CLASS}>{code}</code>
        </pre>
      </div>
    );
  }

  if (state.status === "rendering") {
    return (
      <div className="my-2 p-3 text-sm text-muted-foreground">
        Drawing diagram…
      </div>
    );
  }

  return (
    <div
      className="my-2 overflow-x-auto rounded-md border border-border/50 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid in strict mode
      dangerouslySetInnerHTML={{ __html: state.svg }}
      role="img"
      aria-label="Diagram"
    />
  );
}
