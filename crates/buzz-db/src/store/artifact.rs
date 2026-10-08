//! NIP-AR atomic artifact acceptance. Payloads remain opaque signed events.
//!
//! Channel write permission is checked by the relay's ordinary ingest gates
//! before this transaction; here the relay only serializes each identity and
//! compares the expected head.
use crate::{Db, DbError, Result};
use buzz_core::artifact::{ArtifactEnvelope, ArtifactOp};
use buzz_core::{CommunityId, StoredEvent};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

/// Acceptance outcome. Only a stale-`prev` conflict carries the current head,
/// which the caller discloses after authorizing its channel.
#[derive(Debug)]
pub enum ArtifactOutcome {
    /// Accepted once; stored events to publish (the revision, plus the source
    /// removal on a move).
    Accepted(Vec<StoredEvent>),
    /// Identical previously accepted event; no repeated side effects.
    Duplicate,
    /// `prev` or identity no longer matches; the client should reconcile.
    Conflict(&'static str),
    /// Protocol violation with a public-safe reason.
    Rejected(&'static str),
}

fn invalid(message: &str) -> DbError {
    DbError::InvalidData(message.into())
}

/// Question cards have a single open revision followed by one terminal
/// answer or cancellation. Enforce this inside the head transaction so a
/// later writer cannot replace the answer seen by fresh subscribers.
fn validate_question_transition(
    previous: Option<&str>,
    event: &Event,
    op: ArtifactOp,
) -> std::result::Result<(), &'static str> {
    let next: Value = serde_json::from_str(&event.content).map_err(|_| "invalid question JSON")?;
    if next.get("version") != Some(&Value::from(1))
        || next.get("kind").and_then(Value::as_str) != Some("question")
        || !next.get("questions").is_some_and(Value::is_array)
    {
        return Err("invalid question content");
    }
    let Some(previous) = previous else {
        return if op == ArtifactOp::Create
            && next.get("state").and_then(Value::as_str) == Some("open")
        {
            Ok(())
        } else {
            Err("question must be created open")
        };
    };
    let previous: Value = serde_json::from_str(previous).map_err(|_| "invalid question head")?;
    if previous.get("state").and_then(Value::as_str) != Some("open") {
        return Err("question is final");
    }
    if op != ArtifactOp::Update || next.get("questions") != previous.get("questions") {
        return Err("question update must preserve its questions");
    }
    match next.get("state").and_then(Value::as_str) {
        Some("cancelled") => Ok(()),
        Some("answered") => {
            if next.get("answeredBy").and_then(Value::as_str)
                != Some(event.pubkey.to_hex().as_str())
            {
                return Err("question answer must name its signer");
            }
            let Some(answers) = next.get("answer").and_then(Value::as_object) else {
                return Err("question answer is incomplete");
            };
            let questions = previous["questions"]
                .as_array()
                .ok_or("invalid question head")?;
            if answers.len() != questions.len() || questions.is_empty() {
                return Err("question answer is incomplete");
            }
            for question in questions {
                let id = question
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or("invalid question head")?;
                let choices = answers
                    .get(id)
                    .and_then(Value::as_array)
                    .ok_or("question answer is incomplete")?;
                if choices.is_empty()
                    || (!question
                        .get("multiSelect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                        && choices.len() != 1)
                {
                    return Err("question answer is incomplete");
                }
                let labels = question
                    .get("options")
                    .and_then(Value::as_array)
                    .ok_or("invalid question head")?;
                let mut seen = std::collections::HashSet::new();
                let mut other_count = 0;
                for choice in choices {
                    let value = choice.as_str().ok_or("invalid question answer")?;
                    if !seen.insert(value) {
                        return Err("duplicate question answer");
                    }
                    if !labels
                        .iter()
                        .any(|option| option.get("label").and_then(Value::as_str) == Some(value))
                    {
                        other_count += 1;
                        if !question
                            .get("allowOther")
                            .and_then(Value::as_bool)
                            .unwrap_or(true)
                            || value.trim() != value
                            || value.is_empty()
                            || value.chars().count() > 2000
                        {
                            return Err("invalid other answer");
                        }
                    }
                }
                if other_count > 1 {
                    return Err("multiple other answers");
                }
            }
            Ok(())
        }
        _ => Err("question update must be terminal"),
    }
}

/// The replaced revision (`prev`) was readable in the source, so it
/// distinguishes repeated moves without revealing other activity.
fn removal_marker(keys: &Keys, artifact: Uuid, source: Uuid, prev: &[u8]) -> Result<Event> {
    let tags = [
        ["ar", "1"].map(str::to_owned),
        ["d".into(), artifact.to_string()],
        ["h".into(), source.to_string()],
        ["reason".into(), "moved".into()],
        ["prev".into(), hex::encode(prev)],
    ]
    .into_iter()
    .map(Tag::parse)
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(|e| invalid(&e.to_string()))?;
    EventBuilder::new(Kind::Custom(45011), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| invalid(&e.to_string()))
}

impl Db {
    /// Check the durable acceptance ledger, which survives redaction and retention.
    pub async fn artifact_accepted(&self, community: CommunityId, id: &[u8]) -> Result<bool> {
        let mut conn = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::EventWrite,
        )
        .await?;
        Ok(sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM artifact_revisions WHERE community_id=$1 AND event_id=$2)",
        )
        .bind(community.as_uuid())
        .bind(id)
        .fetch_one(&mut *conn)
        .await?)
    }

