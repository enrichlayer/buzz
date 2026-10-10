import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish", pathlib.Path(__file__).with_name("enrichlayer-publish.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = pathlib.Path(self.tmp.name)
        for platform in publisher.updater.PLATFORMS:
            name = publisher.updater.asset_name("1.2.3", platform)
            (self.directory / name).write_bytes(b"artifact")
            (self.directory / (name + ".sig")).write_text("signature")
        self.commands = []
        self.release = None
        self.source = "a" * 40

    def gh(self, *args):
        self.commands.append(args)
        if args[:2] == ("api", "--paginate"):
            return json.dumps([[self.release]] if self.release else [[]])
        if args[0] == "api":
            return self.source
        return ""

    def run_publish(self):
        with patch.object(publisher.updater, "gh", side_effect=self.gh):
            publisher.publish("1.2.3", "a" * 40, self.directory)

    def test_new_release_uploads_complete_set_before_publication(self):
        self.run_publish()
        self.assertEqual(self.commands[-1][:2], ("release", "edit"))
        upload = next(c for c in self.commands if c[:2] == ("release", "upload"))
        self.assertTrue(any("windows-x86_64-setup.exe" in f for f in upload))
        self.assertTrue(any("linux-x86_64.AppImage" in f for f in upload))

    def test_retry_never_overwrites_published_assets(self):
        self.release = {"tag_name": "el-desktop-v1.2.3", "target_commitish": self.source, "draft": False}
        self.run_publish()
        self.assertFalse(any(c[0] == "release" for c in self.commands))

    def test_missing_platform_prevents_any_api_mutation(self):
        (self.directory / publisher.updater.asset_name("1.2.3", "windows-x86_64")).unlink()
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.commands, [])

    def test_wrong_source_refused(self):
        self.source = "b" * 40
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertFalse(any(c[0] == "release" for c in self.commands))

    def test_upload_failure_keeps_release_draft(self):
        gh = self.gh
        def fail_upload(*args):
            result = gh(*args)
            if args[:2] == ("release", "upload"):
                raise RuntimeError("upload failed")
            return result
        with patch.object(publisher.updater, "gh", side_effect=fail_upload), self.assertRaises(RuntimeError):
            publisher.publish("1.2.3", self.source, self.directory)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.commands))


if __name__ == "__main__":
    unittest.main()
