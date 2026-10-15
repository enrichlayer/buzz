# Agent coordination for Factory and Buzz

Factory should own agent execution, credentials, workspaces and task authority. Buzz should give every enrolled runtime an address and a durable conversation history. Each runtime needs an adapter that brings relevant messages into its active context and publishes correlated replies. This lets agents ask peers for help without requiring the Orchestrator to relay every exchange.

## What the Noam Brown interview supports

In the September 17, 2026 interview, Brown describes OpenAI's approach as primitive agent messaging: a tool call sends a message that enters another agent's context. Agents can ask clarification questions, compare answers and organize their cooperation. He contrasts this flexibility with parent–child scaffolds that make sibling consultation difficult. He also says communication benefits from training and an initial prior about productive collaboration. Putting agents together does not automatically make them cooperate. [Podcast transcript](https://www.dwarkesh.com/p/noam-brown)

Brown describes parallel inference as a latency–cost tradeoff whose benefit depends on the problem. He explicitly cautions that very large swarms lack thorough scaling measurements, and attributes the headline mathematical result primarily to model strength. The practical lesson is to measure useful collaboration at small scale before increasing the fleet. The interview describes research behavior; it does not establish that a public SDK reproduces that system. [Podcast transcript](https://www.dwarkesh.com/p/noam-brown)

## What modern solutions actually provide

| Approach | Coordination mechanism | Fit for this fleet |
|---|---|---|
| OpenAI Agents SDK | Agents exposed as tools, conversational handoffs, or orchestration written in code | Useful inside a Factory task; fleet-wide transport and lifecycle still need integration |
| LangChain and LangGraph | Subagents, handoffs, routing, skills and custom workflows | Useful when a task needs explicit state transitions or isolated specialist contexts |
| AutoGen Swarm | Agents select handoffs within a shared group conversation | Useful for experimenting with decentralized delegation; its turn-taking model differs from independently running laptops and workers |
| CrewAI Flows | Event-driven workflow methods and persisted flow state | Useful for a repeatable business process with agent work inside it |
| A2A | Agent discovery and interoperable message/task interfaces | Useful at an external agent-service boundary; not a replacement for runtime injection or Factory authority |

The capability descriptions below are sourced; the fit assessments are architectural judgments for our existing Factory and Buzz system.

### OpenAI Agents SDK

The SDK distinguishes a manager invoking specialists as tools from handing the conversation to a specialist. It also supports code-defined sequencing, evaluator loops and parallel execution. These are composition choices: a manager can own a final answer while a specialist performs bounded work, or a specialist can become the active conversational agent. [Official orchestration guide](https://openai.github.io/openai-agents-python/multi_agent/)

For Factory, use such patterns inside an authorized task when they improve its result. A fleet member should retain its Buzz identity regardless of which internal SDK pattern it uses. Moving all fleet communication into one SDK runner would couple otherwise independent runtimes to that runner's lifetime.

### LangChain and LangGraph

The documentation separates subagents, handoffs, skills, routing and custom LangGraph workflows. Its central concern is context: specialists should see information relevant to their work. Its illustrated comparisons count model calls and tokens for particular scenarios; those figures are not general performance guarantees. [Official multi-agent guide](https://docs.langchain.com/oss/python/langchain/multi-agent)

That distinction matters here. Engineering, Marketing and Sales can have different tools and context without requiring a distinct process for every skill. Where a workflow already exists in Factory, adding another orchestration engine needs a concrete benefit, such as a task-specific state machine. It should not introduce a second authority for launching or completing the same task.

### AutoGen Swarm

AutoGen's Swarm uses handoff tool calls and a shared conversation. Participants take turns, and responses are broadcast into their shared context. The documentation warns that simultaneous handoffs from parallel tool calls can produce unexpected behavior. [Official Swarm guide](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html)

This is a useful coordination pattern, but the fleet has different operational needs: separate machines, disconnected clients, private credentials and independently progressing tasks. Copying every channel message into every runtime would increase context cost and interruption load. Start with explicit mentions and relevant task threads, then evaluate whether broader subscriptions improve outcomes.

### CrewAI Flows

CrewAI Flows provides workflow state and persistence. Its `@persist` mechanism can persist at class or method scope; documented resume and fork modes distinguish continuing the same flow history from starting a new history from saved state. [Official Flows guide](https://docs.crewai.com/en/concepts/flows)

Those semantics are useful for repeatable commercial processes. However, saving workflow state does not by itself prove that an external action happened once. Buzz request IDs must still correlate to Factory execution and results, particularly when a reply is retried after a crash. Adopt a new flow engine only if it fills a demonstrated gap in the existing task lifecycle.

### A2A

A2A specifies discovery through Agent Cards, messaging, task operations and authentication-related behavior. Its specification includes streaming and push-notification interfaces and describes its relationship to MCP. [A2A specification](https://a2a-protocol.org/latest/specification/)

An A2A gateway could later expose selected Factory capabilities to external services. Internally, we already have Buzz identities and conversations. Adding a protocol gateway now would not solve the immediate problem of getting a message into an actual running agent's context. Preserve the ability to add that boundary without making it a prerequisite for the three-runtime acceptance run.

## The Factory and Buzz design

Enrollment must bind an identity to a concrete native runtime and reuse it after restart. The owner provisioning key belongs in the trusted enrollment process. Only a delegated agent credential enters the model subprocess. Profile creation, membership, runtime readiness and task completion must be recorded separately: appearing in Buzz is the first of those states.

Agents should choose whom to consult within their authorized work. Buzz carries signed, channel-scoped messages and thread references. A runtime adapter verifies incoming events, selects addressed context, saves pending delivery and inserts that context through the runtime's supported interface. The agent can then respond in the originating thread with evidence from its work.

For Pi, the existing RPC mailbox is the insertion point. A successful `follow_up` RPC response can mean only that Pi queued the message in memory. The inbox therefore retains it until the durable Pi transcript records consumption. This addresses delivery recovery; a separate task-level idempotency record is still required to prevent duplicate business actions.

Peer messages supply context and requests. They do not confer credentials, user consent or permission to launch arbitrary work. Factory remains responsible for deciding whether a requested action belongs to an existing authorized task or requires a separate approved task. A peer can ask for help without acquiring the recipient's execution privileges.

The first rollout should retain the existing publisher and task loop. It should also keep explicit limits on inbox size, message length, polling, retries and task spending. Later subscriptions can be broader if measurements show that the additional traffic produces useful work.

## The acceptance experiment

Use one real local telemetry-connected agent, one Herdr agent and the Herdr-based Factory Pi worker. Give the three agents complementary evidence for one bounded task so that a useful answer requires consultation. For example, one checks a local lifecycle receipt, another inspects the remote workspace, and Pi reconciles the deployment evidence. Merely posting three greetings would prove transport but not collaboration.

Record the native session or workspace ID, Buzz pubkey, exact deployed source, request event, recipient consumption evidence, action receipt and reply event. The resulting thread should show that one agent's answer changed or enabled another's work. Verify the correlation independently from the sender's own success message.

Then restart a recipient after intake but before durable consumption. It should recover the pending message. Replay the original request after a completed action and verify that the business action does not execute again. Test an unaddressed message, a wrong-channel event and a peer request for new privileges; these must not silently expand execution scope.

For the shared roles, keep stable identities for Tools Orchestrator, Engineering, Marketing and Sales while Factory owns their runtime instances. Nico's acceptance run must use Nico's own authenticated Buzz request and return useful results to that thread while the laptop Tools runtimes are verified stopped. Retain the old profiles until those receipts establish the migration.

## What to measure before expanding

Compare the same bounded tasks with one agent and with the three-agent group. Measure success against independently checked outcomes, elapsed time, model/tool cost, duplicate work, unanswered requests, message volume and recovery after interruption. Track which peer responses materially changed an action or conclusion.

Expand only where collaboration improves those outcomes enough to justify its overhead. The number of online profiles is an inventory metric; the stronger delivery metric is an authorized task that completes correctly through independently verified cooperation.

## Implementation status

The implementation and current gaps are tracked in [the evidence ledger](fleet-runtime-enrollment-evidence.md) and [Tools draft !7600](https://gitlab.com/vertical-int/tools/-/merge_requests/7600). Local candidate enrollment and an outbound message have live receipts. Herdr and Factory Pi deployment, their real peer responses, the shared-role migration and Nico's acceptance remain pending.
