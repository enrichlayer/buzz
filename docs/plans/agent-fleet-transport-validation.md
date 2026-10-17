# Verified fleet transport CLI

The Buzz CLI now supplies the transport boundary needed by the Tools fleet bridge without a second crypto implementation:

- `messages get-verified --channel <uuid> --max-events <n> [--since <inclusive timestamp>] [--kinds <list>]` returns original signed events only after exhaustive bounded pagination and verification of ID, signature, channel and filters. Saturation or a non-advancing cursor fails without partial output.
- `messages sign --channel <uuid> --content-file <path|->` uses the existing message builder and signer without publishing. Reply parents are cryptographically verified and channel checked before deriving thread tags.
- `messages publish-event --channel <uuid> [--reply-to <id>] --event-file <path|->` checks the persisted event's identity, kind, channel and thread relation, submits it without re-signing, and requires the acknowledgement to identify the same event.

Inputs are bounded before reading; existing `messages get` remains a compatibility interface. The fleet adapter must use the verified interface. These commands do not introduce another scheduler or change Factory ownership.

## Validation and defect ledger

| Item | Evidence and disposition | Owner / next action |
| --- | --- | --- |
| Canonical ID/signature verification | Existing `buzz_core::verify_event` reused; genuine events accepted and forged body, ID and signature rejected | Closed |
| Channel and query scope | Malformed/duplicate channel tags, wrong channel, unexpected kind and pre-since events rejected | Closed |
| Exact signed-event retry | Fake relay received byte-identical stored events and IDs on repeated publication | Closed |
| Sign-only lifecycle | Real CLI entrypoint tested against fake relay: no message EVENT emitted; forged reply parent rejected before publication | Closed |
| Same-second pagination | 501 genuinely signed events crossed the production 500-event page boundary; all expected IDs returned exactly once. Ignored composite cursor and saturation rejected | Closed |
| CLI compatibility | Strict command inventory updated for the three additions; full CLI suite 506 passed, zero failed, one doc test ignored | Closed |
| Focused checks | 11 transport cases, 3 cursor cases, 35 existing message cases passed. Clippy all-targets with warnings denied, rustfmt and diff checks passed | Closed |
| Tools adapter | Saved at Factory seq5; still needs transactional signed outbox, verified CLI adapter, cursor/concurrency proof and repository attribution | DEV-10851: pending next admitted Factory lease |
| Hook delivery and announcements | Reader tests12/12 passed on intermediate source. Callback forwarding, pending replay/bounds/identity fixes, output composition and local announcement emitter remain unfinished | DEV-10852: pending next admitted Factory lease |
| Publication and host CI | Normal hooks and current-head CI must be reported separately from the tests above | Parent: in progress |
| Live delivery and release | No production relay messages, new grants, live fleet acceptance, merge or deployment performed | Pending; not established by fake-relay tests |

The existing INF-2164 package-proxy repair is no longer a required dependency for cryptography if the Tools adapter uses these supported Buzz commands. That does not claim INF-2164 itself is fixed or deployed.
