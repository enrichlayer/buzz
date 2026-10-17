"""Exercise the remote recipe's environment and failure propagation without builds."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("factory-linux.sh").resolve()


class FactoryLinuxContract(unittest.TestCase):
    def run_recipe(self, incremental, fail=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "bin/activate-hermit").write_text("")
            log = root / "commands.log"
            env = os.environ.copy()
            env.update(COMMAND_LOG=str(log), FAIL_CHECK="1" if fail else "0")
            env.pop("CARGO_INCREMENTAL", None)
            if incremental is not None:
                env["CARGO_INCREMENTAL"] = incremental
            # Model the admitted Linux environment only for this command-contract
            # test. Compiler commands are test doubles; this is not a build pass.
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    r'''
uname() { printf 'Linux\n'; }
record() { printf '%s|%s\n' "$(sh -c 'printf "%s" "${CARGO_INCREMENTAL-unset}"')" "$*" >> "$COMMAND_LOG"; }
node() { record node "$@"; }
python3() { record python3 "$@"; }
just() { record just "$@"; if [[ "$FAIL_CHECK" == 1 ]]; then return 47; fi; }
cargo() { record cargo "$@"; }
tar() { record tar "$@"; }
PWD=/workspace/contract-fixture
source "$1" check
''',
                    "factory-linux-contract",
                    str(SCRIPT),
                ],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, log.read_text().splitlines()

    def test_check_disables_incremental_even_when_inherited(self):
        for inherited in (None, "0", "1"):
            with self.subTest(inherited=inherited):
                result, commands = self.run_recipe(inherited)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(commands)
                self.assertTrue(all(line.startswith("0|") for line in commands), commands)
                self.assertIn(
                    "0|just fmt-check clippy test-unit desktop-check desktop-test desktop-build web-build",
                    commands,
                )
                self.assertIn(
                    "0|cargo build --locked --release -p buzz-relay -p buzz-cli",
                    commands,
                )
                self.assertEqual(
                    commands[-1],
                    "0|tar -czf .tmp/factory-artifacts/buzz-linux.tar.gz -C target/release buzz-relay buzz",
                )

    def test_failed_check_keeps_failure_and_does_not_package(self):
        result, commands = self.run_recipe("1", fail=True)
        self.assertEqual(result.returncode, 47, result.stderr)
        self.assertFalse(any("|cargo " in line or "|tar " in line for line in commands))


if __name__ == "__main__":
    unittest.main()
