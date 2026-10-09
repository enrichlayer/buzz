import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

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

    def test_draft_release_never_promotes(self):
        with patch.object(updater, "gh", return_value='{"isDraft":true,"isPrerelease":false}') as gh:
            with self.assertRaises(ValueError):
                updater.promote("1.2.3")
            self.assertEqual(gh.call_count, 1)

    def remote(self, current=None, fail=None):
        candidate_data = json.dumps(self.candidate).encode()
        state = {"exists": current is not None, "draft": False, "assets": {}, "commands": [], "fail": fail}
        if current:
            state["assets"]["latest.json"] = json.dumps(current).encode()
        def fake_gh(*args):
            state["commands"].append(args)
            if args[:2] == ("release", "view"):
                return json.dumps({"isDraft": False, "isPrerelease": False,
                                  "assets": [{"name": n} for n in self.assets], "targetCommitish": "abc"})
            if args[0] == "api" and "--paginate" in args:
                if state["fail"] == "listing":
                    raise RuntimeError("GitHub unavailable")
                rolling = {"tag_name": updater.ROLLING, "draft": state["draft"],
                           "target_commitish": "abc", "assets": [{"name": n} for n in state["assets"]]}
                return json.dumps([[rolling]] if state["exists"] else [[]])
            if args[0] == "api":
                return "abc"
            if args[:2] == ("release", "create"):
                state.update(exists=True, draft=True)
                if state["fail"] == "create":
                    state["fail"] = None
                    raise RuntimeError("interrupted after create")
            if args[:2] == ("release", "upload"):
                path = pathlib.Path(args[3])
                if "--clobber" in args:
                    state["assets"].pop(path.name, None)
                if path.name == "latest.json" and state["fail"] == "upload":
                    state["fail"] = None
                    raise RuntimeError("interrupted after deletion")
                state["assets"][path.name] = path.read_bytes()
            if args[:2] == ("release", "edit"):
                if state["fail"] == "publish":
                    state["fail"] = None
                    raise RuntimeError("interrupted before publication")
                state["draft"] = False
            return ""
        def fake_download(tag, name, directory):
            if tag != updater.ROLLING:
                return b"signature fixture" if name.endswith(".sig") else candidate_data
            return state["assets"][name]
        def run():
            with patch.object(updater, "gh", side_effect=fake_gh), patch.object(updater, "download", side_effect=fake_download):
                updater.promote("1.2.3")
        return state, run

    def test_first_promotion_creates_feed_with_journal(self):
        state, run = self.remote()
        run()
        self.assertFalse(state["draft"])
        self.assertEqual(state["assets"]["latest.json"], state["assets"]["promotion-1.2.3.json"])

    def test_newer_promotion_uploads_existing_feed(self):
        state, run = self.remote({"version": "1.2.2"})
        run()
        self.assertEqual(json.loads(state["assets"]["latest.json"])["version"], "1.2.3")

    def test_downgrade_refused(self):
        _, run = self.remote({"version": "1.2.4"})
        with self.assertRaisesRegex(ValueError, "downgrade"):
            run()

    def test_same_version_requires_identical_manifest(self):
        state, run = self.remote(self.candidate)
        run()
        self.assertFalse(any(c[:2] == ("release", "upload") for c in state["commands"]))
        _, run = self.remote({"version": "1.2.3"})
        with self.assertRaisesRegex(ValueError, "different manifest"):
            run()

    def test_listing_failure_propagates(self):
        _, run = self.remote(fail="listing")
        with self.assertRaisesRegex(RuntimeError, "GitHub unavailable"):
            run()

    def test_interrupted_first_promotion_resumes(self):
        for failure in ("create", "upload", "publish"):
            with self.subTest(failure=failure):
                state, run = self.remote(fail=failure)
                with self.assertRaises(RuntimeError):
                    run()
                self.assertTrue(state["draft"])
                run()
                self.assertFalse(state["draft"])
                self.assertIn("latest.json", state["assets"])

    def test_failed_clobber_recovers_without_losing_version_floor(self):
        state, run = self.remote({"version": "1.2.2"}, fail="upload")
        with self.assertRaises(RuntimeError):
            run()
        self.assertNotIn("latest.json", state["assets"])
        self.assertIn("promotion-1.2.3.json", state["assets"])
        state["assets"]["promotion-1.2.4.json"] = b"newer attempted release"
        with self.assertRaisesRegex(ValueError, "downgrade"):
            run()
        del state["assets"]["promotion-1.2.4.json"]
        run()
        self.assertEqual(json.loads(state["assets"]["latest.json"])["version"], "1.2.3")


if __name__ == "__main__":
    unittest.main()
