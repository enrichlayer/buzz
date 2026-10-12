//! End-to-end over a real stdio agent: a Python script plays claude-agent-acp,
//! sending the AskUserQuestion `elicitation/create` it sends, and records
//! every line Buzz writes back. The relay is in memory.

use std::time::Duration;

use serde_json::{json, Value};

use super::super::{build_client_capabilities, AcpClient, StopReason};
use crate::agent_questions::tests::{asker, single_question_request, tag, FakeRelay};
use buzz_sdk::agent_prompt::{parse_prompt_state, PromptState};

/// Agent script. After the prompt it sends the elicitation, then acts on
/// `mode`: `wait` reads Buzz's reply and ends the turn; `cancel-request`
/// abandons the elicitation with `$/cancel_request` first; `session-cancel`
/// reads the reply, then answers `session/cancel` with a cancelled turn;
/// `twice` sends a second elicitation before reading both replies.
const AGENT: &str = r#"
import json, sys, time
log, mode, request = open(sys.argv[1], "a"), sys.argv[2], json.loads(sys.argv[3])
def send(message): print(json.dumps(message), flush=True)
def recv():
    line = sys.stdin.readline()
    log.write(line); log.flush()
    return json.loads(line)
prompt = json.loads(sys.stdin.readline())
send({"jsonrpc": "2.0", "id": "ask-1", "method": "session/request_permission" if mode.startswith("permission") else "elicitation/create", "params": request})
if mode.endswith("cancel-request"):
    time.sleep(0.5)  # let the card be posted first
    send({"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": "ask-1"}})
if mode == "twice":
    send({"jsonrpc": "2.0", "id": "ask-2", "method": "elicitation/create", "params": request})
    recv()
recv()
if mode.endswith("session-cancel"):
    recv()
    send({"jsonrpc": "2.0", "id": prompt["id"], "result": {"stopReason": "cancelled"}})
else:
    send({"jsonrpc": "2.0", "id": prompt["id"], "result": {"stopReason": "end_turn"}})
sys.stdin.readline()
"#;

struct Agent {
    client: AcpClient,
    log: std::path::PathBuf,
}

impl Agent {
    async fn spawn(mode: &str) -> Self {
        let log = std::env::temp_dir().join(format!("buzz-acp-question-{}", uuid::Uuid::new_v4()));
        let args = [
            "-c".to_string(),
            AGENT.to_string(),
            log.to_string_lossy().into_owned(),
            mode.to_string(),
            if mode.starts_with("permission") {
                permission_request().to_string()
            } else {
                single_question_request().to_string()
            },
        ];
        let client = AcpClient::spawn("python3", &args, &[], false)
            .await
            .expect("spawn agent script");
        Self { client, log }
    }

    /// The lines Buzz wrote to the agent after the prompt, as JSON.
    fn replies(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("json line"))
            .collect()
    }

    async fn prompt(&mut self, idle: Duration) -> Result<StopReason, super::super::AcpError> {
        self.prompt_capped(idle, Duration::from_secs(10)).await
    }

    async fn prompt_capped(
        &mut self,
        idle: Duration,
        cap: Duration,
    ) -> Result<StopReason, super::super::AcpError> {
        self.client
            .session_prompt_with_idle_timeout("s-1", "hi", idle, cap)
            .await
    }

    /// Wait (bounded) until the script has logged `count` replies.
    async fn wait_for_replies(&self, count: usize) -> Vec<Value> {
        for _ in 0..200 {
            let replies = self.replies();
            if replies.len() >= count {
                return replies;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "agent did not receive {count} replies: {:?}",
            self.replies()
        );
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.log);
    }
}

#[test]
fn buzz_advertises_form_elicitation() {
    assert_eq!(
        build_client_capabilities()["elicitation"],
        json!({"form": {}})
    );
}

#[tokio::test]
async fn an_answer_reaches_the_agent_even_after_a_longer_human_wait_than_the_idle_timeout() {
    // The answer lands after 250 polls of 10 ms (2.5 s or more); the idle
    // timeout is 1 s, long enough for the script to start under load.
    let relay = FakeRelay::new(
        250,
        Some((nostr::Keys::generate(), json!({"question_0": ["OAuth"]}))),
    );
    let mut agent = Agent::spawn("wait").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    let stop = agent.prompt(Duration::from_secs(1)).await;
    assert_eq!(stop.expect("turn completes"), StopReason::EndTurn);
    assert_eq!(
        agent.replies(),
        vec![json!({"jsonrpc": "2.0", "id": "ask-1",
            "result": {"action": "accept", "content": {"question_0": "OAuth"}}})]
    );
    assert!(agent.client.pending_question.is_none());
}

