"""Hydrate a screened immutable Factory source on a remote native runner.

The trusted workflow checkout owns this helper and the private R2 transfer.
Source code runs only after commit, tree and transport checks succeed.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess
import tempfile


MAX_PACK = 512 * 1024**2
MAX_TREE = 1024**3
MAX_OUTPUT = 32 * 1024**2
FIELDS = (
    "repo",
    "branch",
    "workspaceId",
    "generation",
    "seq",
    "commitSha",
    "treeDigest",
    "bundleDigest",
    "packDigest",
)


def request_digest(request):
    """Match the operator's canonical source and workflow policy digest."""
    if set(request) != {"subject", "policy"}:
        raise ValueError("Unexpected request fields")
    subject, policy = request["subject"], request["policy"]
    if set(subject) != set(FIELDS) or set(policy) != {"workflowId", "workflowSha"}:
        raise ValueError("Unexpected subject or policy fields")
    if subject["repo"] != "enrichlayer/buzz":
        raise ValueError("Unregistered source repository")
    branch = subject["branch"]
    if (
        not isinstance(branch, str)
        or not re.fullmatch(r"[-a-zA-Z0-9_./]{1,255}", branch)
        or branch in ("main", "master", "HEAD")
        or ".." in branch
    ):
        raise ValueError("Invalid source branch")
    for key, size in (
        ("workspaceId", 64),
        ("commitSha", 40),
        ("treeDigest", 64),
        ("bundleDigest", 64),
        ("packDigest", 64),
    ):
        if not isinstance(subject[key], str) or not re.fullmatch(
            f"[a-f0-9]{{{size}}}", subject[key]
        ):
            raise ValueError(f"Invalid source {key}")
    for value in (subject["generation"], subject["seq"], policy["workflowId"]):
        if type(value) is not int or not 0 < value <= 9007199254740991:
            raise ValueError("Invalid source generation, sequence or workflow")
    if not isinstance(policy["workflowSha"], str) or not re.fullmatch(
        "[a-f0-9]{40}", policy["workflowSha"]
    ):
        raise ValueError("Invalid workflow source")
    canonical = {"version": 1, **{key: subject[key] for key in FIELDS}, **policy}
    # Policy order is canonical even when the stored object's keys are reordered.
    canonical["workflowId"] = policy["workflowId"]
    canonical["workflowSha"] = policy["workflowSha"]
    ordered = {
        key: canonical[key] for key in ("version", *FIELDS, "workflowId", "workflowSha")
    }
    return hashlib.sha256(
        json.dumps(ordered, separators=(",", ":")).encode()
    ).hexdigest()


def git(directory, *args, stdin=None, file_limit=MAX_OUTPUT):
    """Bound command duration, diagnostic files and filesystem output."""

    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))

    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    # Do not permit inherited Git routing to address the control checkout.
    for key in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ):
        env.pop(key, None)
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        result = subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "-C", str(directory), *args],
            stdin=stdin,
            stdout=out,
            stderr=err,
            timeout=120,
            env=env,
            preexec_fn=limits,
        )
        out.seek(0)
        data = out.read(MAX_OUTPUT + 1)
        if len(data) > MAX_OUTPUT:
            raise ValueError("Git source output exceeds bound")
        if result.returncode:
            err.seek(0)
            raise ValueError(
                f"Git source verification failed: {err.read(2000).decode(errors='replace')}"
            )
        return data


def hydrate_pack(pack, directory, subject):
    """Verify a tree-only Git pack before checking out any source files."""
    if pack.stat().st_size > MAX_PACK:
        raise ValueError("Source pack exceeds bound")
    with pack.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != subject["packDigest"]:
            raise ValueError("Source pack digest mismatch")
    directory.mkdir()
    git(directory, "init", "--quiet")
    with pack.open("rb") as stream:
        git(directory, "index-pack", "--stdin", stdin=stream, file_limit=2 * MAX_PACK)
    commit = subject["commitSha"]
    if git(directory, "cat-file", "-t", commit).strip() != b"commit":
        raise ValueError("Admitted source is not a commit")
    (directory / ".git/shallow").write_text(commit + "\n")
    tree = git(directory, "ls-tree", "-r", "-z", "--full-tree", commit)
    if hashlib.sha256(tree).hexdigest() != subject["treeDigest"]:
        raise ValueError("Source tree digest mismatch")
    entries = git(directory, "ls-tree", "-r", "-l", "-z", "--full-tree", commit).split(
        b"\0"
    )
    if len(entries) > 100001:
        raise ValueError("Source file count exceeds bound")
    size = 0
    for entry in filter(None, entries):
        metadata = entry.split(b"\t", 1)[0].split()
        if metadata[1] != b"blob":
            raise ValueError("Source submodules are not admitted")
        size += int(metadata[3])
        if size > MAX_TREE:
            raise ValueError("Expanded source exceeds bound")
    git(directory, "checkout", "--quiet", "--detach", commit, file_limit=MAX_TREE)
    if git(directory, "status", "--porcelain").strip():
        raise ValueError("Hydrated source is not clean")


