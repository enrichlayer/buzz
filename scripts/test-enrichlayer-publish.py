import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish", pathlib.Path(__file__).with_name("enrichlayer-publish.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.source = "a" * 40
        self.commands = []
        self.release = None
        self.notes = ""
        self.artifacts = {}
        self.manifest = {"version": "1.2.3", "platforms": {}}
        for platform in publisher.updater.PLATFORMS:
            name = publisher.updater.asset_name("1.2.3", platform)
            self.artifacts[name] = {}
            self.artifacts[name + ".sig"] = {}
            self.manifest["platforms"][platform] = {"signature": "signed", "url": f"{publisher.updater.PUBLIC}/releases/1.2.3/{name}"}
        for arch in ("aarch64", "x86_64"):
            self.artifacts[f"Buzz_1.2.3_darwin-{arch}.dmg"] = {}

    def gh(self, *args):
        self.commands.append(args)
        if args[0] == "api":
            if "/releases?" in args[1]:
                return json.dumps([self.release] if self.release else [])
            return self.source
        if "--notes-file" in args:
            self.notes = pathlib.Path(args[args.index("--notes-file") + 1]).read_text()
        return ""

    def document(self, key):
        if key.endswith("release.json"):
            return {"sha": "a" * 40, "artifacts": self.artifacts}
        return self.manifest

    def run_publish(self):
        with patch.object(publisher.updater, "gh", side_effect=self.gh), patch.object(publisher.updater, "public_document", side_effect=self.document):
            publisher.publish("1.2.3", "a" * 40)

    def test_announcement_links_all_r2_installers_without_asset_upload(self):
        self.run_publish()
        self.assertEqual(self.commands[-1][:2], ("release", "create"))
        for suffix in ("darwin-aarch64.dmg", "darwin-x86_64.dmg", "windows-x86_64-setup.exe", "linux-x86_64.AppImage"):
            self.assertIn(f"{publisher.updater.PUBLIC}/releases/1.2.3/Buzz_1.2.3_{suffix}", self.notes)
        self.assertFalse(any(c[:2] == ("release", "upload") for c in self.commands))

    def test_published_announcement_is_not_overwritten(self):
        self.release = {"tag_name": "el-desktop-v1.2.3", "target_commitish": self.source, "draft": False}
        self.run_publish()
        self.assertFalse(any(c[0] == "release" for c in self.commands))

    def test_draft_resumes(self):
        self.release = {"tag_name": "el-desktop-v1.2.3", "target_commitish": self.source, "draft": True}
        self.run_publish()
        self.assertEqual(self.commands[-1][:2], ("release", "edit"))

    def test_missing_platform_or_installer_prevents_mutation(self):
        for name in ("Buzz_1.2.3_windows-x86_64-setup.exe", "Buzz_1.2.3_darwin-aarch64.dmg"):
            value = self.artifacts.pop(name)
            with self.assertRaises(ValueError):
                self.run_publish()
            self.artifacts[name] = value
        self.assertFalse(any(c[0] == "release" for c in self.commands))

    def test_wrong_source_refused(self):
        self.source = "b" * 40
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertFalse(any(c[0] == "release" for c in self.commands))

    def test_unavailable_storage_propagates_without_publication(self):
        with patch.object(publisher.updater, "gh", side_effect=self.gh), patch.object(publisher.updater, "public_document", side_effect=RuntimeError("R2 unavailable")):
            with self.assertRaisesRegex(RuntimeError, "R2 unavailable"):
                publisher.publish("1.2.3", self.source)
        self.assertFalse(any(c[0] == "release" for c in self.commands))


if __name__ == "__main__":
    unittest.main()
