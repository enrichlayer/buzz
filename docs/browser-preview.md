# Coding transcript browser preview

The desktop frontend requires Tauri IPC for community setup, identity and local
agent processes. Opening its Vite URL in an ordinary browser does not provide
those native services.

In development, opening the Vite root now offers **Open coding session preview**.
This explicitly installs the existing mock IPC bridge before the app starts.
The banner identifies sample data and the absence of a live agent. Select
**Load coding session**, then open its reply in **#general** to inspect the
transcript. The direct entry is `?e2e=mock&preview=coding` on the dev server.

The sample includes an exact multiline selection, syntax-highlighted code,
command evidence, a confirmed publication receipt, captured thinking and a
distinct follow-up warning. Test quote expansion and receipt disclosure with
Enter, and switch between Conversation, Activity and Full transcript.

Preview activation is development-only and tab-local. Bootstrap query parameters
are consumed before hash routing so they cannot become part of a message ID.
Reloading the preview recreates the mock bridge; load the sample again after a
reload. The preview does not expose native credentials or execute a real harness.
Use Computer Use against **Buzz Dev** to verify live community and agent behavior.
