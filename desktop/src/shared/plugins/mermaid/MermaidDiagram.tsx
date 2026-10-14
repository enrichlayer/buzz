import mermaid from "mermaid";
import { diagramDescription } from "./diagramDescription";
import * as React from "react";
import type { CodeFenceRendererProps } from "@/shared/plugins/codeFences";
import { useTheme } from "@/shared/theme/ThemeProvider";

type RenderState =
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

// Caps keep one oversized diagram from stalling the timeline on every mount.
const MAX_TEXT_SIZE = 20_000;
const MAX_EDGES = 200;

/**
 * Renders a ```mermaid fence as a diagram. Message content is untrusted, so
 * mermaid runs at `securityLevel: "strict"` (labels sanitised, click handlers
 * disabled); the app CSP also forbids inline scripts. Source that cannot be
 * drawn shows the error above the plain code block.
 */
export default function MermaidDiagram({
  code,
  fallback,
}: CodeFenceRendererProps) {
  const { isDark } = useTheme();
  const id = `mermaid-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const attempt = React.useRef(0);
  const [state, setState] = React.useState<RenderState>({
    status: "rendering",
  });

  React.useEffect(() => {
    let cancelled = false;
    // A fresh id per attempt: mermaid deletes any element carrying the id it
    // renders under, which would blank the diagram still on screen.
    attempt.current += 1;
    const renderId = `${id}-${attempt.current}`;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Throw instead of drawing an error graphic into a stray body node.
      suppressErrorRendering: true,
      maxTextSize: MAX_TEXT_SIZE,
      maxEdges: MAX_EDGES,
      theme: isDark ? "dark" : "default",
    });
    mermaid.render(renderId, code).then(
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
        {fallback}
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
    <figure className="my-2">
      <div
        className="overflow-x-auto rounded-md border border-border/50 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced by mermaid in strict mode
        dangerouslySetInnerHTML={{ __html: state.svg }}
        role="img"
        aria-label={diagramDescription(code)}
      />
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-foreground">
          Diagram source
        </summary>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground">
          {code}
        </pre>
      </details>
    </figure>
  );
}
