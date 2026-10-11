import assert from "node:assert/strict";
import test from "node:test";
import {
  composerShellCommand,
  shellCommand,
  shellCommandTags,
} from "./shellCommand.ts";

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
test("bang text without exactly one addressed agent is an ordinary message", () => {
  for (const recipients of [
    [],
    ["human"],
    ["agent", "other"],
    ["agent", "human"],
  ])
    assert.deepEqual(
      shellCommandTags("!!! prod is down", recipients, ["agent", "other"]),
      [],
    );
  assert.deepEqual(shellCommandTags("!pwd", ["agent", "agent"], ["agent"]), [
    ["buzz.shell", "1", "agent", "pwd"],
  ]);
});
test("the composer banner follows the same one-agent rule", () => {
  const agent = { displayName: "Coder", pubkey: "AGENT", isAgent: true };
  const human = { displayName: "Dana", pubkey: "human", isAgent: false };
  assert.equal(composerShellCommand("@Coder !pwd", [agent], []), "pwd");
  assert.equal(composerShellCommand("!pwd", [], ["agent"]), "pwd");
  assert.equal(composerShellCommand("!pwd", [agent], ["agent"]), "pwd");
  assert.equal(composerShellCommand("!!! prod is down", [], []), null);
  assert.equal(composerShellCommand("@Dana !!! down", [human], []), null);
  assert.equal(composerShellCommand("@Dana !pwd", [human], ["agent"]), null);
});
test("one-agent execution rejects attachments and invalid commands", () => {
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
