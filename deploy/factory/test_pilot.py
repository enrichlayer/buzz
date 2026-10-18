"""Exercise the actual deployment templates and fail-closed apply boundary."""

import base64
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import jinja2
import yaml

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("pilot", HERE / "pilot.py")
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)
HEALTHY_STATUS = {
    "build": {"source_sha": "b" * 40},
    "dependencies": {
        "sample": "fresh",
        "reason": "ready",
        "postgres": True,
        "redis": True,
        "deletion_catalog": True,
    },
}


class PilotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.variables = {
            "buzz_pilot_image": "ghcr.io/enrichlayer/buzz@sha256:" + "a" * 64,
            "buzz_pilot_source_sha": "b" * 40,
            "buzz_pilot_postgres_image": "docker.io/library/postgres@sha256:"
            + "c" * 64,
            "buzz_pilot_redis_image": "docker.io/library/redis@sha256:" + "d" * 64,
            "buzz_pilot_hostname": "buzz-pilot.enrichlayer.com",
            "buzz_pilot_http_port": 13415,
            "buzz_pilot_runtime": {
                "owner-public-key": "1" * 64,
                "relay-private-key": "2" * 64,
                "git-hook-secret": "3" * 64,
                "postgres-password": "4" * 64,
                "redis-password": "5" * 64,
            },
            "buzz_pilot_media": {
                "endpoint": "https://" + "6" * 32 + ".r2.cloudflarestorage.com",
                "access-key-id": "7" * 32,
                "secret-access-key": "8" * 64,
            },
        }
        self.environment = jinja2.Environment(
            undefined=jinja2.StrictUndefined, keep_trailing_newline=True
        )
        self.environment.filters["to_json"] = json.dumps
        self.render()
        (self.root / "registry-auth.json").write_text(
            json.dumps(
                {
                    "auths": {
                        "ghcr.io": {
                            "auth": base64.b64encode(b"fixture:fixture").decode(),
                        }
                    }
                }
            )
        )

    def render(self):
        for name in ("runtime.env", "postgres.env", "redis.conf", "expected.json"):
            template = (HERE / ".deploy/templates" / (name + ".j2")).read_text()
            (self.root / name).write_text(
                self.environment.from_string(template).render(self.variables)
            )

    def test_production_templates_validate(self):
        self.assertEqual(pilot.validate(self.root)["source_sha"], "b" * 40)

    def test_failures_never_touch_services_or_pull_images(self):
        original = (self.root / "runtime.env").read_text()
        mutations = [
            original.replace(
                "BUZZ_REQUIRE_RELAY_MEMBERSHIP=true",
                "BUZZ_REQUIRE_RELAY_MEMBERSHIP=false",
            ),
            original.replace(
                "BUZZ_REQUIRE_AUTH_TOKEN=true", "BUZZ_REQUIRE_AUTH_TOKEN=false"
            ),
            original.replace(
                "BUZZ_S3_BUCKET=buzz-pilot-media", "BUZZ_S3_BUCKET=buzz-builds"
            ),
            original.replace("@buzz-relay-pilot-postgres:", "@production-postgres:"),
            original + "BUZZ_ADMIN_AUTH=disabled\n",
            original + "BUZZ_REQUIRE_RELAY_MEMBERSHIP=false\n",
            original.replace("BUZZ_S3_ENDPOINT=https://", "BUZZ_S3_ENDPOINT=http://"),
        ]
        for content in mutations:
            with (
                self.subTest(content=mutations.index(content)),
                patch.object(pilot, "run") as run,
            ):
                (self.root / "runtime.env").write_text(content)
                with self.assertRaises(ValueError):
                    pilot.apply(self.root)
                run.assert_not_called()

    def test_mutable_and_other_repository_images_are_refused(self):
        for image in (
            "ghcr.io/enrichlayer/buzz:main",
            "ghcr.io/block/buzz@sha256:" + "a" * 64,
        ):
            self.variables["buzz_pilot_image"] = image
            self.render()
            with patch.object(pilot, "run") as run, self.assertRaises(ValueError):
                pilot.apply(self.root)
            run.assert_not_called()

    def test_template_secret_newline_is_rejected_without_disclosure(self):
        self.variables["buzz_pilot_runtime"]["relay-private-key"] = (
            "DO_NOT_PRINT\nBUZZ_ADMIN_AUTH=disabled"
        )
        self.render()
        result = subprocess.run(
            ["python3", str(HERE / "pilot.py"), "validate", "--root", str(self.root)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("DO_NOT_PRINT", result.stdout + result.stderr)

    def test_wrong_running_source_is_never_success(self):
        with (
            patch.object(
                pilot,
                "run",
                return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps({"build": {"source_sha": "f" * 40}}).encode()
                ),
            ),
            self.assertRaisesRegex(ValueError, "source revision differs"),
        ):
            pilot.verify(pilot.validate(self.root))

    def test_wrong_running_image_is_never_success(self):
        with (
            patch.object(
                pilot,
                "run",
                side_effect=[
                    subprocess.CompletedProcess([], 0, b"sha256:" + b"a" * 64),
                    subprocess.CompletedProcess([], 0, b"b" * 64),
                ],
            ),
            self.assertRaisesRegex(ValueError, "running container differs"),
        ):
            pilot.verify(pilot.validate(self.root))

    def test_missing_or_stale_dependencies_are_not_success(self):
        for dependencies in (
            {},
            {**HEALTHY_STATUS["dependencies"], "sample": "stale"},
            {**HEALTHY_STATUS["dependencies"], "redis": False},
        ):
            response = {"build": HEALTHY_STATUS["build"], "dependencies": dependencies}
            with (
                patch.object(
                    pilot,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 0, json.dumps(response).encode()
                    ),
                ),
                self.assertRaisesRegex(ValueError, "diagnostics"),
            ):
                pilot.verify(pilot.validate(self.root))

    def test_apply_deadline_stops_before_next_operation(self):
        with (
            patch.object(pilot.time, "monotonic", side_effect=[0, 511]),
            patch.object(pilot, "run") as run,
            self.assertRaisesRegex(RuntimeError, "deployment deadline exceeded"),
        ):
            pilot.apply(self.root)
        run.assert_not_called()

    def test_apply_pulls_all_images_before_restart_and_checks_running_source(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(
                args, 0, json.dumps(HEALTHY_STATUS).encode()
            )

        with patch.object(pilot, "run", side_effect=run):
            result = pilot.apply(self.root)
        self.assertTrue(result["native_build_identity_verified"])
        self.assertEqual([call[:2] for call in calls[:3]], [["podman", "pull"]] * 3)
        self.assertEqual(calls[-1][-1], "http://127.0.0.1:8080/_status")

    def test_pull_failure_keeps_current_services_running(self):
        with (
            patch.object(
                pilot, "run", side_effect=RuntimeError("registry unavailable")
            ) as run,
            self.assertRaises(RuntimeError),
        ):
            pilot.apply(self.root)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][:2], ["podman", "pull"])

    def test_package_installs_real_controller_and_preserves_volumes(self):
        manifest = yaml.safe_load((HERE / ".deploy/manifest.yaml").read_text())
        controller = next(
            x
            for x in manifest["contents"]
            if x["dst"] == "/usr/local/libexec/buzz-relay-pilot"
        )
        self.assertEqual(
            (HERE / ".deploy" / controller["src"]).resolve(),
            (HERE / "pilot.py").resolve(),
        )
        self.assertIn(
            "/usr/local/libexec/buzz-relay-pilot apply",
            manifest["scripts"]["post_install"][0]["cmd"],
        )
        for value in manifest["scripts"].values():
            for hook in value:
                self.assertNotIn("volume rm", hook["cmd"])
        for service in ("postgres", "redis", "relay"):
            text = self.environment.from_string(
                (HERE / ".deploy/templates" / (service + ".container.j2")).read_text()
            ).render(self.variables)
            ports = [
                line for line in text.splitlines() if line.startswith("PublishPort=")
            ]
            self.assertEqual(
                ports,
                ["PublishPort=127.0.0.1:13415:3000"] if service == "relay" else [],
            )
        tunnel = yaml.safe_load((HERE / ".deploy/tunnel.yaml").read_text())
        self.assertEqual(
            tunnel["ingress"][0]["hostname"], self.variables["buzz_pilot_hostname"]
        )
        self.assertEqual(tunnel["ingress"][0]["service"], "http://localhost:13415")
        self.assertFalse(tunnel["ingress"][0]["access"])

    @unittest.skipUnless(
        Path("/usr/libexec/podman/quadlet").is_file(), "requires Linux Podman Quadlet"
    )
    def test_real_quadlet_generator_accepts_the_rendered_package(self):
        units = self.root / "quadlets"
        units.mkdir()
        manifest = yaml.safe_load((HERE / ".deploy/manifest.yaml").read_text())
        for item in manifest["contents"]:
            if not item["dst"].startswith("/etc/containers/systemd/"):
                continue
            source = (
                (HERE / ".deploy" / item["src"]).read_text()
                if "src" in item
                else item["content"]
            )
            (units / Path(item["dst"]).name).write_text(
                self.environment.from_string(source).render(self.variables)
            )
        result = subprocess.run(
            ["/usr/libexec/podman/quadlet", "-dryrun", "-no-kmsg-log"],
            env={**os.environ, "QUADLET_UNIT_DIRS": str(units)},
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in (
            "buzz-relay-pilot",
            "buzz-relay-pilot-postgres",
            "buzz-relay-pilot-redis",
        ):
            self.assertIn(name + ".service", result.stdout)
        self.assertIn("--network-alias=buzz-relay-pilot-postgres", result.stdout)
        self.assertIn("--network-alias=buzz-relay-pilot-redis", result.stdout)
        self.assertIn("--stop-timeout=60", result.stdout)


if __name__ == "__main__":
    unittest.main()
