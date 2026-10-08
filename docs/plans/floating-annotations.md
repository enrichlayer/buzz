# Floating text and code annotations

Tracking: [DEV-11903](https://linear.app/verticalint/issue/DEV-11903/).

Select readable text or code anywhere in Buzz's desktop frontend, then choose
**Comment** beside the selection or press **Command/Ctrl+Shift+M**. The editor
floats above the content without a backdrop or document reflow. Human messages,
agent responses, user prompts, tools, plans, status text, code/diffs and previews
share this interaction. Selections may cross multiple rendered blocks.

One `AnnotationWorkspace` owns selection handling per mounted community.
`SourceAnnotation` adds provenance when the source has a stable identity; it no
longer gates annotation availability. Unregistered content retains the exact
selected text and its view context. Editable inputs and unsent composer drafts
keep their existing selection behavior. Modal previews contain the editor in
their own focus boundary.

The nearest conversation supplies the send destination. Selections outside a
conversation use the active conversation, with its destination displayed before
sending. With no conversation open, the same editor offers **Copy annotation**.
Source provenance and the captured send destination are separate. Removing the
source or destination dismisses the editor without sending, and a late send
completion cannot dismiss a newer draft. Switching communities replaces the
whole registry; there is no shared module-level selection state.

The anchor follows the last selected visual line for a forward selection and
the first for a backward selection. A cloned DOM Range follows scrolling and
layout changes. Streaming source replacements retain the original quote and
revision; registered sources show a revision-change notice. Code line metadata
is captured when the renderer exposes reliable line information.

Escape closes the editor and restores focus; Command/Ctrl+Enter submits.
Failed sends retain the quote and comment for retry. The implementation uses
Buzz's existing annotation submission paths; runtime plugins receive no new
send authority.

Validation lives in the annotation DOM/registry/model tests and
`session-annotations.spec.ts`. Coverage includes unwrapped content, human
messages, tool output, multi-block ranges, outside previews, modal focus,
keyboard/pointer behavior, immutable quotes, failed-send retry, viewport fitting,
navigation isolation and late send completions. Browser tests exercise the mock
native bridge; native installation checks are recorded separately.
