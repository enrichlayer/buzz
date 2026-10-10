"""Build and promote the Enrich Layer desktop updater feed."""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import tempfile

REPOSITORY = "enrichlayer/buzz"
PLATFORMS = {
    "darwin-aarch64": ".app.tar.gz", "darwin-x86_64": ".app.tar.gz",
    "linux-x86_64": ".AppImage", "windows-x86_64": "-setup.exe",
}


def asset_name(version, platform):
    return f"Buzz_{version}_{platform}{PLATFORMS[platform]}"

ROLLING = "buzz-desktop-latest"


def version_tuple(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("version must be stable X.Y.Z")
    return tuple(map(int, version.split(".")))


def manifest(version, directory):
    version_tuple(version)
    platforms = {}
    for platform in PLATFORMS:
        name = asset_name(version, platform)
        if not (directory / name).is_file() or (directory / name).stat().st_size == 0:
            raise ValueError(f"Missing or empty archive: {name}")
        signature = (directory / (name + ".sig")).read_text().strip()
        if not signature:
            raise ValueError(f"Missing signature: {name}")
        platforms[platform] = {
            "signature": signature,
            "url": f"https://github.com/{REPOSITORY}/releases/download/el-desktop-v{version}/{name}",
        }
    return {"version": version, "notes": f"Enrich Layer Buzz {version}",
            "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platforms": platforms}


def validate(candidate, version, assets):
    version_tuple(version)
    if candidate["version"] != version or set(candidate["platforms"]) != set(PLATFORMS):
        raise ValueError("Manifest version or platforms mismatch")
    for platform, entry in candidate["platforms"].items():
        name = asset_name(version, platform)
        expected = f"https://github.com/{REPOSITORY}/releases/download/el-desktop-v{version}/{name}"
        if entry["url"] != expected or not isinstance(entry["signature"], str) or not entry["signature"].strip():
            raise ValueError("Invalid updater URL or signature")
        if name not in assets or name + ".sig" not in assets:
            raise ValueError(f"Release lacks signed asset {name}")


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=180)


def download(tag, name, directory):
    gh("release", "download", tag, "--repo", REPOSITORY, "--pattern", name, "--dir", str(directory), "--clobber")
    return (directory / name).read_bytes()


def promote(version):
    version_tuple(version)
    tag = f"el-desktop-v{version}"
    release = json.loads(gh("release", "view", tag, "--repo", REPOSITORY, "--json", "isDraft,isPrerelease,assets,targetCommitish"))
    if release["isDraft"] or release["isPrerelease"]:
        raise ValueError("Only published stable releases can be promoted")
    sha = gh("api", f"repos/{REPOSITORY}/commits/{tag}", "--jq", ".sha").strip()
    target = gh("api", f"repos/{REPOSITORY}/commits/{release['targetCommitish']}", "--jq", ".sha").strip()
    if sha != target:
        raise ValueError("Release target and immutable source tag differ")
    with tempfile.TemporaryDirectory(prefix="buzz-promotion-") as tmp:
        directory = pathlib.Path(tmp)
        data = download(tag, "updater-manifest.json", directory)
        candidate = json.loads(data)
        validate(candidate, version, {a["name"] for a in release["assets"]})
        for platform in PLATFORMS:
            name = asset_name(version, platform) + ".sig"
            if download(tag, name, directory).decode().strip() != candidate["platforms"][platform]["signature"]:
                raise ValueError("Manifest signature differs from released signature")
        # Listing errors propagate; an auth/network failure must never mean first release.
        releases = json.loads(gh("api", "--paginate", "--slurp", f"repos/{REPOSITORY}/releases?per_page=100"))
        rolling = next((r for page in releases for r in page if r["tag_name"] == ROLLING), None)
        latest_exists = False
        journal_name = f"promotion-{version}.json"
        journal_exists = False
        if rolling:
            if rolling["draft"] and rolling["target_commitish"] != sha:
                raise ValueError("Draft belongs to a different source; resume its original promotion")
            assets = {a["name"] for a in rolling["assets"]}
            journals = [name[len("promotion-"):-len(".json")] for name in assets
                        if name.startswith("promotion-") and name.endswith(".json")]
            if journals:
                highest = max(journals, key=version_tuple)
                if version_tuple(highest) > version_tuple(version):
                    raise ValueError("Refusing downgrade below an attempted promotion")
            journal_exists = journal_name in assets
            if journal_exists and download(ROLLING, journal_name, directory) != data:
                raise ValueError("Same version has a different promotion record")
            latest_exists = "latest.json" in assets
            if latest_exists:
                previous = download(ROLLING, "latest.json", directory)
                current = json.loads(previous)
                if version_tuple(current["version"]) > version_tuple(version):
                    raise ValueError("Refusing updater downgrade")
                if current["version"] == version:
                    if previous != data:
                        raise ValueError("Same version has a different manifest")
                    if rolling["draft"]:
                        gh("release", "edit", ROLLING, "--repo", REPOSITORY, "--draft=false")
                    print(f"Buzz {version} already promoted")
                    return
                if download(ROLLING, "latest.json", directory) != previous:
                    raise ValueError("Promotion changed during validation")
            elif not journals and not rolling["draft"]:
                raise ValueError("Missing feed has no recovery record")
        else:
            # Explicit draft permits recovery after create, journal, or manifest failure.
            gh("release", "create", ROLLING, "--repo", REPOSITORY, "--target", sha,
               "--title", "Enrich Layer Buzz auto updates", "--notes", "Signature-verified desktop update feed",
               "--latest=false", "--draft")
        if not journal_exists:
            (directory / journal_name).write_bytes(data)
            gh("release", "upload", ROLLING, str(directory / journal_name), "--repo", REPOSITORY)
        # The immutable journal preserves both candidate bytes and the version floor
        # if --clobber deletes latest.json and the replacement upload fails.
        if download(ROLLING, journal_name, directory) != data:
            raise ValueError("Promotion record verification failed")
        (directory / "latest.json").write_bytes(data)
        flags = ("--clobber",) if latest_exists else ()
        gh("release", "upload", ROLLING, str(directory / "latest.json"), "--repo", REPOSITORY, *flags)
        if download(ROLLING, "latest.json", directory) != data:
            raise ValueError("Served manifest differs from promoted candidate")
        if rolling is None or rolling["draft"]:
            gh("release", "edit", ROLLING, "--repo", REPOSITORY, "--draft=false")
        print(f"Promoted Enrich Layer Buzz {version} from {sha}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("manifest", "promote"))
    parser.add_argument("version")
    parser.add_argument("directory", type=pathlib.Path, nargs="?")
    args = parser.parse_args()
    if args.action == "manifest":
        if args.directory is None:
            parser.error("manifest requires an artifact directory")
        print(json.dumps(manifest(args.version, args.directory), indent=2))
    else:
        promote(args.version)
