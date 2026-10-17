# Agent steering review

Author review against VISION.md, VISION_AGENT.md, VISION_REMOTE_AGENTS.md,
TESTING.md and the repository review-proven rules. This is not an independent
review or host approval. Goal: explain default channel steering accurately and
provide a reproducible real-relay regression without changing routing policy.

## Findings and dispositions

| Finding | Disposition and owner | Validation |
| --- | --- | --- |
| Delivery assertions could count a later ordinary prompt as same-turn steering | Fixed in runner: exact ordered methods, one initial prompt, shared session ID, no cancellation, adapter responses and harness success acknowledgements. Owner: this change | Passed both filtering modes |
| Current schema manifest uses relative SQL includes | Fixed runner's schema invocation to use the schema directory. Owner: this change | Passed startup on attempt 1 |
| Sequential free-port selection could reuse a fixture port | Fixed by binding all seven sockets before releasing them. Owner: this change | Passed isolated fixture startup |
| Deterministic adapter could outlive a failed harness indefinitely | Adapter now has a six-minute lifetime; readiness subprocesses have bounded communication and process-group cleanup. Owner: this change | Ruff and both relay modes passed; clean shutdown |
| Late HTTP responses or WebSocket frames could inherit the next case label | Recorder now snapshots each connection/request case rather than reading the mutable active case at completion. Owner: this change | Fresh transport/adapter trace captured |
| Old worktree ancestry included unrelated feature commits | Change moved onto current fork main; only the steering diff is being published. Owner: this change | Steering-only diff against fork main |
| Prior run evidence would not validate the new PR base or stricter assertions | Retain original attribution; rebuild and rerun before publication. Owner: this change | Fresh build, relay and desktop checks passed; full CI pending |

The UI keeps theme and rem-based text tokens, associates the guidance with the
existing control's accessible description, and qualifies the behavior as default
settings. The regression crosses actual relay subscriptions, signed events,
harness admission/session routing and ACP delivery; its recorder forwards wire
traffic unchanged. Reaction receipts remain diagnostic evidence, with no
speculative product retry change.

Minimalism: 9/10. Elegance: 9/10. Correctness: 9/10 after the fixes above,
subject to the recorded validation results. No remaining source blocker found.
Human testing and full CI must remain pending until their actual results exist;
this change is being opened as a draft.

Fresh evidence: [real-relay delivery trace](evidence/agent-steering/2026-10-13/DELIVERY_TRACE.md).
