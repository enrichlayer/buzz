//! ACP `elicitation/create` handling for [`AcpClient`] (DEV-11266).
//!
//! Buzz advertises `clientCapabilities.elicitation.form`, which makes
//! claude-agent-acp route AskUserQuestion through `elicitation/create`. An
//! AskUserQuestion form becomes a question card (see
//! [`crate::agent_questions`]); any other form is declined at once so the
//! agent never waits on a request Buzz cannot show.
//!
//! The pending question lives on the client, not in the read loop, because a
//! control cancel drops the read loop mid-turn and
//! [`AcpClient::cancel_with_cleanup`] must still withdraw the card and answer
//! the agent.

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{AcpClient, AcpError};
use crate::agent_questions::{
    accept_content, ask_prompt_from_request, AskQuestion, QuestionAsker, QuestionOutcome,
    Unsupported,
};

/// An `elicitation/create` request waiting on its card.
pub(super) struct PendingQuestion {
    request_id: Value,
    questions: Vec<AskQuestion>,
    cancel_tx: oneshot::Sender<()>,
}

/// Receiver the read loop awaits for the pending question's outcome.
pub(super) type QuestionRx = oneshot::Receiver<QuestionOutcome>;

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn decline(id: &Value, why: &str) -> Value {
    tracing::info!(target: "acp::question", "declining elicitation id={id}: {why}");
    result(id, json!({"action": "decline"}))
}

fn error(id: &Value, message: String) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": message}})
}

impl AcpClient {
    /// Set where this turn's questions are posted. `None` (heartbeats, local
    /// tasks, no reply destination) makes every elicitation decline.
    pub(crate) fn install_question_asker(&mut self, asker: Option<QuestionAsker>) {
        self.question_asker = asker;
    }

    /// End of turn: stop asking and withdraw any card still open. The agent
    /// gets no reply here — its turn is already over.
    pub(crate) fn end_question_turn(&mut self) {
        self.question_asker = None;
        if let Some(pending) = self.pending_question.take() {
            let _ = pending.cancel_tx.send(());
        }
    }

    /// Answer `elicitation/create` at once (decline or error), or post the
    /// card and return the receiver for its outcome.
    pub(super) async fn handle_elicitation_request(
        &mut self,
        msg: &Value,
    ) -> Result<Option<QuestionRx>, AcpError> {
        let Some(id) = msg.get("id").cloned() else {
            return Ok(None);
        };
        let response = if self.pending_question.is_some() {
            decline(&id, "another question is already open")
        } else if let Some(asker) = &self.question_asker {
            match ask_prompt_from_request(&msg["params"]) {
                Ok(prompt) => {
                    let handle = asker.ask(&prompt);
                    tracing::info!(target: "acp::question", "posting question card for elicitation id={id}");
                    self.pending_question = Some(PendingQuestion {
                        request_id: id,
                        questions: prompt.questions,
                        cancel_tx: handle.cancel_tx,
                    });
                    return Ok(Some(handle.outcome_rx));
                }
                Err(Unsupported::NotAskUserQuestion(why)) => decline(&id, why),
                Err(Unsupported::Unrenderable(why)) => {
                    tracing::warn!(target: "acp::question", "cannot show question id={id}: {why}");
                    error(&id, format!("question cannot be shown in Buzz: {why}"))
                }
            }
        } else {
            decline(&id, "no conversation to ask in")
        };
        self.write_ndjson(&response).await?;
        Ok(None)
    }

    /// Reply to the pending question's request with its card's outcome.
    pub(super) async fn finish_question(
        &mut self,
        outcome: Result<QuestionOutcome, oneshot::error::RecvError>,
    ) -> Result<(), AcpError> {
        let Some(pending) = self.pending_question.take() else {
            return Ok(());
        };
        let id = &pending.request_id;
        let response = match outcome {
            Ok(QuestionOutcome::Answered(answer)) => result(
                id,
                json!({"action": "accept", "content": accept_content(&pending.questions, &answer)}),
            ),
            Ok(QuestionOutcome::Failed(reason)) => {
                tracing::warn!(target: "acp::question", "question card not posted: {reason}");
                error(id, format!("could not post the question to Buzz: {reason}"))
            }
            Ok(QuestionOutcome::Withdrawn) | Err(_) => result(id, json!({"action": "cancel"})),
        };
        self.write_ndjson(&response).await
    }

    /// Whether `request_id` names the pending question (for `$/cancel_request`).
    pub(super) fn is_pending_question(&self, request_id: &Value) -> bool {
        self.pending_question
            .as_ref()
            .is_some_and(|pending| pending.request_id == *request_id)
    }

    /// Withdraw the pending card and answer the agent `cancel`.
    pub(super) async fn cancel_pending_question(&mut self) -> Result<(), AcpError> {
        let Some(pending) = self.pending_question.take() else {
            return Ok(());
        };
        let _ = pending.cancel_tx.send(());
        tracing::info!(target: "acp::question", "question cancelled id={}", pending.request_id);
        self.write_ndjson(&result(&pending.request_id, json!({"action": "cancel"})))
            .await
    }

    /// Decline an elicitation outside a prompt turn.
    pub(super) async fn decline_elicitation(&mut self, msg: &Value) -> Result<(), AcpError> {
        match msg.get("id") {
            Some(id) => {
                let response = decline(id, "no prompt turn in flight");
                self.write_ndjson(&response).await
            }
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "questions_tests.rs"]
mod tests;
