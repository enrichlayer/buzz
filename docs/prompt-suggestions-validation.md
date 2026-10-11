# Prompt suggestions prototype validation

Scope: DEV-12634 (shared Tools skill and Pi adapter), DEV-12635 (Buzz). These are opt-in prototypes, with free text as the default and no automatic send, task enqueue, deployment or agent reconfiguration.

## Observed evidence

- Buzz: three parser tests and two component interaction tests passed. They exercise bounded and malformed payloads, terminal controls, duplicate prompts, human/agent identity, supersession, preserved focus, selection, dismissal and Escape.
- Buzz: three Playwright scenarios passed against the actual channel/thread composers using the mock relay: draft/focus preservation, selection without sending, exact source-agent recipient only after a separate Send, newer-message invalidation, dismissal across navigation, and thread draft insertion. Screenshots were visually inspected in `desktop/test-results/prompt-suggestions/`.
- Buzz: full desktop TypeScript check, scoped Biome check across 13 changed files, file-size check, and Vite E2E build passed. The prototype prompt-generation command ran successfully.
- Pi: package TypeScript check and 18 production-callback tests passed in the owned Factory workspace.
- Pi: a real terminal smoke test launched the actual Pi TUI with isolated settings and an offline deterministic provider. Typing produced `My draft`; Alt+1 produced `My draft\n\nCan the label use the account name?`. The user-message count stayed at 1 and provider-request count at 2. This verifies the terminal interaction, not live-model suggestion quality.
- Skill: simulation cases covered a completed fix, unfinished required tests, arithmetic and malicious attachment text. A separate baseline without the skill also behaved sensibly; no measured quality improvement is claimed. The strict skill schema check passed with zero errors/warnings; the routing check reported zero newly ambiguous prompts and zero core misroutes. Generated catalog, manifest and skill discovery checks passed.

## Defect ledger

| Finding | Disposition and owner | Evidence / validation |
|---|---|---|
| Pi lifecycle event names did not match its installed SDK | Fixed by prototype author: use session start/before-switch/before-fork/tree/shutdown and agent-start events | Full package typecheck and lifecycle callback tests pass |
| Slash-command entry can replace an existing terminal draft | Fixed by prototype author: add Alt+1/2/3 insertion shortcuts; retain slash commands as an alternative | Real TUI smoke confirms draft preservation and no second request |
| Buzz dismissal could reappear after navigation | Fixed by prototype author: viewer/source-scoped dismissal receipts shared across mounted composers | Browser navigation regression passes |
| Control-character regex and semantic grouping lint findings | Fixed by prototype author: numeric control checks and semantic fieldset | Scoped Biome and parser/component tests pass |
| Skill test cases lacked explicit expectations | Fixed by prototype author: populated expectations for every case | Strict schema check passes with zero errors and warnings |
| Tools manifest regeneration initially removed historical authors | Fixed by prototype author: give nested Git calls process-scoped trust for the owned Factory path and regenerate | Final manifest diff adds only the new skill; freshness and portability pass |
| First baseline inherited skill context | Discarded as comparative evidence; separate baseline run started without inherited context | Baseline artifact explicitly records simulation limits |

## Limits and manual acceptance

The browser uses a mocked relay; the Pi smoke uses a deterministic offline provider. A real agent/model conversation, native Buzz application acceptance, full repository CI and human testing have not been claimed. No production install, merge or deployment was performed. The owning prototype issues retain this acceptance work.

To try Buzz generation and the UI, follow [the prototype guide](prompt-suggestions-prototype.md). In Pi, load the prototype extension, run `/suggestions on`, complete a turn, type freely, then use Alt+1 to draft a suggestion and review it before explicitly sending. With a terminal configured to intercept Alt/Option, use `/suggestions 1` from an empty input instead. Disable with `/suggestions off`.
