#!/usr/bin/env python3
"""Prepare an upstream merge in a disposable checkout; never push main."""

import argparse
import json
import os
from pathlib import Path
import subprocess

BRANCH = "codex/upstream-sync"
UPSTREAM = "https://github.com/block/buzz.git"


def git(root, *args, capture=True, check=True):
    """Run bounded Git operations, streaming potentially large mutation output."""
    return subprocess.run(
        ["git", "-C", str(root), *args],
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=None,
        timeout=180,
        check=check,
    )


def prepare(root, upstream=UPSTREAM):
    """Merge main and upstream while retaining manual fixes on the sync branch."""
    if git(root, "status", "--porcelain").stdout.strip():
        raise RuntimeError("Use a clean, disposable checkout; working files are present")
    git(root, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", capture=False)
    git(root, "fetch", "--quiet", upstream, "refs/heads/main", capture=False)
    central = git(root, "rev-parse", "FETCH_HEAD").stdout.strip()
    base = git(root, "rev-parse", "origin/main").stdout.strip()
    if git(root, "merge-base", "--is-ancestor", central, base, check=False).returncode == 0:
        return {"status": "current", "base": base, "upstream": central}
    remote = git(root, "ls-remote", "--heads", "origin", f"refs/heads/{BRANCH}").stdout.strip()
    start = base
    recreated = False
    if remote:
        git(root, "fetch", "--quiet", "origin", f"refs/heads/{BRANCH}", capture=False)
        tip = git(root, "rev-parse", "FETCH_HEAD").stdout.strip()
        # A tip already on main was merged; it carries no pending maintainer
        # fixes, so start fresh from main instead of stacking on stale history.
        if git(root, "merge-base", "--is-ancestor", tip, base, check=False).returncode == 0:
            recreated = True
        else:
            start = tip
    git(root, "checkout", "--quiet", "-B", BRANCH, start, capture=False)
    for label, revision in (("fork main", base), ("upstream main", central)):
        result = git(root, "merge", "--quiet", "--no-edit", "--no-ff", "--signoff", revision, capture=False, check=False)
        if result.returncode:
            # Abort only a merge we started. A non-conflict failure must propagate.
            paths = git(root, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
            merge_head = git(root, "rev-parse", "--verify", "MERGE_HEAD", check=False)
            if merge_head.returncode == 0:
                git(root, "merge", "--abort", capture=False)
            if not paths:
                raise RuntimeError(f"Git merge failed for {label} (exit {result.returncode})")
            return {"status": "conflict", "base": base, "upstream": central, "stage": label, "paths": paths[:100]}
    head = git(root, "rev-parse", "HEAD").stdout.strip()
    # Never publish workflow or repository-automation changes that main does not
    # already contain: a same-repository branch runs them with our secrets.
    pushed = set(git(root, "diff", "--name-only", start, head, "--", ".github/").stdout.splitlines())
    untrusted = [path for path in git(root, "diff", "--name-only", base, head, "--", ".github/").stdout.splitlines()
                 if path in pushed]
    if untrusted:
        return {"status": "needs-maintainer", "reason": "github-paths", "base": base, "upstream": central,
                "head": head, "paths": untrusted[:100]}
    return {"status": "ready", "base": base, "upstream": central, "head": head, "changed": head != start,
            "recreated": recreated}


def encode(result):
    """JSON without backticks, so embedding it in a Markdown fence cannot break out."""
    return json.dumps(result, indent=2).replace("`", "\\u0060") + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True, type=Path)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "enrichlayer/buzz":
        parser.error("Run this command only in the fork's disposable GitHub Actions checkout")
    result = prepare(Path.cwd())
    args.result.write_text(encode(result))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            stream.write(f"status={result['status']}\n")
    print(encode(result), end="")


if __name__ == "__main__":
    main()
