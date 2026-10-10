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
import re
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
    request = urllib.request.Request(f"{PUBLIC}/{key}", headers={"Cache-Control": "no-cache"})
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


def publish(store, version, directory, sha):
    updater.version_tuple(version)
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Expected full source commit SHA")
    prefix = f"releases/{version}"
    # Stable manifest bytes make retries after any partial upload idempotent.
    candidate = updater.manifest(version, directory)
    candidate.pop("pub_date", None)
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
    for platform in updater.PLATFORMS:
        name = f"Buzz_{version}_{platform}.app.tar.gz"
        sig, _ = store.document(f"{prefix}/{name}.sig")
        if sig is None or sig.decode().strip() != candidate["platforms"][platform]["signature"]:
            raise ValueError("Signature differs from manifest")
    for name, expected in release["artifacts"].items():
        store.verify(f"{prefix}/{name}", expected)
        public_verify(f"{prefix}/{name}", expected)
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
    parser.add_argument("action", choices=("upload-build", "fetch-build", "publish", "promote"))
    parser.add_argument("ref")
    parser.add_argument("directory", type=Path, nargs="?", default=Path("staged"))
    args = parser.parse_args()
    store = Store(PRIVATE_BUCKET if args.action.endswith("build") else PUBLIC_BUCKET)
    if args.action == "upload-build":
        upload(store, args.ref, args.directory)
    elif args.action == "fetch-build":
        fetch(store, args.ref, args.directory)
    elif args.action == "publish":
        publish(store, args.ref, args.directory, os.environ["GITHUB_SHA"])
    else:
        promote(store, args.ref)
