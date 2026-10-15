#!/usr/bin/env python3
"""Exercise snapshot portability without exposing fixture credentials."""
import errno
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "source_scan", Path(__file__).with_name("check-source-scan-policy.py")
)
SOURCE_SCAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOURCE_SCAN)


class SnapshotTests(unittest.TestCase):
    def test_same_device_uses_hard_link(self):
        with tempfile.TemporaryDirectory() as directory:
            original, snapshot = Path(directory) / "original", Path(directory) / "snapshot"
            original.write_bytes(b"tracked fixture\n")
            SOURCE_SCAN.snapshot_file(original, snapshot)
            self.assertTrue(original.samefile(snapshot))

    def test_cross_device_copies_exact_bytes_without_modifying_source(self):
        with tempfile.TemporaryDirectory() as directory:
            original, snapshot = Path(directory) / "original", Path(directory) / "snapshot"
            original.write_bytes(b"tracked fixture\n")
            with patch.object(SOURCE_SCAN.os, "link", side_effect=OSError(errno.EXDEV, "cross-device")):
                SOURCE_SCAN.snapshot_file(original, snapshot)
            self.assertEqual(snapshot.read_bytes(), original.read_bytes())
            self.assertFalse(original.samefile(snapshot))
            snapshot.write_bytes(b"changed snapshot\n")
            self.assertEqual(original.read_bytes(), b"tracked fixture\n")

    def test_other_link_errors_propagate_without_copying(self):
        error = PermissionError(errno.EACCES, "permission denied")
        with patch.object(SOURCE_SCAN.os, "link", side_effect=error), patch.object(SOURCE_SCAN.shutil, "copy2") as copy:
            with self.assertRaises(PermissionError) as raised:
                SOURCE_SCAN.snapshot_file(Path("original"), Path("snapshot"))
            self.assertIs(raised.exception, error)
            copy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
