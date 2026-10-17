import { Fragment } from "react";
import type { ThemedToken } from "shiki";
import { useCodeTokens } from "./useCodeTokens";

/** Token colors without layout or text changes; inherits its containing code panel. */
export function CodeText({
  code,
  language = "",
}: {
  code: string;
  language?: string;
}) {
  const lines = useCodeTokens(code, language);
  if (!lines) return code;
  return lines.map((tokens, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
    <Fragment key={index}>
      {index > 0 ? "\n" : null}
      <CodeTokens tokens={tokens} />
    </Fragment>
  ));
}

/** Render one tokenized line, preserving literal code as escaped React text. */
export function CodeTokens({ tokens }: { tokens: ThemedToken[] }) {
  return tokens.map((token, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
    <span key={index} style={token.color ? { color: token.color } : undefined}>
      {token.content}
    </span>
  ));
}
