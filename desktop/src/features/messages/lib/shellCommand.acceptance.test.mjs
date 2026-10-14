import assert from "node:assert/strict";
import test from "node:test";
import { shellCommand, shellCommandTags } from "./shellCommand.ts";

test("multiline Bash is preserved in command text and execution tags", () => {
  const command =
    "cat <<'EOF'\n  first line\n\nsecond line\nEOF\nprintf '%s\\n' done";
  const input = `!${command}`;
  assert.equal(shellCommand(input), command);
  assert.deepEqual(shellCommandTags(input, ["agent"], ["agent"]), [
    ["buzz.shell", "1", "agent", command],
  ]);
});

test("NUL input is rejected before execution tags are created", () => {
  assert.throws(
    () => shellCommandTags("!printf 'before\0after'", ["agent"], ["agent"]),
    /Enter a Bash command of 1–16000 bytes after !\./,
  );
});
