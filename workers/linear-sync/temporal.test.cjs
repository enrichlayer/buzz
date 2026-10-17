const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  TestWorkflowEnvironment,
  MockActivityEnvironment,
} = require("@temporalio/testing");
const { Worker } = require("@temporalio/worker");
const { createActivities } = require("./activities.cjs");

test("Temporal cancellation reaches the running source/transport activity", async () => {
  const environment = new MockActivityEnvironment();
  const activities = createActivities({}, async (_config, { signal }) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled child")),
        { once: true },
      );
      environment.cancel();
    });
  });
  await assert.rejects(
    environment.run(activities.syncBatch),
    /Linear sync cancelled/,
  );
});

test("activity history receives receipts only and failures discard private source text", async () => {
  const environment = new MockActivityEnvironment();
  const receipt = {
    processed: 10,
    pending: 0,
    complete: true,
    observedAt: "2026-10-15T00:00:00Z",
  };
  const activities = createActivities({}, async (_config, { signal }) => {
    assert.equal(signal.aborted, false);
    return {
      ...receipt,
      privateDescription: "must not enter workflow history",
    };
  });
  assert.deepEqual(await environment.run(activities.syncBatch), receipt);
  const failed = createActivities({}, async () => {
    throw new Error("private source body");
  });
  await assert.rejects(environment.run(failed.syncBatch), (error) => {
    assert.match(error.message, /private outbox health/);
    assert.doesNotMatch(error.message, /private source body/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("real Temporal workflow retries a failed batch and drains the persisted continuation", {
  timeout: 120_000,
}, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    let calls = 0;
    const taskQueue = `buzz-linear-test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("./workflows.cjs"),
      activities: {
        async syncBatch() {
          calls++;
          if (calls === 1) throw new Error("transient test failure");
          return {
            processed: 1,
            pending: calls === 2 ? 1 : 0,
            complete: calls > 2,
            observedAt: "2026-10-15T00:00:00Z",
          };
        },
      },
    });
    await worker.runUntil(async () => {
      const result = await environment.client.workflow.execute(
        "linearProjectSync",
        {
          workflowId: `buzz-linear-test-${randomUUID()}`,
          taskQueue,
          args: [],
        },
      );
      assert.equal(result.complete, true);
      assert.equal(calls, 3);
    });
  } finally {
    await environment.teardown();
  }
});
