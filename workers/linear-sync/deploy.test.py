"""Render the actual Quadlet template and verify private non-root runtime inputs."""
from pathlib import Path
import re
import unittest

import jinja2
import yaml

ROOT = Path(__file__).parent / ".deploy"


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


if __name__ == "__main__":
    unittest.main()