def r2_module():
    spec = importlib.util.spec_from_file_location(
        "buzz_r2", Path(__file__).with_name("buzz-r2.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def store():
    return r2_module().Store("buzz-builds")


def publish_results(directory, digest, run_id, attempt):
    """Fresh trusted job: validate opaque artifact paths before loading credentials."""
    if not re.fullmatch("[a-f0-9]{64}", digest) or not all(
        re.fullmatch(r"[1-9][0-9]*", value) for value in (run_id, attempt)
    ):
        raise ValueError("Invalid native publication identity")
    native_files = {
        "Buzz-validation.app.tar.gz",
        "buzz-cli-macos.tar.gz",
        "native-validation.log",
        "native-packaging.log",
    }
    lanes = {
        "macos-15": native_files,
        "macos-15-intel": native_files,
        "mobile": {"mobile-validation.log"},
    }
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Invalid native result directory")
    if {path.name for path in directory.iterdir()} != {
        f"source-result-{lane}" for lane in lanes
    }:
        raise ValueError("Unexpected native result set")
    for lane, names in lanes.items():
        folder = directory / f"source-result-{lane}"
        if (
            folder.is_symlink()
            or not folder.is_dir()
            or {path.name for path in folder.iterdir()} != names
        ):
            raise ValueError("Unexpected native artifact set")
        for path in folder.iterdir():
            if path.is_symlink() or not path.is_file():
                raise ValueError("Native artifacts must be ordinary files")
    module = r2_module()
    storage = module.Store("buzz-builds")
    for lane in lanes:
        prefix = f"source-validation/{digest}/{run_id}/{attempt}/{lane}"
        module.upload(storage, prefix, directory / f"source-result-{lane}")
        module.fetch(storage, prefix, directory.parent / "verified" / lane)


def admitted_request(data, digest, workspace):
    if not re.fullmatch("[a-f0-9]{64}", digest) or data is None or len(data) > 16384:
        raise ValueError("Missing or invalid admitted source request")
    request = json.loads(data)
    if request_digest(request) != digest:
        raise ValueError("Admitted source request digest mismatch")
    control_sha = request["policy"]["workflowSha"]
    if git(workspace, "rev-parse", "HEAD").decode().strip() != control_sha:
        raise ValueError("Validation control checkout is not the admitted workflow")
    if os.environ.get("GITHUB_SHA") != control_sha:
        raise ValueError("Workflow execution source mismatch")
    return request


def prepare(digest, destination, workspace):
    """Credential-bearing transfer runs only in a fresh job that executes no source."""
    if not re.fullmatch("[a-f0-9]{64}", digest):
        raise ValueError("Invalid request digest")
    storage = store()
    data, _ = storage.document(f"native-source/v1/{digest}/request.json")
    request = admitted_request(data, digest, workspace)
    destination.mkdir()
    response = storage.get(
        f"native-source/v1/objects/{request['subject']['packDigest']}.pack"
    )
    if response is None:
        raise ValueError("Admitted source pack is absent")
    size = 0
    with response["Body"] as stream, (destination / "source.pack").open("wb") as output:
        while chunk := stream.read(1024**2):
            size += len(chunk)
            if size > MAX_PACK:
                raise ValueError("Source pack exceeds bound")
            output.write(chunk)
    with tempfile.TemporaryDirectory(
        prefix="buzz-source-check-", dir=destination.parent
    ) as temporary:
        hydrate_pack(
            destination / "source.pack", Path(temporary) / "source", request["subject"]
        )
    (destination / "request.json").write_bytes(data)


def install(digest, inputs, workspace, runner_temp):
    """No storage credentials or network: consume the preparation job's artifact."""
    control = runner_temp / "buzz-native-control"
    if control.exists() or workspace.is_symlink() or not (workspace / ".git").is_dir():
        raise ValueError("Native control/source directories are not fresh")
    with (inputs / "request.json").open("rb") as stream:
        data = stream.read(16385)
    request = admitted_request(data, digest, workspace)
    with tempfile.TemporaryDirectory(
        prefix="buzz-native-hydration-", dir=runner_temp
    ) as temporary:
        source = Path(temporary) / "source"
        hydrate_pack(inputs / "source.pack", source, request["subject"])
        workspace.rename(control)
        try:
            source.rename(workspace)
        except BaseException:
            control.rename(workspace)
            raise
    print(f"Hydrated admitted source {request['subject']['commitSha']} for {digest}")


def cleanup(workspace, runner_temp, required=False):
    control = runner_temp / "buzz-native-control"
    if not control.exists():
        if required:
            raise ValueError("Hydrated source lost its control checkout")
        return
    if (
        control.is_symlink()
        or not (control / ".git").is_dir()
        or workspace.is_symlink()
    ):
        raise ValueError("Native cleanup custody mismatch")
    if workspace.exists():
        shutil.rmtree(workspace)
    control.rename(workspace)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "install", "cleanup", "publish"))
    parser.add_argument("digest", nargs="?")
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--required", action="store_true")
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit(
            "Native source hydration requires the registered remote workflow"
        )
    root = Path(os.environ["GITHUB_WORKSPACE"]).absolute()
    temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    if args.action == "prepare":
        if args.inputs is None:
            raise SystemExit("prepare requires --inputs")
        prepare(args.digest or "", args.inputs, root)
    elif args.action == "install":
        if args.inputs is None:
            raise SystemExit("install requires --inputs")
        install(args.digest or "", args.inputs, root, temp)
    elif args.action == "publish":
        if args.inputs is None:
            raise SystemExit("publish requires --inputs")
        publish_results(
            args.inputs,
            args.digest or "",
            os.environ["GITHUB_RUN_ID"],
            os.environ["GITHUB_RUN_ATTEMPT"],
        )
    else:
        cleanup(root, temp, required=args.required)
