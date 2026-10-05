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

## Status

- [ ] Artifact-type plugin registry + per-channel artifact subscription/store
- [ ] `buzz.agent_prompt` parser/validator with unit tests
- [ ] Question card UI (header chips, options, multi-select, Other, previews, keyboard)
- [ ] Submit → answered revision; conflict → show existing answer
- [ ] Answered state ("Answered by …" + choices) for every viewer
- [ ] e2e: render, submit, conflict (mock bridge)
- [ ] A way to post a prompt for a human test (dev-only helper or `buzz` CLI command)
- [ ] Human test in the desktop app

## Next (separate issues)

1. `buzz-acp`: advertise ACP `elicitation.form`, turn elicitations into prompt
   artifacts, wait for the answer, reply to the agent.
2. Approval and plan cards on the same registry.
