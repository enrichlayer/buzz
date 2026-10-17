# Optional prompt suggestions prototype (DEV-12635)

The chips are a desktop preview feature (`promptSuggestions` in `preview-features.json`), off by default; enable it in Settings → Experiments. Free text remains the normal composer. Zero to three chips may appear after a completed agent answer. Selecting a chip appends an editable prompt addressed to that exact agent and focuses the draft; a separate Send is required. Existing text, rich content and attachments stay in place. Dismiss and Escape send nothing. Dismissal is shared across channel/thread views for the current app session (bounded to 512 source messages).

The client reads only a complete, bounded `suggested-prompts` JSON footer from a known agent, with version 1 and `suggestions: [{label, prompt}]`. Invalid payloads remain ordinary message content. A newer message supersedes suggestions; loading, typing, editing and disabled composers suppress them. Human messages cannot supply suggestions. Source identity and recipient come from the signed message and agent directory, never from the JSON; a label or prompt with an `@` at a token start is rejected, because a plain-text `@Name` resolves to a channel member on Send.

The desktop shared message formatter (`formatTimelineMessages`) strips a valid footer from agent message text whether or not the preview is enabled, so channel, thread, inbox detail, copy and reply surfaces show clean text. Previews built from raw event content (desktop notifications, inbox and home-feed previews, search results) strip a valid footer only when the author is a known agent (managed or relay-registered agent, profile agent flag, or a bot-role channel member where the roster is cached); human and unresolved authors keep their text. Web (`web/`) and mobile (`mobile/`) clients do not parse the footer yet and show it as an ordinary fenced code block.

## Enable generation for a prototype agent

Run `node scripts/prompt-suggestions-prototype.mjs /tmp/buzz-suggestions-base.md` from this checkout. This combines the existing Buzz platform prompt and the shared skill snapshot in `scripts/prompt-suggestions-skill.md` (canonical source: Tools `claude/skills/suggest-next-prompts/SKILL.md`, DEV-12634).

Start your test agent through its usual `buzz-acp` command with `--base-prompt-file /tmp/buzz-suggestions-base.md`, or set `BUZZ_ACP_BASE_PROMPT_FILE` to that path for that agent. This is opt-in and does not modify running agents or account settings. Do not use `--no-base-prompt` at the same time. For agents already using a custom base prompt, append the skill to that prompt instead of replacing it.

The skill instructs agents to emit suggestions only after completing human-requested work, and to abstain for unfinished work, failures, questions requiring answers, heartbeats and messages from other agents. Generation quality and correct completion remain agent responsibilities; the client validates presentation data, not task completion.

## Exercise the UI

From `desktop`, activate Hermit, run `pnpm build:e2e`, then `pnpm exec playwright test --config=playwright.suggestions.config.ts`. The isolated preview uses port 4192. The fixture uses the real composer with a mocked relay, and saves screenshots under `test-results/prompt-suggestions/`.

Manually check a real test-agent turn too: type before its answer, confirm chips do not move focus, click a chip, inspect its agent mention and editable draft, then explicitly Send. Dismiss another set and navigate away/back. No production agent installation or deployment is part of this prototype.

## Installed-client compatibility

The rendering feature belongs to each installed desktop build, not to the shared chat or agent. Buzz and Buzz Dev can display the same relay message while running different code. A build without this feature renders the `suggested-prompts` footer as a JSON code block; switching chats cannot add support. Verify the exact app and revision in Settings before testing. Install a build containing this feature in every desktop client used for the trial, then enable **Settings → Experiments → Prompt suggestions** in each profile.

In a supporting build, turning the preview off hides the buttons but still removes valid agent suggestion metadata from message text. An old build showing JSON is therefore different from a supporting build with the preview disabled. Keep generation opt-in until the intended clients support this format. Web and mobile remain unsupported.
