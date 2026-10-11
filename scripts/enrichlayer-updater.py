"""Build and promote the Enrich Layer desktop updater feed."""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import urllib.error
import urllib.request

REPOSITORY = "enrichlayer/buzz"
PLATFORMS = {
    "darwin-aarch64": ".app.tar.gz", "darwin-x86_64": ".app.tar.gz",
    "linux-x86_64": ".AppImage", "windows-x86_64": "-setup.exe",
}


def asset_name(version, platform):
    return f"Buzz_{version}_{platform}{PLATFORMS[platform]}"

PUBLIC = "https://buzz-downloads.enrichlayer.com"



def public_document(key, *, missing_ok=False):
    """Read bounded release metadata; only an explicit 404 means absent."""
    url = f"{PUBLIC}/{key}"
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.geturl() != url:
                raise ValueError("Unexpected release metadata redirect")
            data = response.read(1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise
    if len(data) > 1024 * 1024:
        raise ValueError("Release metadata exceeds size limit")
    return json.loads(data)

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
            "url": f"{PUBLIC}/releases/{version}/{name}",
        }
    return {"version": version, "notes": f"Enrich Layer Buzz {version}",
            "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platforms": platforms}


def validate(candidate, version, assets):
    version_tuple(version)
    if candidate["version"] != version or set(candidate["platforms"]) != set(PLATFORMS):
        raise ValueError("Manifest version or platforms mismatch")
    for platform, entry in candidate["platforms"].items():
        name = asset_name(version, platform)
        expected = f"{PUBLIC}/releases/{version}/{name}"
        if entry["url"] != expected or not isinstance(entry["signature"], str) or not entry["signature"].strip():
            raise ValueError("Invalid updater URL or signature")
        if name not in assets or name + ".sig" not in assets:
            raise ValueError(f"Release lacks signed asset {name}")


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=180)



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("manifest",))
    parser.add_argument("version")
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(manifest(args.version, args.directory), indent=2))
