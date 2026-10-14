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
    (target / "test-objects").write_text("generated")
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

    def run_check(self, **extra):
        env = {
            **os.environ,
            "RECORD": str(self.record),
            "CARGO_TARGET_DIR": str(self.shared),
            **extra,
        }
        return subprocess.run(
            ["bash", "factory-linux.sh", "check"],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )

    def test_complete_suite_and_isolated_release_artifact(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        checks = next(r for r in records if r["name"] == "just")
        self.assertEqual(
            checks["args"],
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
            [r["args"][0] for r in records if r["name"] == "cargo"], ["clean", "build"]
        )
        self.assertEqual((self.shared / "keep").read_text(), "peer cache")
        self.assertTrue(
            (self.root / ".tmp/factory-artifacts/buzz-linux.tar.gz").is_file()
        )

    def test_failure_propagates_and_does_not_build_release(self):
        result = self.run_check(JUST_EXIT="19")
        self.assertEqual(result.returncode, 19, result.stderr + result.stdout)
        records = [json.loads(line) for line in self.record.read_text().splitlines()]
        self.assertFalse(any(r["name"] == "cargo" for r in records))
        self.assertEqual((self.shared / "keep").read_text(), "peer cache")


if __name__ == "__main__":
    unittest.main()
