import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sprig", Path(__file__).with_name("publish-sprig-rolling.py"))
sprig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sprig)


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        Path(self.temp.name, "sprig.tar.gz").write_bytes(b"artifact")
        self.calls = []
        self.pages = [[]]

    def gh(self, *args):
        self.calls.append(args)
        return json.dumps(self.pages.pop(0)) if args[0] == "api" else ""

    def publish(self):
        with patch.object(sprig, "gh", side_effect=self.gh):
            sprig.publish("enrichlayer/buzz", "a" * 40, self.temp.name)

    def test_first_release_is_created_at_source_before_upload(self):
        self.publish()
        self.assertEqual(self.calls[1][:3], ("release", "create", "sprig-latest"))
        self.assertEqual(self.calls[1][3:5], ("--target", "a" * 40))
        self.assertEqual(self.calls[-1][:2], ("release", "upload"))

    def test_existing_release_is_updated_after_paginated_lookup(self):
        self.pages = [[{"tag_name": str(i)} for i in range(100)], [{"tag_name": "sprig-latest"}]]
        self.publish()
        self.assertIn("page=2", self.calls[1][1])
        self.assertEqual(self.calls[2][:2], ("release", "edit"))

    def test_unavailable_api_does_not_attempt_creation(self):
        with patch.object(sprig, "gh", side_effect=RuntimeError("API unavailable")) as gh:
            with self.assertRaisesRegex(RuntimeError, "API unavailable"):
                sprig.publish("enrichlayer/buzz", "a" * 40, self.temp.name)
            self.assertEqual(gh.call_count, 1)

    def test_incomplete_listing_does_not_publish(self):
        self.pages = [[{"tag_name": str(i)} for i in range(100)]] * 20
        with self.assertRaisesRegex(ValueError, "pagination bound"):
            self.publish()
        self.assertTrue(all(call[0] == "api" for call in self.calls))

    def test_no_artifacts_refuses_before_api(self):
        Path(self.temp.name, "sprig.tar.gz").unlink()
        with self.assertRaisesRegex(ValueError, "No Sprig artifacts"):
            self.publish()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