#[tokio::test]
async fn without_a_conversation_the_elicitation_is_declined() {
    let mut agent = Agent::spawn("wait").await;
    let stop = agent.prompt(Duration::from_secs(5)).await;
    assert_eq!(stop.expect("turn completes"), StopReason::EndTurn);
    assert_eq!(
        agent.replies(),
        vec![json!({"jsonrpc": "2.0", "id": "ask-1", "result": {"action": "decline"}})]
    );
}

async fn wait_for_cancelled_card(relay: &FakeRelay) {
    let events = relay.wait_for(3).await;
    assert_eq!(tag(&events[2], "op"), Some("update"));
    assert_eq!(
        parse_prompt_state(&events[2].content, &events[2].pubkey.to_hex()),
        Some(PromptState::Cancelled)
    );
}

#[tokio::test]
async fn cancelling_the_turn_withdraws_the_card_and_answers_cancel() {
    let relay = FakeRelay::new(0, None);
    let mut agent = Agent::spawn("session-cancel").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    // The pool drops the prompt future when a control cancel arrives.
    tokio::select! {
        _ = agent.prompt(Duration::from_secs(5)) => panic!("turn must still be waiting"),
        _ = relay.wait_for(2) => {}
    }
    let stop = agent
        .client
        .cancel_with_cleanup_grace("s-1", Duration::from_secs(5))
        .await;
    assert_eq!(stop.expect("cancelled turn"), StopReason::Cancelled);
    let replies = agent.replies();
    assert_eq!(
        replies[0],
        json!({"jsonrpc": "2.0", "id": "ask-1", "result": {"action": "cancel"}})
    );
    assert_eq!(replies[1]["method"], "session/cancel");
    wait_for_cancelled_card(&relay).await;
}

#[tokio::test]
async fn an_abandoned_elicitation_withdraws_the_card() {
    let relay = FakeRelay::new(0, None);
    let mut agent = Agent::spawn("cancel-request").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    let stop = agent.prompt(Duration::from_secs(5)).await;
    assert_eq!(stop.expect("turn completes"), StopReason::EndTurn);
    assert_eq!(
        agent.replies(),
        vec![json!({"jsonrpc": "2.0", "id": "ask-1", "result": {"action": "cancel"}})]
    );
    wait_for_cancelled_card(&relay).await;
}

#[tokio::test]
async fn ending_the_turn_withdraws_an_unanswered_card() {
    let relay = FakeRelay::new(0, None);
    let mut agent = Agent::spawn("wait").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    tokio::select! {
        _ = agent.prompt(Duration::from_secs(5)) => panic!("turn must still be waiting"),
        _ = relay.wait_for(2) => {}
    }
    agent.client.end_question_turn();
    assert!(agent.client.question_asker.is_none());
    wait_for_cancelled_card(&relay).await;
}

#[tokio::test]
async fn a_second_question_while_one_is_open_is_an_error_not_a_skip() {
    let relay = FakeRelay::new(
        5,
        Some((nostr::Keys::generate(), json!({"question_0": ["OAuth"]}))),
    );
    let mut agent = Agent::spawn("twice").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    let stop = agent.prompt(Duration::from_secs(5)).await;
    assert_eq!(stop.expect("turn completes"), StopReason::EndTurn);
    assert_eq!(
        agent.replies(),
        vec![
            json!({"jsonrpc": "2.0", "id": "ask-2", "error": {"code": -32603,
                "message": "another question is already open"}}),
            json!({"jsonrpc": "2.0", "id": "ask-1",
                "result": {"action": "accept", "content": {"question_0": "OAuth"}}}),
        ]
    );
}

