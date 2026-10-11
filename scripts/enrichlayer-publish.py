"""Announce verified R2 downloads on GitHub without duplicating artifact storage."""
import importlib.util
import json
import pathlib
import sys
import tempfile

spec = importlib.util.spec_from_file_location("updater", pathlib.Path(__file__).with_name("enrichlayer-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def publish(version, sha):
    updater.version_tuple(version)
    tag = f"el-desktop-v{version}"
    actual = updater.gh("api", f"repos/{updater.REPOSITORY}/commits/{tag}", "--jq", ".sha").strip()
    if actual != sha:
        raise ValueError("Release tag does not match reviewed source")
    release = updater.public_document(f"releases/{version}/release.json")
    candidate = updater.public_document(f"releases/{version}/updater-manifest.json")
    if release["sha"] != sha:
        raise ValueError("R2 release does not match reviewed source")
    updater.validate(candidate, version, set(release["artifacts"]))
    downloads = {"Mac (Apple Silicon)": f"Buzz_{version}_darwin-aarch64.dmg",
                 "Mac (Intel)": f"Buzz_{version}_darwin-x86_64.dmg",
                 "Windows x64": updater.asset_name(version, "windows-x86_64"),
                 "Linux x64 AppImage": updater.asset_name(version, "linux-x86_64")}
    if not set(downloads.values()) <= set(release["artifacts"]):
        raise ValueError("R2 release lacks a team installer")
    previous = None
    for page in range(1, 21):
        items = json.loads(updater.gh("api", f"repos/{updater.REPOSITORY}/releases?per_page=100&page={page}"))
        previous = next((item for item in items if item["tag_name"] == tag), None)
        if previous or len(items) < 100:
            break
    else:
        raise ValueError("Release listing exceeds pagination bound")
    if previous:
        if previous["target_commitish"] != sha:
            raise ValueError("Existing announcement belongs to another source")
        if not previous["draft"]:
            return
    notes = "Mac builds use ad-hoc signing without Apple notarization. Downloads are served from our R2 storage.\n\n"
    notes += "\n".join(f"- [{label}]({updater.PUBLIC}/releases/{version}/{name})" for label, name in downloads.items())
    notes += "\n\n[Installation and update guide](https://github.com/enrichlayer/buzz/blob/main/docs/enrichlayer-buzz-user-guide.md)\n"
    with tempfile.TemporaryDirectory(prefix="buzz-announcement-") as tmp:
        body = pathlib.Path(tmp) / "notes.md"
        body.write_text(notes)
        if previous:
            updater.gh("release", "edit", tag, "--repo", updater.REPOSITORY, "--notes-file", str(body), "--draft=false")
        else:
            updater.gh("release", "create", tag, "--repo", updater.REPOSITORY, "--verify-tag", "--target", sha,
                       "--title", f"Buzz {version} (Enrich Layer)", "--notes-file", str(body))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: enrichlayer-publish.py VERSION SOURCE_SHA")
    publish(sys.argv[1], sys.argv[2])
