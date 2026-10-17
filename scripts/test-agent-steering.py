#!/usr/bin/env python3
"""Real-relay, deterministic ACP steering regression. See buzz-acp/TESTING.md."""
# Ruff project defaults target a newer Python; this fixture also supports 3.10.
# ruff: noqa: UP041

import asyncio
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import signal
import socket
import sys
import time
import uuid

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web

AGENT = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
SENDER = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
BASE = (
    pathlib.Path(
        os.environ.get(
            "BUZZ_STEERING_ARTIFACT_DIR", str(REPO / "test-results/agent-steering")
        )
    )
    / (
        "RUN_"
        + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S")  # noqa: UP017 - Python 3.10 support
        + "_"
        + uuid.uuid4().hex[:6]
    )
)
BASE.mkdir(parents=True)
print("EVIDENCE_DIR=" + str(BASE), flush=True)
BIN = pathlib.Path(os.environ.get("BUZZ_STEERING_BIN_DIR", str(REPO / "target/debug")))
CLI = os.environ.get("BUZZ_STEERING_CLI", str(BIN / "buzz"))
DB = "buzz_steering_" + uuid.uuid4().hex[:12]
COM = uuid.uuid4()
ENV = {
    k: v
    for k, v in os.environ.items()
    if not k.startswith(
        ("BUZZ_", "GIT_CONFIG_", "PG", "DATABASE_URL", "REDIS_URL", "RELAY_URL")
    )
}
ENV.update(TMPDIR=str(BASE), BUZZ_GIT_IDENTITY="user")
TRACE = open(BASE / "transport.jsonl", "w", buffering=1)  # noqa: SIM115 - closed in main cleanup
ACTIVE = "setup"


def record(stage, **kw):
    TRACE.write(
        json.dumps({"at": time.time(), "case": ACTIVE, "stage": stage, **kw}) + "\n"
    )


def ports(count):
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


BACK, PROXY, HEALTH, METRICS, REDIS, PGPORT, MINIO = ports(7)
PGNAME = DB + "-postgres"
REDISNAME = DB + "-redis"
MINIONAME = DB + "-minio"
ENV.update(
    PGHOST="127.0.0.1",
    PGPORT=str(PGPORT),
    PGUSER="buzz",
    PGPASSWORD="fixture-password",
    PGDATABASE=DB,
)
URL = f"http://127.0.0.1:{PROXY}"
WSURL = f"ws://127.0.0.1:{PROXY}"


