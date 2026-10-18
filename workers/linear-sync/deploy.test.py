"""Render the actual Quadlet template and verify private non-root runtime inputs."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import unittest

import jinja2
import yaml

ROOT = Path(__file__).parent / ".deploy"


def runtime_command(rendered, image, data_dir=None):
    """Exercise the rendered worker's user and tmpfs options with real Podman."""
    command = ["podman", "run", "--rm", "--network=none"]
    for line in rendered.splitlines():
        if line.startswith("User="):
            command.extend(["--user", line.removeprefix("User=")])
        elif line.startswith("Tmpfs="):
            command.extend(["--tmpfs", line.removeprefix("Tmpfs=")])
        elif line == "ReadOnly=true":
            command.append("--read-only")
    if data_dir:
        # Stand-in for the Quadlet named volume, which is owned by uid/gid 1000
        # (see the .volume unit in manifest.yaml). A bind mount lets the test
        # prove the read-only rootfs still leaves /data writable to the worker.
        command.extend(["--volume", f"{data_dir}:/data"])
    command.extend(["--entrypoint=node", image, "-e", r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(process.getuid(), 1000);
const home = fs.statSync('/home/node');
assert.equal(home.uid, 1000);
assert.equal(home.gid, 1000);
assert.equal(home.mode & 0o777, 0o700);
fs.writeFileSync('/home/node/probe', 'private', {mode: 0o600});
assert.equal(fs.readFileSync('/home/node/probe', 'utf8'), 'private');
fs.writeFileSync('/tmp/probe', 'temporary');
fs.writeFileSync('/data/probe', 'private', {mode: 0o600});
assert.equal(fs.readFileSync('/data/probe', 'utf8'), 'private');
const root = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  .split('\n').find(line => line.split(' ')[4] === '/');
assert.ok(root.split(' ')[5].split(',').includes('ro'));
assert.throws(() => fs.writeFileSync('/rootfs-write-probe', 'no'));
console.log('worker tmpfs runtime passed');
console.log('worker data volume passed');
"""])
    return command


def render(image):
    environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
    environment.tests["match"] = lambda value, pattern: re.match(pattern, value) is not None
    environment.globals["undef"] = lambda hint: jinja2.StrictUndefined(hint=hint)
    environment.filters["mandatory"] = lambda value: str(value)
    return environment.from_string((ROOT / "worker.container.j2").read_text()).render(
        buzz_linear_sync_image=image,
        buzz_linear_sync_task_queue="buzz-linear-test",
        buzz_linear_sync_temporal_address="temporal.test:7233",
        buzz_linear_sync_temporal_namespace="default",
    )


class DeploymentContract(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("BUZZ_LINEAR_PODMAN_TEST_IMAGE"), "requires Linux Podman")
    def test_non_root_private_home_is_writable_in_podman(self):
        image = os.environ["BUZZ_LINEAR_PODMAN_TEST_IMAGE"]
        rendered = render("ghcr.io/enrichlayer/buzz-linear-sync@sha256:" + "a" * 64)
        data_dir = tempfile.mkdtemp(prefix="buzz-linear-data-")
        try:
            # Mirror the Quadlet named volume's ownership so the probe runs as
            # the worker uid on a volume it should be able to write.
            os.chown(data_dir, 1000, 1000)
            result = subprocess.run(
                runtime_command(rendered, image, data_dir),
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("worker tmpfs runtime passed", result.stdout)
            self.assertIn("worker data volume passed", result.stdout)
        finally:
            shutil.rmtree(data_dir, ignore_errors=True)

    def test_only_immutable_owned_images_can_render(self):
        for bad in ["", "ghcr.io/enrichlayer/buzz-linear-sync:latest", "example.test/worker@sha256:" + "a" * 64]:
            with self.assertRaises(jinja2.UndefinedError):
                render(bad)
        rendered = render("ghcr.io/enrichlayer/buzz-linear-sync@sha256:" + "a" * 64)
        self.assertIn("Environment=TASK_QUEUE=buzz-linear-test", rendered)
        self.assertIn("User=1000:1000", rendered)
        self.assertIn("ReadOnly=true", rendered)
        self.assertIn("Volume=buzz-linear-sync-private.volume:/data", rendered)

    def test_config_is_readable_by_worker_but_credentials_remain_root_only(self):
        manifest = yaml.safe_load((ROOT / "manifest.yaml").read_text())
        self.assertEqual(manifest["hosts"], "ovh-us-east-vin-1b")
        files = {item["dst"]: item for item in manifest["contents"]}
        config = files["/etc/buzz-linear-sync-private/config.json"]["file_info"]
        self.assertEqual(config, {"mode": "0600", "owner": "1000", "group": "1000"})
        for name in ["runtime.env", "registry-auth.json"]:
            self.assertEqual(files[f"/etc/buzz-linear-sync-private/{name}"]["file_info"]["owner"], "root")
            self.assertEqual(files[f"/etc/buzz-linear-sync-private/{name}"]["file_info"]["mode"], "0600")
        # The named volume the worker writes its outbox to must be owned by the
        # worker uid/gid, or the first boot fails with a read-only /data.
        volume = files["/etc/containers/systemd/buzz-linear-sync-private.volume"]["content"]
        self.assertIn("User=1000", volume)
        self.assertIn("Group=1000", volume)


if __name__ == "__main__":
    unittest.main()
