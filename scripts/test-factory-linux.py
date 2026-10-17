"""Exercise the Factory shell entrypoint without compiling Buzz (Linux only)."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("factory-linux.sh")


@unittest.skipUnless(os.uname().sysname == "Linux", "Factory execution is Linux-only")
class FactoryLinuxTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="factory-contract-", dir="/workspace"))
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "bin").mkdir()
        (self.root / "bin/activate-hermit").write_text('export PATH="$PWD/bin:$PATH"\n')
        shutil.copyfile(SCRIPT, self.root / "factory-linux.sh")
        self.record = self.root / "commands.jsonl"
        self.shared = self.root / "shared-target"
        self.shared.mkdir()
        (self.shared / "keep").write_text("peer cache")
        stub = r"""#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
target = pathlib.Path(os.environ["CARGO_TARGET_DIR"])
with open(os.environ["RECORD"], "a") as f:
    f.write(json.dumps({"name": name, "args": sys.argv[1:], "target": str(target),
        "incremental": os.environ.get("CARGO_INCREMENTAL"),
        "dev_debug": os.environ.get("CARGO_PROFILE_DEV_DEBUG"),
        "test_debug": os.environ.get("CARGO_PROFILE_TEST_DEBUG")}) + "\n")
if name == "just":
    if sys.argv[1] == "test-unit":
        assert not (target / "test-objects").exists(), "Clippy objects were retained"
    target.mkdir(parents=True, exist_ok=True)
    (target / "test-objects").write_text("generated")
    if os.environ.get("JUST_FAIL_PHASE", sys.argv[1]) == sys.argv[1]:
        sys.exit(int(os.environ.get("JUST_EXIT", "0")))
if name == "cargo" and sys.argv[1] == "clean":
    assert sys.argv[2:] == ["--target-dir", str(target)]
    assert target.parent == pathlib.Path.cwd() / ".tmp"
    shutil.rmtree(target)
if name == "cargo" and sys.argv[1] == "build":
    assert not (target / "test-objects").exists()
    (target / "release").mkdir(parents=True)
    for binary in ("buzz", "buzz-relay"):
        (target / "release" / binary).write_text("fixture")