    /// Current home channel, read before authorizing a move's source.
    pub async fn artifact_home(
        &self,
        community: CommunityId,
        artifact: Uuid,
    ) -> Result<Option<Uuid>> {
        let mut conn = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::EventWrite,
        )
        .await?;
        Ok(sqlx::query_scalar(
            "SELECT channel_id FROM artifact_heads WHERE community_id=$1 AND artifact_id=$2",
        )
        .bind(community.as_uuid())
        .bind(artifact)
        .fetch_optional(&mut *conn)
        .await?)
    }

    /// Atomically compare the expected head, store the full revision, advance
    /// the head, and on a move store the source removal. `authorized_source` is
    /// the move source the caller authorized; a head that has since moved elsewhere
    /// conflicts. Relay keys only sign removals.
    pub async fn accept_artifact(
        &self,
        community: CommunityId,
        event: &Event,
        env: &ArtifactEnvelope,
        authorized_source: Option<Uuid>,
        relay_keys: &Keys,
    ) -> Result<ArtifactOutcome> {
        let mut tx = self.begin_event_write_transaction().await?;
        sqlx::query("SET LOCAL statement_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        // A coordinate lock handles the missing-row create race as well as edits.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("artifact:{}:{}", community.as_uuid(), env.id))
            .execute(&mut *tx)
            .await?;
        let duplicate: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM artifact_revisions WHERE community_id=$1 AND event_id=$2)",
        )
        .bind(community.as_uuid())
        .bind(event.id.as_bytes().as_slice())
        .fetch_one(&mut *tx)
        .await?;
        if duplicate {
            return Ok(ArtifactOutcome::Duplicate);
        }
        let head = sqlx::query(
            "SELECT event_id,channel_id,artifact_type,root,deleted FROM artifact_heads WHERE community_id=$1 AND artifact_id=$2 FOR UPDATE",
        )
        .bind(community.as_uuid())
        .bind(env.id)
        .fetch_optional(&mut *tx)
        .await?;
        let source = head.as_ref().map(|h| h.get::<Uuid, _>("channel_id"));
        let old_root = head
            .as_ref()
            .and_then(|h| h.get::<Option<Vec<u8>>, _>("root"));
        match (&head, env.op) {
            (Some(_), ArtifactOp::Create) => {
                return Ok(ArtifactOutcome::Conflict("artifact identity is taken"))
            }
            (None, ArtifactOp::Create) => {}
            (None, _) => return Ok(ArtifactOutcome::Conflict("artifact head unavailable")),
            (Some(head), op) => {
                let current: Vec<u8> = head.get("event_id");
                if env.prev.as_deref() != Some(current.as_slice()) {
                    return Ok(ArtifactOutcome::Conflict("artifact head changed"));
                }
                if env.artifact_type != head.get::<String, _>("artifact_type") {
                    return Ok(ArtifactOutcome::Rejected("artifact type is immutable"));
                }
                if head.get::<bool, _>("deleted") != (op == ArtifactOp::Restore) {
                    return Ok(ArtifactOutcome::Rejected(
                        "deleted artifacts require restore; live artifacts cannot restore",
                    ));
                }
                if (op == ArtifactOp::Move) != (source != Some(env.home)) {
                    return Ok(ArtifactOutcome::Rejected(
                        "only move changes home and move must change home",
                    ));
                }
                if op == ArtifactOp::Move && authorized_source != source {
                    return Ok(ArtifactOutcome::Conflict("artifact home changed"));
                }
                if op == ArtifactOp::Delete && env.root != old_root {
                    return Ok(ArtifactOutcome::Rejected("delete preserves root"));
                }
            }
        }
        if env.artifact_type == "buzz.agent_prompt" {
            let previous = if let Some(head) = &head {
                let current: Vec<u8> = head.get("event_id");
                let content: Option<String> = sqlx::query_scalar(
                    "SELECT content FROM events WHERE community_id=$1 AND id=$2",
                )
                .bind(community.as_uuid())
                .bind(current)
                .fetch_optional(&mut *tx)
                .await?;
                let Some(content) = content else {
                    return Ok(ArtifactOutcome::Rejected(
                        "question head content unavailable",
                    ));
                };
                Some(content)
            } else {
                None
            };
            if let Err(reason) = validate_question_transition(previous.as_deref(), event, env.op) {
                return Ok(ArtifactOutcome::Rejected(reason));
            }
            if head.is_some() && env.root != old_root {
                return Ok(ArtifactOutcome::Rejected("question root is immutable"));
            }
        }
        if head.is_none() || env.root != old_root || source != Some(env.home) {
            if let Some(root) = &env.root {
                let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM events WHERE community_id=$1 AND id=$2 AND channel_id=$3 AND deleted_at IS NULL AND kind IN (9,40002,45001,45003))")
                    .bind(community.as_uuid()).bind(root).bind(env.home).fetch_one(&mut *tx).await?;
                if !exists {
                    return Ok(ArtifactOutcome::Rejected(
                        "root must be an existing conversation anchor in home",
                    ));
                }
            }
        }
        sqlx::query(
            "INSERT INTO artifact_revisions (community_id,event_id,artifact_id) VALUES ($1,$2,$3)",
        )
        .bind(community.as_uuid())
        .bind(event.id.as_bytes().as_slice())
        .bind(env.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO artifact_heads (community_id,artifact_id,event_id,channel_id,artifact_type,root,deleted) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (community_id,artifact_id) DO UPDATE SET event_id=EXCLUDED.event_id,channel_id=EXCLUDED.channel_id,root=EXCLUDED.root,deleted=EXCLUDED.deleted")
            .bind(community.as_uuid()).bind(env.id).bind(event.id.as_bytes().as_slice()).bind(env.home).bind(&env.artifact_type).bind(&env.root).bind(env.op == ArtifactOp::Delete).execute(&mut *tx).await?;
        let (stored, _) =
            crate::event::insert_event_in_transaction(&mut tx, community, event, Some(env.home))
                .await?;
        crate::insert_mentions_in_transaction(&mut tx, community, event, Some(env.home)).await?;
        let mut accepted = vec![stored];
        if let (ArtifactOp::Move, Some(source), Some(prev)) = (env.op, source, &env.prev) {
            let removal = removal_marker(relay_keys, env.id, source, prev)?;
            let (stored, _) = crate::event::insert_event_in_transaction(
                &mut tx,
                community,
                &removal,
                Some(source),
            )
            .await?;
            accepted.push(stored);
        }
        tx.commit().await?;
        Ok(ArtifactOutcome::Accepted(accepted))
    }
}

