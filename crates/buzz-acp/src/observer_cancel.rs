//! Owner-authenticated observer stop commands. Thread controls have a separate
//! wire type: older harnesses must ignore them instead of dropping the scope.
use crate::{observer, pool::AgentPool, pool::ControlSignal, scope::SessionScope};
use uuid::Uuid;

/// Handle a `cancel_turn` control frame: signal the in-flight task to cancel.
pub(crate) fn handle_cancel_turn_control(
    payload: &serde_json::Value,
    pool: &mut AgentPool,
    observer: Option<&observer::ObserverHandle>,
) {
    let Some(channel_id) = payload
        .get("channelId")
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse::<Uuid>().ok())
    else {
        tracing::warn!("observer cancel_turn control frame missing valid channelId");
        return;
    };

    let status = if pool.channel_control_is_ambiguous(channel_id) {
        "ambiguous_target"
    } else if crate::signal_in_flight_task(pool, channel_id, ControlSignal::Cancel) {
        "sent"
    } else {
        "no_active_turn"
    };
    if let Some(observer) = observer {
        observer.emit(
            "control_result",
            None,
            &observer::ObserverContext {
                channel_id: Some(channel_id.to_string()),
                session_id: None,
                turn_id: None,
                started_at: None,
            },
            serde_json::json!({
                "type": "cancel_turn",
                "status": status,
                "requestId": payload.get("requestId"),
            }),
        );
    }
}

/// Stop exactly the named thread; malformed or absent roots never fall back to
/// channel cancellation. Authentication and freshness are checked by dispatch.
pub(crate) fn handle_cancel_thread_turn_control(
    payload: &serde_json::Value,
    pool: &mut AgentPool,
    observer: Option<&observer::ObserverHandle>,
) {
    let Some(channel_id) = payload
        .get("channelId")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<Uuid>().ok())
    else {
        return;
    };
    let Some(root) = payload
        .get("threadRootEventId")
        .and_then(|v| v.as_str())
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    else {
        return;
    };
    let scope = SessionScope::Thread {
        channel_id,
        root_event_id: root.to_ascii_lowercase(),
    };
    let status = if crate::signal_in_flight_task_for_scope(pool, &scope, ControlSignal::Cancel) {
        "sent"
    } else {
        "no_active_turn"
    };
    if let Some(observer) = observer {
        observer.emit(
            "control_result",
            None,
            &observer::ObserverContext {
                channel_id: Some(channel_id.to_string()),
                session_id: None,
                turn_id: None,
                started_at: None,
            },
            serde_json::json!({
                "type": "cancel_thread_turn", "status": status,
                "requestId": payload.get("requestId"),
                "threadRootEventId": root,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::owner_control_command_tests::{insert_task_meta, thread_scope};

    #[tokio::test]
    async fn scoped_stop_preserves_sibling_and_echoes_identity() {
        let mut pool = AgentPool::from_slots(vec![]);
        let channel = Uuid::new_v4();
        let (tx_a, rx_a) = tokio::sync::oneshot::channel();
        let (tx_b, mut rx_b) = tokio::sync::oneshot::channel();
        insert_task_meta(&mut pool, 0, thread_scope(channel, &"a".repeat(64)), tx_a);
        insert_task_meta(&mut pool, 1, thread_scope(channel, &"b".repeat(64)), tx_b);
        let observer = observer::ObserverHandle::in_process();
        let payload = serde_json::json!({
            "channelId": channel.to_string(), "threadRootEventId": "A".repeat(64),
            "requestId": "stop-a",
        });
        handle_cancel_thread_turn_control(&payload, &mut pool, Some(&observer));
        assert_eq!(rx_a.await.unwrap(), ControlSignal::Cancel);
        assert_eq!(
            rx_b.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        );
        let results = observer.snapshot();
        assert_eq!(results[0].payload["type"], "cancel_thread_turn");
        assert_eq!(results[0].payload["status"], "sent");
        assert_eq!(results[0].payload["requestId"], "stop-a");
        assert_eq!(results[0].payload["threadRootEventId"], "A".repeat(64));
        assert_eq!(results[0].channel_id, Some(channel.to_string()));
    }

    #[tokio::test]
    async fn disconnected_turn_receiver_is_not_reported_as_sent() {
        let mut pool = AgentPool::from_slots(vec![]);
        let channel = Uuid::new_v4();
        let root = "a".repeat(64);
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(rx);
        insert_task_meta(&mut pool, 0, thread_scope(channel, &root), tx);
        let observer = observer::ObserverHandle::in_process();
        handle_cancel_thread_turn_control(
            &serde_json::json!({
                "channelId": channel.to_string(), "threadRootEventId": root,
            }),
            &mut pool,
            Some(&observer),
        );
        assert_eq!(observer.snapshot()[0].payload["status"], "no_active_turn");
    }

    #[tokio::test]
    async fn invalid_or_unknown_thread_never_falls_back_to_channel() {
        let mut pool = AgentPool::from_slots(vec![]);
        let channel = Uuid::new_v4();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        insert_task_meta(
            &mut pool,
            0,
            SessionScope::Conversation {
                channel_id: channel,
            },
            tx,
        );
        let observer = observer::ObserverHandle::in_process();
        for root in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("z".repeat(64)),
            serde_json::json!("a".repeat(64)),
        ] {
            handle_cancel_thread_turn_control(
                &serde_json::json!({
                    "channelId": channel.to_string(), "threadRootEventId": root,
                }),
                &mut pool,
                Some(&observer),
            );
        }
        assert_eq!(
            rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        );
        assert_eq!(observer.snapshot().len(), 1);
        assert_eq!(observer.snapshot()[0].payload["status"], "no_active_turn");
    }
}
