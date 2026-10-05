import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArtifactUpdateTags,
  parseArtifactRevision,
} from "./artifactEnvelope";
import { ChannelArtifactStore } from "./channelArtifactStore";

const CHANNEL = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const D = "04737c81-e5e8-4412-bb47-f446813cfeba";
const ROOT = "a".repeat(64);
const hex = (n) => n.toString(16).padStart(64, "0");

function revision({
  id,
  op = "update",
  prev,
  createdAt = 100,
  d = D,
  h = CHANNEL,
  root = ROOT,
  type = "buzz.agent_prompt",
  extra = [],
}) {
  const tags = [
    ["ar", "1"],
    ["d", d],
    ["h", h],
    ["type", type],
    ["op", op],
  ];
  if (op !== "delete") tags.push(["title", "Which auth?"]);
  if (prev) tags.push(["prev", prev]);
  if (root) tags.push(["root", root]);
  tags.push(...extra);
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: createdAt,
    kind: 45010,
    tags,
    content: op === "delete" ? "" : `{"rev":"${id}"}`,
    sig: "",
  };
}

const store = () =>
  new ChannelArtifactStore(CHANNEL, (type) => type === "buzz.agent_prompt");

test("envelope parser rejects what the relay would reject", () => {
  assert.ok(parseArtifactRevision(revision({ id: hex(1), op: "create" })));
  assert.equal(
    parseArtifactRevision(revision({ id: hex(1), op: "update" })),
    null,
    "update without prev",
  );
  assert.equal(
    parseArtifactRevision(revision({ id: hex(1), op: "create", prev: hex(9) })),
    null,
    "create with prev",
  );
  assert.equal(
    parseArtifactRevision(revision({ id: hex(1), op: "create", d: "NOPE" })),
    null,
  );
  const duplicated = revision({ id: hex(1), op: "create" });
  duplicated.tags.push(["d", D]);
  assert.equal(parseArtifactRevision(duplicated), null, "repeated tag");
  const blankTitle = revision({ id: hex(1), op: "create" });
  blankTitle.tags = blankTitle.tags.map((t) =>
    t[0] === "title" ? ["title", "  "] : t,
  );
  assert.equal(parseArtifactRevision(blankTitle), null);
});

test("indexes registered heads by root and keeps the newest by prev chain", () => {
  const s = store();
  let notified = 0;
  s.subscribe(() => notified++);
  s.ingest(revision({ id: hex(1), op: "create", createdAt: 200 }));
  const first = s.getForRoot(ROOT);
  assert.equal(first.length, 1);
  // The answer was signed with a skewed clock: prev chain still wins.
  s.ingest(revision({ id: hex(2), prev: hex(1), createdAt: 50 }));
  assert.equal(s.getForRoot(ROOT)[0].id, hex(2));
  assert.notEqual(s.getForRoot(ROOT), first, "changed root gets a new array");
  // A late delivery of the superseded revision is ignored.
  assert.equal(
    s.ingest(revision({ id: hex(1), op: "create", createdAt: 200 })),
    false,
  );
  assert.equal(s.getForRoot(ROOT)[0].id, hex(2));
  assert.equal(notified, 2);
});

test("an older revision arriving after its successor never wins", () => {
  const s = store();
  s.ingest(revision({ id: hex(3), prev: hex(2), createdAt: 300 }));
  s.ingest(revision({ id: hex(2), prev: hex(1), createdAt: 400 }));
  assert.equal(s.getHead(D)?.id, hex(3));
});

test("unlinked revisions fall back to created_at", () => {
  const s = store();
  s.ingest(revision({ id: hex(5), prev: hex(4), createdAt: 100 }));
  s.ingest(revision({ id: hex(7), prev: hex(6), createdAt: 200 }));
  assert.equal(s.getHead(D)?.id, hex(7));
  s.ingest(revision({ id: hex(8), prev: hex(6), createdAt: 150 }));
  assert.equal(s.getHead(D)?.id, hex(7));
});

test("deletes, other channels, unregistered types and other roots stay out", () => {
  const s = store();
  s.ingest(revision({ id: hex(1), op: "create" }));
  s.ingest(revision({ id: hex(2), op: "delete", prev: hex(1) }));
  assert.equal(s.getForRoot(ROOT).length, 0);
  s.ingest(revision({ id: hex(3), op: "restore", prev: hex(2) }));
  assert.equal(s.getForRoot(ROOT).length, 1);

  const other = "11111111-1111-4111-8111-111111111111";
  s.ingest(revision({ id: hex(4), op: "create", d: other, type: "buzz.task" }));
  s.ingest(
    revision({ id: hex(5), op: "create", d: other.replace("1", "2"), h: "x" }),
  );
  assert.equal(s.getForRoot(ROOT).length, 1);
  const quiet = s.getForRoot("c".repeat(64));
  assert.equal(quiet, s.getForRoot("c".repeat(64)), "stable empty snapshot");
});

test("a root change moves the artifact between roots", () => {
  const s = store();
  s.ingest(revision({ id: hex(1), op: "create" }));
  s.ingest(revision({ id: hex(2), prev: hex(1), root: "c".repeat(64) }));
  assert.equal(s.getForRoot(ROOT).length, 0);
  assert.equal(s.getForRoot("c".repeat(64))[0].id, hex(2));
});

test("update tags chain to the head and keep annotations, not auth", () => {
  const head = parseArtifactRevision(
    revision({
      id: hex(1),
      op: "create",
      extra: [
        ["agent", "x"],
        ["auth", "owner", "kinds", "sig"],
      ],
    }),
  );
  const tags = buildArtifactUpdateTags(head);
  assert.deepEqual(tags.slice(0, 7), [
    ["ar", "1"],
    ["d", D],
    ["h", CHANNEL],
    ["type", "buzz.agent_prompt"],
    ["title", "Which auth?"],
    ["op", "update"],
    ["prev", hex(1)],
  ]);
  assert.deepEqual(tags.slice(7), [
    ["root", ROOT],
    ["agent", "x"],
  ]);
  assert.ok(parseArtifactRevision({ ...revision({ id: hex(2) }), tags }));
});
