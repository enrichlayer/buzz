"""Build and promote the Enrich Layer macOS updater feed."""
import argparse
import datetime
import json
import pathlib
import re
import subprocess

REPOSITORY = "enrichlayer/buzz"
PLATFORMS = ("darwin-aarch64", "darwin-x86_64")


def version_tuple(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("version must be stable X.Y.Z")
    return tuple(map(int, version.split(".")))


def manifest(version, directory):
    version_tuple(version)
    platforms = {}
    for platform in PLATFORMS:
        name = f"Buzz_{version}_{platform}.app.tar.gz"
        if not (directory / name).is_file() or (directory / name).stat().st_size == 0:
            raise ValueError(f"Missing or empty archive: {name}")
        signature = (directory / (name + ".sig")).read_text().strip()
        if not signature:
            raise ValueError(f"Missing signature: {name}")
        platforms[platform] = {
            "signature": signature,
            "url": f"https://buzz-downloads.enrichlayer.com/releases/{version}/{name}",
        }
    return {"version": version, "notes": f"Enrich Layer Buzz {version}",
            "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platforms": platforms}


def validate(candidate, version, assets):
    version_tuple(version)
    if candidate["version"] != version or set(candidate["platforms"]) != set(PLATFORMS):
        raise ValueError("Manifest version or platforms mismatch")
    for platform, entry in candidate["platforms"].items():
        name = f"Buzz_{version}_{platform}.app.tar.gz"
        expected = f"https://buzz-downloads.enrichlayer.com/releases/{version}/{name}"
        if entry["url"] != expected or not isinstance(entry["signature"], str) or not entry["signature"].strip():
            raise ValueError("Invalid updater URL or signature")
        if name not in assets or name + ".sig" not in assets:
            raise ValueError(f"Release lacks signed asset {name}")


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("manifest",))
    parser.add_argument("version")
    parser.add_argument("directory", type=pathlib.Path, nargs="?")
    args = parser.parse_args()
    if args.action == "manifest":
        if args.directory is None:
            parser.error("manifest requires an artifact directory")
        print(json.dumps(manifest(args.version, args.directory), indent=2))
