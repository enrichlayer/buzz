//! Agent questions (DEV-11266): an agent's ACP form elicitation becomes a
//! `buzz.agent_prompt` question card in the conversation the turn answers,
//! and the first answer becomes the elicitation response.
//!
//! Flow, per question: post a short kind-9 anchor message in the turn's reply
//! thread, create the prompt artifact rooted at it, then poll the artifact's
//! current head until it is answered, cancelled, or removed. Cancelling the
//! turn withdraws the card by publishing a `state: "cancelled"` revision.
//! See `docs/plans/agent-questions.md`.

mod mapping;

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use buzz_sdk::agent_prompt::{
    build_prompt_tags, build_prompt_update_tags, parse_prompt_state, PromptState,
};
use futures_util::future::BoxFuture;
use nostr::{Event, EventBuilder, EventId, Keys, Kind};
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use crate::relay::RestClient;

pub(crate) use mapping::{
    accept_content, ask_prompt_from_request, AskPrompt, AskQuestion, Unsupported,
};

/// NIP-AR artifact revision kind.
const KIND_ARTIFACT: u16 = 45010;
/// How often an open card's head is polled for an answer.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Longest wait between polls after relay errors (exponential backoff).
const MAX_POLL_BACKOFF: Duration = Duration::from_secs(30);
/// Bound on a single relay call.
const RELAY_CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Head reads and writes tried when withdrawing a card; a conflict means
/// someone else changed it, so the loop re-reads before writing again.
const WITHDRAW_ATTEMPTS: usize = 3;

/// Card withdrawals still running, so harness shutdown can let them finish.
static WITHDRAWALS: LazyLock<TaskTracker> = LazyLock::new(TaskTracker::new);

/// Wait (bounded) for question tasks to finish withdrawing their cards. A
/// turn aborted at shutdown drops its pending question, which starts the
/// withdrawal; without this the runtime would exit before it is sent.
pub(crate) async fn drain_withdrawals(limit: Duration) {
    WITHDRAWALS.close();
    if tokio::time::timeout(limit, WITHDRAWALS.wait())
        .await
        .is_err()
    {
        tracing::warn!(target: "acp::question", "question cards still open at shutdown");
    }
}

/// The relay calls a question needs. Implemented by [`RestClient`]; tests
/// substitute an in-memory relay.
pub(crate) trait QuestionRelay: Send + Sync {
    /// Publish a signed event; `Err` carries the relay's reason.
    fn submit<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, Result<(), String>>;
    /// The current head revision of artifact `d` in `channel`, if any.
    fn head<'a>(
        &'a self,
        channel: Uuid,
        d: &'a str,
    ) -> BoxFuture<'a, Result<Option<Event>, String>>;
}

impl QuestionRelay for RestClient {
    fn submit<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let response = self.submit_event(event).await.map_err(|e| e.to_string())?;
            if response.get("accepted").and_then(Value::as_bool) == Some(false) {
                let reason = response.get("message").and_then(Value::as_str);
                return Err(reason.unwrap_or("rejected").to_string());
            }
            Ok(())
        })
    }

    fn head<'a>(
        &'a self,
        channel: Uuid,
        d: &'a str,
    ) -> BoxFuture<'a, Result<Option<Event>, String>> {
        Box::pin(async move {
            // The relay's artifact heads follow the prev chain it enforces.
            let filter = serde_json::json!({
                "artifact": "current", "kinds": [KIND_ARTIFACT],
                "#h": [channel.to_string()], "#d": [d], "limit": 1,
            });
            let events = self.query_raw(&[filter]).await.map_err(|e| e.to_string())?;
            let Some(first) = events.as_array().and_then(|events| events.first()) else {
                return Ok(None);
            };
            let event: Event = serde_json::from_value(first.clone()).map_err(|e| e.to_string())?;
            event.verify().map_err(|e| e.to_string())?;
            Ok(Some(event))
        })
    }
}

/// How a card ended, reported to the waiting read loop.
#[derive(Debug, PartialEq)]
pub(crate) enum QuestionOutcome {
    /// First valid answer: question id → choices.
    Answered(BTreeMap<String, Vec<String>>),
    /// Someone cancelled, moved or deleted the card.
    Withdrawn,
    /// The card could not be posted.
    Failed(String),
}

