"""Require exact-source CI and an independent approval before reserving or shipping a release."""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path

REPOSITORY = "enrichlayer/buzz"
REQUIRED = {".github/workflows/ci.yml", ".github/workflows/enrichlayer-updater-checks.yml"}
IGNORED = {".github/workflows/enrichlayer-auto-release.yml",
           ".github/workflows/enrichlayer-desktop-release.yml",
           ".github/workflows/enrichlayer-promote-desktop.yml"}
# Review bots are GitHub Apps, which have no collaborator permission to look up.
TRUSTED_BOT_REVIEWERS = {"enrichlayer-el-bot[bot]"}
WRITE_PERMISSIONS = {"admin", "maintain", "write"}


class Pending(Exception):
    """Evidence is not final yet (or this commit is not a release candidate).

    The automatic coordinator treats this as a no-op and retries on the next
    workflow completion or hourly schedule; release/publish steps still fail.
    """


def api(endpoint, **fields):
    command = ["gh", "api", f"repos/{REPOSITORY}/{endpoint}"]
    for key, value in fields.items():
        command += ["-f", f"{key}={value}"]
    return json.loads(subprocess.check_output(command, text=True, timeout=60))


def pages(endpoint, key=None):
    """Bound API traversal; incomplete evidence is an error, never approval."""
    result = []
    for page in range(1, 21):
        separator = "&" if "?" in endpoint else "?"
        response = api(f"{endpoint}{separator}per_page=100&page={page}")
        items = response[key] if key else response
        result.extend(items)
        if len(items) < 100:
            return result
    raise ValueError("Release evidence exceeds pagination bound")


def check_external(sha):
    for run in pages(f"commits/{sha}/check-runs", "check_runs"):
        # Actions checks are covered by their parent workflows above. In-progress
        # release jobs must not wait for themselves, but external gates still count.
        if (run.get("app") or {}).get("slug") == "github-actions":
            continue
        if run["status"] != "completed":
            raise Pending(f"External check still running: {run['name']}")
        if run["conclusion"] not in ("success", "neutral", "skipped"):
            raise ValueError(f"External check not successful: {run['name']}")
    latest = {}
    for status in pages(f"commits/{sha}/statuses"):
        latest.setdefault(status["context"], status)
    for context, status in latest.items():
        if status["state"] == "pending":
            raise Pending(f"Commit status still pending: {context}")
        if status["state"] != "success":
            raise ValueError(f"Commit status not successful: {context}")


def is_ancestor_of_main(sha):
    comparison = api(f"compare/{sha}...main")
    return comparison["status"] in ("ahead", "identical")


def trusted_reviewer(user, author):
    login = user["login"]
    if login == author:
        return False
    if user.get("type") == "Bot":
        return login in TRUSTED_BOT_REVIEWERS
    return api(f"collaborators/{login}/permission")["permission"] in WRITE_PERMISSIONS


def approvals_for(pr):
    """Return current-head approvals from anyone with write access except the author.

    The latest decisive review per reviewer wins. A dismissed review neither
    approves nor blocks; an approval of an older head is stale and ignored.
    """
    decisions = {}
    for review in sorted(pages(f"pulls/{pr['number']}/reviews"), key=lambda r: r["id"]):
        if review["state"] in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED") and review.get("user"):
            decisions[review["user"]["login"]] = review
    if any(r["state"] == "CHANGES_REQUESTED" for r in decisions.values()):
        raise ValueError("PR has unresolved changes requested")
    author = pr["user"]["login"]
    approvals = [r for r in decisions.values() if r["state"] == "APPROVED"
                 and r["commit_id"] == pr["head"]["sha"] and trusted_reviewer(r["user"], author)]
    if not approvals:
        raise ValueError("PR lacks an approval of its final head from a reviewer other than the author")
    return approvals


