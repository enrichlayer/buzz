# Prompt suggestion visual evidence

These captures drive the real desktop React UI through the existing mocked
Tauri/relay bridge. They prove presentation, focus, draft retention, dismissal,
and absence of auto-send; they do not prove live relay delivery or native app
installation. Record those checks separately.

From the repository root, activate Hermit, then run:

```sh
source bin/activate-hermit
cd desktop
pnpm build:e2e
EL_VE_RECORD_VIDEO=1 pnpm test:capture
```

The capture helper uses the DOM mechanics auditor from the installed Enrich
Layer Tools CLI at `~/.el-cli-main`. Set `EL_TOOLS_ROOT` to another built Tools
checkout if needed. This dependency is only needed for visual capture, not the
ordinary regression suite. An absent auditor fails the capture instead of
inventing or omitting its measurements.

The three viewport projects produce seven screenshots, measured DOM sidecars,
and one real WebM recording each. Output defaults to
`desktop/test-results/visual-evidence`; the canonical CLI supplies
`EL_VE_OUTPUT_DIR`. `PLAYWRIGHT_BASE_URL` may select an already running build;
otherwise the config serves the local E2E build on port 4173.

The `/prompt-suggestions` entry in the root routes manifest identifies this
capture workflow. The spec opens the existing fixture channel, thread, inbox,
and search UI; it is not a public application route. Capture and review this
workflow through `el-visual-evidence` to generate the review envelope. Test
outputs alone are not a signed review or merge approval.
