"""Extract and attest the Linux Buzz CLI bundled in the signed AppImage."""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
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


@contextmanager
def _default_extractor(argv, *, env):
    """Run the release CI extractor without retaining unbounded child output."""
    with tempfile.TemporaryDirectory(prefix="buzz-cli-sidecar-") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        # APPIMAGE_EXTRACT_AND_RUN is set for other steps in this job. Omit it
        # here so the runtime handles the explicit extraction command and never
        # starts the bundled application.
        environment = {**env, "HOME": str(root), "TMPDIR": str(root)}
        result = subprocess.run(
            argv, cwd=root,
            env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False, timeout=900,
        )
        if result.returncode != 0:
            raise ValueError(f"AppImage extraction failed ({result.returncode})")

        yield root


@contextmanager
def _extracted_cli_file(appimage, *, run_extractor=None, destination=None):
    """Inspect actual extracted bytes while the caller's extraction stays alive.

    The caller must verify the AppImage signature first. An optional context
    manager callback runs the exact argv with the supplied minimal environment,
    runs with cwd set to its fresh private scratch directory, overrides HOME
    and TMPDIR to that same directory after allocation, and yields that same
    directory only after successful extraction. It owns process containment,
    cancellation, resource limits and scratch cleanup for its entire context.
    With a callback, the verified image is never chmodded: the caller must
    stage it executable before sealing or mounting it read-only.
    """
    if run_extractor is None:
        # R2 downloads have no POSIX mode; preserve release CI restoration.
        appimage.chmod(0o700)
    environment = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    runner = run_extractor if run_extractor is not None else _default_extractor
    with runner([str(appimage), "--appimage-extract"], env=environment) as temporary:
        root = Path(temporary)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError("Extractor must yield an ordinary private 0700 directory")
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
        if (destination is not None
                and Path(destination).resolve().is_relative_to(root.resolve())):
            raise ValueError("CLI destination must be outside ephemeral extraction scratch")
        yield executable, (relative, digest_file(executable), mode)



def _extracted_cli(appimage):
    """Extract the signature-verified AppImage and return its actual CLI tuple."""
    with _extracted_cli_file(appimage) as (_, identity):
        return identity


def _retain_cli(executable, destination, expected):
    """Copy checked bytes into private caller staging, publishing without replace."""
    destination = Path(destination)
    parent = destination.parent
    parent_info = parent.lstat()
    if (not stat.S_ISDIR(parent_info.st_mode)
            or stat.S_IMODE(parent_info.st_mode) != 0o700):
        raise ValueError("CLI destination parent must be an ordinary private 0700 directory")
    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None

    def same_file(left, right):
        return all(getattr(left, field) == getattr(right, field) for field in (
            "st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns"))

    try:
        if not same_file(os.fstat(parent_fd), parent_info):
            raise ValueError("CLI destination parent changed")
        source_info = executable.lstat()
        source_fd = os.open(executable, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(source_fd, "rb") as source:
            opened = os.fstat(source.fileno())
            if (not stat.S_ISREG(opened.st_mode) or not same_file(opened, source_info)
                    or stat.S_IMODE(opened.st_mode) != 0o755
                    or opened.st_size != expected["size"]):
                raise ValueError("Bundled CLI source changed before retention")
            candidate = ".buzz-cli-" + secrets.token_hex(16)
            output_fd = os.open(candidate, os.O_RDWR | os.O_CREAT | os.O_EXCL,
                                0o600, dir_fd=parent_fd)
            # Cleanup owns this name only after exclusive creation succeeded.
            temporary = candidate
            with os.fdopen(output_fd, "w+b") as output:
                digest = hashlib.sha256()
                size = 0
                while chunk := source.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected["size"] or size > MAX_ARTIFACT:
                        raise ValueError("Bundled CLI exceeds expected size")
                    digest.update(chunk)
                    output.write(chunk)
                if (size != expected["size"] or digest.hexdigest() != expected["sha256"]
                        or not same_file(os.fstat(source.fileno()), opened)):
                    raise ValueError("Bundled CLI changed during retention")
                output.flush()
                os.fchmod(output.fileno(), 0o755)
                output.seek(0)
                readback = hashlib.sha256()
                while chunk := output.read(1024 * 1024):
                    readback.update(chunk)
                retained = os.fstat(output.fileno())
                if (readback.hexdigest() != expected["sha256"]
                        or retained.st_size != expected["size"]
                        or stat.S_IMODE(retained.st_mode) != 0o755):
                    raise ValueError("Retained CLI readback differs")
                os.fsync(output.fileno())
            os.link(temporary, destination.name, src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd, follow_symlinks=False)
            # Atomic no-replace link is the commit point. After it succeeds,
            # cleanup/cancellation errors propagate with the verified destination
            # preserved; callers must reconcile that existing committed file.
        os.unlink(temporary, dir_fd=parent_fd)
        temporary = None
        os.fsync(parent_fd)
    finally:
        try:
            if temporary is not None:
                os.unlink(temporary, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)


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
