"""Publish a complete desktop release without replacing already-published assets."""
import importlib.util
import json
import pathlib
import sys

spec = importlib.util.spec_from_file_location("updater", pathlib.Path(__file__).with_name("enrichlayer-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def publish(version, sha, directory):
    candidate = updater.manifest(version, directory)
    tag = f"el-desktop-v{version}"
    actual = updater.gh("api", f"repos/{updater.REPOSITORY}/commits/{tag}", "--jq", ".sha").strip()
    if actual != sha:
        raise ValueError("Release tag does not match reviewed source")
    pages = json.loads(updater.gh("api", "--paginate", "--slurp", f"repos/{updater.REPOSITORY}/releases?per_page=100"))
    release = next((r for page in pages for r in page if r["tag_name"] == tag), None)
    if release:
        if release["target_commitish"] != sha:
            raise ValueError("Existing release belongs to another commit")
        if not release["draft"]:
            # A retry must use the immutable published bytes, not a fresh build.
            print(f"Release {tag} already published; verify and resume promotion")
            return
    else:
        updater.gh("release", "create", tag, "--repo", updater.REPOSITORY, "--verify-tag",
                   "--target", sha, "--draft", "--title", f"Buzz {version} (Enrich Layer)",
                   "--notes", "Mac (ad-hoc signed), Windows, and Linux AppImage. "
                   "Installation and updates: https://github.com/enrichlayer/buzz/blob/main/docs/enrichlayer-buzz-user-guide.md")
    (directory / "updater-manifest.json").write_text(json.dumps(candidate, indent=2) + "\n")
    assets = [str(p) for p in sorted(directory.iterdir()) if p.is_file()]
    updater.gh("release", "upload", tag, *assets, "--repo", updater.REPOSITORY, "--clobber")
    updater.gh("release", "edit", tag, "--repo", updater.REPOSITORY, "--draft=false")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: enrichlayer-publish.py VERSION SOURCE_SHA ARTIFACT_DIRECTORY")
    publish(sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3]))