#[cfg(test)]
mod question_transition_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answer_and_cancel_are_terminal() {
        let owner = Keys::generate();
        let peer = Keys::generate();
        let open = json!({
            "version": 1, "kind": "question", "state": "open",
            "questions": [{"id": "q1", "options": [{"label": "A"}, {"label": "B"}]}]
        });
        let event = |content: Value, keys: &Keys| {
            EventBuilder::new(Kind::Custom(45010), content.to_string())
                .sign_with_keys(keys)
                .unwrap()
        };
        let create = event(open.clone(), &owner);
        assert_eq!(
            validate_question_transition(None, &create, ArtifactOp::Create),
            Ok(())
        );

        let mut answered = open.clone();
        answered["state"] = "answered".into();
        answered["answer"] = json!({"q1": ["A"]});
        answered["answeredBy"] = peer.public_key().to_hex().into();
        let answer = event(answered.clone(), &peer);
        assert_eq!(
            validate_question_transition(Some(&open.to_string()), &answer, ArtifactOp::Update),
            Ok(())
        );
        let rewrite = event(
            json!({"state":"answered", "answer":{"q1":["B"]},
            "answeredBy":owner.public_key().to_hex(), "version":1,"kind":"question",
            "questions":open["questions"]}),
            &owner,
        );
        assert_eq!(
            validate_question_transition(Some(&answered.to_string()), &rewrite, ArtifactOp::Update),
            Err("question is final")
        );
        assert_eq!(
            validate_question_transition(Some(&answered.to_string()), &create, ArtifactOp::Update),
            Err("question is final")
        );

        let mut cancelled = open.clone();
        cancelled["state"] = "cancelled".into();
        let cancel = event(cancelled.clone(), &owner);
        assert_eq!(
            validate_question_transition(Some(&open.to_string()), &cancel, ArtifactOp::Update),
            Ok(())
        );
        assert_eq!(
            validate_question_transition(Some(&cancelled.to_string()), &answer, ArtifactOp::Update),
            Err("question is final")
        );
    }

    #[test]
    fn invalid_first_answer_does_not_take_the_head() {
        let peer = Keys::generate();
        let open = json!({
            "version": 1, "kind": "question", "state": "open",
            "questions": [{"id": "q1", "options": [{"label": "A"}]}]
        });
        let invalid = EventBuilder::new(
            Kind::Custom(45010),
            json!({"version":1,"kind":"question","state":"answered",
                "questions":open["questions"], "answer":{"q1":[]},
                "answeredBy":peer.public_key().to_hex()})
            .to_string(),
        )
        .sign_with_keys(&peer)
        .unwrap();
        assert_eq!(
            validate_question_transition(Some(&open.to_string()), &invalid, ArtifactOp::Update),
            Err("question answer is incomplete")
        );
    }
}
