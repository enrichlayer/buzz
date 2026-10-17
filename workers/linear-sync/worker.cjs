const { Worker, NativeConnection } = require("@temporalio/worker");
const { loadConfig } = require("./config.cjs");
const { createActivities } = require("./activities.cjs");

async function main() {
  const config = loadConfig();
  const { runLinearSyncOnce } = await import("../../scripts/linear-sync.mjs");
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE,
      taskQueue: process.env.TASK_QUEUE,
      workflowsPath: require.resolve("./workflows.cjs"),
      activities: createActivities(config, runLinearSyncOnce),
      maxConcurrentActivityTaskExecutions: 1,
      shutdownGraceTime: "30 seconds",
    });
    console.log(
      JSON.stringify({
        event: "worker-started",
        taskQueue: process.env.TASK_QUEUE,
      }),
    );
    await worker.run();
  } finally {
    await connection.close();
  }
}
main().catch(() => {
  console.error(
    "Linear sync worker failed; verify the protected configuration and Temporal connectivity",
  );
  process.exitCode = 1;
});
