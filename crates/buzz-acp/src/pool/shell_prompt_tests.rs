//! `run_prompt_task`'s direct-command path over a real Bash process and a
//! loopback HTTP relay: shell requests are split from the batch, run before
//! any model prompt, and only an explicit stop kills them.
use super::*;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Loopback relay: answers every request with `[]` and records each
/// `POST /events` body.
async fn relay() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let published = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&published);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let sink = Arc::clone(&sink);
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0; 8192];
                let body = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&request);
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break (text[..end].to_string(), text[end + 4..].to_string());
                    }
                };
                if body.0.starts_with("POST /events") {
                    sink.lock().unwrap().push(body.1);
                }
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]",
                    )
                    .await;
            });
        }
    });
    (url, published)
}

struct Fixture {
    ctx: Arc<PromptContext>,
    batch: FlushBatch,
    published: Arc<Mutex<Vec<String>>>,
    receipts: std::path::PathBuf,
    _cwd: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.receipts);
    }
}

async fn fixture(command: &str) -> Fixture {
    let owner = nostr::Keys::generate();
    let agent_keys = nostr::Keys::generate();
    let channel_id = Uuid::new_v4();
    let (url, published) = relay().await;
    let cwd = tempfile::tempdir().unwrap();
    let mut ctx = tests::make_prompt_context_with_owner(&agent_keys, owner.public_key());
    ctx.dedup_mode = DedupMode::Queue;
    ctx.cwd = cwd.path().to_string_lossy().into_owned();
    ctx.rest_client.base_url = url;
    ctx.channel_info = ChannelInfoResolver::new(
        HashMap::from([(
            channel_id,
            ChannelInfo {
                name: "shell".into(),
                channel_type: "stream".into(),
                description: None,
            },
        )]),
        ctx.rest_client.clone(),
    );
    let agent = agent_keys.public_key().to_hex();
    let message = |content: &str, tags: Vec<nostr::Tag>| crate::queue::BatchEvent {
        event: nostr::EventBuilder::new(nostr::Kind::Custom(9), content)
            .tags(tags)
            .sign_with_keys(&owner)
            .unwrap(),
        prompt_tag: "@mention".into(),
        received_at: Instant::now(),
        edit: None,
    };
    let routing = || {
        vec![
            nostr::Tag::parse(["h", &channel_id.to_string()]).unwrap(),
            nostr::Tag::parse(["p", &agent]).unwrap(),
        ]
    };
    let mut shell_tags = routing();
    shell_tags.push(nostr::Tag::parse([crate::shell_commands::TAG, "1", &agent, command]).unwrap());
    let batch = FlushBatch {
        channel_id,
        scope: tests::conv(channel_id),
        events: vec![
            message(&format!("!{command}"), shell_tags),
            message("and what does that mean?", routing()),
        ],
        cancelled_events: vec![],
        cancel_reason: None,
    };
    let receipts = std::path::Path::new(&std::env::var_os("HOME").unwrap())
        .join(".buzz/shell-receipts")
        .join(&agent);
    Fixture {
        ctx: Arc::new(ctx),
        batch,
        published,
        receipts,
        _cwd: cwd,
    }
}

async fn owned_agent() -> OwnedAgent {
    OwnedAgent {
        index: 0,
        acp: AcpClient::spawn("bash", &["-c".into(), "exec sleep 30".into()], &[], false)
            .await
            .unwrap(),
        state: SessionState::default(),
        model_capabilities: None,
        desired_model: None,
        model_overridden: false,
        desired_model_request_id: None,
        desired_model_pending_ack: false,
        startup_effort: None,
        agent_name: "shell-test-agent".into(),
        goose_system_prompt_supported: None,
        protocol_version: 1,
    }
}