#[tokio::test]
async fn the_hard_cap_answers_the_open_question_cancel_and_withdraws_it() {
    let relay = FakeRelay::new(0, None);
    let mut agent = Agent::spawn("wait").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    let stop = agent
        .prompt_capped(Duration::from_secs(30), Duration::from_secs(2))
        .await;
    assert!(
        matches!(stop, Err(super::super::AcpError::HardTimeout { .. })),
        "hard cap reported: {stop:?}"
    );
    assert!(agent.client.pending_question.is_none());
    assert_eq!(
        agent.wait_for_replies(1).await,
        vec![json!({"jsonrpc": "2.0", "id": "ask-1", "result": {"action": "cancel"}})]
    );
    wait_for_cancelled_card(&relay).await;
}

fn permission_request() -> Value {
    json!({"sessionId":"s-1", "toolCall": {"toolCallId":"tool-1", "title":"Run test command", "rawInput":{"command":"pwd", "cwd":"/tmp"}},
        "options":[{"optionId":"adapter-yes", "name":"Allow", "kind":"allow_once"}, {"optionId":"adapter-no", "name":"Deny", "kind":"reject_once"}]})
}

#[tokio::test]
async fn permission_waits_for_owner_and_maps_exact_adapter_option() {
    for (choice, expected) in [("Allow once", "adapter-yes"), ("Deny", "adapter-no")] {
        let owner = nostr::Keys::generate();
        let relay = FakeRelay::new(130, Some((owner.clone(), json!({"permission":[choice]}))));
        let mut agent = Agent::spawn("permission").await;
        agent.client.install_question_asker(Some(
            asker(relay.clone(), None)
                .with_permission_context(Some(owner.public_key()), "/tmp".into()),
        ));
        assert_eq!(
            agent.prompt(Duration::from_secs(1)).await.unwrap(),
            StopReason::EndTurn
        );
        assert_eq!(
            agent.replies(),
            vec![
                json!({"jsonrpc":"2.0", "id":"ask-1", "result":{"outcome":{"outcome":"selected", "optionId":expected}}})
            ]
        );
    }
}

#[tokio::test]
async fn permission_non_owner_answer_never_approves() {
    let owner = nostr::Keys::generate();
    let relay = FakeRelay::new(
        1,
        Some((
            nostr::Keys::generate(),
            json!({"permission":["Allow once"]}),
        )),
    );
    let mut agent = Agent::spawn("permission").await;
    agent.client.install_question_asker(Some(
        asker(relay, None).with_permission_context(Some(owner.public_key()), "/tmp".into()),
    ));
    assert!(agent
        .prompt_capped(Duration::from_secs(1), Duration::from_secs(2))
        .await
        .is_err());
    let replies = agent.wait_for_replies(1).await;
    assert_eq!(replies[0]["result"]["outcome"]["outcome"], "cancelled");
    assert!(replies
        .iter()
        .all(|v| v["result"]["outcome"]["outcome"] != "selected"));
}

#[tokio::test]
async fn permission_abandoned_request_withdraws_card_without_execution() {
    let owner = nostr::Keys::generate();
    let relay = FakeRelay::new(usize::MAX, None);
    let mut agent = Agent::spawn("permission-cancel-request").await;
    agent.client.install_question_asker(Some(
        asker(relay.clone(), None).with_permission_context(Some(owner.public_key()), "/tmp".into()),
    ));
    assert_eq!(
        agent.prompt(Duration::from_secs(2)).await.unwrap(),
        StopReason::EndTurn
    );
    assert_eq!(
        agent.replies()[0]["result"]["outcome"]["outcome"],
        "cancelled"
    );
    wait_for_cancelled_card(&relay).await;
}

#[tokio::test]
async fn permission_stop_withdraws_card_and_cancels_the_adapter() {
    let owner = nostr::Keys::generate();
    let relay = FakeRelay::new(usize::MAX, None);
    let mut agent = Agent::spawn("permission-session-cancel").await;
    agent.client.install_question_asker(Some(
        asker(relay.clone(), None).with_permission_context(Some(owner.public_key()), "/tmp".into()),
    ));
    tokio::select! {
        _ = agent.prompt(Duration::from_secs(5)) => panic!("permission must wait"),
        _ = relay.wait_for(2) => {}
    }
    assert_eq!(
        agent
            .client
            .cancel_with_cleanup_grace("s-1", Duration::from_secs(5))
            .await
            .unwrap(),
        StopReason::Cancelled
    );
    let replies = agent.replies();
    assert_eq!(replies[0]["result"]["outcome"]["outcome"], "cancelled");
    assert_eq!(replies[1]["method"], "session/cancel");
    wait_for_cancelled_card(&relay).await;
}

