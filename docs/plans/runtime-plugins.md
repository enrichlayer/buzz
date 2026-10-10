# Runtime declarative content plugins

Tracking: [DEV-11398](https://linear.app/verticalint/issue/DEV-11398/)

## Goal

Let a user install, update, disable, and remove versioned rich-content
renderers without rebuilding Buzz Desktop. Runtime plugins are app-global
definitions stored on the device. They do not cache message or community data.

## Contract

A plugin is a bounded JSON manifest with schema version `1`, a namespaced id,
semantic version, and a unique `buzz-*` Markdown fence language. Its layout is
made from built-in blocks:

- headings and text resolved from dotted data paths;
- highlighted code and the existing unified diff viewer;
- native disclosure sections;
- text, textarea, select, and checkbox forms;
- explicit copy and compose actions.

The fence body is either JSON or text, according to `contentType`. A JSON
plugin can render content like this:

````markdown
```buzz-review-card
{"title":"Review ready","summary":"Two focused checks passed."}
```
````

Templates interpolate `{{data.path}}` and form values such as
`{{form.feedback}}`. `copy` writes only to the clipboard. `compose` calls the
nearest `RuntimePluginHostProvider`:

```tsx
<RuntimePluginHostProvider onCompose={(text) => setComposerDraft(text)}>
  <Markdown>{message}</Markdown>
</RuntimePluginHostProvider>
```

The host places text in the current composer; it must never send the message.
Without a host, compose actions remain visible and disabled.
Required fields, including checkboxes, block both actions until they are valid
and expose an inline announced error.

Select fields may opt into `"presentation": "segmented"`. Two or three unique
choices render as the shared segmented buttons when every label fits at the
current panel width and text size. Longer lists, narrow panels, and unknown
initial values retain the dropdown. Omitted presentation or `"dropdown"`
preserves the original appearance. Switching presentation never changes the
value or submits the form; the explicit copy/compose button remains the action.
The review-card example uses this for Approve / Needs changes.

## Safety and failure behavior

Runtime plugins contain no JavaScript, commands, native calls, URL-opening, or
network hooks. The schema caps manifest bytes, content bytes, layout depth and nodes,
data depth and nodes, fields, strings, installed plugin count, and composed
output. Paths use own properties only and reject prototype traversal. Runtime
languages cannot replace compile-time renderers such as `mermaid`.

One user mutation writes one complete localStorage snapshot. Mutations re-read
the durable snapshot immediately before writing. Browser development uses Web
Locks for cross-window serialization. Native Buzz exposes plugin mutation only
from main-window Settings (companion-window settings are read-only), so the
fallback queue has a single writer and serializes mutations within that
renderer. A future second mutating surface must require cross-realm locking or
refuse mutation when it is unavailable. Failed writes do not change live state
and appear in Settings. Corrupt saved data is preserved, reported, and can be
explicitly cleared. Invalid fence content shows a useful error and the original
code block, so content never disappears behind a plugin failure.

## Management

Settings → Plugins accepts pasted JSON or a local `.json` file. Install refuses
an existing id; replacing a definition requires the separate Update action.
Each installed plugin can be disabled or removed immediately. Example manifests
live in `docs/examples/runtime-plugins/`.

## Deliberate limits

- Definitions are local to one desktop installation; there is no catalog or
  community distribution protocol.
- Plugins cannot add event kinds or change message policy.
- Compose integration is supplied by the thread surface through the host
  provider; the runtime layer has no channel, identity, or send authority.
- Mobile continues to display these fences as code.
