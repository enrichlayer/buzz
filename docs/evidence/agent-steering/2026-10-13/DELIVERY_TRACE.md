# Real-relay steering delivery evidence

Actual packaged run `RUN_20261013T121232_99ba6f`, October 13, 2026.

Base HEAD: `bdb04759ebfdd3d90620945bc88d8985b1b66dd6` with the PR working changes. No Rust production source changed in this PR. The runner and adapter hashes below bind the executable test inputs. The recorder forwards signed payloads unchanged; the adapter holds each initial prompt open until the runner releases it.

Runner exit: **0**. Both harnesses and relay exit: **0**. Normal relay startup succeeded on attempt **1**. Cleanup: `containers_removed: true`, `errors: []`; a subsequent Docker listing found no fixture containers. OrbStack was Running.

## SHA-256 provenance

- `runner_sha256`: `638aecca3b847887be2329dada589436227952f6ae9c9742309b9b70f6f7316a`
- `adapter_sha256`: `685b4484520e5d2568b818a091cef3824a90e4d922b67ce5987498d9452fe4a0`
- `relay_sha256`: `55946d5bcb07afd7b2794495f5f15beb46bfd260f0929c601cc7755eb9ff71e4`
- `harness_sha256`: `c0176a6c6237a23ab518a4d4e25823fa8d6460c66db696e0d565138363246c27`
- `cli_sha256`: `0c050b2f9166e137d671c984dc737fef328dbb2a88dd627bdff6157371f2e002`

## mentions-default

Channel: `017b00fd-6258-4116-a75d-625f71724f18`

Root event ID: `62d506f4f374e3fd9b48e77d8314770b5e60b3686d52006cb6172c874ce1097b`
Plain signed event ID: `904ee5b29d8348768fae70ea7374e0197ca4126a40d9095c81580348c612e70b`
Mention signed event ID: `9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894`

### Actual subscriptions

```json
[
  "REQ",
  "membership-notif",
  {
    "#p": [
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ],
    "kinds": [
      44100,
      44101
    ],
    "since": 1791893595
  }
]
```

```json
[
  "REQ",
  "ch-017b00fd-6258-4116-a75d-625f71724f18",
  {
    "#h": [
      "017b00fd-6258-4116-a75d-625f71724f18"
    ],
    "#p": [
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ],
    "kinds": [
      9,
      40003,
      46010,
      40007
    ],
    "since": 1791893595
  }
]
```

### Chronological delivery

| UTC | Actual observation |
| --- | --- |
| 2026-10-13T12:13:24.131+00:00 | Adapter received `session/prompt` id `2` (initial held prompt), session `probe-session` |
| 2026-10-13T12:13:24.148+00:00 | Runner confirmed initial prompt active |
| 2026-10-13T12:13:24.374+00:00 | HTTP response received for `904ee5b29d8348768fae70ea7374e0197ca4126a40d9095c81580348c612e70b`: status 200, `{"accepted": true, "event_id": "904ee5b29d8348768fae70ea7374e0197ca4126a40d9095c81580348c612e70b", "message": ""}` |
| 2026-10-13T12:13:25.003+00:00 | HTTP response received for `9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894`: status 200, `{"accepted": true, "event_id": "9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894", "message": ""}` |
| 2026-10-13T12:13:25.004+00:00 | Relay → harness EVENT `9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894` |
| 2026-10-13T12:13:25.019+00:00 | Adapter received `_session/steering` id `3` (mention), session `probe-session` |
| 2026-10-13T12:13:25.019+00:00 | Adapter emitted response id `3`: `{"outcome":"injected"}` |

### Verbatim adapter steering traffic

```json
{
  "at": 1791893605.0192971,
  "direction": "harness_to_adapter",
  "wire": {
    "id": 3,
    "jsonrpc": "2.0",
    "method": "_session/steering",
    "params": {
      "prompt": [
        {
          "text": "<new-message-arrived-while-you-were-working>\n\n</new-message-arrived-while-you-were-working>\n\n<buzz-event type=\"@mention\">\nEvent ID: 9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894\nChannel: 017b00fd-6258-4116-a75d-625f71724f18\nKind: 9\nFrom: npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd (hex: c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)\nTime: 2026-10-13T12:13:24+00:00\nContent: MENTION_THREAD_PROBE\nTags: [[\"h\",\"017b00fd-6258-4116-a75d-625f71724f18\"],[\"e\",\"62d506f4f374e3fd9b48e77d8314770b5e60b3686d52006cb6172c874ce1097b\",\"\",\"reply\"],[\"p\",\"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798\"]]\nParsed: root=62d506f4f374e3fd9b48e77d8314770b5e60b3686d52006cb6172c874ce1097b, mentions=[79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798]\n</buzz-event>\n\nNote: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.",
          "type": "text"
        }
      ],
      "sessionId": "probe-session"
    }
  }
}
```