def check(sha, allow_ancestor=False):
    """Validate release evidence for sha.

    allow_ancestor permits manual promotion of an already-built release whose
    source has since been followed by other main commits; the updater still
    refuses any downgrade below the served or journaled version.
    """
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected full source commit SHA")
    if api("commits/main")["sha"] != sha:
        if not allow_ancestor:
            raise Pending("Release source is not current main")
        if not is_ancestor_of_main(sha):
            raise ValueError("Release source is not on main")
    runs = pages(f"actions/runs?head_sha={sha}&event=push", "workflow_runs")
    latest = {}
    for run in sorted(runs, key=lambda r: (r["id"], r["run_attempt"])):
        if run["head_sha"] == sha and run["head_branch"] == "main":
            latest[run["path"]] = run
    for path in REQUIRED:
        if path not in latest or latest[path]["status"] != "completed":
            raise Pending(f"Required checks still running: {path}")
        if latest[path]["conclusion"] != "success":
            raise ValueError(f"Required checks not successful: {path}")
    for path, run in latest.items():
        if path in IGNORED:
            continue
        if run["status"] != "completed":
            raise Pending(f"Source workflow still running: {path}")
        if run["conclusion"] not in ("success", "skipped", "neutral"):
            raise ValueError(f"Source workflow not successful: {path}")
    prs = pages(f"commits/{sha}/pulls")
    eligible = [p for p in prs if p["merged_at"] and p["merge_commit_sha"] == sha
                and p["base"]["ref"] == "main" and p["base"]["repo"]["full_name"] == REPOSITORY]
    if len(eligible) != 1:
        raise Pending("Source is not the merge commit of exactly one main PR")
    pr = api(f"pulls/{eligible[0]['number']}")
    if pr["draft"]:
        raise ValueError("Draft PR cannot release")
    approvals = approvals_for(pr)
    check_external(sha)
    check_external(pr["head"]["sha"])
    # A main update during evidence collection must not inherit this approval.
    if not allow_ancestor and api("commits/main")["sha"] != sha:
        raise Pending("Main changed while checking release evidence")
    return {"source_sha": sha, "pull_request": pr["number"],
            "review_ids": [r["id"] for r in approvals],
            "check_run_ids": [latest[p]["id"] for p in sorted(REQUIRED)]}


def release_state(proof, version):
    # Scheduled retries must not rebuild an already-promoted commit, and a
    # published-but-unpromoted release resumes promotion from its immutable assets.
    releases = pages("releases")
    versioned = next((r for r in releases if r["tag_name"] == f"el-desktop-v{version}"), None)
    published = bool(versioned and not versioned["draft"])
    rolling = next((r for r in releases if r["tag_name"] == "buzz-desktop-latest"), None)
    promoted = False
    if rolling and not rolling["draft"]:
        assets = {a["name"] for a in rolling["assets"]}
        # Journal alone is not success: a failed feed upload leaves it behind.
        if "latest.json" in assets and f"promotion-{version}.json" in assets:
            data = subprocess.check_output(
                ["gh", "release", "download", "buzz-desktop-latest", "--repo", REPOSITORY,
                 "--pattern", "latest.json", "--output", "-"], text=True, timeout=60)
            promoted = json.loads(data)["version"] == version
    return dict(proof, version=version, already_promoted=str(promoted).lower(),
                published=str(published).lower())


def reserve(sha):
    proof = check(sha)
    tags = pages("tags")
    versions = []
    for tag in tags:
        match = re.fullmatch(r"el-desktop-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag["name"])
        if match:
            version = tuple(map(int, match.groups()))
            versions.append(version)
            if tag["commit"]["sha"] == sha:
                return release_state(proof, ".".join(map(str, version)))
    baseline = json.loads(Path("desktop/src-tauri/tauri.conf.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", baseline):
        raise ValueError("Release baseline must be stable X.Y.Z")
    highest = max([tuple(map(int, baseline.split("."))), *versions])
    version = f"{highest[0]}.{highest[1]}.{highest[2] + 1}"
    api("git/refs", ref=f"refs/tags/el-desktop-v{version}", sha=sha)
    return dict(proof, version=version, already_promoted="false", published="false")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "reserve"))
    parser.add_argument("sha")
    parser.add_argument("--allow-ancestor", action="store_true",
                        help="check only: accept a reviewed source that is an ancestor of main")
    args = parser.parse_args()
    if args.allow_ancestor and args.action != "check":
        parser.error("--allow-ancestor applies only to check")
    try:
        result = reserve(args.sha) if args.action == "reserve" else check(args.sha, args.allow_ancestor)
    except Pending as pending:
        if args.action != "reserve":
            raise SystemExit(f"Release evidence incomplete: {pending}")
        # Not a failure: no outputs means the release job is skipped this run.
        print(f"::notice::No release this run: {pending}")
        raise SystemExit(0)
    print(json.dumps(result))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key in ("source_sha", "version", "already_promoted", "published"):
                if key in result:
                    output.write(f"{key}={result[key]}\n")
