const { proxyActivities, ApplicationFailure } = require("@temporalio/workflow");
const { syncBatch } = proxyActivities({
  startToCloseTimeout: "21 minutes",
  scheduleToCloseTimeout: "65 minutes",
  heartbeatTimeout: "45 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "15 seconds",
    maximumInterval: "1 minute",
  },
});

/** Reconciliation stores only counts/timestamps in Temporal, never source bodies. */
async function linearProjectSync() {
  for (let batch = 0; batch < 200; batch++) {
    const result = await syncBatch();
    if (result.complete) return result;
  }
  throw ApplicationFailure.nonRetryable(
    "Sync batch budget exhausted; persisted outbox will resume on the next scheduled run",
    "SyncBudgetExceeded",
  );
}
module.exports = { linearProjectSync };