```json
{
  "at": 1791893605.019351,
  "direction": "adapter_to_harness",
  "wire": {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
      "outcome": "injected"
    }
  }
}
```

### Harness acknowledgements

```text
2026-10-13T12:13:25.019867Z  INFO buzz_acp: non-cancelling steer ack received channel=017b00fd-6258-4116-a75d-625f71724f18 event_id=9a8662b10d63d83acc33c47a44e61baa39bbf5c3ad73523bff45366030198894 ack=Ok(Success { session_id: "probe-session" }) release_withheld=false drop_withheld=true signal_fallback=false
```

### Checked result

- `plain_id` relay EVENT count: **0**.
- `mention_id` relay EVENT count: **1**.
- Exactly one initial prompt; expected ordered steering calls in that session; no cancellation; successful adapter responses and harness acknowledgements.
- Full signed readbacks: [mentions-default.signed-events.json](mentions-default.signed-events.json).
- Raw adapter traffic: [mentions-default.adapter.jsonl](mentions-default.adapter.jsonl).

## mention-filter-disabled

Channel: `f8988f2b-3e44-44a6-8a96-c9d98bf38797`

Root event ID: `07670f2c808bff3a7a130b429b133a3fcb75d0a7aed43e9289d06251e1949c1f`
Plain signed event ID: `544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57`
Mention signed event ID: `f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d`

### Actual subscriptions

```json
[
  "REQ",
  "membership-notif",
  {
    "#p": [
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ],
    "kinds": [
      44100,
      44101
    ],
    "since": 1791893601
  }
]
```

```json
[
  "REQ",
  "ch-f8988f2b-3e44-44a6-8a96-c9d98bf38797",
  {
    "#h": [
      "f8988f2b-3e44-44a6-8a96-c9d98bf38797"
    ],
    "kinds": [
      9,
      40003,
      46010,
      40007
    ],
    "since": 1791893601
  }
]
```

### Chronological delivery

| UTC | Actual observation |
| --- | --- |
| 2026-10-13T12:13:28.105+00:00 | Adapter received `session/prompt` id `2` (initial held prompt), session `probe-session` |
| 2026-10-13T12:13:28.133+00:00 | Runner confirmed initial prompt active |
| 2026-10-13T12:13:28.421+00:00 | HTTP response received for `544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57`: status 200, `{"accepted": true, "event_id": "544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57", "message": ""}` |
| 2026-10-13T12:13:28.435+00:00 | Relay → harness EVENT `544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57` |
| 2026-10-13T12:13:28.455+00:00 | Adapter received `_session/steering` id `3` (plain), session `probe-session` |
| 2026-10-13T12:13:28.455+00:00 | Adapter emitted response id `3`: `{"outcome":"injected"}` |
| 2026-10-13T12:13:31.173+00:00 | HTTP response received for `f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d`: status 200, `{"accepted": true, "event_id": "f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d", "message": ""}` |
| 2026-10-13T12:13:31.192+00:00 | Relay → harness EVENT `f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d` |
| 2026-10-13T12:13:31.232+00:00 | Adapter received `_session/steering` id `4` (mention), session `probe-session` |
| 2026-10-13T12:13:31.233+00:00 | Adapter emitted response id `4`: `{"outcome":"injected"}` |

### Verbatim adapter steering traffic

```json
{
  "at": 1791893608.455104,
  "direction": "harness_to_adapter",
  "wire": {
    "id": 3,
    "jsonrpc": "2.0",
    "method": "_session/steering",
    "params": {
      "prompt": [
        {
          "text": "<new-message-arrived-while-you-were-working>\n\n</new-message-arrived-while-you-were-working>\n\n<buzz-event type=\"@mention\">\nEvent ID: 544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57\nChannel: f8988f2b-3e44-44a6-8a96-c9d98bf38797\nKind: 9\nFrom: npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd (hex: c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)\nTime: 2026-10-13T12:13:28+00:00\nContent: PLAIN_THREAD_PROBE\nTags: [[\"h\",\"f8988f2b-3e44-44a6-8a96-c9d98bf38797\"],[\"e\",\"07670f2c808bff3a7a130b429b133a3fcb75d0a7aed43e9289d06251e1949c1f\",\"\",\"reply\"]]\nParsed: root=07670f2c808bff3a7a130b429b133a3fcb75d0a7aed43e9289d06251e1949c1f\n</buzz-event>\n\nNote: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.",
          "type": "text"
        }
      ],
      "sessionId": "probe-session"
    }
  }
}
```

