import { useMemo } from "react";
import {
  Diff,
  computeOldLineNumber,
  computeNewLineNumber,
  type DiffProps,
  type HunkTokens,
  type TokenNode,
} from "react-diff-view";
import type { ThemedToken } from "shiki";
import { languageForCodePath } from "./codeLanguage";
import { useCodeTokens } from "./useCodeTokens";

type SourceLine = { number: number; content: string };

function mapTokens(
  lines: SourceLine[],
  tokens: ThemedToken[][],
): TokenNode[][] {
  // Sparse indexing preserves original line numbers without padding/tokenizing
  // all the omitted source above a hunk in a large file.
  const result: TokenNode[][] = [];
  lines.forEach((line, index) => {
    result[line.number - 1] = (tokens[index] ?? []).map((token) => ({
      type: "syntax",
      value: token.content,
      color: token.color,
    }));
  });
  return result;
}

/** Highlight each side independently while retaining the diff's layout and gutters. */
export function SyntaxDiff({ path, ...props }: DiffProps & { path: string }) {
  const sources = useMemo(() => {
    const old: SourceLine[] = [];
    const next: SourceLine[] = [];
    for (const hunk of props.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "insert")
          old.push({
            number: computeOldLineNumber(change),
            content: change.content,
          });
        if (change.type !== "delete")
          next.push({
            number: computeNewLineNumber(change),
            content: change.content,
          });
      }
    }
    return { old, next };
  }, [props.hunks]);
  const language = languageForCodePath(path);
  const oldTokens = useCodeTokens(
    sources.old.map((line) => line.content).join("\n"),
    language,
  );
  const newTokens = useCodeTokens(
    sources.next.map((line) => line.content).join("\n"),
    language,
  );
  const tokens: HunkTokens | null = useMemo(
    () =>
      oldTokens && newTokens
        ? {
            old: mapTokens(sources.old, oldTokens),
            new: mapTokens(sources.next, newTokens),
          }
        : null,
    [sources, oldTokens, newTokens],
  );
  return <Diff {...props} tokens={tokens} renderToken={renderSyntaxToken} />;
}

const renderSyntaxToken: NonNullable<DiffProps["renderToken"]> = (
  token,
  renderDefault,
  index,
) =>
  token.type === "syntax" ? (
    <span key={index} style={{ color: token.color }}>
      {token.value}
    </span>
  ) : (
    renderDefault(token, index)
  );
