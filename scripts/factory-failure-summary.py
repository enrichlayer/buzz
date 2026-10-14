"""Retain bounded Rust failure context in Factory's separate stderr receipt."""

from pathlib import Path
import re
import sys


def summarize(path: Path) -> str:
    """Extract at most 3000 UTF-8 bytes of failure context from a bounded window."""
    # Bound memory even when a compiler/test emits a runaway log. State this
    # window explicitly; this summary is not a substitute for the full log.
    window = 4 * 1024 * 1024
    with path.open("rb") as stream:
        stream.seek(0, 2)
        offset = max(0, stream.tell() - window)
        stream.seek(offset)
        text = stream.read(window).decode("utf-8", errors="replace")
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    contexts = []
    count = 0
    # A name can occur in several crates. Match panics only within the same
    # failed libtest invocation, never an earlier successful should_panic test.
    parts = re.split(r"(^test result: [^\n]*$)", text, flags=re.MULTILINE)
    for run, result in zip(parts[::2], parts[1::2]):
        if not result.startswith("test result: FAILED"):
            continue
        failed = set(re.findall(r"^test (\S+) \.\.\. FAILED", run, re.MULTILINE))
        for match in re.finditer(r"thread '([^']+)'(?: \([^\n]*\))? panicked at", run):
            if match[1] in failed:
                count += 1
                if len(contexts) < 3:
                    contexts.append(
                        "\n".join(
                            run[match.start() : match.start() + 1000].splitlines()[:9]
                        )[:850]
                    )
    if not contexts:
        for match in re.finditer(r"^error(?:\[[^\]\n]+\])?:", text, re.MULTILINE):
            count += 1
            if len(contexts) < 3:
                contexts.append(
                    "\n".join(
                        text[match.start() : match.start() + 1000].splitlines()[:6]
                    )[:850]
                )
    header = f"Factory failure context (last 4 MiB; log offset {offset}):\n"
    if contexts:
        body = "\n---\n".join(contexts[:3])
        if count > 3:
            body += f"\n[{count - 3} additional contexts omitted]"
    else:
        body = "No assertion context recognized. Final log excerpt:\n" + text[-2200:]
    # Leave room for the final disk snapshot in the 4 KiB stderr receipt.
    return (header + body).encode("utf-8")[:3000].decode("utf-8", errors="ignore")


if __name__ == "__main__":
    print(summarize(Path(sys.argv[1])))