/// A running question: its outcome, and the switch that withdraws it.
pub(crate) struct AskHandle {
    pub outcome_rx: oneshot::Receiver<QuestionOutcome>,
    /// Send (or drop) to cancel: the card is withdrawn and no outcome sent.
    pub cancel_tx: oneshot::Sender<()>,
}

/// Where and as whom one turn asks its questions.
#[derive(Clone)]
pub(crate) struct QuestionAsker {
    relay: Arc<dyn QuestionRelay>,
    keys: Keys,
    channel_id: Uuid,
    /// The turn's reply thread (the triggering thread's root, or the
    /// triggering top-level message); `None` posts at top level.
    thread_root: Option<EventId>,
    agent_name: Option<String>,
    poll_interval: Duration,
}

impl QuestionAsker {
    pub(crate) fn new(
        relay: Arc<dyn QuestionRelay>,
        keys: Keys,
        channel_id: Uuid,
        thread_root: Option<EventId>,
        agent_name: Option<String>,
    ) -> Self {
        Self {
            relay,
            keys,
            channel_id,
            thread_root,
            agent_name,
            poll_interval: POLL_INTERVAL,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    /// Post `prompt` as a card and wait for it in a background task.
    pub(crate) fn ask(&self, prompt: &AskPrompt) -> AskHandle {
        let (outcome_tx, outcome_rx) = oneshot::channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let asker = self.clone();
        let fields = prompt.questions.iter().map(|q| q.field.clone()).collect();
        let (content, title) = (prompt.content.clone(), prompt.title.clone());
        WITHDRAWALS.spawn(async move {
            asker
                .run(content, title, fields, cancel_rx, outcome_tx)
                .await;
        });
        AskHandle {
            outcome_rx,
            cancel_tx,
        }
    }

    async fn run(
        self,
        content: String,
        title: String,
        fields: Vec<String>,
        mut cancel_rx: oneshot::Receiver<()>,
        outcome_tx: oneshot::Sender<QuestionOutcome>,
    ) {
        let d = Uuid::new_v4().to_string();
        let mut created = false;
        let outcome = tokio::select! {
            biased;
            _ = &mut cancel_rx => None,
            outcome = self.post_and_wait(&d, &content, &title, &fields, &mut created) => Some(outcome),
        };
        match outcome {
            // A create that timed out may still have landed: withdraw it.
            Some(QuestionOutcome::Failed(reason)) => {
                if created {
                    self.withdraw(&d).await;
                }
                let _ = outcome_tx.send(QuestionOutcome::Failed(reason));
            }
            Some(outcome) => {
                let _ = outcome_tx.send(outcome);
            }
            None if created => self.withdraw(&d).await,
            None => {}
        }
    }

    /// Post the anchor and the card, then poll until it is resolved. Sets
    /// `created` once the create may have reached the relay.
    async fn post_and_wait(
        &self,
        d: &str,
        content: &str,
        title: &str,
        fields: &[String],
        created: &mut bool,
    ) -> QuestionOutcome {
        let anchor = match self.anchor_event(title) {
            Ok(anchor) => anchor,
            Err(e) => return QuestionOutcome::Failed(e),
        };
        if let Err(e) = self.submit(&anchor).await {
            return QuestionOutcome::Failed(format!("anchor message: {e}"));
        }
        let channel = self.channel_id.to_string();
        let card = build_prompt_tags(d, &channel, &anchor.id.to_hex(), title)
            .map_err(|e| e.to_string())
            .and_then(|tags| {
                self.sign(EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content).tags(tags))
            });
        let card = match card {
            Ok(card) => card,
            Err(e) => return QuestionOutcome::Failed(e),
        };
        *created = true;
        if let Err(e) = self.submit(&card).await {
            return QuestionOutcome::Failed(format!("question card: {e}"));
        }
        tracing::info!(target: "acp::question", artifact = d, "question card posted");
        let mut delay = self.poll_interval;
        loop {
            tokio::time::sleep(delay).await;
            let head = match tokio::time::timeout(
                RELAY_CALL_TIMEOUT,
                self.relay.head(self.channel_id, d),
            )
            .await
            {
                Ok(Ok(head)) => head,
                Ok(Err(e)) => {
                    tracing::warn!(target: "acp::question", artifact = d, "head read failed: {e}");
                    delay = (delay * 2).min(MAX_POLL_BACKOFF);
                    continue;
                }
                Err(_) => {
                    delay = (delay * 2).min(MAX_POLL_BACKOFF);
                    continue;
                }
            };
            delay = self.poll_interval;
            let Some(head) = head else {
                return QuestionOutcome::Withdrawn;
            };
            match parse_prompt_state(&head.content, &head.pubkey.to_hex()) {
                Some(PromptState::Answered(answer))
                    if answer.len() == fields.len()
                        && fields.iter().all(|f| answer.contains_key(f)) =>
                {
                    return QuestionOutcome::Answered(answer)
                }
                Some(PromptState::Cancelled) => return QuestionOutcome::Withdrawn,
                // Open, or a revision whose answer is not a valid answer to
                // these questions from its signer: keep waiting.
                _ => {}
            }
        }
    }

    /// Publish a cancelled revision if the card is still open. Best effort:
    /// a card someone else answered or changed is left alone.
    async fn withdraw(&self, d: &str) {
        for _ in 0..WITHDRAW_ATTEMPTS {
            let head =
                match tokio::time::timeout(RELAY_CALL_TIMEOUT, self.relay.head(self.channel_id, d))
                    .await
                {
                    Ok(Ok(Some(head))) => head,
                    Ok(Ok(None)) => return,
                    _ => continue,
                };
            if parse_prompt_state(&head.content, &head.pubkey.to_hex()) != Some(PromptState::Open) {
                return;
            }
            let event = match self.cancelled_revision(d, &head) {
                Ok(event) => event,
                Err(e) => {
                    tracing::warn!(target: "acp::question", artifact = d, "cannot withdraw card: {e}");
                    return;
                }
            };
            match self.submit(&event).await {
                Ok(()) => {
                    tracing::info!(target: "acp::question", artifact = d, "question card withdrawn");
                    return;
                }
                Err(e) => {
                    tracing::debug!(target: "acp::question", artifact = d, "withdraw failed: {e}")
                }
            }
        }
        tracing::warn!(target: "acp::question", artifact = d, "could not withdraw question card");
    }

    /// The next revision of `head` with `state: "cancelled"`, keeping its
    /// other content fields and its title and root.
    fn cancelled_revision(&self, d: &str, head: &Event) -> Result<Event, String> {
        let mut content: serde_json::Map<String, Value> =
            serde_json::from_str(&head.content).map_err(|e| e.to_string())?;
        content.insert("state".into(), "cancelled".into());
        let tag = |name: &str| {
            head.tags
                .iter()
                .find(|t| t.as_slice().first().map(String::as_str) == Some(name))
                .and_then(|t| t.as_slice().get(1).cloned())
        };
        let title = tag("title").ok_or("head has no title")?;
        let tags = build_prompt_update_tags(
            d,
            &self.channel_id.to_string(),
            &title,
            tag("root").as_deref(),
            &head.id.to_hex(),
        )
        .map_err(|e| e.to_string())?;
        let content = serde_json::to_string(&content).map_err(|e| e.to_string())?;
        self.sign(EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content).tags(tags))
    }

    /// The kind-9 message the card hangs under, in the turn's reply thread.
    fn anchor_event(&self, title: &str) -> Result<Event, String> {
        let text = match &self.agent_name {
            Some(name) => format!("{name} asks: {title}"),
            None => format!("Question: {title}"),
        };
        let thread = self.thread_root.map(|root| buzz_sdk::ThreadRef {
            root_event_id: root,
            parent_event_id: root,
        });
        let builder = buzz_sdk::build_message(
            self.channel_id,
            &text,
            thread.as_ref(),
            &[],
            false,
            &[],
            &[],
        )
        .map_err(|e| e.to_string())?;
        self.sign(builder)
    }

    fn sign(&self, builder: EventBuilder) -> Result<Event, String> {
        builder
            .sign_with_keys(&self.keys)
            .map_err(|e| e.to_string())
    }

    async fn submit(&self, event: &Event) -> Result<(), String> {
        match tokio::time::timeout(RELAY_CALL_TIMEOUT, self.relay.submit(event)).await {
            Ok(result) => result,
            Err(_) => Err("relay timed out".into()),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
