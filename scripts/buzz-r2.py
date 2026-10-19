"""Immutable Buzz build artifacts and atomic updater publication in R2.

Install scripts/buzz-r2-requirements.txt on the remote runner. Credentials are
provided through AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, never arguments.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import tempfile
import urllib.request

PUBLIC = "https://buzz-downloads.enrichlayer.com"
ENDPOINT = "https://fc42fab64b7a71c11ced03fee83fe27d.r2.cloudflarestorage.com"
PRIVATE_BUCKET = "buzz-builds"
PUBLIC_BUCKET = "buzz-releases"
MAX_JSON = 1024 * 1024
MAX_ASSET = 4 * 1024**3
spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("enrichlayer-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
spec = importlib.util.spec_from_file_location("minisign", Path(__file__).with_name("enrichlayer-minisign.py"))
minisign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(minisign)
spec = importlib.util.spec_from_file_location("cli_sidecar", Path(__file__).with_name("enrichlayer-cli-sidecar.py"))
cli_sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli_sidecar)

SIDECAR_SUFFIX = ".cli-sidecar.json"


def cli_sidecar_name(version):
    return f"Buzz_{version}_linux-x86_64.AppImage{SIDECAR_SUFFIX}"


def validate_cli_sidecar(receipt, version, source_sha, artifacts, expected_prefix=None):
    """Validate the receipt against immutable release-catalog artifact hashes."""
    if set(receipt) != {
        "schema_version", "kind", "repository", "version", "source_sha",
        "platform", "build", "installer", "signature", "executable",
    }:
        raise ValueError("CLI sidecar has unexpected fields")
    if (receipt["schema_version"] != 1
            or receipt["kind"] != "enrichlayer-buzz-cli-sidecar"
            or receipt["repository"] != "enrichlayer/buzz"
            or receipt["platform"] != "linux-x86_64"
            or receipt["version"] != version
            or receipt["source_sha"] != source_sha
            or not re.fullmatch(r"[a-f0-9]{40}", source_sha)):
        raise ValueError("CLI sidecar release identity mismatch")

    build = receipt["build"]
    if set(build) != {"workflow_ref", "workflow_sha", "run_id", "run_attempt", "r2_prefix"}:
        raise ValueError("CLI sidecar build identity has unexpected fields")
    if (not isinstance(build["workflow_ref"], str)
            or build["workflow_ref"] != (
            "enrichlayer/buzz/.github/workflows/enrichlayer-auto-release.yml@refs/heads/main")
            or not isinstance(build["workflow_sha"], str)
            or not re.fullmatch(r"[a-f0-9]{40}", build["workflow_sha"])
            or build["workflow_sha"] != source_sha
            or not isinstance(build["run_id"], str)
            or not re.fullmatch(r"[1-9][0-9]*", build["run_id"])
            or not isinstance(build["run_attempt"], str)
            or not re.fullmatch(r"[1-9][0-9]*", build["run_attempt"])):
        raise ValueError("CLI sidecar was not produced by the release workflow")
    prefix = f"desktop/{source_sha}/{build['run_id']}/{build['run_attempt']}/linux-x86_64"
    if build["r2_prefix"] != prefix or (expected_prefix is not None and prefix != expected_prefix):
        raise ValueError("CLI sidecar build prefix mismatch")

    installer_name = updater.asset_name(version, "linux-x86_64")
    signature_name = installer_name + ".sig"
    installer = receipt["installer"]
    signature = receipt["signature"]
    if set(installer) != {"filename", "sha256", "size"} or set(signature) != {
            "filename", "sha256", "size", "updater_public_key_sha256"}:
        raise ValueError("CLI sidecar artifact records have unexpected fields")
    if installer["filename"] != installer_name or signature["filename"] != signature_name:
        raise ValueError("CLI sidecar artifact filename mismatch")
    for name, record in ((installer_name, installer), (signature_name, signature)):
        expected = artifacts.get(name)
        if (not expected or set(expected) != {"sha256", "size"}
                or record["sha256"] != expected["sha256"]
                or record["size"] != expected["size"]):
            raise ValueError(f"CLI sidecar does not match release artifact: {name}")
    key_digest = hashlib.sha256(minisign.pinned_public_key().encode()).hexdigest()
    if signature["updater_public_key_sha256"] != key_digest:
        raise ValueError("CLI sidecar uses a different updater key")

    executable = receipt["executable"]
    if set(executable) != {"path", "sha256", "size", "mode"}:
        raise ValueError("CLI sidecar executable record has unexpected fields")
    path = executable["path"]
    if (not isinstance(path, str) or path != posixpath.normpath(path)
            or path.startswith("/") or path in ("", ".") or ".." in path.split("/")
            or executable["mode"] != "0755"
            or not re.fullmatch(r"[a-f0-9]{64}", executable["sha256"])
            or not isinstance(executable["size"], int) or executable["size"] <= 0):
        raise ValueError("CLI sidecar executable identity is invalid")
    return receipt


def validate_cli_sidecar_directory(directory, version, source_sha, expected_prefix=None):
    name = cli_sidecar_name(version)
    sidecar_path = directory / name
    if sidecar_path.is_symlink() or not sidecar_path.is_file():
        raise ValueError("Release lacks the Linux CLI sidecar")
    if sidecar_path.stat().st_size > MAX_JSON:
        raise ValueError("CLI sidecar exceeds size limit")
    data = sidecar_path.read_bytes()
    receipt = json.loads(data)
    artifacts = {}
    for artifact_name in (updater.asset_name(version, "linux-x86_64"),
                          updater.asset_name(version, "linux-x86_64") + ".sig"):
        artifact_path = directory / artifact_name
        if artifact_path.is_symlink() or not artifact_path.is_file():
            raise ValueError(f"Release lacks ordinary Linux artifact: {artifact_name}")
        with artifact_path.open("rb") as stream:
            artifacts[artifact_name] = digest(stream)
    validate_cli_sidecar(receipt, version, source_sha, artifacts, expected_prefix)
    image_name = updater.asset_name(version, "linux-x86_64")
    signature_path = directory / (image_name + ".sig")
    if signature_path.stat().st_size > cli_sidecar.MAX_SIGNATURE:
        raise ValueError("Updater signature exceeds size limit")
    with (directory / image_name).open("rb") as stream:
        minisign.verify_stream(minisign.pinned_public_key(),
                               signature_path.read_text().strip(), stream)
    verify_cli_sidecar_executable(receipt, directory / image_name)
    return receipt


def verify_cli_sidecar_executable(receipt, image_path, *, destination=None,
                                  run_extractor=None):
    """Compare actual CLI bytes to a receipt, optionally retaining a checked copy.

    This is not signature or receipt authentication: callers must first verify
    the AppImage's pinned updater signature and validate receipt provenance.
    The optional extraction context owns all consumer containment and cleanup;
    see cli_sidecar._extracted_cli_file for its callback contract. Destination
    is an absent filename inside the caller's existing private staging folder,
    outside ephemeral extraction scratch. Retention requires run_extractor so
    consumer containment can never fall back to the release CI extractor.
    Returns None, including when a copy is retained. Before the atomic no-replace
    link, failure leaves no destination. After that commit point, cleanup errors
    (including callback cancellation) propagate and preserve the verified copy;
    callers must reconcile the existing destination before any retry.
    """
    if destination is not None and run_extractor is None:
        raise ValueError("CLI destination requires run_extractor for consumer containment")

    def compare(identity):
        path, executable_digest, mode = identity
        actual = {"path": path, **executable_digest, "mode": f"{mode:04o}"}
        if actual != receipt["executable"]:
            raise ValueError("CLI sidecar executable differs from the signed AppImage")

    if destination is None and run_extractor is None:
        compare(cli_sidecar._extracted_cli(image_path.resolve()))
        return
    with cli_sidecar._extracted_cli_file(
            image_path.resolve(), run_extractor=run_extractor,
            destination=destination) as (executable, identity):
        compare(identity)
        if destination is not None:
            cli_sidecar._retain_cli(executable, destination, receipt["executable"])


def download_verified_artifact(store, key, expected, destination):
    """Download one bounded immutable object and verify its catalog digest."""
    response = store.get(key)
    if response is None:
        raise ValueError(f"Missing release artifact: {key}")
    size = 0
    hasher = hashlib.sha256()
    with response["Body"] as source, destination.open("xb") as output:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ASSET:
                raise ValueError("Artifact exceeds 4 GiB limit")
            hasher.update(chunk)
            output.write(chunk)
    if {"sha256": hasher.hexdigest(), "size": size} != expected:
        raise ValueError(f"Release artifact checksum mismatch: {key}")


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def digest(stream):
    hasher = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_ASSET:
            raise ValueError("Artifact exceeds 4 GiB limit")
        hasher.update(chunk)
    return {"sha256": hasher.hexdigest(), "size": size}


class Store:
    def __init__(self, bucket):
        import boto3
        from botocore.config import Config
        self.bucket = bucket
        self.client = boto3.client("s3", endpoint_url=ENDPOINT, region_name="auto",
                                   config=Config(connect_timeout=15, read_timeout=120,
                                                 retries={"max_attempts": 3},
                                                 request_checksum_calculation="when_required",
                                                 response_checksum_validation="when_required"))

    def get(self, key):
        from botocore.exceptions import ClientError
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if error.response["Error"]["Code"] == "NoSuchKey":
                return None
            raise

    def document(self, key):
        response = self.get(key)
        if response is None:
            return None, None
        with response["Body"] as stream:
            data = stream.read(MAX_JSON + 1)
        if len(data) > MAX_JSON:
            raise ValueError("Document exceeds size limit")
        return data, response["ETag"]

    def put(self, key, body, *, etag=None, immutable=True):
        condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        content_type = "application/json" if key.endswith(".json") else "application/octet-stream"
        return self.client.put_object(Bucket=self.bucket, Key=key, Body=body,
                                      ContentType=content_type,
                                      CacheControl="public,max-age=31536000,immutable" if immutable else "no-store",
                                      **condition)

    def file(self, key, path):
        with path.open("rb") as stream:
            expected = digest(stream)
        if not expected["size"]:
            raise ValueError("Empty artifact")
        old = self.get(key)
        if old is None:
            with path.open("rb") as stream:
                self.put(key, stream)
        if old is not None:
            old["Body"].close()
        self.verify(key, expected)
        return expected

    def verify(self, key, expected):
        response = self.get(key)
        if response is None:
            raise ValueError(f"Missing artifact: {key}")
        with response["Body"] as stream:
            actual = digest(stream)
        if actual != expected:
            raise ValueError(f"Artifact checksum mismatch: {key}")

    def immutable_document(self, key, data):
        old, _ = self.document(key)
        if old is None:
            self.put(key, data)
        elif old != data:
            raise ValueError(f"Immutable document differs: {key}")
        if self.document(key)[0] != data:
            raise ValueError(f"Document readback mismatch: {key}")


def public_verify(key, expected):
    request = urllib.request.Request(f"{PUBLIC}/{key}", headers={
        "Cache-Control": "no-cache",
        "User-Agent": "EnrichLayer-Buzz-Release/1.0",
    })
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.geturl() != f"{PUBLIC}/{key}":
            raise ValueError("Unexpected artifact redirect")
        actual = digest(response)
    if actual != expected:
        raise ValueError(f"Public download checksum mismatch: {key}")


def upload(store, prefix, directory):
    if not re.fullmatch(r"[a-zA-Z0-9/_.-]+", prefix) or ".." in prefix:
        raise ValueError("Invalid build prefix")
    files = sorted(directory.iterdir())
    if not files or len(files) > 100:
        raise ValueError("Expected 1 to 100 artifacts")
    catalog = {}
    for path in files:
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r"[a-zA-Z0-9_.-]+", path.name):
            raise ValueError("Expected ordinary artifact files")
        catalog[path.name] = store.file(f"{prefix}/{path.name}", path)
    store.immutable_document(f"{prefix}/artifacts.json", encode(catalog))
    return catalog


def fetch(store, prefix, directory):
    data, _ = store.document(f"{prefix}/artifacts.json")
    if data is None:
        raise ValueError("Build has no completed artifact catalog")
    catalog = json.loads(data)
    if not catalog or len(catalog) > 100:
        raise ValueError("Invalid artifact catalog")
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in catalog.items():
        if not re.fullmatch(r"[a-zA-Z0-9_.-]+", name) or name in (".", ".."):
            raise ValueError("Invalid artifact name")
        key = expected.get("key", f"{prefix}/{name}")
        if key not in (f"{prefix}/{name}", f"{prefix}/{expected['sha256']}/{name}"):
            raise ValueError("Artifact key escapes its build identity")
        response = store.get(key)
        if response is None:
            raise ValueError("Missing build artifact")
        path = directory / name
        # Never silently replace another platform's output.
        if path.exists():
            raise ValueError(f"Duplicate artifact: {name}")
        with response["Body"] as source, path.open("xb") as output:
            size = 0
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_ASSET:
                    raise ValueError("Artifact exceeds size limit")
                output.write(chunk)
        with path.open("rb") as stream:
            if digest(stream) != {"sha256": expected["sha256"], "size": expected["size"]}:
                raise ValueError("Downloaded artifact checksum mismatch")


def stage_release(store, version, directory, sha, prefixes):
    """Pin the first complete build set so new workflow runs reuse identical bytes."""
    updater.version_tuple(version)
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Expected full source commit SHA")
    key = f"release-inputs/{version}.json"
    prior, _ = store.document(key)
    receipt = json.loads(prior) if prior else {"sha": sha, "prefixes": prefixes}
    if receipt["sha"] != sha or len(receipt["prefixes"]) != len(updater.PLATFORMS):
        raise ValueError("Release build receipt has wrong source or platform count")
    platforms = set()
    linux_prefix = None
    for prefix in receipt["prefixes"]:
        match = re.fullmatch(r"desktop/([a-f0-9]{40})/[0-9]+/[0-9]+/([a-z0-9_-]+)", prefix)
        if not match or match[1] != sha or match[2] in platforms:
            raise ValueError("Release build prefix has wrong identity")
        platforms.add(match[2])
        if match[2] == "linux-x86_64":
            linux_prefix = prefix
        fetch(store, prefix, directory)
    if platforms != set(updater.PLATFORMS):
        raise ValueError("Release build receipt lacks a platform")
    updater.manifest(version, directory)
    require_installers(version, {path.name for path in directory.iterdir()})
    validate_cli_sidecar_directory(directory, version, sha, linux_prefix)
    store.immutable_document(key, encode(receipt))


def require_installers(version, names):
    installers = {f"Buzz_{version}_darwin-{arch}.dmg" for arch in ("aarch64", "x86_64")}
    installers.update(updater.asset_name(version, p) for p in ("windows-x86_64", "linux-x86_64"))
    installers.add(cli_sidecar_name(version))
    if not installers <= names:
        raise ValueError("Release lacks a team installer")


def publish(store, version, directory, sha):
    updater.version_tuple(version)
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Expected full source commit SHA")
    prefix = f"releases/{version}"
    # Stable manifest bytes make retries after any partial upload idempotent.
    candidate = updater.manifest(version, directory)
    require_installers(version, {path.name for path in directory.iterdir()})
    validate_cli_sidecar_directory(directory, version, sha)
    candidate.pop("pub_date", None)
    # Never publish an archive the pinned updater key did not sign.
    key = minisign.pinned_public_key()
    for platform in updater.PLATFORMS:
        name = updater.asset_name(version, platform)
        with (directory / name).open("rb") as stream:
            minisign.verify_stream(key, candidate["platforms"][platform]["signature"], stream)
    data = encode(candidate)
    catalog = upload(store, prefix, directory)
    for name, expected in catalog.items():
        public_verify(f"{prefix}/{name}", expected)
    store.immutable_document(f"{prefix}/updater-manifest.json", data)
    store.immutable_document(f"{prefix}/release.json", encode({"sha": sha, "artifacts": catalog}))


def promote(store, version):
    updater.version_tuple(version)
    prefix = f"releases/{version}"
    ready, _ = store.document(f"{prefix}/release.json")
    data, _ = store.document(f"{prefix}/updater-manifest.json")
    if ready is None or data is None:
        raise ValueError("Release is incomplete")
    release = json.loads(ready)
    sha = updater.gh("api", f"repos/{updater.REPOSITORY}/commits/el-desktop-v{version}", "--jq", ".sha").strip()
    if release["sha"] != sha:
        raise ValueError("Release does not match source tag")
    candidate = json.loads(data)
    updater.validate(candidate, version, set(release["artifacts"]))
    require_installers(version, set(release["artifacts"]))
    sidecar_name = cli_sidecar_name(version)
    sidecar_data, _ = store.document(f"{prefix}/{sidecar_name}")
    if sidecar_data is None:
        raise ValueError("Release is missing its Linux CLI sidecar")
    if hashlib.sha256(sidecar_data).hexdigest() != release["artifacts"][sidecar_name]["sha256"]:
        raise ValueError("Linux CLI sidecar differs from the immutable release catalog")
    sidecar = validate_cli_sidecar(json.loads(sidecar_data), version, release["sha"], release["artifacts"])
    linux_name = updater.asset_name(version, "linux-x86_64")
    with tempfile.TemporaryDirectory(prefix="buzz-r2-cli-verify-") as temporary:
        image_path = Path(temporary) / linux_name
        signature_path = Path(temporary) / (linux_name + ".sig")
        download_verified_artifact(
            store, f"{prefix}/{linux_name}", release["artifacts"][linux_name], image_path)
        download_verified_artifact(
            store, f"{prefix}/{linux_name}.sig", release["artifacts"][linux_name + ".sig"],
            signature_path)
        with image_path.open("rb") as stream:
            minisign.verify_stream(minisign.pinned_public_key(),
                                   signature_path.read_text().strip(), stream)
        verify_cli_sidecar_executable(sidecar, image_path)
    for platform in updater.PLATFORMS:
        name = updater.asset_name(version, platform)
        sig, _ = store.document(f"{prefix}/{name}.sig")
        if sig is None or sig.decode().strip() != candidate["platforms"][platform]["signature"]:
            raise ValueError("Signature differs from manifest")
    for name, expected in release["artifacts"].items():
        store.verify(f"{prefix}/{name}", expected)
        public_verify(f"{prefix}/{name}", expected)
    # Hashes only prove the bytes are unchanged since publish; the pinned key
    # proves they came from our signer even if release storage was tampered with.
    key = minisign.pinned_public_key()
    for platform in updater.PLATFORMS:
        response = store.get(f"{prefix}/{updater.asset_name(version, platform)}")
        if response is None:
            raise ValueError("Missing release archive")
        with response["Body"] as stream:
            minisign.verify_stream(key, candidate["platforms"][platform]["signature"], stream)
    previous, etag = store.document("latest.json")
    if previous is not None:
        prior = json.loads(previous)
        if updater.version_tuple(prior["version"]) > updater.version_tuple(version):
            raise ValueError("Refusing updater downgrade")
        if prior["version"] == version:
            if previous != data:
                raise ValueError("Same version has a different manifest")
            public_verify("latest.json", {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
            return
    store.immutable_document(f"promotions/{version}.json", data)
    # Atomic conditional replacement retains the previous feed on failure and
    # rejects a concurrent promoter. No delete-then-upload gap exists.
    store.put("latest.json", data, etag=etag, immutable=False)
    if store.document("latest.json")[0] != data:
        raise ValueError("Feed readback mismatch")
    public_verify("latest.json", {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("upload-build", "fetch-build", "publish", "promote", "stage-release"))
    parser.add_argument("ref")
    parser.add_argument("directory", type=Path, nargs="?", default=Path("staged"))
    args = parser.parse_args()
    store = Store(PRIVATE_BUCKET if args.action.endswith("build") or args.action == "stage-release" else PUBLIC_BUCKET)
    if args.action == "upload-build":
        upload(store, args.ref, args.directory)
    elif args.action == "fetch-build":
        fetch(store, args.ref, args.directory)
    elif args.action == "stage-release":
        stage_release(store, args.ref, args.directory, os.environ["SOURCE_SHA"], json.loads(os.environ["BUILD_PREFIXES"]))
    elif args.action == "publish":
        publish(store, args.ref, args.directory, os.environ["GITHUB_SHA"])
    else:
        promote(store, args.ref)
