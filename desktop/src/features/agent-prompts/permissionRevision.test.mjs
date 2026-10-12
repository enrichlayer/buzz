import assert from "node:assert/strict";
import test from "node:test";

import {
  needsPermissionChain,
  resolvePermissionRevision,
} from "./permissionRevision";

const AGENT = "a".repeat(64);
const OWNER = "b".repeat(64);
const MEMBER = "c".repeat(64);

const permission = {
  version: 1,
  ownerPubkey: OWNER,
  agentPubkey: AGENT,
  cwd: "/tmp",
  command: "pwd",
  toolCall: { title: "Run" },
};
const questions = [
  {
    id: "permission",
    header: "Permission",
    question: "Allow pwd?",
    multiSelect: false,
    allowOther: false,
    options: [{ label: "Allow once" }, { label: "Deny" }],
  },
];

let next = 0;
function revision(pubkey, prev, content, op = prev ? "update" : "create") {
  next += 1;
  return {
    id: String(next).padStart(64, "0"),
    pubkey,
    createdAt: next,
    d: "card",
    h: "channel",
    type: "buzz.agent_prompt",
    op,
    title: "Permission",
    root: "root",
    prev: prev?.id ?? null,
    content: JSON.stringify(content),
    tags: [],
  };
}
const open = (extra = {}) => ({
  version: 1,
  kind: "question",
  state: "open",
  questions,
  permission,
  ...extra,
});
const answered = (by, extra = {}) =>
  open({
    state: "answered",
    answer: { permission: ["Allow once"] },
    answeredBy: by,
    ...extra,
  });

test("a member revision cannot hide or replace the owner's decision", () => {
  const original = revision(AGENT, null, open());
  assert.equal(needsPermissionChain(original), false);

  const squat = revision(MEMBER, original, open());
  assert.equal(needsPermissionChain(squat), true);
  assert.equal(resolvePermissionRevision(squat, [original]), original);

  const decision = revision(OWNER, squat, answered(OWNER));
  assert.equal(
    resolvePermissionRevision(decision, [squat, original]),
    decision,
  );
  const trailing = revision(MEMBER, decision, answered(MEMBER));
  assert.equal(
    resolvePermissionRevision(trailing, [decision, squat, original]),
    decision,
  );
});

test("forged owners, altered requests and broken chains are not decisions", () => {
  const original = revision(AGENT, null, open());
  const forged = revision(
    MEMBER,
    original,
    answered(MEMBER, { permission: { ...permission, ownerPubkey: MEMBER } }),
  );
  assert.equal(needsPermissionChain(forged), true);
  assert.equal(resolvePermissionRevision(forged, [original]), original);
  const altered = revision(
    OWNER,
    original,
    answered(OWNER, { permission: { ...permission, command: "rm -rf ." } }),
  );
  assert.equal(resolvePermissionRevision(altered, [original]), original);
  const withdrawn = revision(AGENT, original, open({ state: "cancelled" }));
  assert.equal(resolvePermissionRevision(withdrawn, [original]), withdrawn);
  const orphan = revision(OWNER, { id: "f".repeat(64) }, answered(OWNER));
  assert.equal(resolvePermissionRevision(orphan, [original]), null);
});
