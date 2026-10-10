#!/usr/bin/env python3
"""Exercise the production merge path using real local Git repositories."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("enrichlayer-upstream-sync.py"))
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.DEVNULL).strip()


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.origin = self.root / "origin"
        self.worker = self.root / "worker"
        self.upstream.mkdir()
        git(self.upstream, "init", "-b", "main")
        self.identity(self.upstream)
        self.commit(self.upstream, "common", "base")
        git(self.root, "clone", "--bare", str(self.upstream), str(self.origin))
        git(self.root, "clone", str(self.origin), str(self.worker))
        self.identity(self.worker)

    def identity(self, root):
        git(root, "config", "user.name", "Sync Test")
        git(root, "config", "user.email", "sync@example.invalid")

    def commit(self, root, name, text):
        (root / name).write_text(text)
        git(root, "add", name)
        git(root, "commit", "-s", "-m", name)
        return git(root, "rev-parse", "HEAD")

    def prepare(self):
        return SYNC.prepare(self.worker, str(self.upstream))

    def test_current_does_not_change_branch(self):
        before = git(self.worker, "rev-parse", "HEAD")
        self.assertEqual(self.prepare()["status"], "current")
        self.assertEqual(git(self.worker, "branch", "--show-current"), "main")
        self.assertEqual(git(self.worker, "rev-parse", "HEAD"), before)

    def test_merge_preserves_both_histories_and_does_not_push(self):
        fork = self.commit(self.worker, "custom", "our customization")
        git(self.worker, "push", "origin", "main")
        central = self.commit(self.upstream, "new", "central feature")
        result = self.prepare()
        self.assertEqual(result["status"], "ready")
        self.assertTrue(result["changed"])
        for sha in (fork, central):
            git(self.worker, "merge-base", "--is-ancestor", sha, "HEAD")
        self.assertEqual((self.worker / "custom").read_text(), "our customization")
        self.assertEqual(git(self.origin, "rev-parse", "main"), fork)
        self.assertIn("Signed-off-by: Sync Test", git(self.worker, "log", "-1", "--format=%B"))

    def test_conflicts_are_reported_and_aborted(self):
        self.commit(self.worker, "common", "fork change")
        git(self.worker, "push", "origin", "main")
        self.commit(self.upstream, "common", "central change")
        result = self.prepare()
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(result["paths"], ["common"])
        self.assertEqual((self.worker / "common").read_text(), "fork change")
        self.assertEqual(git(self.worker, "status", "--porcelain"), "")

    def test_remote_manual_fixes_survive_and_unchanged_retry_is_noop(self):
        self.commit(self.upstream, "central", "first")
        self.prepare()
        self.commit(self.worker, "manual", "maintainer fix")
        git(self.worker, "push", "origin", SYNC.BRANCH)
        self.assertFalse(self.prepare()["changed"])
        self.commit(self.upstream, "next", "second")
        self.assertTrue(self.prepare()["changed"])
        self.assertEqual((self.worker / "manual").read_text(), "maintainer fix")

    def test_uncommitted_files_are_rejected(self):
        (self.worker / "unsaved").write_text("user work")
        with self.assertRaisesRegex(RuntimeError, "clean, disposable"):
            self.prepare()
        self.assertEqual((self.worker / "unsaved").read_text(), "user work")

    def test_unavailable_upstream_is_an_error(self):
        with self.assertRaises(subprocess.CalledProcessError):
            SYNC.prepare(self.worker, str(self.root / "missing"))


if __name__ == "__main__":
    unittest.main()
