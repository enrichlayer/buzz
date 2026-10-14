"""Small real-Git contracts for native source custody; no Buzz compilation."""

import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import yaml


spec = importlib.util.spec_from_file_location(
    "native", Path(__file__).with_name("buzz-native-source.py")
)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeSourceTest(unittest.TestCase):
    def test_operator_canonical_request_fixture(self):
        request = {
            "subject": {
                "repo": "enrichlayer/buzz",
                "branch": "codex/DEV-13135-native-source",
                "workspaceId": "a" * 64,
                "generation": 1,
                "seq": 2,
                "commitSha": "b" * 40,
                "treeDigest": "c" * 64,
                "bundleDigest": "d" * 64,
                "packDigest": "f" * 64,
            },
            "policy": {"workflowId": 123, "workflowSha": "e" * 40},
        }
        self.assertEqual(
            native.request_digest(request),
            "1a65df1abc5d04646abafd38cc59dce1a65f6113249d1667feec5e12d066db36",
        )

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "original"
        self.repo.mkdir()
        native.git(self.repo, "init", "--quiet")
        native.git(self.repo, "config", "user.name", "Fixture")
        native.git(self.repo, "config", "user.email", "fixture@example.invalid")
        (self.repo / "source.txt").write_text("admitted source\n")
        native.git(self.repo, "add", "source.txt")
        native.git(self.repo, "commit", "--quiet", "-m", "fixture")
        commit = native.git(self.repo, "rev-parse", "HEAD").decode().strip()
        objects = native.git(
            self.repo, "rev-list", "--objects", "--no-object-names", "HEAD"
        )
        self.pack = self.root / "source.pack"
        with self.pack.open("wb") as output:
            subprocess.run(
                ["git", "-C", str(self.repo), "pack-objects", "--stdout"],
                input=objects,
                stdout=output,
                check=True,
                timeout=30,
            )
        self.subject = {
            "repo": "enrichlayer/buzz",
            "branch": "codex/fixture",
            "workspaceId": "a" * 64,
            "generation": 1,
            "seq": 2,
            "commitSha": commit,
            "treeDigest": hashlib.sha256(
                native.git(self.repo, "ls-tree", "-r", "-z", "--full-tree", commit)
            ).hexdigest(),
            "bundleDigest": "d" * 64,
            "packDigest": hashlib.sha256(self.pack.read_bytes()).hexdigest(),
        }
        self.policy = {"workflowId": 123, "workflowSha": "e" * 40}

    def test_real_pack_hydrates_only_matching_source(self):
        destination = self.root / "hydrated"
        native.hydrate_pack(self.pack, destination, self.subject)
        self.assertEqual((destination / "source.txt").read_text(), "admitted source\n")
        self.assertEqual(
            native.git(destination, "rev-parse", "HEAD").decode().strip(),
            self.subject["commitSha"],
        )
        self.assertEqual(native.git(destination, "status", "--porcelain"), b"")

    def test_full_hydration_and_cleanup_preserve_trusted_control(self):
        workspace = self.root / "workspace"
        workspace.mkdir()
        native.git(workspace, "init", "--quiet")
        native.git(workspace, "config", "user.name", "Control")
        native.git(workspace, "config", "user.email", "control@example.invalid")
        (workspace / "control.txt").write_text("trusted workflow")
        native.git(workspace, "add", "control.txt")
        native.git(workspace, "commit", "--quiet", "-m", "control")
        control_sha = native.git(workspace, "rev-parse", "HEAD").decode().strip()
        request = {
            "subject": self.subject,
            "policy": {**self.policy, "workflowSha": control_sha},
        }
        digest = native.request_digest(request)
        pack = self.pack.read_bytes()

        class Storage:
            def document(self, key):
                if key != f"native-source/v1/{digest}/request.json":
                    raise AssertionError("Unexpected request key")
                return json.dumps(request).encode(), "etag"

            def get(self, key):
                if (
                    key
                    != f"native-source/v1/objects/{request['subject']['packDigest']}.pack"
                ):
                    raise AssertionError("Unexpected pack key")
                return {"Body": io.BytesIO(pack)}

        runner = self.root / "runner"
        runner.mkdir()
        with (
            patch.object(native, "store", return_value=Storage()),
            patch.dict(os.environ, {"GITHUB_SHA": control_sha}),
        ):
            inputs = self.root / "inputs"
            native.prepare(digest, inputs, workspace)
            self.assertTrue((workspace / "control.txt").exists())
            # Source execution does not receive a storage client or credential.
            with patch.object(
                native, "store", side_effect=AssertionError("No storage in source job")
            ):
                native.install(digest, inputs, workspace, runner)
        self.assertEqual((workspace / "source.txt").read_text(), "admitted source\n")
        self.assertFalse((workspace / "control.txt").exists())
        self.assertEqual(
            (runner / "buzz-native-control/control.txt").read_text(), "trusted workflow"
        )
        native.cleanup(workspace, runner, required=True)
        self.assertEqual((workspace / "control.txt").read_text(), "trusted workflow")
        self.assertFalse((workspace / "source.txt").exists())

    def test_corrupt_pack_is_rejected_before_source_creation(self):
        self.pack.write_bytes(self.pack.read_bytes() + b"tampered")
        destination = self.root / "hydrated"
        with self.assertRaisesRegex(ValueError, "pack digest mismatch"):
            native.hydrate_pack(self.pack, destination, self.subject)
        self.assertFalse(destination.exists())

    def test_wrong_tree_is_rejected_before_checkout(self):
        destination = self.root / "hydrated"
        with self.assertRaisesRegex(ValueError, "tree digest mismatch"):
            native.hydrate_pack(
                self.pack, destination, {**self.subject, "treeDigest": "f" * 64}
            )
        self.assertFalse((destination / "source.txt").exists())

    def test_unknown_commit_is_rejected(self):
        with self.assertRaises(ValueError):
            native.hydrate_pack(
                self.pack,
                self.root / "hydrated",
                {**self.subject, "commitSha": "f" * 40},
            )

    def test_canonical_digest_ignores_json_key_order_but_binds_each_field(self):
        request = {"subject": self.subject, "policy": self.policy}
        digest = native.request_digest(request)
        self.assertEqual(
            native.request_digest(json.loads(json.dumps(request, sort_keys=True))),
            digest,
        )
        for field in native.FIELDS:
            changed = {
                **self.subject,
                field: 9
                if field in ("generation", "seq")
                else "codex/other"
                if field == "branch"
                else "e" * len(self.subject[field]),
            }
            with self.subTest(field=field):
                if field == "repo":
                    with self.assertRaises(ValueError):
                        native.request_digest(
                            {"subject": changed, "policy": self.policy}
                        )
                else:
                    self.assertNotEqual(
                        native.request_digest(
                            {"subject": changed, "policy": self.policy}
                        ),
                        digest,
                    )

    def test_cleanup_restores_control_without_touching_peer_directory(self):
        runner = self.root / "runner"
        runner.mkdir()
        control = runner / "buzz-native-control"
        self.repo.rename(control)
        source = self.root / "workspace"
        source.mkdir()
        (source / "generated").write_text("temporary")
        peer = self.root / "peer"
        peer.mkdir()
        (peer / "keep").write_text("preserve")
        native.cleanup(source, runner)
        self.assertTrue((source / ".git").is_dir())
        self.assertFalse((source / "generated").exists())
        self.assertEqual((peer / "keep").read_text(), "preserve")

    def test_cleanup_refuses_symlink_workspace(self):
        runner = self.root / "runner"
        runner.mkdir()
        self.repo.rename(runner / "buzz-native-control")
        source = self.root / "workspace"
        source.symlink_to(runner, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "custody mismatch"):
            native.cleanup(source, runner)

    def test_cleanup_refuses_lost_control_after_successful_hydration(self):
        runner = self.root / "runner"
        runner.mkdir()
        with self.assertRaisesRegex(ValueError, "lost its control"):
            native.cleanup(self.repo, runner, required=True)
        native.cleanup(self.repo, runner, required=False)

    def test_workflow_keeps_source_jobs_outside_credential_boundary(self):
        workflow = yaml.safe_load(
            Path(__file__)
            .parents[1]
            .joinpath(".github/workflows/enrichlayer-native-source-validation.yml")
            .read_text()
        )
        jobs = workflow["jobs"]
        for name in ("native", "mobile"):
            job = jobs[name]
            self.assertNotIn("environment", job)
            self.assertEqual(job["needs"], "prepare")
            for forbidden in (
                "secrets.",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "scripts/buzz-r2.py",
                "desktop-candidate",
            ):
                self.assertNotIn(forbidden, json.dumps(job))
        publisher = jobs["publish"]
        self.assertEqual(publisher["needs"], ["native", "mobile"])
        self.assertEqual(publisher["environment"], "desktop-candidate")
        self.assertTrue(publisher["steps"][0]["uses"].startswith("actions/checkout@"))
        command = publisher["steps"][-1]["run"]
        self.assertIn("$GITHUB_WORKSPACE/scripts/buzz-native-source.py", command)
        self.assertNotIn("buzz-native-control", command)

    def test_actual_workflow_cleanup_refuses_lost_control_after_hydration(self):
        workflow = yaml.safe_load(
            Path(__file__)
            .parents[1]
            .joinpath(".github/workflows/enrichlayer-native-source-validation.yml")
            .read_text()
        )
        request = {
            "subject": self.subject,
            "policy": {**self.policy, "workflowSha": self.subject["commitSha"]},
        }
        digest = native.request_digest(request)
        inputs = self.root / "inputs"
        inputs.mkdir()
        (inputs / "request.json").write_text(json.dumps(request))
        shutil.copyfile(self.pack, inputs / "source.pack")
        for name in ("native", "mobile"):
            with self.subTest(job=name):
                workspace = self.root / name
                shutil.copytree(self.repo, workspace)
                runner = self.root / f"runner-{name}"
                runner.mkdir()
                env = {
                    **os.environ,
                    "GITHUB_SHA": self.subject["commitSha"],
                    "GITHUB_WORKSPACE": str(workspace),
                    "RUNNER_TEMP": str(runner),
                }
                with patch.dict(os.environ, env):
                    native.install(digest, inputs, workspace, runner)
                shutil.rmtree(runner / "buzz-native-control")
                cleanup = next(
                    step
                    for step in workflow["jobs"][name]["steps"]
                    if step.get("name") == "Cleanup admitted source"
                )
                self.assertEqual(
                    cleanup["if"], "always() && steps.hydrate.outcome == 'success'"
                )
                result = subprocess.run(
                    ["bash", "-c", cleanup["run"]],
                    env=env,
                    capture_output=True,
                    timeout=10,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(
                    (workspace / "source.txt").read_text(), "admitted source\n"
                )

    def test_artifact_helper_smuggling_is_refused_before_credentials(self):
        results = self.root / "results"
        results.mkdir()
        names = {
            "Buzz-validation.app.tar.gz",
            "buzz-cli-macos.tar.gz",
            "native-validation.log",
            "native-packaging.log",
        }
        for lane in ("macos-15", "macos-15-intel", "mobile"):
            directory = results / f"source-result-{lane}"
            directory.mkdir()
            for name in names if lane != "mobile" else {"mobile-validation.log"}:
                (directory / name).write_text("opaque artifact")
        marker = self.root / "credential-helper-ran"
        attack = (
            f"from pathlib import Path\nPath({str(marker)!r}).write_text('unsafe')\n"
        )
        trusted_module = Mock()
        with patch.object(native, "r2_module", return_value=trusted_module):
            native.publish_results(results, "a" * 64, "123", "1")
        self.assertFalse(marker.exists())
        self.assertEqual(trusted_module.upload.call_count, 3)
        self.assertEqual(trusted_module.fetch.call_count, 3)
        # Smuggling the replacement helper in results also fails before any credentialed transport.
        (results / "source-result-mobile/buzz-r2.py").write_text(attack)
        with (
            patch.object(native, "r2_module") as loader,
            self.assertRaisesRegex(ValueError, "artifact set"),
        ):
            native.publish_results(results, "a" * 64, "123", "1")
        loader.assert_not_called()
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
