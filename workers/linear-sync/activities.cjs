const { Context, heartbeat } = require("@temporalio/activity");
const { ApplicationFailure, CancelledFailure } = require("@temporalio/common");

/** Bind the production outbox to Temporal cancellation and bounded failure reporting. */
function createActivities(config, runBatch) {
  return {
    async syncBatch() {
      const context = Context.current();
      const pulse = setInterval(() => heartbeat(), 10_000);
      try {
        heartbeat();
        const result = await runBatch(config, {
          signal: context.cancellationSignal,
        });
        // Explicit projection prevents private payloads from entering workflow history.
        if (
          !Number.isInteger(result.processed) ||
          !Number.isInteger(result.pending) ||
          typeof result.complete !== "boolean" ||
          !Number.isFinite(Date.parse(result.observedAt))
        )
          throw new Error("Invalid sync receipt");
        return {
          processed: result.processed,
          pending: result.pending,
          complete: result.complete,
          observedAt: result.observedAt,
        };
      } catch {
        if (context.cancellationSignal.aborted)
          throw new CancelledFailure("Linear sync cancelled");
        throw ApplicationFailure.create({
          message:
            "Linear sync activity failed; inspect the private outbox health receipt",
          type: "LinearSyncFailed",
        });
      } finally {
        clearInterval(pulse);
      }
    },
  };
}
module.exports = { createActivities };
