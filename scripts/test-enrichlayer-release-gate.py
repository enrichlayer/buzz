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
                   "head": {"sha": HEAD}, "draft": False, "body": "",
                   "user": {"login": "author"}}
        self.reviews = [{"id": 1, "state": "APPROVED", "commit_id": HEAD,
                         "user": {"login": "reviewer", "type": "User"}, "author_association": "MEMBER"}]
        self.runs = [{"id": i, "run_attempt": 1, "path": path, "head_sha": SHA,
                      "head_branch": "main", "status": "completed", "conclusion": "success"}
                     for i, path in enumerate(sorted(gate.REQUIRED))]
        self.tags = []
        self.posts = []
        self.main = SHA
        self.external = []
        self.statuses = []
        self.permissions = {"reviewer": "write", "author": "admin", "reader": "read"}
        self.compare = "ahead"

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
        if "/check-runs?" in endpoint:
            return {"check_runs": self.external}
        if "/statuses?" in endpoint:
            return self.statuses
        if endpoint.startswith("collaborators/"):
            return {"permission": self.permissions.get(endpoint.split("/")[1], "none")}
        if endpoint.startswith(f"compare/{SHA}...main"):
            return {"status": self.compare}
        if endpoint.startswith("releases?"):
            return []
        if endpoint.startswith("tags?"):
            return self.tags
        if endpoint == "git/refs":
            self.posts.append(fields)
            return fields
        raise AssertionError(endpoint)

    def check(self, **kwargs):
        with patch.object(gate, "api", side_effect=self.api):
            return gate.check(SHA, **kwargs)

    def test_current_reviewed_green_source_passes(self):
        self.assertEqual(self.check()["review_ids"], [1])

    def test_fail_closed_for_failed_or_skipped_required_checks(self):
        for status in (None, "failure", "skipped", "cancelled"):
            with self.subTest(status=status):
                self.runs[0]["conclusion"] = status
                with self.assertRaises(ValueError):
                    self.check()

    def test_running_or_missing_required_check_is_pending_not_failure(self):
        self.runs[0].update(status="in_progress", conclusion=None)
        with self.assertRaisesRegex(gate.Pending, "still running"):
            self.check()
        self.runs = []
        with self.assertRaises(gate.Pending):
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
        self.runs[-1].update(status="in_progress", conclusion=None)
        with self.assertRaises(gate.Pending):
            self.check()

    def test_old_main_and_direct_push_are_not_release_candidates(self):
        self.main = "c" * 40
        with self.assertRaises(gate.Pending):
            self.check()
        self.main = SHA
        self.pr["merge_commit_sha"] = "c" * 40
        with self.assertRaises(gate.Pending):
            self.check()

    def test_manual_promotion_accepts_reviewed_ancestor_of_main_only(self):
        self.main = "c" * 40
        self.assertEqual(self.check(allow_ancestor=True)["source_sha"], SHA)
        self.compare = "diverged"
        with self.assertRaisesRegex(ValueError, "not on main"):
            self.check(allow_ancestor=True)

    def test_body_marker_is_not_approval_and_draft_refused(self):
        self.pr["body"] = "buzz-review-completed"
        self.reviews = []
        with self.assertRaisesRegex(ValueError, "lacks an approval"):
            self.check()
        self.reviews = [{"id": 1, "state": "APPROVED", "commit_id": HEAD, "user": {"login": "reviewer", "type": "User"}}]
        self.pr["draft"] = True
        with self.assertRaises(ValueError):
            self.check()

    def test_author_self_approval_and_read_only_approver_do_not_count(self):
        for login in ("author", "reader", "stranger"):
            with self.subTest(login=login):
                self.reviews = [dict(self.reviews[0], user={"login": login, "type": "User"})]
                with self.assertRaisesRegex(ValueError, "lacks an approval"):
                    self.check()

    def test_trusted_bot_reviewer_counts_and_unknown_bot_does_not(self):
        self.reviews = [dict(self.reviews[0], user={"login": "enrichlayer-el-bot[bot]", "type": "Bot"})]
        self.assertEqual(self.check()["review_ids"], [1])
        self.reviews = [dict(self.reviews[0], user={"login": "other[bot]", "type": "Bot"})]
        with self.assertRaises(ValueError):
            self.check()

    def test_stale_approval_ignored_but_current_one_passes(self):
        stale = dict(self.reviews[0], id=0, commit_id="c" * 40, user={"login": "other", "type": "User"})
        self.permissions["other"] = "write"
        self.reviews.insert(0, stale)
        self.assertEqual(self.check()["review_ids"], [1])
        self.reviews = [stale]
        with self.assertRaisesRegex(ValueError, "lacks an approval"):
            self.check()

    def test_dismissed_review_ignored_rather_than_refused(self):
        dismissed = dict(self.reviews[0], id=0, state="DISMISSED", user={"login": "other", "type": "User"})
        self.reviews.insert(0, dismissed)
        self.assertEqual(self.check()["review_ids"], [1])
        # A dismissed approval is not an approval.
        self.reviews = [dict(self.reviews[1], id=2, state="DISMISSED")]
        with self.assertRaises(ValueError):
            self.check()

    def test_outstanding_changes_requested_blocks(self):
        self.reviews.append(dict(self.reviews[0], id=2, state="CHANGES_REQUESTED", user={"login": "other", "type": "User"}))
        with self.assertRaisesRegex(ValueError, "changes requested"):
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
        with patch.object(gate, "api", side_effect=moving), self.assertRaises(gate.Pending):
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

    def test_published_unpromoted_release_is_reported_for_promotion_only(self):
        versioned = {"tag_name": "el-desktop-v1.2.3", "draft": False, "assets": []}
        with patch.object(gate, "pages", return_value=[versioned]):
            state = gate.release_state({}, "1.2.3")
            self.assertEqual((state["published"], state["already_promoted"]), ("true", "false"))
            versioned["draft"] = True
            self.assertEqual(gate.release_state({}, "1.2.3")["published"], "false")

    def test_external_check_failure_and_pending_status_block(self):
        self.external = [{"app": {"slug": "dco"}, "name": "DCO", "status": "completed", "conclusion": "failure"}]
        with self.assertRaisesRegex(ValueError, "External check"):
            self.check()
        self.external = []
        self.statuses = [{"context": "external-ci", "state": "error"}]
        with self.assertRaisesRegex(ValueError, "Commit status"):
            self.check()
        self.statuses = [{"context": "external-ci", "state": "pending"}]
        with self.assertRaises(gate.Pending):
            self.check()

    def test_latest_external_status_supersedes_failure(self):
        self.statuses = [{"context": "external-ci", "state": "success"}, {"context": "external-ci", "state": "failure"}]
        self.assertEqual(self.check()["source_sha"], SHA)

    def test_api_error_propagates(self):
        with patch.object(gate, "api", side_effect=RuntimeError("network unavailable")), self.assertRaises(RuntimeError):
            gate.check(SHA)


if __name__ == "__main__":
    unittest.main()
