# Agent coding sessions in threads

Tracks [DEV-11398](https://linear.app/verticalint/issue/DEV-11398/).

## Product behavior

An agent thread remains a normal message thread: the root, published replies,
question cards, reactions, and reply composer keep their existing behavior. When
observer activity can be tied to an exact turn triggered by a message in that
thread, a Coding session section appears in the same scroll surface. It reuses
the activity feed renderer, including Markdown/code output, collapsed tool,
shell, read, and edit details, and prominent errors.

Published message events stay authoritative in the message timeline. The
session projection removes the corresponding prompt echo and successful
send-message tool row, avoiding duplicate replies and questions.

Selection annotations send their explicit quoted feedback through the existing
thread reply path and address the owning agent. Runtime plugin compose actions
append to the current thread draft and focus it; they never send automatically
or replace text already authored by the user.

## Scope and isolation

The current observer envelope carries `channelId`, `sessionId`, and `turnId`,
but no thread root. Channel-policy harnesses can reuse one session for several
threads. The thread projection therefore binds a published triggering message
to its prompt and admits only observer items with that exact `turnId`; it never
widens by `sessionId` or by channel. Session-only setup stays available in the
standalone Activity viewer until the observer protocol carries explicit thread
scope.

A channel-policy turn can also batch prompts from more than one thread. If any
user prompt in a candidate turn does not map to a published message in the open
thread, the whole turn is hidden. Partial visibility is not treated as proof of
thread ownership.

The Stop action is enabled only for a locally managed, thread-policy agent in a
non-DM channel. Channel-policy sessions and DM conversation sessions cannot be
targeted by the native thread-only cancellation path, so the control stays
disabled with an explanation. An enabled action uses the thread root and the
distinct `cancel_thread_turn` control path. A legacy harness cannot silently
interpret it as channel-wide cancel. `ambiguous_target`, `no_active_turn`,
timeout, and transport failure stay visible and are never reported as scoped
success.

Archive hydration is owned once by the open thread, even when several agents
participate. Each agent card reads its own archived event window from that
shared channel load. If the published prompt anchor is older than the eager
archive window, the card remains visible with a Load older action until the
anchor is recovered or the channel archive is exhausted; live-window eviction
does not silently erase the only recovery affordance. Archive read failures
appear inline and keep the retry action available.

## Validation seams

- Agent candidate selection intersects authors/recipient tags with the known
  agent roster, preserving ordinary human threads.
- Transcript selection tests cover exact channel and turn filtering, same
  session/different thread isolation, and published-message deduplication.
- Exact active-turn state remains available alongside the existing
  channel-collapsed badge state so a neighboring thread cannot enable Stop or a
  live indicator.
- Stop eligibility covers the thread policy, default/channel policy, and DM
  conversation policy without a channel-wide fallback.
- Long-turn coverage keeps the recovery affordance visible when the prompt
  anchor precedes more than 3,000 observer frames and verifies exact-turn
  selection once the older page is loaded.
- Composer insertion is an imperative draft operation that appends with a
  paragraph break and retains the existing draft.

## Native gap

Thread history is exact at turn granularity, but observer frames that have a
session id and no turn id cannot yet be displayed inline safely. Adding an
explicit thread root to observer envelopes and archived observer indexes would
allow session setup and other turnless frames to join the thread view without
inference.
