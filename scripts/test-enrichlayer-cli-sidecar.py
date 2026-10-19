import importlib.util
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sidecar", Path(__file__).with_name("enrichlayer-cli-sidecar.py"))
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)
spec = importlib.util.spec_from_file_location(
    "fixture", Path(__file__).with_name("test-enrichlayer-minisign.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class CliSidecarTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.version = "1.2.3"
        self.source_sha = "a" * 40
        self.run_id = "12345"
        self.run_attempt = "2"
        self.workflow_ref = (
            "enrichlayer/buzz/.github/workflows/"
            "enrichlayer-auto-release.yml@refs/heads/main")
        self.workflow_sha = self.source_sha
        self.prefix = (
            f"desktop/{self.source_sha}/{self.run_id}/"
            f"{self.run_attempt}/linux-x86_64")
        self.artifact = self.root / "Buzz_1.2.3_linux-x86_64.AppImage"
        self.signature = self.root / (self.artifact.name + ".sig")
        self.output = self.root / "staged" / (self.artifact.name + ".cli-sidecar.json")
        self.artifact.write_bytes(fixture.DATA)
        self.signature.write_text(fixture.PREHASHED_SIG)

    def create(self, extraction=None):
        def extract(argv, *, cwd, env, stdin, stdout, stderr, check, timeout):
            self.assertEqual(argv, [str(self.artifact.resolve()), "--appimage-extract"])
            self.assertNotIn("APPIMAGE_EXTRACT_AND_RUN", env)
            self.assertIs(stdin, sidecar.subprocess.DEVNULL)
            self.assertEqual(timeout, 900)
            root = Path(cwd) / "squashfs-root" / "usr" / "bin"
            root.mkdir(parents=True)
            executable = root / "buzz"
            executable.write_bytes(b"fixture-cli-binary\n")
            executable.chmod(0o755)
            if extraction:
                extraction(Path(cwd) / "squashfs-root")
            return types.SimpleNamespace(returncode=0)

        with patch.object(sidecar.minisign, "pinned_public_key", return_value=fixture.PUBLIC_KEY), \
             patch.object(sidecar.subprocess, "run", side_effect=extract):
            return sidecar.create_receipt(
                version=self.version,
                source_sha=self.source_sha,
                run_id=self.run_id,
                run_attempt=self.run_attempt,
                workflow_ref=self.workflow_ref,
                workflow_sha=self.workflow_sha,
                build_prefix=self.prefix,
                artifact_path=self.artifact,
                signature_path=self.signature,
                output_path=self.output,
            )

    def test_receipt_binds_signed_appimage_build_and_extracted_cli(self):
        receipt = self.create()
        self.assertEqual(receipt["schema_version"], 1)
        self.assertEqual(receipt["repository"], "enrichlayer/buzz")
        self.assertEqual(receipt["source_sha"], self.source_sha)
        self.assertEqual(receipt["build"]["r2_prefix"], self.prefix)
        self.assertEqual(receipt["installer"]["filename"], self.artifact.name)
        self.assertEqual(receipt["executable"]["path"], "usr/bin/buzz")
        self.assertEqual(receipt["executable"]["mode"], "0755")
        self.assertEqual(receipt["executable"]["size"], len(b"fixture-cli-binary\n"))
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o644)

    def test_bad_signature_fails_before_extraction(self):
        self.artifact.write_bytes(fixture.DATA + b"tampered")
        with patch.object(sidecar.minisign, "pinned_public_key", return_value=fixture.PUBLIC_KEY), \
             patch.object(sidecar.subprocess, "run") as extract:
            with self.assertRaisesRegex(ValueError, "signature verification failed"):
                sidecar.create_receipt(
                    version=self.version, source_sha=self.source_sha,
                    run_id=self.run_id, run_attempt=self.run_attempt,
                    workflow_ref=self.workflow_ref, workflow_sha=self.workflow_sha,
                    build_prefix=self.prefix, artifact_path=self.artifact,
                    signature_path=self.signature, output_path=self.output)
            extract.assert_not_called()

    def test_download_without_execute_bit_runs_only_the_extractor(self):
        self.artifact.write_text(
            '#!/bin/sh\n'
            '[ "$#" = 1 ] && [ "$1" = --appimage-extract ] || exit 41\n'
            '[ -z "${APPIMAGE_EXTRACT_AND_RUN+x}" ] || exit 42\n'
            'mkdir -p squashfs-root/usr/bin\n'
            'printf "extracted-cli\\n" > squashfs-root/usr/bin/buzz\n'
            'chmod 755 squashfs-root/usr/bin/buzz\n')
        self.artifact.chmod(0o644)
        with patch.dict(sidecar.os.environ, {"APPIMAGE_EXTRACT_AND_RUN": "1"}):
            path, observed, mode = sidecar._extracted_cli(self.artifact)
        self.assertEqual(path, "usr/bin/buzz")
        self.assertEqual(observed, {
            "sha256": sidecar.hashlib.sha256(b"extracted-cli\n").hexdigest(),
            "size": len(b"extracted-cli\n"),
        })
        self.assertEqual(mode, 0o755)

    def test_source_and_build_prefix_mismatch_are_refused(self):
        with self.assertRaisesRegex(ValueError, "Build prefix differs"):
            sidecar.create_receipt(
                version=self.version, source_sha=self.source_sha,
                run_id=self.run_id, run_attempt=self.run_attempt,
                workflow_ref=self.workflow_ref, workflow_sha=self.workflow_sha,
                build_prefix=self.prefix.replace(self.source_sha, "c" * 40),
                artifact_path=self.artifact, signature_path=self.signature,
                output_path=self.output)

    def test_non_main_workflow_ref_is_refused(self):
        with self.assertRaisesRegex(ValueError, "approved.*main workflow"):
            sidecar.create_receipt(
                version=self.version, source_sha=self.source_sha,
                run_id=self.run_id, run_attempt=self.run_attempt,
                workflow_ref=self.workflow_ref.replace("refs/heads/main", "refs/pull/1/merge"),
                workflow_sha=self.workflow_sha, build_prefix=self.prefix,
                artifact_path=self.artifact, signature_path=self.signature,
                output_path=self.output)

    def test_workflow_sha_must_be_the_artifact_source(self):
        with self.assertRaisesRegex(ValueError, "same commit"):
            sidecar.create_receipt(
                version=self.version, source_sha=self.source_sha,
                run_id=self.run_id, run_attempt=self.run_attempt,
                workflow_ref=self.workflow_ref, workflow_sha="b" * 40,
                build_prefix=self.prefix, artifact_path=self.artifact,
                signature_path=self.signature, output_path=self.output)

    def test_ambiguous_cli_or_symlink_entry_is_refused(self):
        def add_second(root):
            second = root / "other" / "buzz"
            second.parent.mkdir()
            second.write_bytes(b"other")
            second.chmod(0o755)

        with self.assertRaisesRegex(ValueError, "found 2"):
            self.create(add_second)

        self.output.unlink(missing_ok=True)

        def add_symlink(root):
            (root / "other").mkdir()
            (root / "other" / "buzz").symlink_to(root / "usr" / "bin" / "buzz")

        with self.assertRaisesRegex(ValueError, "non-regular"):
            self.create(add_symlink)

    def test_existing_receipt_is_never_overwritten(self):
        self.output.parent.mkdir()
        self.output.write_text("existing")
        with patch.object(sidecar.minisign, "pinned_public_key", return_value=fixture.PUBLIC_KEY), \
             patch.object(sidecar.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)):
            # Validation can fail earlier during extraction, but must not replace the output.
            with self.assertRaises(ValueError):
                sidecar.create_receipt(
                    version=self.version, source_sha=self.source_sha,
                    run_id=self.run_id, run_attempt=self.run_attempt,
                    workflow_ref=self.workflow_ref, workflow_sha=self.workflow_sha,
                    build_prefix=self.prefix, artifact_path=self.artifact,
                    signature_path=self.signature, output_path=self.output)
        self.assertEqual(self.output.read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
