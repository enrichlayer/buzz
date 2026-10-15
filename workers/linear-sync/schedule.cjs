const {
  Connection,
  Client,
  ScheduleOverlapPolicy,
} = require("@temporalio/client");
const { loadConfig } = require("./config.cjs");

/** Create only, paused by default; existing schedules are never replaced. */
async function main() {
  if (process.argv.slice(2).join(" ") !== "create-paused")
    throw new Error("Usage: node schedule.cjs create-paused");
  loadConfig();
  const id = process.env.BUZZ_LINEAR_SCHEDULE_ID;
  if (!id || id !== process.env.TASK_QUEUE)
    throw new Error("Schedule ID must equal its isolated worker task queue");
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS,
  });
  try {
    const client = new Client({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE,
    });
    await client.schedule.create({
      scheduleId: id,
      spec: { intervals: [{ every: "15 minutes" }] },
      action: {
        type: "startWorkflow",
        workflowType: "linearProjectSync",
        taskQueue: process.env.TASK_QUEUE,
        args: [],
        workflowExecutionTimeout: "24 hours",
      },
      policies: {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: "15 minutes",
        pauseOnFailure: false,
      },
      state: {
        paused: true,
        note: "Awaiting private membership and first-run verification",
      },
    });
    console.log(JSON.stringify({ scheduleId: id, paused: true }));
  } finally {
    await connection.close();
  }
}
main().catch(() => {
  console.error(
    "Schedule creation failed; inspect existing schedule and protected configuration. No schedule was replaced.",
  );
  process.exitCode = 1;
});
