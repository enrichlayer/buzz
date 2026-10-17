#!/usr/bin/env python3
"""Validate and apply the infractl-installed Buzz pilot, without building images."""

import argparse
import base64
import binascii
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/etc/buzz-relay-pilot")
NAME = "buzz-relay-pilot"
HEX64 = re.compile(r"[0-9a-f]{64}")
DIGEST = r"@sha256:[0-9a-f]{64}"


def read_small(path):
    """Read a bounded configuration file; errors never include file contents."""
    with path.open("rb") as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError(f"{path.name}: configuration exceeds 64 KiB")
    return data.decode("utf-8")


def read_env(path):
    result = {}
    for line in read_small(path).splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in result:
            raise ValueError(f"{path.name}: invalid or duplicate environment entry")
        result[key] = value
    return result


def validate(root):
    """Fail before pulling images or touching services on an unsafe configuration."""
    expected = json.loads(read_small(root / "expected.json"))
    for key, repository in (
        ("image", "ghcr.io/enrichlayer/buzz"),
        ("postgres_image", "docker.io/library/postgres"),
        ("redis_image", "docker.io/library/redis"),
    ):
        if not re.fullmatch(re.escape(repository) + DIGEST, expected.get(key, "")):
            raise ValueError(
                f"{key}: require the approved repository and immutable digest"
            )
    if not re.fullmatch(r"[0-9a-f]{40}", expected.get("source_sha", "")):
        raise ValueError("source_sha: require a full source revision")
    # Tunnel manifest and package identity deliberately describe one pilot.
    if (
        expected.get("hostname") != "buzz-pilot.enrichlayer.com"
        or expected.get("http_port") != 13415
    ):
        raise ValueError("hostname/port must match the managed pilot tunnel")
    registry = json.loads(read_small(root / "registry-auth.json"))
    try:
        auths = registry["auths"]
        credential = base64.b64decode(auths["ghcr.io"]["auth"], validate=True).decode()
        if (
            set(registry) != {"auths"}
            or set(auths) != {"ghcr.io"}
            or ":" not in credential
        ):
            raise ValueError("invalid registry configuration")
        username, password = credential.split(":", 1)
        if not username or not password or "\n" in credential:
            raise ValueError("invalid registry credential")
    except (KeyError, TypeError, ValueError, binascii.Error):
        raise ValueError(
            "registry-auth.json: require a dedicated ghcr.io pull credential"
        ) from None
    runtime = read_env(root / "runtime.env")
    postgres = read_env(root / "postgres.env")
    fixed = {
        "BUZZ_BIND_ADDR": "0.0.0.0:3000",
        "BUZZ_HEALTH_PORT": "8080",
        "BUZZ_METRICS_PORT": "9102",
        "RELAY_URL": "wss://buzz-pilot.enrichlayer.com",
        "BUZZ_MEDIA_BASE_URL": "https://buzz-pilot.enrichlayer.com/media",
        "BUZZ_CORS_ORIGINS": "https://buzz-pilot.enrichlayer.com",
        "BUZZ_REQUIRE_AUTH_TOKEN": "true",
        "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "true",
        "BUZZ_ALLOW_NIP_OA_AUTH": "true",
        "BUZZ_S3_BUCKET": "buzz-pilot-media",
        "BUZZ_S3_REGION": "auto",
        "BUZZ_S3_ADDRESSING_STYLE": "path",
        "BUZZ_GIT_REPO_PATH": "/data/git",
        "BUZZ_AUTO_MIGRATE": "true",
        "BUZZ_GIT_CONFORMANCE_PROBE": "true",
        "BUZZ_PUSH_ENABLED": "false",
        "BUZZ_SERVE_GIT_WEB_GUI": "true",
        "RUST_LOG": "buzz_relay=info,buzz_db=info,buzz_auth=info",
    }
    dynamic = {
        "RELAY_OWNER_PUBKEY",
        "BUZZ_RELAY_PRIVATE_KEY",
        "BUZZ_GIT_HOOK_HMAC_SECRET",
        "DATABASE_URL",
        "REDIS_URL",
        "BUZZ_S3_ENDPOINT",
        "BUZZ_S3_ACCESS_KEY",
        "BUZZ_S3_SECRET_KEY",
    }
    if set(runtime) != set(fixed) | dynamic:
        raise ValueError("runtime.env: missing or unexpected environment entries")
    for key, value in fixed.items():
        if runtime[key] != value:
            raise ValueError(f"{key}: pilot security or routing contract differs")
    for key in (
        "RELAY_OWNER_PUBKEY",
        "BUZZ_RELAY_PRIVATE_KEY",
        "BUZZ_GIT_HOOK_HMAC_SECRET",
    ):
        if not HEX64.fullmatch(runtime[key]) or runtime[key] == "0" * 64:
            raise ValueError(f"{key}: require a nonzero 64-character hex value")
    if set(postgres) != {"POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD", "PGDATA"}:
        raise ValueError("postgres.env: missing or unexpected environment entries")
    if (postgres["POSTGRES_USER"], postgres["POSTGRES_DB"], postgres["PGDATA"]) != (
        "buzz",
        "buzz",
        "/var/lib/postgresql/data/pgdata",
    ) or not HEX64.fullmatch(postgres["POSTGRES_PASSWORD"]):
        raise ValueError("postgres.env: invalid database configuration")
    if runtime["DATABASE_URL"] != (
        f"postgres://buzz:{postgres['POSTGRES_PASSWORD']}@{NAME}-postgres:5432/buzz"
    ):
        raise ValueError("DATABASE_URL: must match the private pilot database")
    redis = re.fullmatch(
        r"redis://:([0-9a-f]{64})@buzz-relay-pilot-redis:6379", runtime["REDIS_URL"]
    )
    if not redis or read_small(root / "redis.conf") != (
        "bind 0.0.0.0\nprotected-mode yes\nappendonly yes\ndir /data\n"
        f"requirepass {redis[1]}\nmaxmemory 192mb\nmaxmemory-policy noeviction\n"
    ):
        raise ValueError(
            "redis.conf: must match the private authenticated Redis configuration"
        )
    if not re.fullmatch(
        r"https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com", runtime["BUZZ_S3_ENDPOINT"]
    ):
        raise ValueError("BUZZ_S3_ENDPOINT: require an account R2 HTTPS endpoint")
    for key, length in (("BUZZ_S3_ACCESS_KEY", 32), ("BUZZ_S3_SECRET_KEY", 64)):
        if not re.fullmatch(r"[0-9a-f]{" + str(length) + "}", runtime[key]):
            raise ValueError(f"{key}: missing or malformed bucket-scoped credential")
    return expected