"""
        # python3 itself must stay real because it runs these tiny stubs.
        for name in ("node", "just", "cargo"):
            p = self.root / "bin" / name
            p.write_text(stub)
            p.chmod(0o755)
        (self.root / "scripts").mkdir()
        for name in (
            "test-enrichlayer-updater.py",
            "test-buzz-r2.py",
            "test-factory-linux.py",
        ):
            (self.root / "scripts" / name).write_text("pass\n")
        shutil.copyfile(
            SCRIPT.with_name("factory-failure-summary.py"),
            self.root / "scripts/factory-failure-summary.py",
        )

    def run_check(self, command="check", **extra):
        env = {
            **os.environ,
            "RECORD": str(self.record),
            "CARGO_TARGET_DIR": str(self.shared),
            **extra,
        }
        return subprocess.run(
            ["bash", "factory-linux.sh", command],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )

    def test_setup_refuses_missing_git_capability_before_install(self):
        for name in ("cc", "cmake", "pkg-config"):
            tool = self.root / "bin" / name
            tool.write_text("#!/bin/sh\nexit 0\n")
            tool.chmod(0o755)
        git = self.root / "bin/git"
        for status, capability in (
            (129, ""),
            (0, "capability other"),
            (0, "capability authtype"),
        ):
            with self.subTest(status=status, capability=capability):
                git.write_text(
                    "#!/usr/bin/env python3\nimport sys\n"
                    "if sys.argv[1:] == ['--version']:\n print('git version fixture')\n"
                    f"else:\n print({capability!r}); sys.exit({status})\n"
                )
                git.chmod(0o755)
                result = self.run_check(command="setup")
                if capability == "capability authtype":
                    self.assertEqual(result.returncode, 0, result.stderr)
                    records = [
                        json.loads(line)
                        for line in self.record.read_text().splitlines()
                    ]
                    self.assertEqual(
                        [r["args"] for r in records], [["desktop-install-ci"]]
                    )
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("git version fixture", result.stderr)
                    self.assertIn("lacks credential authtype", result.stderr)
                    self.assertFalse(
                        self.record.exists(),
                        "setup ran expensive install before refusing Git",
                    )

    def test_complete_suite_and_isolated_release_artifact(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        checks = [r for r in records if r["name"] == "just"]
        self.assertEqual(
            [arg for r in checks for arg in r["args"]],
            [
                "fmt-check",
                "clippy",
                "test-unit",
                "desktop-check",
                "desktop-test",
                "desktop-build",
                "web-build",
            ],
        )
        self.assertTrue(
            all(
                r[k] == "0"
                for r in records
                for k in ("incremental", "dev_debug", "test_debug")
            )
        )
        self.assertEqual(
            [r["args"][0] for r in records if r["name"] == "cargo"],
            ["clean", "clean", "build"],
        )
        self.assertEqual((self.shared / "keep").read_text(), "peer cache")
        self.assertTrue(
            (self.root / ".tmp/factory-artifacts/buzz-linux.tar.gz").is_file()
        )

    def test_check_disables_incremental_even_when_inherited(self):
        # DEV-13542: an inherited CARGO_INCREMENTAL=1 must not re-enable the
        # incremental cache that exhausted the remote workspace.
        result = self.run_check(CARGO_INCREMENTAL="1")
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        self.assertTrue(records)
        self.assertTrue(all(r["incremental"] == "0" for r in records), records)

    def test_unit_failure_after_clippy_cleanup_preserves_verdict(self):
        result = self.run_check(JUST_EXIT="19", JUST_FAIL_PHASE="test-unit")
        self.assertEqual(result.returncode, 19, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        self.assertEqual(
            [r["args"][0] for r in records if r["name"] == "cargo"], ["clean"]
        )
        self.assertEqual((self.shared / "keep").read_text(), "peer cache")
        self.assertFalse(
            (self.root / ".tmp/factory-artifacts/buzz-linux.tar.gz").is_file()
        )

    def test_failure_propagates_and_does_not_build_release(self):
        result = self.run_check(JUST_EXIT="19")
        self.assertEqual(result.returncode, 19, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        self.assertFalse(any(r["name"] == "cargo" for r in records))
        self.assertEqual((self.shared / "keep").read_text(), "peer cache")

    def test_failed_assertion_survives_later_passing_output(self):
        just = self.root / "bin/just"
        just.write_text(
            "#!/usr/bin/env python3\n"
            "print(\"thread 'acp::trust' panicked at expected.rs:1:1:\\nexpected\")\n"
            "print('test acp::trust ... ok')\n"
            "print('test result: ok. 1 passed; 0 failed')\n"
            "print(\"thread 'acp::trust' (123) panicked at trust.rs:12:3:\\n"
            'assertion `left == right` failed\\n  left: 401\\n right: 200")\n'
            "print('test acp::trust ... FAILED')\n"
            "print('test result: FAILED. 0 passed; 1 failed')\n"
            "print('passing test output\\n' * 2000)\n"
            "raise SystemExit(19)\n"
        )
        result = self.run_check()
        self.assertEqual(result.returncode, 19)
        self.assertIn("left: 401", result.stderr[-4096:])
        self.assertIn("right: 200", result.stderr[-4096:])
        self.assertNotIn("expected.rs", result.stderr)
        self.assertLess(len(result.stderr.encode()), 4096)

    def test_summary_bounds_large_unicode_logs(self):
        log = self.root / "large.log"
        log.write_text(
            "x" * (4 * 1024 * 1024 + 100)
            + "\n"
            + "\n".join(
                f"thread 'failure_{n}' panicked at test.rs:1:1:\n"
                + "Ω" * 2000
                + f"\ntest failure_{n} ... FAILED\n"
                for n in range(20)
            )
            + "\ntest result: FAILED. 0 passed; 20 failed\n"
        )
        result = subprocess.run(
            ["python3", "scripts/factory-failure-summary.py", str(log)],
            cwd=self.root,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.stdout), 3001)
        self.assertIn("failure_0", result.stdout.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
