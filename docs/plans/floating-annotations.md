# Floating text and code annotations

Tracking: [DEV-11903](https://linear.app/verticalint/issue/DEV-11903/).

Select prose or code in an agent response, then choose **Comment** beside the
selection. **Command/Ctrl+Shift+M** opens the same editor. The comment editor
floats above the conversation without a backdrop or document reflow. It uses
Buzz's built-in annotation interaction and existing submission provider; it
does not require a new runtime-manifest block or grant runtime plugins send
authority.

The anchor follows the last selected visual line for a forward selection and
the first for a backward selection. A cloned DOM Range follows scrolling and
layout changes after focus enters the editor. If streaming replaces the
selected nodes, the editor retains the captured location relative to the
source and shows the existing revision-change notice. The immutable quote,
code range and thread routing remain the existing annotation contract.

Both the Comment button and editor render in the overlay layer so adjacent
messages cannot cover the action. Radix fits the editor within the viewport.
Escape closes it and restores focus; Command/Ctrl+Enter submits. Failed sends
retain the captured quote and draft for retry. Leaving the source, including
thread navigation or a responsive layout that remounts the thread, dismisses
the editor without sending.

Validation lives in `selectionPosition.jsdom-test.mjs`,
`SourceAnnotation.jsdom-test.mjs`, `annotationModel.test.mjs`, and
`session-annotations.spec.ts`. The browser tests cover code and prose sends,
physical placement, keyboard focus, desktop and narrow viewport fitting, and
navigation isolation. They use the mock native bridge; they do not attest a
live relay or a packaged native build.
