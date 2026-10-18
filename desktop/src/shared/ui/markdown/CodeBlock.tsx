import * as React from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { ThemedToken } from "shiki";
import { useCodeTokens } from "./useCodeTokens";

import { copyCodeBlockToClipboard } from "@/shared/lib/codeBlockClipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { useSmoothCorners } from "@/shared/ui/smoothCorners";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

import { getReactNodeText } from "./utils";

export const CODE_BLOCK_CLASS =
  "code-block-lines block min-w-full whitespace-pre font-mono text-sm font-medium text-foreground";
const DIFF_ADD_RE = /\s*\/\/\s*\[!code\s*\+\+\]\s*$/;
const DIFF_REMOVE_RE = /\s*\/\/\s*\[!code\s*--\]\s*$/;

export function extractLanguage(className?: string): string {
  if (typeof className !== "string") return "";
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : "";
}

function stripDiffMarker(tokens: ThemedToken[], marker: RegExp): ThemedToken[] {
  const last = tokens[tokens.length - 1];
  if (!last) return tokens;
  const stripped = last.content.replace(marker, "");
  if (stripped === last.content) return tokens;
  if (stripped === "") return tokens.slice(0, -1);
  return [...tokens.slice(0, -1), { ...last, content: stripped }];
}

export function getCodeBlockText(children: React.ReactNode) {
  return getReactNodeText(children).replace(/\n$/, "");
}

export function MarkdownCodeBlock({
  children,
  language,
}: {
  children?: React.ReactNode;
  language?: string;
}) {
  const [isCopying, setIsCopying] = React.useState(false);
  const codeBlockRef = React.useRef<HTMLPreElement | null>(null);
  const code = React.useMemo(() => getCodeBlockText(children), [children]);
  useSmoothCorners(codeBlockRef);

  const handleCopy = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsCopying(true);

      try {
        await copyCodeBlockToClipboard(code);
        toast.success("Copied code to clipboard");
      } catch (error) {
        console.error("Failed to copy code block", error);
        toast.error("Failed to copy code");
      } finally {
        setIsCopying(false);
      }
    },
    [code],
  );

  return (
    <div className="group relative" data-code-block="">
      <pre
        ref={codeBlockRef}
        className="max-h-[400px] overflow-x-auto overflow-y-auto rounded-2xl border border-border/70 bg-muted/60 px-3 py-1.5 pr-12 shadow-xs"
        style={{ borderRadius: "1rem" }}
      >
        {language && (
          <div className="mb-1 text-xs text-muted-foreground/70">
            {language}
          </div>
        )}
        {children}
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Copy code block"
            className="absolute right-2 top-2 h-7 w-7 bg-background/80 text-muted-foreground opacity-0 shadow-xs ring-1 ring-border/60 backdrop-blur-sm transition-opacity hover:bg-background hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-60"
            disabled={isCopying}
            onClick={handleCopy}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Copy className="h-4 w-4" />
            <span className="sr-only">Copy code block</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy code</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SyntaxHighlightedCode({
  className,
  code,
  language: languageHint,
  ...props
}: {
  code: string;
  language: string;
} & React.ComponentProps<"code">) {
  const tokens = useCodeTokens(code, languageHint);

  const codeClassName = cn(CODE_BLOCK_CLASS, className);

  if (!tokens) {
    const lines = code.split("\n");
    return (
      <code {...props} className={codeClassName}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <span key={i} data-code-line={i + 1} data-line="">
            {line}
          </span>
        ))}
      </code>
    );
  }

  return (
    <code {...props} className={codeClassName}>
      {tokens.map((line, lineIdx) => {
        const lineText = line.map((t) => t.content).join("");
        const isAdd = DIFF_ADD_RE.test(lineText);
        const isRemove = DIFF_REMOVE_RE.test(lineText);
        const diffClass = isAdd
          ? "code-line-diff-add"
          : isRemove
            ? "code-line-diff-remove"
            : undefined;

        const renderedTokens =
          isAdd || isRemove
            ? stripDiffMarker(line, isAdd ? DIFF_ADD_RE : DIFF_REMOVE_RE)
            : line;

        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered
            key={lineIdx}
            data-code-line={lineIdx + 1}
            data-line=""
            className={diffClass}
          >
            {renderedTokens.map((token, tokenIdx) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reordered
                key={tokenIdx}
                style={token.color ? { color: token.color } : undefined}
              >
                {token.content}
              </span>
            ))}
          </span>
        );
      })}
    </code>
  );
}
