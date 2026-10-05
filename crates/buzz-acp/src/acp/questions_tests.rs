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
/// reads the reply, then answers `session/cancel` with a cancelled turn.
const AGENT: &str = r#"
import json, sys, time
log, mode, request = open(sys.argv[1], "a"), sys.argv[2], json.loads(sys.argv[3])
def send(message): print(json.dumps(message), flush=True)
def recv():
    line = sys.stdin.readline()
    log.write(line); log.flush()
    return json.loads(line)
prompt = json.loads(sys.stdin.readline())
send({"jsonrpc": "2.0", "id": "ask-1", "method": "elicitation/create", "params": request})
if mode == "cancel-request":
    time.sleep(0.5)  # let the card be posted first
    send({"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": "ask-1"}})
recv()
if mode == "session-cancel":
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
            single_question_request().to_string(),
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
        self.client
            .session_prompt_with_idle_timeout("s-1", "hi", idle, Duration::from_secs(10))
            .await
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
