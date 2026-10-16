/** Stable native links for source work, independent of mutable event IDs. */
export type LinearWorkLink = {
  type: "linear-task" | "linear-project";
  owner: string;
  dtag: string;
  id: string;
};
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const DTAG = new RegExp(`^linear:(${UUID}):(${UUID}):(${UUID})$`);

export function parseLinearWorkLink(value: string): LinearWorkLink | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "buzz:" ||
      !["linear-task", "linear-project"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    )
      return null;
    if (
      [...url.searchParams.keys()].some(
        (key) => !["owner", "d"].includes(key),
      ) ||
      url.searchParams.getAll("owner").length !== 1 ||
      url.searchParams.getAll("d").length !== 1
    )
      return null;
    const owner = url.searchParams.get("owner")?.toLowerCase() ?? "";
    const dtag = url.searchParams.get("d")?.toLowerCase() ?? "";
    const match = DTAG.exec(dtag);
    if (!/^[a-f0-9]{64}$/.test(owner) || !match) return null;
    return {
      type: url.hostname as LinearWorkLink["type"],
      owner,
      dtag,
      id: match[3],
    };
  } catch {
    return null;
  }
}

export function buildLinearWorkLink(
  input: Pick<LinearWorkLink, "type" | "owner" | "dtag">,
): string {
  const href = `buzz://${input.type}?owner=${encodeURIComponent(input.owner)}&d=${encodeURIComponent(input.dtag)}`;
  const parsed = parseLinearWorkLink(href);
  if (!parsed) throw new Error("Invalid Linear work coordinate");
  return `buzz://${parsed.type}?owner=${parsed.owner}&d=${encodeURIComponent(parsed.dtag)}`;
}

export function linearWorkLinkFromAddress(address: string): string | null {
  const match = /^(30623|30624):([a-f0-9]{64}):(linear:.+)$/.exec(address);
  if (!match || !DTAG.test(match[3])) return null;
  return buildLinearWorkLink({
    type: match[1] === "30623" ? "linear-project" : "linear-task",
    owner: match[2],
    dtag: match[3],
  });
}
