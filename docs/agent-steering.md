# Channel steering and reaction receipt evidence

The stock harness subscribes to mentions by default. Both the relay subscription
and the local rule matcher require the agent's `p` tag. An `e` thread tag controls
session routing after admission; it does not bypass those gates. Recent plain
thread replies may be fetched as context when a later mention triggers a turn.
Context isolation, author admission, and live message handling are separate.

The persona editor explains this beside Conversation context. It qualifies the
advice as default channel behavior: custom ACP commands, subscription overrides,
and message-handling options can differ. No routing behavior changed here.

The executable regression is `scripts/test-agent-steering.py`, with prerequisites
and interpretation in [ACP testing](../crates/buzz-acp/TESTING.md#real-relay-channel-steering-regression).
It tests the real relay and harness with a deterministic adapter and transparent
recording proxy. Default filtering must deliver only the explicit mention;
`--no-mention-filter` must deliver both replies during the same active turn.
Signed readbacks, actual subscription filters, relay EVENT frames and adapter
requests/responses are kept per run. The [packaged October 13 run](evidence/agent-steering/2026-10-13/DELIVERY_TRACE.md)
includes exact filters, signed event IDs and the complete transport/adapter traces. These checks do not prove a real LLM follows the input.

## Reaction timeout investigation

In the October 12 real-relay run, every captured reaction POST (seven total)
returned HTTP 200 with `accepted: true`. Three of those requests had already
exceeded the harness's best-effort 500 ms budget. The server receipts arrived
later than the timeout diagnostics:

| Target event | Reaction | Timeout diagnostic (UTC) | Server acceptance receipt (UTC) |
| --- | --- | --- | --- |
| `75a8525fb2e67e5630182995e381348bbf0f2f0f14c6c87efcdf91149e1de5d8` | 👀 | 16:30:50.442990 | 16:30:50.781641 |
| `c0206367e115280863d4f2efeeaf489797bb90aaf94f6de8f8cfdf116ab9de1e` | 💬 | 16:31:02.192428 | 16:31:02.356606 |
| `4f8b44f7227a6a846931cfc70df500dbf852d66c2b90c2e561f295983c9e89d4` | 👀 | 16:31:04.379614 | 16:31:04.593635 |

Sources: [recorded signed reaction receipts and timeout diagnostics](agent-steering-reaction-receipts.json), extracted from experiment
`RUN_20261012T162904_ad05e3` with its source revision and trace hash; and the
`REACTION_TIMEOUT` / `reaction_add` production path in
[pool.rs](../crates/buzz-acp/src/pool.rs). The receipts are correlated by reaction
kind, emoji, and exact target event tag, rather than by message text.

The evidence establishes late acceptance receipts; it does not isolate proxy,
server, or host scheduling latency. No retry or timeout change is justified by
this sample alone. The repository runner now records HTTP response duration to
support that next diagnostic step. If this becomes a product defect, the owning
surface is the ACP reaction path: compare a direct connection with the recording
proxy under the same workload and verify signed reaction readbacks before
changing its transport policy.
