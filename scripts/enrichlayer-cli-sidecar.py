"""Extract and attest the Linux Buzz CLI bundled in the signed AppImage."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile

MAX_ARTIFACT = 4 * 1024**3
MAX_SIGNATURE = 64 * 1024
MAX_RECEIPT = 1024 * 1024
REPOSITORY = "enrichlayer/buzz"
PLATFORM = "linux-x86_64"
WORKFLOW_REFS = {
    f"{REPOSITORY}/.github/workflows/enrichlayer-auto-release.yml@refs/heads/main",
    f"{REPOSITORY}/.github/workflows/macos-intel-canary.yml@refs/heads/main",
}

spec = importlib.util.spec_from_file_location(
    "minisign", Path(__file__).with_name("enrichlayer-minisign.py"))
minisign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(minisign)


def digest_file(path):
    """Hash a regular non-symlink file without loading it into memory."""
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Expected an ordinary file: {path.name}")
    if info.st_size <= 0 or info.st_size > MAX_ARTIFACT:
        raise ValueError(f"File size outside release limit: {path.name}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT:
                raise ValueError(f"File exceeds release limit: {path.name}")
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size": size}


def _extracted_cli(appimage):
    """Extract, but never launch, the verified AppImage and find one CLI binary."""
    # R2 stores bytes without POSIX mode. Callers have verified the ordinary
    # file's updater signature; restore owner-only execution for its extractor.
    appimage.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="buzz-cli-sidecar-") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        log_path = root / "extract.log"
        # APPIMAGE_EXTRACT_AND_RUN is set for other steps in this job. Omit it
        # here so the runtime handles the explicit extraction command and never
        # starts the bundled application.
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(root),
            "TMPDIR": str(root),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
        with log_path.open("wb") as log:
            result = subprocess.run(
                [str(appimage), "--appimage-extract"], cwd=root,
                env=environment, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT,
                check=False, timeout=900,
            )
        if result.returncode != 0:
            with log_path.open("rb") as log:
                log.seek(max(0, log_path.stat().st_size - 4096))
                detail = log.read(4096).decode("utf-8", "replace")
            raise ValueError(f"AppImage extraction failed ({result.returncode}): {detail}")

        extracted = root / "squashfs-root"
        if not extracted.is_dir() or extracted.is_symlink():
            raise ValueError("AppImage did not produce a fresh squashfs-root directory")
        candidates = []
        for directory, names, files in os.walk(extracted, followlinks=False):
            base = Path(directory)
            names[:] = [name for name in names if not (base / name).is_symlink()]
            for name in files:
                if name != "buzz":
                    continue
                candidate = base / name
                info = candidate.lstat()
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("AppImage contains a non-regular `buzz` entry")
                candidates.append(candidate)
        if len(candidates) != 1:
            raise ValueError(f"Expected one regular `buzz` executable, found {len(candidates)}")

        executable = candidates[0]
        info = executable.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if mode != 0o755:
            raise ValueError(f"Expected bundled CLI mode 0755, got {mode:04o}")
        relative = executable.relative_to(extracted).as_posix()
        relative_path = PurePosixPath(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise ValueError("Bundled CLI path escapes the AppImage root")
        return relative, digest_file(executable), mode


def create_receipt(*, version, source_sha, run_id, run_attempt,
                   workflow_ref, workflow_sha, build_prefix,
                   artifact_path, signature_path, output_path):
    """Verify the existing updater signature, then attest the embedded CLI."""
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Version must be stable X.Y.Z")
    if not re.fullmatch(r"[a-f0-9]{40}", source_sha):
        raise ValueError("Expected full lowercase source commit SHA")
    if not re.fullmatch(r"[1-9][0-9]*", run_id) or not re.fullmatch(r"[1-9][0-9]*", run_attempt):
        raise ValueError("Expected positive GitHub run ID and attempt")
    if not re.fullmatch(r"[a-f0-9]{40}", workflow_sha):
        raise ValueError("Expected full workflow commit SHA")
    if workflow_sha != source_sha:
        raise ValueError("Release workflow and artifact source must be the same commit")
    if workflow_ref not in WORKFLOW_REFS:
        raise ValueError("Caller workflow must be an approved Enrich Layer Buzz main workflow")

    expected_prefix = f"desktop/{source_sha}/{run_id}/{run_attempt}/{PLATFORM}"
    if build_prefix != expected_prefix:
        raise ValueError("Build prefix differs from source/run/platform identity")
    expected_name = f"Buzz_{version}_{PLATFORM}.AppImage"
    if artifact_path.name != expected_name:
        raise ValueError(f"Expected Linux updater artifact {expected_name}")
    if signature_path.name != expected_name + ".sig":
        raise ValueError("Updater signature filename does not match its AppImage")
    if artifact_path.is_symlink() or signature_path.is_symlink():
        raise ValueError("AppImage and updater signature must not be symlinks")
    artifact_digest = digest_file(artifact_path)
    signature_digest = digest_file(signature_path)
    if signature_digest["size"] > MAX_SIGNATURE:
        raise ValueError("Updater signature exceeds size limit")

    public_key = minisign.pinned_public_key()
    signature_text = signature_path.read_bytes().decode("utf-8").strip()
    with artifact_path.open("rb") as stream:
        minisign.verify_stream(public_key, signature_text, stream)

    executable_path, executable_digest, mode = _extracted_cli(artifact_path.resolve())
    receipt = {
        "schema_version": 1,
        "kind": "enrichlayer-buzz-cli-sidecar",
        "repository": REPOSITORY,
        "version": version,
        "source_sha": source_sha,
        "platform": PLATFORM,
        "build": {
            "workflow_ref": workflow_ref,
            "workflow_sha": workflow_sha,
            "run_id": run_id,
            "run_attempt": run_attempt,
            "r2_prefix": build_prefix,
        },
        "installer": {
            "filename": expected_name,
            **artifact_digest,
        },
        "signature": {
            "filename": expected_name + ".sig",
            **signature_digest,
            "updater_public_key_sha256": hashlib.sha256(public_key.encode()).hexdigest(),
        },
        "executable": {
            "path": executable_path,
            **executable_digest,
            "mode": f"{mode:04o}",
        },
    }
    data = (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()
    if len(data) > MAX_RECEIPT:
        raise ValueError("CLI sidecar receipt exceeds size limit")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("xb") as output:
        output.write(data)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("source_sha")
    parser.add_argument("run_id")
    parser.add_argument("run_attempt")
    parser.add_argument("workflow_ref")
    parser.add_argument("workflow_sha")
    parser.add_argument("build_prefix")
    parser.add_argument("artifact", type=Path)
    parser.add_argument("signature", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    create_receipt(
        version=args.version, source_sha=args.source_sha, run_id=args.run_id,
        run_attempt=args.run_attempt, workflow_ref=args.workflow_ref,
        workflow_sha=args.workflow_sha, build_prefix=args.build_prefix,
        artifact_path=args.artifact, signature_path=args.signature,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