```json
{
  "at": 1791893608.455188,
  "direction": "adapter_to_harness",
  "wire": {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
      "outcome": "injected"
    }
  }
}
```

```json
{
  "at": 1791893611.232183,
  "direction": "harness_to_adapter",
  "wire": {
    "id": 4,
    "jsonrpc": "2.0",
    "method": "_session/steering",
    "params": {
      "prompt": [
        {
          "text": "<new-message-arrived-while-you-were-working>\n\n</new-message-arrived-while-you-were-working>\n\n<buzz-event type=\"@mention\">\nEvent ID: f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d\nChannel: f8988f2b-3e44-44a6-8a96-c9d98bf38797\nKind: 9\nFrom: npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd (hex: c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5)\nTime: 2026-10-13T12:13:30+00:00\nContent: MENTION_THREAD_PROBE\nTags: [[\"h\",\"f8988f2b-3e44-44a6-8a96-c9d98bf38797\"],[\"e\",\"07670f2c808bff3a7a130b429b133a3fcb75d0a7aed43e9289d06251e1949c1f\",\"\",\"reply\"],[\"p\",\"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798\"]]\nParsed: root=07670f2c808bff3a7a130b429b133a3fcb75d0a7aed43e9289d06251e1949c1f, mentions=[79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798]\n</buzz-event>\n\nNote: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.",
          "type": "text"
        }
      ],
      "sessionId": "probe-session"
    }
  }
}
```

```json
{
  "at": 1791893611.233674,
  "direction": "adapter_to_harness",
  "wire": {
    "jsonrpc": "2.0",
    "id": 4,
    "result": {
      "outcome": "injected"
    }
  }
}
```

### Harness acknowledgements

```text
2026-10-13T12:13:28.456649Z  INFO buzz_acp: non-cancelling steer ack received channel=f8988f2b-3e44-44a6-8a96-c9d98bf38797 event_id=544fbd651ccc1e9bba49edaae04cc22b6284f6f4ede81619aa39157f5c707d57 ack=Ok(Success { session_id: "probe-session" }) release_withheld=false drop_withheld=true signal_fallback=false
2026-10-13T12:13:31.235481Z  INFO buzz_acp: non-cancelling steer ack received channel=f8988f2b-3e44-44a6-8a96-c9d98bf38797 event_id=f1f1232530bb9e6e3599ff008aefad968d62d163ee15017f4485998b29bdb26d ack=Ok(Success { session_id: "probe-session" }) release_withheld=false drop_withheld=true signal_fallback=false
```

### Checked result

- `plain_id` relay EVENT count: **1**.
- `mention_id` relay EVENT count: **1**.
- Exactly one initial prompt; expected ordered steering calls in that session; no cancellation; successful adapter responses and harness acknowledgements.
- Full signed readbacks: [mention-filter-disabled.signed-events.json](mention-filter-disabled.signed-events.json).
- Raw adapter traffic: [mention-filter-disabled.adapter.jsonl](mention-filter-disabled.adapter.jsonl).

## Independent signed-event verification

All four readbacks passed signature and canonical-ID verification using the desktop dependency `nostr-tools`, separately from the Rust relay and the Python runner. Actual output: [SIGNATURE_CHECK.txt](SIGNATURE_CHECK.txt).

## Raw evidence

The captured transport is [transport.jsonl](transport.jsonl); it includes command exits, response durations, subscriptions, EVENT frames and cleanup. The startup log is [relay-startup-1.log](relay-startup-1.log). File hashes are in [SHA256SUMS.txt](SHA256SUMS.txt).

DEV-13784 (also carried in the accepted DEV-13682 composite) redacts only the two relay-to-harness NIP-42 `AUTH` challenge payloads at lines 188 and 234 (`mentions-default` and `mention-filter-disabled`) as `[REDACTED NIP-42 AUTH challenge]`. Case, direction, timestamps and frame kind are unchanged. `SHA256SUMS.txt` now hashes the redacted transport; the other evidence files and signed-event verification are unchanged. This is a later redaction of the October 13 capture, not a new runtime run.

`docs/security/source-scan-fixtures.json` records the two removed findings under `redactedFixtures` as historical documentation only (path, line, rule, match digest, classification, reason and the commit where they were observed). That metadata is not part of the active `findings` baseline, is not a scanner exemption, and does not allow any secret.

This establishes current-source relay/harness/ACP delivery in the tested configuration. It does not establish the October 9 deployment configuration, OrbStack’s original startup cause, or an actual LLM following steering.