#[tokio::test]
async fn permission_without_an_owner_keeps_the_configured_policy_without_a_card() {
    // No owner: an unowned agent or a non-default permission mode
    // (`pool::question_asker` attaches no owner outside `default`).
    let relay = FakeRelay::new(0, None);
    let mut agent = Agent::spawn("permission").await;
    agent
        .client
        .install_question_asker(Some(asker(relay.clone(), None)));
    assert_eq!(
        agent.prompt(Duration::from_secs(2)).await.unwrap(),
        StopReason::EndTurn
    );
    assert_eq!(
        agent.replies(),
        vec![
            json!({"jsonrpc":"2.0", "id":"ask-1", "result":{"outcome":{"outcome":"selected", "optionId":"adapter-yes"}}})
        ]
    );
    assert!(relay.submitted().is_empty(), "no card without an owner");
}

#[test]
fn permission_v2_preserves_tool_payload_and_rejects_ambiguous_allow_options() {
    let owner = nostr::Keys::generate();
    let asker = asker(FakeRelay::new(0, None), None)
        .with_permission_context(Some(owner.public_key()), "/tmp".into());
    let mut params = permission_request();
    let tool = params.as_object_mut().unwrap().remove("toolCall").unwrap();
    params["subject"] = json!({"toolCall": tool});
    let mut request = json!({"id":"v2-permission", "params":params});
    let prompt = super::super::permissions::permission_prompt(&request, &asker).unwrap();
    let content: Value = serde_json::from_str(&prompt.content).unwrap();
    assert_eq!(content["permission"]["toolCall"], tool);
    request["params"]["options"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"allow_once","optionId":"second"}));
    assert!(super::super::permissions::permission_prompt(&request, &asker).is_err());
}

#[tokio::test]
async fn an_owner_answer_after_a_member_revision_still_decides_the_permission() {
    let owner = nostr::Keys::generate();
    let relay = FakeRelay::new(usize::MAX, None);
    let asker =
        asker(relay.clone(), None).with_permission_context(Some(owner.public_key()), "/tmp".into());
    let request = json!({"id":"p-1", "params":{"sessionId":"s-1",
        "toolCall": {"toolCallId":"tool-1", "title":"Run", "rawInput":{"command":"pwd", "cwd":"/tmp"}},
        "options":[{"optionId":"yes", "name":"Allow", "kind":"allow_once"}, {"optionId":"no", "name":"Deny", "kind":"reject_once"}]}});
    let prompt = super::super::permissions::permission_prompt(&request, &asker).expect("card");
    let handle = asker.ask(&prompt);
    let card = relay.wait_for(2).await.pop().expect("card");
    let d = tag(&card, "d").expect("d").to_string();
    let revise = |keys: &nostr::Keys, prev: &nostr::Event, state: &str| {
        let mut content: serde_json::Map<String, Value> =
            serde_json::from_str(&card.content).expect("content");
        content.insert("state".into(), state.into());
        if state == "answered" {
            content.insert("answer".into(), json!({"permission":["Allow once"]}));
            content.insert("answeredBy".into(), keys.public_key().to_hex().into());
        }
        nostr::EventBuilder::new(
            nostr::Kind::Custom(45010),
            Value::Object(content).to_string(),
        )
        .tags(
            buzz_sdk::agent_prompt::build_prompt_update_tags(
                &d,
                crate::agent_questions::tests::CHANNEL,
                "t",
                None,
                &prev.id.to_hex(),
            )
            .unwrap(),
        )
        .sign_with_keys(keys)
        .unwrap()
    };
    let squat = revise(&nostr::Keys::generate(), &card, "open");
    crate::agent_questions::QuestionRelay::submit(relay.as_ref(), &squat)
        .await
        .unwrap();
    let decision = revise(&owner, &squat, "answered");
    crate::agent_questions::QuestionRelay::submit(relay.as_ref(), &decision)
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(5), handle.outcome_rx)
        .await
        .expect("decided in time")
        .expect("outcome");
    assert_eq!(
        outcome,
        crate::agent_questions::QuestionOutcome::Answered(std::collections::BTreeMap::from([(
            "permission".to_string(),
            vec!["Allow once".to_string()]
        )]))
    );
}
