import * as React from "react";
import { getCodeFenceRenderer } from "@/shared/plugins/codeFences";
import {
  RuntimePluginRenderer,
  useRuntimeCodeFencePlugin,
} from "@/shared/plugins/runtime";
import {
  extractLanguage,
  getCodeBlockText,
  MarkdownCodeBlock,
} from "./CodeBlock";

/**
 * Markdown `pre` body: a fence whose language has a code-fence plugin renders
 * through it; every other fence is a highlighted code block.
 */
export function FencedCodeBlock({ children }: { children?: React.ReactNode }) {
  let language = "";
  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement<Record<string, unknown>>(child) &&
      typeof child.props?.className === "string"
    ) {
      language = extractLanguage(child.props.className);
    }
  });

  const codeBlock = (
    <MarkdownCodeBlock language={language}>{children}</MarkdownCodeBlock>
  );
  const FenceRenderer = getCodeFenceRenderer(language);
  const runtimePlugin = useRuntimeCodeFencePlugin(language);
  if (FenceRenderer) {
    return (
      <React.Suspense fallback={codeBlock}>
        <FenceRenderer code={getCodeBlockText(children)} fallback={codeBlock} />
      </React.Suspense>
    );
  }
  if (!runtimePlugin) return codeBlock;
  return (
    <RuntimePluginRenderer
      code={getCodeBlockText(children)}
      fallback={codeBlock}
      manifest={runtimePlugin}
    />
  );
}
