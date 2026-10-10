import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gate", pathlib.Path(__file__).with_name("enrichlayer-release-gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SHA = "a" * 40
HEAD = "b" * 40


class GateTest(unittest.TestCase):
    def setUp(self):
        self.pr = {"number": 8, "merged_at": "2026-10-11T00:00:00Z", "merge_commit_sha": SHA,
                   "base": {"ref": "main", "repo": {"full_name": gate.REPOSITORY}},
                   "head": {"sha": HEAD}, "draft": False, "body": "buzz-review-completed",
                   "user": {"login": "author"}}
        self.reviews = [{"id": 1, "state": "APPROVED", "commit_id": HEAD,
                         "user": {"login": "reviewer", "type": "User"}, "author_association": "MEMBER"}]
        self.runs = [{"id": i, "run_attempt": 1, "path": path, "head_sha": SHA,
                      "head_branch": "main", "status": "completed", "conclusion": "success"}
                     for i, path in enumerate(sorted(gate.REQUIRED))]
        self.tags = []
        self.posts = []
        self.main = SHA

    def api(self, endpoint, **fields):
        if endpoint == "commits/main":
            return {"sha": self.main}
        if endpoint.startswith("actions/runs?"):
            return {"workflow_runs": self.runs}
        if endpoint.startswith(f"commits/{SHA}/pulls?"):
            return [self.pr]
        if endpoint == "pulls/8":
            return self.pr
        if endpoint.startswith("pulls/8/reviews?"):
            return self.reviews
        if endpoint.startswith("releases?"):
            return []
        if endpoint.startswith("tags?"):
            return self.tags
        if endpoint == "git/refs":
            self.posts.append(fields)
            return fields
        raise AssertionError(endpoint)

    def check(self):
        with patch.object(gate, "api", side_effect=self.api):
            return gate.check(SHA)

    def test_current_reviewed_green_source_passes(self):
        self.assertEqual(self.check()["review_ids"], [1])

    def test_fail_closed_for_missing_pending_failed_or_skipped_required_checks(self):
        for status in (None, "failure", "skipped", "cancelled"):
            with self.subTest(status=status):
                self.runs[0]["conclusion"] = status
                with self.assertRaises(ValueError):
                    self.check()
        self.runs = []
        with self.assertRaises(ValueError):
            self.check()

    def test_later_failed_attempt_overrides_old_success(self):
        failed = dict(self.runs[0], run_attempt=2, conclusion="failure")
        self.runs.append(failed)
        with self.assertRaises(ValueError):
            self.check()

    def test_unrelated_selected_check_failure_also_blocks(self):
        self.runs.append(dict(self.runs[0], id=100, path=".github/workflows/security.yml", conclusion="failure"))
        with self.assertRaises(ValueError):
            self.check()

    def test_old_main_and_direct_push_refused(self):
        self.main = "c" * 40
        with self.assertRaises(ValueError):
            self.check()
        self.main = SHA
        self.pr["merge_commit_sha"] = "c" * 40
        with self.assertRaises(ValueError):
            self.check()

    def test_marker_and_non_draft_required(self):
        for field, value in (("body", ""), ("draft", True)):
            original = self.pr[field]
            self.pr[field] = value
            with self.assertRaises(ValueError):
                self.check()
            self.pr[field] = original

    def test_stale_approval_refused(self):
        self.reviews[0]["commit_id"] = "c" * 40
        with self.assertRaises(ValueError):
            self.check()

    def test_repository_attestation_accepts_comment_based_agent_review(self):
        self.reviews = []
        self.assertEqual(self.check()["review_ids"], [])
        self.pr["body"] = ""
        with self.assertRaises(ValueError):
            self.check()

    def test_revoked_review_or_outstanding_changes_block(self):
        for state in ("DISMISSED", "CHANGES_REQUESTED"):
            self.reviews = [dict(self.reviews[0], state=state)]
            with self.assertRaises(ValueError):
                self.check()

    def test_main_movement_during_check_blocks(self):
        real_api = self.api
        calls = 0
        def moving(endpoint, **fields):
            nonlocal calls
            if endpoint == "commits/main":
                calls += 1
                if calls == 2:
                    return {"sha": "c" * 40}
            return real_api(endpoint, **fields)
        with patch.object(gate, "api", side_effect=moving), self.assertRaises(ValueError):
            gate.check(SHA)

    def test_version_reservation_is_retryable_and_numeric(self):
        self.tags = [{"name": "el-desktop-v1.9.0", "commit": {"sha": "c" * 40}},
                     {"name": "el-desktop-v1.10.0", "commit": {"sha": "c" * 40}}]
        with patch.object(gate, "api", side_effect=self.api), patch.object(pathlib.Path, "read_text", return_value='{"version":"0.5.27"}'):
            self.assertEqual(gate.reserve(SHA)["version"], "1.10.1")
            self.tags.append({"name": "el-desktop-v1.10.1", "commit": {"sha": SHA}})
            self.assertEqual(gate.reserve(SHA)["version"], "1.10.1")
        self.assertEqual(len(self.posts), 1)

    def test_already_promoted_skips_rebuild_but_journal_alone_does_not(self):
        rolling = {"tag_name": "buzz-desktop-latest", "draft": False,
                   "assets": [{"name": "promotion-1.2.3.json"}, {"name": "latest.json"}]}
        with patch.object(gate, "pages", return_value=[rolling]), patch.object(gate.subprocess, "check_output", return_value='{"version":"1.2.3"}'):
            self.assertEqual(gate.release_state({}, "1.2.3")["already_promoted"], "true")
            rolling["assets"].pop()
            self.assertEqual(gate.release_state({}, "1.2.3")["already_promoted"], "false")

    def test_api_error_propagates(self):
        with patch.object(gate, "api", side_effect=RuntimeError("network unavailable")), self.assertRaises(RuntimeError):
            gate.check(SHA)


if __name__ == "__main__":
    unittest.main()
