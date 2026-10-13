"""Publish the rolling Sprig release, including a fork's first publication."""
import json
import re
import subprocess
import sys
from pathlib import Path


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=120)


def publish(repository, sha, directory):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Expected owner/repository")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected full source SHA")
    assets = sorted(str(path) for path in Path(directory).glob("*") if path.is_file())
    if not assets:
        raise ValueError("No Sprig artifacts to publish")
    tag = "sprig-latest"
    exists = False
    for page in range(1, 21):
        releases = json.loads(gh("api", f"repos/{repository}/releases?per_page=100&page={page}"))
        if any(release["tag_name"] == tag for release in releases):
            exists = True
            break
        if len(releases) < 100:
            break
    else:
        raise ValueError("Release listing exceeds pagination bound")
    notes = f"Rolling Linux build of Sprig (buzz-acp + buzz-agent + buzz-dev-mcp), tracking main ({sha})."
    options = ["--repo", repository, "--prerelease", "--title", "Sprig (rolling)", "--notes", notes]
    if exists:
        gh("release", "edit", tag, *options)
    else:
        gh("release", "create", tag, "--target", sha, *options)
    gh("release", "upload", tag, "--repo", repository, "--clobber", *assets)


if __name__ == "__main__":
    publish(*sys.argv[1:])
