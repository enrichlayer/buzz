"""Require exact-source CI and human review before reserving or shipping a release."""
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


def check(sha):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Expected full source commit SHA")
    if api("commits/main")["sha"] != sha:
        raise ValueError("Release source is not current main")
    runs = pages(f"actions/runs?head_sha={sha}&event=push", "workflow_runs")
    latest = {}
    for run in sorted(runs, key=lambda r: (r["id"], r["run_attempt"])):
        if run["head_sha"] == sha and run["head_branch"] == "main":
            latest[run["path"]] = run
    for path in REQUIRED:
        if path not in latest or latest[path]["conclusion"] != "success":
            raise ValueError(f"Required checks not successful: {path}")
    for path, run in latest.items():
        if path not in IGNORED and (run["status"] != "completed" or
                                   run["conclusion"] not in ("success", "skipped", "neutral")):
            raise ValueError(f"Source workflow not complete/successful: {path}")
    prs = pages(f"commits/{sha}/pulls")
    eligible = [p for p in prs if p["merged_at"] and p["merge_commit_sha"] == sha
                and p["base"]["ref"] == "main" and p["base"]["repo"]["full_name"] == REPOSITORY]
    if len(eligible) != 1:
        raise ValueError("Source must correspond to one merged main PR")
    pr = api(f"pulls/{eligible[0]['number']}")
    if pr["draft"] or "buzz-review-completed" not in (pr["body"] or ""):
        raise ValueError("PR lacks the repository review and human-test attestation")
    decisions = {}
    for review in sorted(pages(f"pulls/{pr['number']}/reviews"), key=lambda r: r["id"]):
        if review["state"] in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            decisions[review["user"]["login"]] = review
    if any(r["state"] == "CHANGES_REQUESTED" for r in decisions.values()):
        raise ValueError("PR has unresolved changes requested")
    # Buzz agents review through comments. The repository's attestation is
    # the acceptance contract; do not add another human-approval ceremony.
    # When GitHub approvals exist, they must still apply to the current head.
    approvals = [r for r in decisions.values() if r["state"] == "APPROVED"]
    if any(r["commit_id"] != pr["head"]["sha"] for r in approvals):
        raise ValueError("GitHub approval is stale for the PR head")
    if any(r["state"] == "DISMISSED" for r in decisions.values()):
        raise ValueError("Dismissed review must be resolved before release")
    # A main update during evidence collection must not inherit this approval.
    if api("commits/main")["sha"] != sha:
        raise ValueError("Main changed while checking release evidence")
    return {"source_sha": sha, "pull_request": pr["number"],
            "review_ids": [r["id"] for r in approvals],
            "check_run_ids": [latest[p]["id"] for p in sorted(REQUIRED)]}


def release_state(proof, version):
    # Scheduled retries must not rebuild an already-promoted commit.
    releases = pages("releases")
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
    return dict(proof, version=version, already_promoted=str(promoted).lower())


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
    return dict(proof, version=version, already_promoted="false")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "reserve"))
    parser.add_argument("sha")
    args = parser.parse_args()
    result = reserve(args.sha) if args.action == "reserve" else check(args.sha)
    print(json.dumps(result))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key in ("source_sha", "version", "already_promoted"):
                if key in result:
                    output.write(f"{key}={result[key]}\n")
