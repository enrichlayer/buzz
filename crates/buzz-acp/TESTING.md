# Pi adapter integration

Buzz uses the [buzz-pi-acp fork](https://github.com/salman1993/buzz-pi-acp).
Install Node.js 22 or newer, configure Pi, and install the latest development
adapter from the fork's `main` branch:

```sh
npm install -g @earendil-works/pi-coding-agent
pi
npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#main'
```

This test setup intentionally tracks `main`; the Desktop runtime catalog pins a
reviewed adapter revision for users.

Make sure `pi` and `buzz-pi-acp` are on PATH, then restart Buzz.

## Tests

```sh
cargo test -p buzz-acp
```

Managed agent sessions may already export harness options. Clear them when
running the package suite: three CLI parsing tests assert the unset defaults,
and inherited values would change the inputs those tests exercise. Running the
package serially also avoids scheduling flakes in existing short-deadline tests.

```sh
env -u BUZZ_ACP_ALLOWED_RESPOND_TO \
  -u BUZZ_ACP_LAZY_POOL \
  -u BUZZ_ACP_IDLE_POOL_SLEEP \
  cargo test -p buzz-acp -- --test-threads=1
```

Run the ignored real-adapter test with a built fork checkout:

```sh
BUZZ_TEST_PI_ACP=/absolute/buzz-pi-acp/dist/index.js \
  cargo test -p buzz-acp real_pi_preserves -- --ignored
```

## Git bootstrap

`cargo test -p buzz-acp --test git_bootstrap` starts the actual harness with a
probe adapter, runs real signed commits/tags and scoped credential resolution,
and verifies key cleanup on startup failure and SIGTERM. No relay is contacted.

To exercise the real runtime boundaries on Unix:

```sh
cargo build -p buzz-acp -p buzz-agent -p buzz-dev-mcp
BUZZ_TEST_BIN_DIR="$PWD/target/debug" cargo test -p buzz-acp git_runtime_tests -- --ignored --nocapture
```

The Buzz Agent test uses a deterministic local OpenAI-compatible response to
invoke the actual MCP shell. The Goose test requires an installed, configured
Goose and uses its provider to invoke the native developer shell. Both operate
only on temporary local repositories, verify commit/tag signatures and identity,
check unrelated-remote credential scoping, and assert keyfile removal. They do
not replace authenticated relay clone/push/readback testing.

## Real-relay channel steering regression

`python3 scripts/test-agent-steering.py` starts the real relay and harness with
an adapter that holds its first turn open, records ACP input, and acknowledges
native steering. It sends two signed replies in the same thread, one plain and
one explicitly mentioning the agent, then repeats with `--no-mention-filter`.
The test asserts exact live relay event counts and actual adapter input: default
filtering delivers only the mention; disabling it delivers both. Neither mode
changes author admission or thread scope.

Prerequisites: Docker running, `psql` and `pg_isready` on PATH, and Python 3.10+
with `aiohttp` (tested requirement in `scripts/agent-steering-requirements.txt`).
Build the binaries and cache the fixture images before running:

```sh
. ./bin/activate-hermit
cargo build -p buzz-relay -p buzz-acp -p buzz-cli
python3 -m pip install -r scripts/agent-steering-requirements.txt
docker pull postgres:17
docker pull redis:7
docker pull --platform linux/amd64 ghcr.io/block/buzz-minio@sha256:71f235d6aa0c39517b9864d8524546607ccdde40b83742e0dd8d4fb52b3be6dd
python3 scripts/test-agent-steering.py
```

Use the same Python interpreter for dependency setup and execution. The runner
never installs dependencies or pulls images. It uses unique fixture containers,
loopback ports, disposable public identities, and a fresh database; it does not
read `.env` or write to an existing relay. The normal git object-store startup
conformance probe remains enabled. PostgreSQL uses a bounded 512 MiB tmpfs.
Startup/readiness waits are bounded; up to three relay starts are allowed only
for a database pool-acquisition timeout, with each attempt logged separately.
Containers are removed on success or failure.

Each run keeps signed event readbacks, WebSocket REQ/EVENT frames, exact adapter
input, harness logs, and cleanup results under `test-results/agent-steering/`.
The recorder forwards traffic unchanged; it does not implement relay filtering.
`BUZZ_STEERING_BIN_DIR`, `BUZZ_STEERING_CLI`, and
`BUZZ_STEERING_ARTIFACT_DIR` may select existing binaries and an evidence folder.
These overrides are useful for worktrees; record their binary hashes from the
trace before attributing a result to a source revision.

A successful test does not prove a real LLM followed an instruction or establish
historical deployment configuration. Reaction timeout diagnostics likewise do
not establish rejection: correlate the signed reaction's server receipt and
readback before proposing a transport or retry change.
