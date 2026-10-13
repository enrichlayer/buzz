#!/usr/bin/env bash
set -euo pipefail
# Each remote job owns this environment. Credentials stay in its environment.
test -n "${RUNNER_TEMP:-}" || { echo 'RUNNER_TEMP is required' >&2; exit 1; }
case "${RUNNER_OS:-}" in
  Windows) bootstrap=python; interpreter="$RUNNER_TEMP/buzz-r2/Scripts/python.exe" ;;
  *) bootstrap=python3; interpreter="$RUNNER_TEMP/buzz-r2/bin/python" ;;
esac
if [ ! -f "$RUNNER_TEMP/buzz-r2/.ready" ]; then
  "$bootstrap" -m venv "$RUNNER_TEMP/buzz-r2"
  "$interpreter" -m pip install --disable-pip-version-check --retries 3 --timeout 60 -r scripts/buzz-r2-requirements.txt
  touch "$RUNNER_TEMP/buzz-r2/.ready"
fi
exec "$interpreter" scripts/buzz-r2.py "$@"
