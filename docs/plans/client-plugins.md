# Desktop client plugins

Tracking: [DEV-11171](https://linear.app/verticalint/issue/DEV-11171/) ·
Design: [Buzz shared agent sessions](https://claude.ai/code/artifact/8809d329-75d0-4740-b8de-7d849cbeac1f)
(P2, "Rich content and extension points").

## Goal

Make every new message card and rich code block a plugin, so the shared agent
session cards (questions, approvals, plans) and diagrams land as one file each
instead of edits across the desktop app.

## Design

Two registries under `desktop/src/shared/plugins/`:

| Registry | Key | What a plugin declares | First entries |
| --- | --- | --- | --- |
| Message-kind plugins (`messageKinds/`) | Event kind | A pure policy (`types.ts`) plus a card component (`cards.tsx`) | `diff` (40008), `huddle-started` (48100) |
| Code-fence plugins (`codeFences.ts`) | Fence language | A lazy component taking the fence source | `mermaid` |

Policy flags replace the hand-maintained kind checks:

| Flag | Replaces |
| --- | --- |
| (every plugin) | `CHANNEL_EVENT_KINDS`, `CHANNEL_TIMELINE_CONTENT_KINDS`, `isTimelineContentEvent` |
| `countsAsUnread` | `NON_CONVERSATIONAL_UNREAD_KINDS` |
| `notifiesInDm` | `DM_NOTIFIABLE_EVENT_KINDS` |
| `endsTyping` | `isTypingCompletionEvent` |
| `workflowPickable` | `PICKABLE_MESSAGE_KINDS` |
| `systemCard` | Copy, link, report, edit, delete and thread-summary checks |

Decisions:

- Compile-time plugins only. No runtime loading of third-party code.
- Policies stay free of React so constants and node tests can import them;
  `kinds.ts` re-exports plugin-owned kind constants to avoid an import cycle.
- Mermaid runs at `securityLevel: "strict"` and is lazy-loaded; the app CSP
  already forbids inline scripts.
- Desktop only. Mobile keeps rendering Mermaid fences as code.

## Status

- [x] Message-kind registry with policies and type-checked card map
- [x] Diff and huddle-started moved in with unchanged behaviour
- [x] All kind checks routed through the registry
- [x] Code-fence registry and Mermaid plugin with error fallback
- [x] Unit tests (`policies.test.mjs`) and e2e (`code-fence-plugins.spec.ts`)
- [x] Desktop typecheck, lint, file-size check, unit suite, messaging e2e
- [ ] Human test in the desktop app (post a Mermaid block, check diff and huddle cards)
- [ ] Review on the enrichlayer/buzz fork PR

## Next

1. Question card plugin (`buzz.agent_prompt` artifact) on this registry.
2. Approval and plan cards.
3. Mobile parity for code-fence plugins.