def run(argv, *, check=True, capture=False, timeout=60):
    # Only the bounded curl response is captured. Image pulls and systemd commands
    # inherit neither a shell nor a credential-bearing environment dump.
    result = subprocess.run(
        argv,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode:
        raise RuntimeError(
            f"{argv[0]} {argv[1]} failed (exit {result.returncode}); inspect the service journal"
        )
    return result


def wait_for(probe, label, attempts=30):
    for attempt in range(attempts):
        if probe():
            return
        if attempt + 1 < attempts:
            time.sleep(3)
    raise RuntimeError(
        f"{label}: readiness deadline exceeded; inspect the service journal"
    )


def read_status(execute):
    response = execute(
        [
            "podman",
            "exec",
            NAME,
            "curl",
            "--fail",
            "--silent",
            "--max-time",
            "5",
            "--max-filesize",
            "65536",
            "http://127.0.0.1:8080/_status",
        ],
        capture=True,
    )
    return json.loads(response.stdout)


def dependencies_ready(status):
    dependencies = status.get("dependencies", {})
    return (
        dependencies.get("sample") == "fresh"
        and dependencies.get("reason") == "ready"
        and all(
            dependencies.get(key) is True
            for key in ("postgres", "redis", "deletion_catalog")
        )
    )


def verify(expected, execute=None):
    """Verify intrinsic build identity, not just process or HTTP availability."""
    execute = execute or run
    for suffix, field in (
        ("", "image"),
        ("-postgres", "postgres_image"),
        ("-redis", "redis_image"),
    ):
        actual = execute(
            ["podman", "container", "inspect", "--format", "{{.Image}}", NAME + suffix],
            capture=True,
        ).stdout.strip()
        admitted = execute(
            ["podman", "image", "inspect", "--format", "{{.Id}}", expected[field]],
            capture=True,
        ).stdout.strip()
        if not actual or actual.removeprefix(b"sha256:") != admitted.removeprefix(
            b"sha256:"
        ):
            raise ValueError(
                f"{field}: running container differs from the admitted image"
            )
    status = read_status(execute)
    if status.get("build", {}).get("source_sha") != expected["source_sha"]:
        raise ValueError(
            "running relay source revision differs from the admitted artifact"
        )
    if not dependencies_ready(status):
        raise ValueError("relay dependency diagnostics are missing, stale or unhealthy")
    return {
        "image": expected["image"],
        "source_sha": expected["source_sha"],
        "hostname": expected["hostname"],
        "native_build_identity_verified": True,
    }


def apply(root):
    expected = validate(root)
    deadline = time.monotonic() + 510

    def execute(argv, **kwargs):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(
                "deployment deadline exceeded; inspect the service journal"
            )
        kwargs["timeout"] = min(kwargs.get("timeout", 60), remaining)
        return run(argv, **kwargs)

    # All pulls complete before any current service is restarted.
    for field in ("image", "postgres_image", "redis_image"):
        execute(
            [
                "podman",
                "pull",
                "--authfile",
                str(root / "registry-auth.json"),
                expected[field],
            ],
            timeout=120,
        )
    execute(["systemctl", "daemon-reload"])
    execute(["systemctl", "restart", NAME + "-postgres.service"], timeout=120)
    wait_for(
        lambda: (
            execute(
                [
                    "podman",
                    "exec",
                    NAME + "-postgres",
                    "pg_isready",
                    "-U",
                    "buzz",
                    "-d",
                    "buzz",
                ],
                check=False,
                timeout=5,
            ).returncode
            == 0
        ),
        "Postgres",
    )
    execute(["systemctl", "restart", NAME + "-redis.service"], timeout=120)
    wait_for(
        lambda: (
            execute(
                [
                    "podman",
                    "exec",
                    NAME + "-redis",
                    "sh",
                    "-ec",
                    (
                        "export REDISCLI_AUTH=$(sed -n 's/^requirepass //p' /usr/local/etc/redis/redis.conf); "
                        'test "$(redis-cli ping)" = PONG'
                    ),
                ],
                check=False,
                timeout=5,
            ).returncode
            == 0
        ),
        "Redis",
    )
    execute(["systemctl", "restart", NAME + ".service"], timeout=180)
    wait_for(
        lambda: (
            execute(
                [
                    "podman",
                    "exec",
                    NAME,
                    "curl",
                    "--fail",
                    "--silent",
                    "--max-time",
                    "5",
                    "http://127.0.0.1:8080/_readiness",
                ],
                check=False,
                timeout=8,
            ).returncode
            == 0
        ),
        "Buzz relay",
    )
    wait_for(lambda: dependencies_ready(read_status(execute)), "Buzz dependencies")
    return verify(expected, execute)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "apply", "verify"))
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        if args.command == "apply":
            result = apply(args.root)
        else:
            expected = validate(args.root)
            result = (
                verify(expected)
                if args.command == "verify"
                else {"configuration_valid": True}
            )
        print(json.dumps(result))
    except (
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        OSError,
        RuntimeError,
        subprocess.TimeoutExpired,
    ) as error:
        # Never print command arguments, output, configuration values or secrets.
        print(f"Buzz pilot refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
