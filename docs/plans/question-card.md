# Agent question card

Tracking: [DEV-11200](https://linear.app/verticalint/issue/DEV-11200/) · Builds on
[DEV-11171](https://linear.app/verticalint/issue/DEV-11171/) (`docs/plans/client-plugins.md`) ·
Design: [Buzz shared agent sessions](https://claude.ai/code/artifact/8809d329-75d0-4740-b8de-7d849cbeac1f),
"Interactive prompts".

## Goal

An agent's multiple-choice question appears as a clickable card under the
agent's message. Anyone who can post in the channel can answer; the first
answer wins for everyone.

## Design

**Record.** A NIP-AR artifact (kind 45010), `type=buzz.agent_prompt`,
`root=<agent message id>`, `h=<channel>`, `title=<first question>`. Content is
JSON:

```json
{
  "version": 1,
  "kind": "question",
  "state": "open",
  "questions": [
    {
      "id": "question_0",
      "header": "Auth method",
      "question": "Which auth method should the endpoint use?",
      "multiSelect": false,
      "allowOther": true,
      "options": [
        { "label": "API key (Recommended)", "description": "Matches v2" },
        { "label": "OAuth", "description": "Third-party apps", "preview": "Authorization: Bearer ..." }
      ]
    }
  ]
}
```

Answering publishes `op=update` with `prev=<current revision id>`, the same
questions, `state: "answered"`, `answer: { "question_0": ["OAuth"] }` (an
"Other" answer is its typed text) and `answeredBy: <pubkey>`. The relay locks
the artifact head, so a second answer against the same open revision gets
`conflict: artifact head changed`; the client then shows the existing answer.

**Why attached, not a row.** NIP-AR says revisions are state changes, not
messages: they must not add rows, unreads or reply counts. So prompts are not a
message-kind plugin. They are an **artifact-type plugin**: a third registry
(`desktop/src/shared/plugins/artifactTypes/`) keyed by artifact `type`, whose
card renders under the `root` message.

**Reading.** One extra channel subscription, `{kinds:[45010], "#h":[channel]}`
over WebSocket: replay returns current heads only, live delivers every
revision. The client keeps the newest revision per `d` and indexes registered
types by `root`. (The HTTP `artifact: "current"` query with `#root` is not
needed for this slice.) The timeline's own fetch lists stay unchanged.

**Writing.** `sign_event` + `relayClient.publishEvent`, as other desktop
writes do.

**Safety.** Content is untrusted: validate before rendering; malformed or
unknown content shows the title only. Prompt text renders as plain text, not
markdown, in this slice.

Decisions made while building (DEV-11200):

- **Head by `prev` chain, not "newest".** Replay sends heads and live sends
  every revision in no guaranteed order, so the store treats any revision
  another revision names as `prev` as stale. `created_at` only breaks ties
  between unlinked revisions (a gap). Code: `features/artifacts/channelArtifactStore.ts`.
- **Answering preserves what it doesn't own.** The update copies the head's
  envelope and annotation tags (dropping NIP-OA `auth`, which attests the
  previous signer) and spreads the parsed content, so unfamiliar fields
  survive, as NIP-AR requires of editors.
- **Content limits.** 1–4 questions, 1–8 options (options plus "Other" fit
  number keys 1–9); `multiSelect` defaults to false, `allowOther` to true. An
  answered revision must carry a valid answer for every question, or the card
  falls back to the title. The CLI enforces the desktop's per-field caps
  (header 40, question 2000, label 200, description 1000, preview 10000,
  counted as JavaScript does), so it cannot post a card that won't render.
- **Who answered comes from the signature.** "Answered by" shows the answered
  revision's signer. Content is writer-controlled, so the parser rejects an
  answered revision whose `answeredBy` is not its own signer; the field stays
  in the content for agents reading it.
- **"First answer wins" holds for honest clients only.** The relay's head lock
  stops two answers to the same open revision, but any channel writer can
  publish a later revision (a new answer, or reopen it). This client never
  edits an answered prompt; agents should treat the answered revision they
  see first as the answer, and NIP-AR history keeps every revision.
- **Conflict.** On `conflict:` the card fetches the head with
  `{kinds:[45010], #h, #d}` (single-letter tags are fine on WS REQ) and folds
  it into the store. If it is answered, the card shows "Already answered by X"
  and "Your answer was not sent"; if it changed but is still open, it asks the
  viewer to review and submit again. If the relay returns no head (moved,
  deleted, redacted) the card is removed. A permission rejection
  (`restricted:`/`blocked:`/`auth-required:`) says "You can't post in this
  channel".
- **Subscription lifetime.** Message rows acquire the channel's artifact
  subscription (`kinds:[45010,45011]`) by reference count and release it
  after a 1 s grace, so timeline virtualization does not churn the REQ. A
  45011 removal marker for the current head hides an artifact that moved out.
  The registry is community-scoped: `resetChannelArtifactSubscriptions()`
  runs in `resetCommunityState()`, because `relayClient.disconnect()` kills
  live REQs without telling their owners. Not handled: a terminal `CLOSED`
  (auth/access) on the artifact REQ leaves the entry thinking it is
  subscribed until its rows unmount. `subscribeLive` exposes no removal hook,
  and `relayClientSession.ts` sits at the 1200-line cap.
- **Keyboard.** Number keys pick, Tab/Shift+Tab move between questions,
  plain Enter on an option toggles it like a click, and Ctrl/⌘+Enter (or
  Enter outside an option) submits. After the viewer's own submit, focus
  moves to the `role="status"` result line.
- **Self label.** "Answered by You" for the viewer's own answer, matching
  `resolveUserLabel` elsewhere; others see their display name.
- **Posting.** `buzz prompts ask --channel <uuid> --root <event-id> --file q.json`
  (crates/buzz-cli) creates the artifact; the file needs only `questions`.
  The content builder and caps live in `buzz_sdk::agent_prompt`, shared with
  buzz-acp.
- **Cancelled.** `state: "cancelled"` (added by DEV-11266) means the asking
  agent withdrew the card; it renders as "Question cancelled" with no form.

## Status

- [x] Artifact-type plugin registry + per-channel artifact subscription/store
- [x] `buzz.agent_prompt` parser/validator with unit tests
- [x] Question card UI (header chips, options, multi-select, Other, previews, keyboard)
- [x] Submit → answered revision; conflict → show existing answer
- [x] Answered state ("Answered by …" + choices) for every viewer
- [x] e2e: render, submit, conflict (mock bridge) — `question-card.spec.ts` (smoke)
- [x] A way to post a prompt for a human test (`buzz prompts ask`)
- [ ] Human test in the desktop app
- [x] Agent review per AGENTS.md (2 blockers fixed: signer as answerer, subscription reset on community switch)

## Human test

1. In the desktop app, open a channel and send a message; copy its event ID
   (message menu → copy link gives `buzz://message?channel=<channel-uuid>&id=<event-id>`).
2. Save a prompt file, e.g. `.tmp/q.json`:

   ```json
   {"questions":[
     {"id":"question_0","header":"Auth method","question":"Which auth method should the endpoint use?",
      "options":[{"label":"API key (Recommended)","description":"Matches v2"},
                 {"label":"OAuth","description":"Third-party apps","preview":"Authorization: Bearer ..."}]},
     {"id":"question_1","header":"Clients","question":"Which clients need access?","multiSelect":true,
      "options":[{"label":"Web"},{"label":"CLI"},{"label":"Mobile"}]}]}
   ```

3. `BUZZ_RELAY_URL=<relay> BUZZ_PRIVATE_KEY=<a member's key> buzz prompts ask --channel <channel-uuid> --root <event-id> --file .tmp/q.json`
4. Working looks like: a card appears under the message with two tabs;
   hovering OAuth shows the preview; `2` picks OAuth and moves to Clients;
   `1`, `3`, `4` + text pick Web, Mobile and Other; Ctrl/⌘+Enter submits; the card
   turns into "Answered by You" with the choices, and a second viewer sees
   "Answered by <your name>". Answering from two clients at once: the loser
   sees "Already answered by …".

## Next (separate issues)

1. `buzz-acp`: advertise ACP `elicitation.form`, turn elicitations into prompt
   artifacts, wait for the answer, reply to the agent — DEV-11266,
   [agent-questions.md](agent-questions.md).
2. Approval and plan cards on the same registry.
