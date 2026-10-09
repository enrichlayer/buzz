import assert from "node:assert/strict";
import test from "node:test";
import { diagramDescription } from "./diagramDescription.ts";
test("simple flow has a meaningful relationship description and authored copy wins", () => {
  assert.equal(
    diagramDescription(
      "flowchart LR\nRead --> FailingTests --> Edit --> PassingTests",
    ),
    "Read leads to FailingTests. FailingTests leads to Edit. Edit leads to PassingTests.",
  );
  assert.equal(
    diagramDescription("accDescr: Deployment stages\nflowchart LR\na --> b"),
    "Deployment stages",
  );
  assert.match(
    diagramDescription("sequenceDiagram\nA->>B: Hello"),
    /complete textual representation/,
  );
});
