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
  answered revision must carry a valid answer for every question and a hex
  `answeredBy`, or the card falls back to the title.
- **Conflict.** On `conflict:` the card fetches the head with
  `{kinds:[45010], #h, #d}` (single-letter tags are fine on WS REQ) and folds
  it into the store. If it is answered, the card shows "Already answered by X"
  and "Your answer was not sent"; if it changed but is still open, it asks the
  viewer to review and submit again.
- **Subscription lifetime.** Message rows acquire the channel's artifact
  subscription by reference count and release it after a 1 s grace, so
  timeline virtualization does not churn the REQ.
- **Self label.** "Answered by You" for the viewer's own answer, matching
  `resolveUserLabel` elsewhere; others see their display name.
- **Posting.** `buzz prompts ask --channel <uuid> --root <event-id> --file q.json`
  (crates/buzz-cli) creates the artifact; the file needs only `questions`.

## Status

- [x] Artifact-type plugin registry + per-channel artifact subscription/store
- [x] `buzz.agent_prompt` parser/validator with unit tests
- [x] Question card UI (header chips, options, multi-select, Other, previews, keyboard)
- [x] Submit → answered revision; conflict → show existing answer
- [x] Answered state ("Answered by …" + choices) for every viewer
- [x] e2e: render, submit, conflict (mock bridge) — `question-card.spec.ts` (smoke)
- [x] A way to post a prompt for a human test (`buzz prompts ask`)
- [ ] Human test in the desktop app
- [ ] Agent review per AGENTS.md

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
   `1`, `3`, `4` + text pick Web, Mobile and Other; Enter submits; the card
   turns into "Answered by You" with the choices, and a second viewer sees
   "Answered by <your name>". Answering from two clients at once: the loser
   sees "Already answered by …".

## Next (separate issues)

1. `buzz-acp`: advertise ACP `elicitation.form`, turn elicitations into prompt
   artifacts, wait for the answer, reply to the agent.
2. Approval and plan cards on the same registry.
