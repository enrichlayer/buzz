import assert from "node:assert/strict";
import test from "node:test";
import { shellCommand, shellCommandTags } from "./shellCommand.ts";

test("only explicit leading bang creates command intent", () => {
  assert.equal(shellCommand("  !printf 'hello\\n'"), "printf 'hello\\n'");
  for (const text of [
    "please run !pwd",
    "!cancel",
    "!rotate now",
    "!shutdown",
    "```bash\n!pwd\n```",
  ])
    assert.equal(shellCommand(text), null);
  assert.deepEqual(shellCommandTags("!pwd", ["agent"], ["agent"]), [
    ["buzz.shell", "1", "agent", "pwd"],
  ]);
  assert.equal(
    shellCommand("@Coding Session Test !pwd", ["Coding Session Test"]),
    "pwd",
  );
  assert.equal(shellCommand("@Unknown !pwd", ["Coding Session Test"]), null);
});
test("execution rejects missing or ambiguous recipients and attachments", () => {
  for (const recipients of [[], ["human"], ["agent", "other"]])
    assert.throws(
      () => shellCommandTags("!pwd", recipients, ["agent"]),
      /exactly one agent/,
    );
  assert.throws(
    () => shellCommandTags("!pwd", ["agent"], ["agent"], true),
    /attachments/,
  );
  assert.throws(
    () => shellCommandTags("!", ["agent"], ["agent"]),
    /Enter a Bash command/,
  );
  assert.throws(
    () => shellCommandTags(`!${"é".repeat(8001)}`, ["agent"], ["agent"]),
    /16000/,
  );
});
