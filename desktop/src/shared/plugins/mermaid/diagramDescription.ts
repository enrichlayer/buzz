/** Preserve authored accessibility copy; describe simple flow chains without guessing graph topology. */
export function diagramDescription(code: string): string {
  const authored = code.match(/^\s*accDescr\s*:\s*(.+)$/m)?.[1];
  if (authored) return authored.trim();
  const edges: string[] = [];
  for (const line of code.split(/[\n;]/)) {
    const chain = line.trim();
    if (!/^[\w-]+(?:\s*-->\s*[\w-]+)+$/.test(chain)) continue;
    const nodes = chain.split(/\s*-->\s*/);
    for (let i = 1; i < nodes.length; i++)
      edges.push(`${nodes[i - 1]} leads to ${nodes[i]}`);
  }
  return edges.length
    ? `${edges.join(". ")}.`
    : "Diagram. Expand Diagram source for its complete textual representation and relationships.";
}
