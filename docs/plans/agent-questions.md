# Agent questions

Tracking: [DEV-11266](https://linear.app/verticalint/issue/DEV-11266/) · Builds on
[DEV-11200](https://linear.app/verticalint/issue/DEV-11200/) (`docs/plans/question-card.md`).

## Goal

When a Claude Code agent running under `buzz-acp` calls AskUserQuestion, the
question appears as a clickable question card in the conversation, the first
answer goes back to the agent, and the turn continues.

## Design

**Protocol.** `buzz-acp` advertises `clientCapabilities.elicitation.form` (`{}`).
claude-agent-acp (0.84.0) then enables AskUserQuestion (it disables the tool
when the client cannot show forms) and sends each call as the ACP client
request `elicitation/create`: one field per question keyed `question_<n>` — a
titled `oneOf` string enum for single-select, an array with titled `anyOf`
items for multi-select, `const` = option label — plus an optional free-text
`question_<n>_custom`. One question carries its text in `message`, several in
each field's `description`; the header is the field `title`; a preview rides in
the option's `_meta["_claude/askUserQuestionOption"].preview`. The reply is
`{action: "accept", content}`, `{action: "decline"}` or `{action: "cancel"}`;
`applyAskElicitationResponse` reads `content.question_<n>` (label, or label
array) and `content.question_<n>_custom` (typed text).

**Card.** `agent_questions/mapping.rs` converts the schema into
`buzz.agent_prompt` content (question ids = field keys, `allowOther` = the
custom field exists) and validates it with `buzz_sdk::agent_prompt`, the same
builder and caps `buzz prompts ask` uses (moved from buzz-cli so there is one
copy, mirroring the desktop parser). Display text (header, question,
description, preview) is trimmed and cut to the card's caps; labels are the
answer, so a label the card cannot show rejects the card instead of being
altered.

**Anchor.** The card is posted under a short kind-9 message from the agent,
`<agent name> asks: <first question>` (or `Question: …` without a name), in the
turn's reply thread: the triggering thread's root, or the triggering top-level
message (`BatchEvent::reply_thread`, the destination the harness gives the
agent). The artifact's `root` is that message. A dedicated anchor keeps the
card attached to a message the agent owns even before the agent has replied,
and works for every turn shape (thread, top-level, DM).

**Waiting.** A background task (`agent_questions.rs`) polls the artifact's
current head through the relay's HTTP bridge (`POST /query` with
`{"artifact":"current","#h","#d"}`) every 2 s, backing off to 30 s on errors.
The relay maintains heads along the `prev` chain it enforces, so this is the
prev-chain head. An answered head counts only if `parse_prompt_state` accepts
it (valid answer for every question, `answeredBy` = signer) and it answers
exactly the agent's questions; anything else is ignored and polling continues.
A cancelled or missing head (another client withdrew, moved or deleted it)
answers the agent `cancel`.

**Timeouts.** While a card is open the read loop's idle clock is paused and it
restarts when the answer arrives. The hard turn cap (`max_turn_duration`,
default 2 h, ceiling 7 days) is not extended: it is the repo's existing upper
bound on a turn, and the main loop's in-flight deadline for the channel is
derived from it, so extending one without the other would let the queue
release a scope whose turn is still running. The desktop's
`turn_timeout_seconds` (default 320) is no longer passed to buzz-acp (the
desktop emits `BUZZ_ACP_IDLE_TIMEOUT` only when set), so nothing else bounds the
wait.

**Cancelling.** The pending request lives on `AcpClient`, not in the read loop,
because a control cancel drops the read loop mid-turn. `cancel_with_cleanup`
withdraws the card and answers the elicitation `cancel` before
`session/cancel`. `$/cancel_request` for the pending id does the same. The end
of every turn (`send_prompt_result`) withdraws a card still open, and harness
shutdown waits up to 5 s for withdrawals. Withdrawing publishes `op=update`,
`prev=<head>`, the same title and root, content with `state: "cancelled"`; a
head that is no longer open is left alone.

**Declining.** Not the AskUserQuestion shape (MCP forms, the refusal-fallback
consent dialog), URL mode, a second question while one is open, and turns with
no conversation (heartbeats, `buzz-acp run --task`, or outside a prompt) are
declined at once. claude-agent-acp maps decline to "the user skipped" for
AskUserQuestion and to its default for the other dialogs, which is the
behaviour before this change. A question the card cannot hold, or a card that
could not be posted, gets a JSON-RPC error, which claude-agent-acp reports to
the model as "Could not present the question to the user".

**Desktop.** The parser accepts `state: "cancelled"`; the card shows "Question
cancelled" with the title and no form.

Decisions made while building:

- **Poll, not subscribe.** The harness's WebSocket subscriptions are owned by
  the main loop; routing kind-45010 events from it to a waiting turn would
  thread new state through `lib.rs`. A bounded poll per open question keeps the
  feature self-contained; 2 s is fine for a human answer.
- **One question at a time.** A second concurrent `elicitation/create` is
  declined rather than queued.
- **Permission requests are unchanged** (still auto `allow_once`).
- **Not handled:** if the harness process is killed (not shut down), an open
  card stays open; nobody is waiting for it. Cancelling after the anchor is
  posted but before the card is created leaves the anchor message without a
  card.

## Status

- [x] Shared prompt builder/caps/state parser in `buzz_sdk::agent_prompt` (buzz-cli uses it)
- [x] Advertise `elicitation.form`
- [x] `elicitation/create` → card; decline/error for everything else
- [x] Anchor message in the reply thread; artifact rooted at it
- [x] Wait for the first valid answer; map back to claude-agent-acp's shape
- [x] Idle timeout paused while a card is open
- [x] Withdraw on cancel, `$/cancel_request`, end of turn, shutdown
- [x] Desktop renders cancelled cards
- [x] Unit tests (mapping, answers, decline, withdraw, forged answer), stdio tests with a script agent (answer after a wait longer than the idle timeout, decline, cancel, `$/cancel_request`, end of turn), `buzz-acp run` integration test (capability + decline), e2e smoke for the cancelled card
- [ ] Exercised against a live claude-agent-acp + relay
- [ ] Human test in the desktop app
- [ ] Agent review per AGENTS.md

## Human test

1. Build and launch the dev app from this branch: `just desktop-standalone`
   (it builds `buzz-acp` and the other sidecars in debug and copies them into
   `desktop/src-tauri/binaries/`, then runs "Buzz Dev"). If a Buzz Dev app is
   already running, quit it first so agents start from the new sidecar.
2. Connect to a relay (a local `just relay`, or a community you can write to)
   and open a channel.
3. In Agents, use **Add agent** with the Claude Code runtime (claude-agent-acp
   0.84.0 or newer, as installed under the app's node tools), then **Add agent
   to channel**.
4. Mention it: `@<agent> Before you write anything, use the AskUserQuestion
   tool to ask me which auth method the endpoint should use (API key or
   OAuth) and which clients need access (Web, CLI, Mobile; multi-select).`
5. Working looks like: a message from the agent, "<agent> asks: …", appears in
   the thread with the question card under it; the agent's turn stays busy
   past its idle timeout. Pick OAuth, then Web and Mobile plus Other "Desktop",
   and submit. The card turns into "Answered by You", and within a few seconds
   the agent continues and its reply reflects those choices (it should name
   OAuth and Web, Mobile, Desktop).
6. Cancel path: ask again, and before answering stop the agent's turn (the
   Stop control on its working turn, or, as its owner,
   `buzz messages send --channel <channel> --reply-to <thread-root>
   --mention <agent-pubkey> --content '!cancel'`). The card changes to
   "Question cancelled" for every viewer and the agent's turn ends.
