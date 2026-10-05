import * as React from "react";
import { getCodeFenceRenderer } from "@/shared/plugins/codeFences";
import { extractLanguage, MarkdownCodeBlock } from "./CodeBlock";

/**
 * Markdown `pre` body: a fence whose language has a code-fence plugin renders
 * through it; every other fence is a highlighted code block.
 */
export function FencedCodeBlock({ children }: { children?: React.ReactNode }) {
  let language = "";
  let code = "";
  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement<Record<string, unknown>>(child) &&
      typeof child.props?.className === "string"
    ) {
      language = extractLanguage(child.props.className);
      code = String(child.props.children ?? "").replace(/\n$/, "");
    }
  });

  const codeBlock = (
    <MarkdownCodeBlock language={language}>{children}</MarkdownCodeBlock>
  );
  const FenceRenderer = getCodeFenceRenderer(language);
  if (!FenceRenderer) return codeBlock;
  return (
    <React.Suspense fallback={codeBlock}>
      <FenceRenderer code={code} />
    </React.Suspense>
  );
}