/// Run one turn, sending `signal` while the command is still running.
/// Also returns how long the turn took after the signal.
async fn run_with_signal(fixture: &Fixture, signal: ControlSignal) -> (PromptResult, Duration) {
    let (result_tx, mut result_rx) = mpsc::unbounded_channel();
    let (control_tx, control_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(run_prompt_task(
        owned_agent().await,
        Some(fixture.batch.clone()),
        None,
        Arc::clone(&fixture.ctx),
        result_tx,
        Some(control_rx),
        "shell-turn".into(),
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let signalled = Instant::now();
    control_tx.send(signal).unwrap();
    let mut result = tokio::time::timeout(Duration::from_secs(10), result_rx.recv())
        .await
        .expect("turn finished")
        .expect("prompt result");
    let elapsed = signalled.elapsed();
    task.await.unwrap();
    result.agent.acp.shutdown().await;
    (result, elapsed)
}

#[tokio::test]
async fn steer_during_a_command_lets_it_finish_then_requeues_the_rest_as_a_steer() {
    let fixture = fixture("sleep 1; printf '%s-%s' out put").await;
    let (result, after_signal) = run_with_signal(&fixture, ControlSignal::Steer).await;
    assert!(
        after_signal >= Duration::from_millis(500),
        "command ran to completion"
    );
    assert!(matches!(result.outcome, PromptOutcome::Cancelled));
    let retry = result.batch.expect("steer keeps the batch");
    assert_eq!(retry.cancel_reason, Some(CancelReason::Steer));
    assert_eq!(
        retry
            .events
            .iter()
            .map(|e| e.event.content.as_str())
            .collect::<Vec<_>>(),
        ["and what does that mean?"],
        "the shell request is split out; the chat message waits for the model"
    );
    let published = fixture.published.lock().unwrap().clone();
    assert_eq!(published.len(), 1);
    assert!(published[0].contains("completed") && published[0].contains("out-put"));
}

#[tokio::test]
async fn switch_model_during_a_command_lands_after_it_finishes() {
    let fixture = fixture("sleep 1; printf '%s-%s' out put").await;
    let (result, _) = run_with_signal(
        &fixture,
        ControlSignal::SwitchModel {
            model_id: "model-b".into(),
            request_id: Some("pick-1".into()),
        },
    )
    .await;
    assert!(matches!(result.outcome, PromptOutcome::Cancelled));
    assert_eq!(result.agent.desired_model.as_deref(), Some("model-b"));
    assert!(result.agent.desired_model_pending_ack);
    let retry = result.batch.expect("switch requeues the batch");
    assert_eq!(retry.cancel_reason, Some(CancelReason::Interrupt));
    assert!(fixture.published.lock().unwrap()[0].contains("completed"));
}

#[tokio::test]
async fn cancel_during_a_command_stops_it_and_drops_the_batch() {
    let fixture = fixture("sleep 5; printf '%s-%s' out put").await;
    let (result, after_signal) = run_with_signal(&fixture, ControlSignal::Cancel).await;
    assert!(
        after_signal < Duration::from_secs(4),
        "cancel stopped the command"
    );
    assert!(matches!(result.outcome, PromptOutcome::Cancelled));
    assert!(result.batch.is_none());
    let published = fixture.published.lock().unwrap().clone();
    assert_eq!(published.len(), 1);
    assert!(
        published[0].contains("Command stopped by session control")
            && !published[0].contains("out-put")
    );
}

#[test]
fn permission_cards_attach_an_owner_only_in_default_mode() {
    let owner = nostr::Keys::generate();
    let agent = nostr::Keys::generate();
    let channel_id = Uuid::new_v4();
    let batch = FlushBatch {
        channel_id,
        scope: tests::conv(channel_id),
        events: vec![],
        cancelled_events: vec![],
        cancel_reason: None,
    };
    for (mode, expected) in [
        (PermissionMode::Default, Some(owner.public_key())),
        (PermissionMode::BypassPermissions, None),
        (PermissionMode::AcceptEdits, None),
        (PermissionMode::DontAsk, None),
    ] {
        let mut ctx = tests::make_prompt_context_with_owner(&agent, owner.public_key());
        ctx.permission_mode = mode;
        let asker = question_asker(&ctx, Some(&batch)).expect("channel turn asks");
        assert_eq!(asker.permission_owner, expected, "{mode:?}");
    }
}