async def cmd(*args, env=ENV, input=None, timeout=120, cwd=BASE):
    proc = await asyncio.create_subprocess_exec(
        *args,
        env=env,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(input.encode() if input else None), timeout
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()
        record(
            "command_interrupted",
            command=args[0:3],
            deadline_seconds=timeout,
            exit=proc.returncode,
        )
        raise
    record(
        "command_result",
        command=args[0:3],
        exit=proc.returncode,
        stdout=out.decode()[:8000],
        stderr=err.decode()[:4000],
    )
    if proc.returncode:
        raise RuntimeError(f"{args[0]} exited {proc.returncode}: {err.decode()}")
    return out.decode()


async def cli(*args):
    env = ENV | {"BUZZ_PRIVATE_KEY": "0" * 63 + "2", "BUZZ_RELAY_URL": URL}
    return json.loads(await cmd(CLI, *args, env=env, timeout=60))


async def stop(proc):
    if proc and proc.returncode is None:
        proc.send_signal(signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 35)
        except asyncio.TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
    if proc:
        record("process_stopped", pid=proc.pid, exit=proc.returncode)


async def main():
    global ACTIVE
    if not __debug__:
        raise RuntimeError(
            "Run without Python -O: regression assertions must remain enabled"
        )
    for tool in ["docker", "psql", "pg_isready"]:
        if not shutil.which(tool):
            raise RuntimeError(
                f"Missing prerequisite: {tool}; see crates/buzz-acp/TESTING.md"
            )
    for binary in [BIN / "buzz-relay", BIN / "buzz-acp", pathlib.Path(CLI)]:
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError(f"Build prerequisite missing: {binary}")
    await cmd("docker", "version", "--format", "{{.Server.Version}}")
    runner = None
    redis = None
    relay = None
    created = False
    redis_created = False
    minio_created = False
    try:
        created = True
        await cmd(
            "docker",
            "run",
            "--pull",
            "never",
            "--rm",
            "-d",
            "--name",
            PGNAME,
            "--tmpfs",
            "/var/lib/postgresql/data:rw,size=512m",
            "-p",
            f"127.0.0.1:{PGPORT}:5432",
            "-e",
            "POSTGRES_USER=buzz",
            "-e",
            "POSTGRES_PASSWORD=fixture-password",
            "-e",
            f"POSTGRES_DB={DB}",
            "postgres:17",
        )
        end = time.monotonic() + 180
        while True:
            ready = await asyncio.create_subprocess_exec(
                "pg_isready",
                "-t",
                "2",
                env=ENV,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            try:
                out, err = await asyncio.wait_for(ready.communicate(), 10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                os.killpg(ready.pid, signal.SIGKILL)
                await ready.wait()
                raise
            record(
                "postgres_readiness",
                exit=ready.returncode,
                stdout=out.decode(),
                stderr=err.decode(),
            )
            if ready.returncode == 0:
                break
            if time.monotonic() > end:
                await cmd("docker", "logs", PGNAME)
                raise TimeoutError("isolated container Postgres readiness timed out")
            await asyncio.sleep(0.2)
        await cmd(
            "psql",
            "-d",
            DB,
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            str(REPO / "schema/schema.sql"),
            cwd=REPO / "schema",
        )
        sql = f"INSERT INTO communities(id,host) VALUES ('{COM}','127.0.0.1:{PROXY}'); INSERT INTO relay_members(community_id,pubkey,role) VALUES ('{COM}','{SENDER}','owner'),('{COM}','{AGENT}','member');"
        await cmd("psql", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", sql)
        session = ClientSession(timeout=ClientTimeout(total=30))

        async def proxy(req):
            request_case = ACTIVE
            started = time.monotonic()
            headers = {
                k: v
                for k, v in req.headers.items()
                if k.lower()
                not in (
                    "connection",
                    "upgrade",
                    "sec-websocket-key",
                    "sec-websocket-version",
                    "sec-websocket-extensions",
                    "content-length",
                )
            }
            headers["Host"] = f"127.0.0.1:{PROXY}"
            if req.headers.get("Upgrade", "").lower() == "websocket":
                local = web.WebSocketResponse()
                await local.prepare(req)
                upstream = await session.ws_connect(
                    f"ws://127.0.0.1:{BACK}" + req.rel_url.path_qs, headers=headers
                )
                record("ws_open", case=request_case)

                async def forward(src, dst, direction):
                    async for msg in src:
                        if msg.type == WSMsgType.TEXT:
                            wire = json.loads(msg.data)
                            record(
                                "ws_frame",
                                case=request_case,
                                direction=direction,
                                wire=wire,
                            )
                            await dst.send_str(msg.data)
                        elif msg.type == WSMsgType.BINARY:
                            await dst.send_bytes(msg.data)
                        elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                            break

                tasks = [
                    asyncio.create_task(forward(local, upstream, "harness_to_relay")),
                    asyncio.create_task(forward(upstream, local, "relay_to_harness")),
                ]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await upstream.close()
                await local.close()
                return local
            body = await req.read()
            async with session.request(
                req.method,
                f"http://127.0.0.1:{BACK}" + req.rel_url.path_qs,
                headers=headers,
                data=body,
            ) as response:
                data = await response.read()
                try:
                    request_body = json.loads(body) if body else None
                except (json.JSONDecodeError, UnicodeDecodeError):
                    request_body = None
                try:
                    response_body = json.loads(data)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    response_body = data.decode(errors="replace")[:1000]
                record(
                    "http",
                    case=request_case,
                    duration_ms=(time.monotonic() - started) * 1000,
                    method=req.method,
                    path=req.path,
                    status=response.status,
                    request=request_body,
                    response=response_body,
                )
                return web.Response(
                    body=data,
                    status=response.status,
                    headers={
                        "Content-Type": response.headers.get(
                            "Content-Type", "application/json"
                        )
                    },
                )

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", proxy)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", PROXY).start()
        redis_created = True
        await cmd(
            "docker",
            "run",
            "--pull",
            "never",
            "--rm",
            "-d",
            "--name",
            REDISNAME,
            "-p",
            f"127.0.0.1:{REDIS}:6379",
            "redis:7",
            "redis-server",
            "--save",
            "",
            "--appendonly",
            "no",
        )
        minio_created = True
        await cmd(
            "docker",
            "run",
            "--pull",
            "never",
            "--rm",
            "-d",
            "--platform",
            "linux/amd64",
            "--name",
            MINIONAME,
            "-p",
            f"127.0.0.1:{MINIO}:9000",
            "-e",
            "MINIO_ROOT_USER=fixture",
            "-e",
            "MINIO_ROOT_PASSWORD=fixture-secret",
            "ghcr.io/block/buzz-minio@sha256:71f235d6aa0c39517b9864d8524546607ccdde40b83742e0dd8d4fb52b3be6dd",
            "server",
            "/data",
        )
        end = time.monotonic() + 180
        while True:
            try:
                async with session.get(
                    f"http://127.0.0.1:{MINIO}/minio/health/live"
                ) as ready:
                    if ready.status == 200:
                        break
            except (asyncio.TimeoutError, ClientError, OSError) as error:
                record("readiness_retry", error=str(error))
            if time.monotonic() > end:
                raise TimeoutError("MinIO readiness timed out")
            await asyncio.sleep(0.1)
        await cmd(
            "docker",
            "exec",
            MINIONAME,
            "mc",
            "alias",
            "set",
            "fixture",
            "http://127.0.0.1:9000",
            "fixture",
            "fixture-secret",
        )
        await cmd("docker", "exec", MINIONAME, "mc", "mb", "fixture/buzz-media")
        record("minio_bucket_created", bucket="buzz-media")
        renv = ENV | {
            "DATABASE_URL": f"postgres://buzz:fixture-password@127.0.0.1:{PGPORT}/{DB}",
            "REDIS_URL": f"redis://127.0.0.1:{REDIS}",
            "RELAY_URL": WSURL,
            "BUZZ_BIND_ADDR": f"127.0.0.1:{BACK}",
            "BUZZ_HEALTH_PORT": str(HEALTH),
            "BUZZ_METRICS_PORT": str(METRICS),
            "BUZZ_RELAY_PRIVATE_KEY": "0" * 63 + "3",
            "BUZZ_REQUIRE_AUTH_TOKEN": "false",
            "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "false",
            "BUZZ_GIT_REPO_PATH": str(BASE / "repos"),
            "RUST_LOG": "buzz_relay=debug",
            "BUZZ_RECONCILE_CHANNELS": "true",
            "BUZZ_S3_ENDPOINT": f"http://127.0.0.1:{MINIO}",
            "BUZZ_S3_ACCESS_KEY": "fixture",
            "BUZZ_S3_SECRET_KEY": "fixture-secret",
            "BUZZ_STORAGE_SWEEP_ENABLED": "false",
        }
        for startup_attempt in range(1, 4):
            await cmd("psql", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1")
            relay_path = BASE / f"relay-startup-{startup_attempt}.log"
            relaylog = open(relay_path, "w")  # noqa: ASYNC230, SIM115 - closed in cleanup
            relay = await asyncio.create_subprocess_exec(
                str(BIN / "buzz-relay"),
                cwd=BASE,
                env=renv,
                stdout=relaylog,
                stderr=relaylog,
                start_new_session=True,
            )
            end = time.monotonic() + 180
            while True:
                if relay.returncode is not None:
                    relaylog.close()
                    log = relay_path.read_text()
                    record(
                        "relay_startup_failed",
                        attempt=startup_attempt,
                        exit=relay.returncode,
                        log=str(relay_path),
                    )
                    if (
                        startup_attempt < 3
                        and "pool timed out while waiting for an open connection" in log
                    ):
                        await asyncio.sleep(1)
                        break
                    raise RuntimeError(
                        f"relay exited {relay.returncode}; see {relay_path}"
                    )
                try:
                    async with session.get(
                        f"http://127.0.0.1:{HEALTH}/_readiness"
                    ) as r:
                        if r.status == 200:
                            break
                except (asyncio.TimeoutError, ClientError, OSError) as error:
                    record("readiness_retry", error=str(error))
                if time.monotonic() > end:
                    raise TimeoutError("real relay readiness timed out")
                await asyncio.sleep(0.1)
            if relay.returncode is None:
                record(
                    "relay_startup_succeeded",
                    attempt=startup_attempt,
                    log=str(relay_path),
                )
                break
        record(
            "real_relay_ready",
            source_head=(await cmd("git", "rev-parse", "HEAD", cwd=REPO)).strip(),
            runner_sha256=hashlib.sha256(
                pathlib.Path(__file__).read_bytes()
            ).hexdigest(),
            adapter_sha256=hashlib.sha256(
                (REPO / "crates/buzz-acp/tests/fixtures/steering_agent.py").read_bytes()
            ).hexdigest(),
            database=DB,
            ports={
                "backend": BACK,
                "recording_proxy": PROXY,
                "health": HEALTH,
                "metrics": METRICS,
                "redis": REDIS,
            },
            relay_sha256=hashlib.sha256((BIN / "buzz-relay").read_bytes()).hexdigest(),
            harness_sha256=hashlib.sha256((BIN / "buzz-acp").read_bytes()).hexdigest(),
            cli_sha256=hashlib.sha256(pathlib.Path(CLI).read_bytes()).hexdigest(),
        )
        for label, disabled in [
            ("mentions-default", False),
            ("mention-filter-disabled", True),
        ]:
            ACTIVE = label
            create = await cli(
                "channels",
                "create",
                "--name",
                "steering-" + label,
                "--type",
                "stream",
                "--visibility",
                "open",
            )
            channel = create["channel_id"]
            assert create["accepted"], create
            await cli(
                "channels",
                "add-member",
                "--channel",
                channel,
                "--pubkey",
                AGENT,
                "--role",
                "member",
            )
            adapterlog = BASE / (label + ".adapter.jsonl")
            adapterlog.write_text("")
            finish = BASE / (label + ".finish")
            finish.unlink(missing_ok=True)
            henv = ENV | {
                "PROBE_ADAPTER_LOG": str(adapterlog),
                "PROBE_FINISH_FILE": str(finish),
                "RUST_LOG": "buzz_acp=debug",
            }
            args = [
                str(BIN / "buzz-acp"),
                "--relay-url",
                WSURL,
                "--private-key",
                "0" * 63 + "1",
                "--agent-command",
                sys.executable,
                "--agent-args",
                str(REPO / "crates/buzz-acp/tests/fixtures/steering_agent.py"),
                "--respond-to",
                "anyone",
                "--channels",
                channel,
                "--session-policy",
                "thread",
                "--multiple-event-handling",
                "steer",
                "--no-memory",
                "--no-presence",
                "--no-typing",
                "--no-base-prompt",
                "--system-prompt",
                "Real relay delivery probe",
                "--turn-liveness-secs",
                "0",
                "--idle-timeout",
                "60",
                "--max-turn-duration",
                "180",
            ]
            if disabled:
                args += ["--no-mention-filter"]
            hlog = open(BASE / (label + ".harness.log"), "w")  # noqa: ASYNC230, SIM115 - closed in case cleanup
            harness = await asyncio.create_subprocess_exec(
                *args,
                cwd=BASE,
                env=henv,
                stdout=hlog,
                stderr=hlog,
                start_new_session=True,
            )

            def records():
                return [
                    json.loads(l)
                    for l in (BASE / "transport.jsonl").read_text().splitlines()
                ]

            def wires(adapterlog=adapterlog):
                return [
                    json.loads(l)["wire"]
                    for l in adapterlog.read_text().splitlines()
                    if json.loads(l).get("direction") == "harness_to_adapter"
                ]

            async def until(pred, timeout=45, harness=harness):
                end = time.monotonic() + timeout
                while time.monotonic() < end:
                    if pred():
                        return
                    if harness.returncode is not None:
                        raise RuntimeError(f"harness exited {harness.returncode}")
                    await asyncio.sleep(0.05)
                raise TimeoutError("harness probe deadline")

            try:
                await until(
                    lambda label=label, channel=channel: any(
                        r["case"] == label
                        and r["stage"] == "ws_frame"
                        and (r["direction"] == "harness_to_relay")
                        and (r["wire"][0] == "REQ")
                        and any(channel in f.get("#h", []) for f in r["wire"][2:])
                        for r in records()
                    )
                )
                root = await cli(
                    "messages",
                    "send",
                    "--channel",
                    channel,
                    "--content",
                    "ROOT_HOLD_ACTIVE",
                    "--mention",
                    AGENT,
                )
                assert root["accepted"]
                await until(
                    lambda: any(m.get("method") == "session/prompt" for m in wires())
                )
                record("adapter_turn_active", root=root["event_id"], channel=channel)
                plain = await cli(
                    "messages",
                    "send",
                    "--channel",
                    channel,
                    "--reply-to",
                    root["event_id"],
                    "--content",
                    "PLAIN_THREAD_PROBE",
                )
                assert plain["accepted"]
                if disabled:
                    await until(
                        lambda: any(
                            m.get("method") == "_session/steering"
                            and "PLAIN_THREAD_PROBE" in json.dumps(m)
                            for m in wires()
                        )
                    )
                else:
                    await asyncio.sleep(0.5)
                mention = await cli(
                    "messages",
                    "send",
                    "--channel",
                    channel,
                    "--reply-to",
                    root["event_id"],
                    "--content",
                    "MENTION_THREAD_PROBE",
                    "--mention",
                    AGENT,
                )
                assert mention["accepted"]
                await until(
                    lambda: any(
                        m.get("method") == "_session/steering"
                        and "MENTION_THREAD_PROBE" in json.dumps(m)
                        for m in wires()
                    )
                )
                delivered = [
                    {
                        "method": m["method"],
                        "plain": "PLAIN_THREAD_PROBE" in json.dumps(m),
                        "mention": "MENTION_THREAD_PROBE" in json.dumps(m),
                    }
                    for m in wires()
                    if m.get("method") in ("session/prompt", "_session/steering")
                ]
                expected = [
                    {"method": "session/prompt", "plain": False, "mention": False},
                ]
                if disabled:
                    expected.append(
                        {"method": "_session/steering", "plain": True, "mention": False}
                    )
                expected.append(
                    {"method": "_session/steering", "plain": False, "mention": True}
                )
                assert delivered == expected, delivered
                prompts = [m for m in wires() if m.get("method") == "session/prompt"]
                assert "ROOT_HOLD_ACTIVE" in json.dumps(prompts[0])
                steering = [
                    m for m in wires() if m.get("method") == "_session/steering"
                ]
                session_id = prompts[0]["params"]["sessionId"]
                assert all(m["params"]["sessionId"] == session_id for m in steering)
                assert not any(m.get("method") == "session/cancel" for m in wires())
                await until(
                    lambda hlog=hlog, plain=plain, mention=mention, disabled=disabled: (
                        all(
                            f"event_id={event_id} ack=Ok(Success"
                            in pathlib.Path(hlog.name).read_text()
                            for event_id in (
                                [plain["event_id"], mention["event_id"]]
                                if disabled
                                else [mention["event_id"]]
                            )
                        )
                    )
                )
                outgoing = [
                    json.loads(l)["wire"]
                    for l in adapterlog.read_text().splitlines()
                    if json.loads(l).get("direction") == "adapter_to_harness"
                ]
                for m in steering:
                    assert any(
                        r.get("id") == m["id"]
                        and r.get("result") == {"outcome": "injected"}
                        for r in outgoing
                    )
                frames = [
                    r["wire"]
                    for r in records()
                    if r["case"] == label
                    and r["stage"] == "ws_frame"
                    and (r["direction"] == "relay_to_harness")
                    and (r["wire"][0] == "EVENT")
                ]
                assert sum(f[2]["id"] == plain["event_id"] for f in frames) == int(
                    disabled
                )
                assert sum(f[2]["id"] == mention["event_id"] for f in frames) == 1
                async with session.post(
                    URL + "/query",
                    json=[
                        {"ids": [plain["event_id"], mention["event_id"]], "kinds": [9]}
                    ],
                    headers={"X-Pubkey": SENDER},
                ) as r:
                    readback = await r.json()
                    assert r.status == 200, readback
                assert {e["id"] for e in readback} == {
                    plain["event_id"],
                    mention["event_id"],
                }, readback
                for ev in readback:
                    payload = json.dumps(
                        [
                            0,
                            ev["pubkey"],
                            ev["created_at"],
                            ev["kind"],
                            ev["tags"],
                            ev["content"],
                        ],
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode()
                    assert hashlib.sha256(payload).hexdigest() == ev["id"]
                (BASE / (label + ".signed-events.json")).write_text(
                    json.dumps(readback, indent=2) + "\n"
                )
                record(
                    "assertions_passed",
                    channel=channel,
                    root=root["event_id"],
                    plain_id=plain["event_id"],
                    mention_id=mention["event_id"],
                    delivery=delivered,
                    signed_event_readback=True,
                )
                print(
                    json.dumps(
                        {
                            "case": label,
                            "pass": True,
                            "plain_id": plain["event_id"],
                            "mention_id": mention["event_id"],
                            "delivery": delivered,
                        }
                    ),
                    flush=True,
                )
            finally:
                finish.write_text("release")
                await asyncio.sleep(0.3)
                await stop(harness)
                hlog.close()
                assert harness.returncode == 0, harness.returncode
        ACTIVE = "cleanup"
    finally:
        errors = []
        for proc in [relay, redis]:
            try:
                await stop(proc)
            except (asyncio.TimeoutError, RuntimeError, OSError) as error:
                errors.append(str(error))
        if "relaylog" in locals():
            relaylog.close()
        if runner:
            await runner.cleanup()
        if "session" in locals():
            await session.close()
        for exists, name in [
            (created, PGNAME),
            (redis_created, REDISNAME),
            (minio_created, MINIONAME),
        ]:
            if exists:
                try:
                    names = await cmd(
                        "docker",
                        "ps",
                        "-a",
                        "--filter",
                        f"name={name}",
                        "--format",
                        "{{.Names}}",
                    )
                    if name in names.splitlines():
                        await cmd("docker", "rm", "-f", name)
                except (asyncio.TimeoutError, RuntimeError, OSError) as error:
                    errors.append(str(error))
        record("cleanup_complete", containers_removed=not errors, errors=errors)
        TRACE.close()
        if errors:
            raise RuntimeError("cleanup failed: " + "; ".join(errors))


async def run():
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await main()
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


if __name__ == "__main__":
    asyncio.run(run())
