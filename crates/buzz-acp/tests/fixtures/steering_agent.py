"""Deterministic ACP peer: holds a turn until the runner releases it."""

import json
import os
import select
import sys
import time

log = open(os.environ["PROBE_ADAPTER_LOG"], "a", buffering=1)  # noqa: SIM115 - lifetime of the fixture process
pending = None
deadline = time.monotonic() + 360


def respond(response):
    log.write(
        json.dumps(
            {"at": time.time(), "direction": "adapter_to_harness", "wire": response}
        )
        + "\n"
    )
    print(json.dumps(response), flush=True)


while time.monotonic() < deadline:
    if pending is not None and os.path.exists(os.environ["PROBE_FINISH_FILE"]):
        respond({"jsonrpc": "2.0", "id": pending, "result": {"stopReason": "end_turn"}})
        log.write(json.dumps({"at": time.time(), "stage": "turn_released"}) + "\n")
        pending = None
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if not ready:
        continue
    line = sys.stdin.readline()
    if not line:
        break
    msg = json.loads(line)
    log.write(
        json.dumps({"at": time.time(), "direction": "harness_to_adapter", "wire": msg})
        + "\n"
    )
    method = msg.get("method")
    result = {}
    if method == "initialize":
        result = {
            "protocolVersion": 2,
            "agentCapabilities": {},
            "agentInfo": {"name": "deterministic-steering-probe"},
            "_meta": {"steering": {"supported": True}},
        }
    elif method == "session/new":
        result = {"sessionId": "probe-session"}
    elif method == "session/prompt":
        pending = msg["id"]
        continue
    elif method == "_session/steering":
        result = {"outcome": "injected"}
    elif method == "session/cancel":
        continue
    if "id" in msg:
        respond({"jsonrpc": "2.0", "id": msg["id"], "result": result})
else:
    raise TimeoutError("deterministic adapter exceeded its six-minute lifetime")
