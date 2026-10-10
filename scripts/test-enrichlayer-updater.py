import copy
import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("updater", pathlib.Path(__file__).with_name("enrichlayer-updater.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = pathlib.Path(self.tmp.name)
        self.assets = set()
        for platform in updater.PLATFORMS:
            name = f"Buzz_1.2.3_{platform}.app.tar.gz"
            (self.directory / name).write_bytes(b"archive fixture")
            (self.directory / (name + ".sig")).write_text("signature fixture")
            self.assets.update((name, name + ".sig"))
        self.candidate = updater.manifest("1.2.3", self.directory)

    def test_valid_signed_manifest(self):
        updater.validate(self.candidate, "1.2.3", self.assets)

    def test_rejects_foreign_feed(self):
        candidate = copy.deepcopy(self.candidate)
        candidate["platforms"]["darwin-aarch64"]["url"] = "https://github.com/block/buzz/releases/foreign"
        with self.assertRaises(ValueError):
            updater.validate(candidate, "1.2.3", self.assets)

    def test_rejects_missing_architecture_or_signature(self):
        for missing in ("darwin-aarch64", "darwin-x86_64"):
            candidate = copy.deepcopy(self.candidate)
            del candidate["platforms"][missing]
            with self.assertRaises(ValueError):
                updater.validate(candidate, "1.2.3", self.assets)
        with self.assertRaises(ValueError):
            updater.validate(self.candidate, "1.2.3", set())

    def test_requires_real_nonempty_archives(self):
        next(self.directory.glob("*.tar.gz")).write_bytes(b"")
        with self.assertRaises(ValueError):
            updater.manifest("1.2.3", self.directory)

    def test_version_order_is_numeric(self):
        self.assertGreater(updater.version_tuple("1.10.0"), updater.version_tuple("1.9.0"))
        for version in ("1.2.3-beta", "01.2.3", "../1.2.3", "1.2"):
            with self.assertRaises(ValueError):
                updater.version_tuple(version)


if __name__ == '__main__':
    unittest.main()
