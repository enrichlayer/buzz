//! Durable, verified message transport primitives for external orchestrators.

use nostr::Event;
use uuid::Uuid;

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{parse_event_id, MAX_CONTENT_BYTES};

const MAX_SIGNED_EVENT_BYTES: usize = 256 * 1024;
const MAX_VERIFIED_EVENTS: u32 = 100_000;
const MESSAGE_KINDS: [u16; 5] = [9, 40002, 40008, 45001, 45003];
const PUBLISHABLE_MESSAGE_KINDS: [u16; 3] = [9, 45001, 45003];

/// Sign one message with the same builders and enrichment used by `messages send`.
pub struct SignMessageParams {
    pub channel_id: String,
    pub content: Option<String>,
    pub content_file: Option<String>,
    pub kind: Option<u16>,
    pub reply_to: Option<String>,
    pub broadcast: bool,
    pub mentions: Vec<String>,
}

pub async fn cmd_sign_message(
    client: &BuzzClient,
    params: SignMessageParams,
) -> Result<(), CliError> {
    let content = match (params.content, params.content_file) {
        (Some(content), None) if content == "-" => {
            read_bounded_event_input("-", MAX_CONTENT_BYTES)?
        }
        (Some(content), None) => content,
        (None, Some(path)) => read_bounded_event_input(&path, MAX_CONTENT_BYTES)?,
        _ => {
            return Err(CliError::Usage(
                "provide exactly one of --content or --content-file".into(),
            ))
        }
    };
    let event = crate::commands::messages::build_signed_message_event(
        client,
        crate::commands::messages::SendMessageParams {
            channel_id: params.channel_id,
            content,
            kind: params.kind,
            reply_to: params.reply_to,
            broadcast: params.broadcast,
            files: Vec::new(),
            mentions: params.mentions,
        },
        false,
    )
    .await?;
    println!(
        "{}",
        serde_json::to_string(&event)
            .map_err(|error| CliError::Other(format!("event serialization failed: {error}")))?
    );
    Ok(())
}

fn read_bounded_event_input(path: &str, max_bytes: usize) -> Result<String, CliError> {
    use std::io::Read;

    fn read_bounded(reader: impl Read, max_bytes: usize) -> Result<Vec<u8>, std::io::Error> {
        let mut bytes = Vec::new();
        reader
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    let bytes = if path == "-" {
        read_bounded(std::io::stdin().lock(), max_bytes)
            .map_err(|error| CliError::Other(format!("failed to read stdin: {error}")))?
    } else {
        let file = std::fs::File::open(path)
            .map_err(|error| CliError::Usage(format!("failed to read {path:?}: {error}")))?;
        read_bounded(file, max_bytes)
            .map_err(|error| CliError::Usage(format!("failed to read {path:?}: {error}")))?
    };
    if bytes.len() > max_bytes {
        return Err(CliError::Usage(format!(
            "input exceeds {max_bytes} byte limit"
        )));
    }
    String::from_utf8(bytes).map_err(|_| CliError::Usage("input must be valid UTF-8".into()))
}

/// Parse and cryptographically verify one raw Nostr event without blocking the async executor.
pub(crate) async fn verify_raw_event(raw: serde_json::Value) -> Result<Event, CliError> {
    let event: Event = serde_json::from_value(raw)
        .map_err(|error| CliError::Other(format!("relay returned malformed event: {error}")))?;
    tokio::task::spawn_blocking(move || {
        buzz_core::verify_event(&event)
            .map_err(|error| CliError::Other(format!("relay returned invalid event: {error}")))?;
        Ok(event)
    })
    .await
    .map_err(|error| CliError::Other(format!("event verification task failed: {error}")))?
}

pub(crate) fn channel_tag(event: &Event) -> Result<Uuid, CliError> {
    let channel_tags: Vec<&[String]> = event
        .tags
        .iter()
        .map(nostr::Tag::as_slice)
        .filter(|parts| parts.first().map(String::as_str) == Some("h"))
        .collect();
    if channel_tags.len() != 1 {
        return Err(CliError::Usage(format!(
            "signed message must contain exactly one h-tag (found {})",
            channel_tags.len()
        )));
    }
    let channel = channel_tags[0]
        .get(1)
        .ok_or_else(|| CliError::Usage("signed message h-tag is missing its channel".into()))?;
    Uuid::parse_str(channel)
        .map_err(|_| CliError::Usage("signed message h-tag is not a valid channel UUID".into()))
}

fn validate_thread_expectation(event: &Event, reply_to: Option<&str>) -> Result<(), CliError> {
    let mut roots = Vec::new();
    let mut replies = Vec::new();
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some("e") {
            continue;
        }
        let Some(marker) = parts.get(3).map(String::as_str) else {
            continue;
        };
        if marker != "root" && marker != "reply" {
            continue;
        }
        let id = parts
            .get(1)
            .ok_or_else(|| CliError::Usage(format!("{marker} marker is missing its event ID")))?;
        parse_event_id(id)?;
        if marker == "root" {
            roots.push(id.as_str());
        } else {
            replies.push(id.as_str());
        }
    }
    if roots.len() > 1 || replies.len() > 1 {
        return Err(CliError::Usage(
            "signed message has duplicate root or reply markers".into(),
        ));
    }
    if replies.is_empty() && !roots.is_empty() {
        return Err(CliError::Usage(
            "signed message has a root marker without a reply marker".into(),
        ));
    }
    if roots
        .first()
        .zip(replies.first())
        .is_some_and(|(root, reply)| root == reply)
    {
        return Err(CliError::Usage(
            "a direct reply must omit the redundant root marker".into(),
        ));
    }
    let resolved = buzz_core::nip10::parse_thread_markers(&event.tags).resolve();
    match (resolved, reply_to) {
        (None, None) => Ok(()),
        (Some(_), None) => Err(CliError::Usage(
            "signed reply requires --reply-to so its parent is checked".into(),
        )),
        (None, Some(_)) => Err(CliError::Usage(
            "--reply-to was supplied but the signed event is top-level".into(),
        )),
        (Some((_, actual_parent)), Some(expected_parent)) => {
            parse_event_id(expected_parent)?;
            if actual_parent.eq_ignore_ascii_case(expected_parent) {
                Ok(())
            } else {
                Err(CliError::Usage(format!(
                    "signed reply parent {actual_parent} does not match --reply-to {expected_parent}"
                )))
            }
        }
    }
}

async fn get_verified_events(
    client: &BuzzClient,
    channel_id: &str,
    max_events: u32,
    since: Option<i64>,
    kinds: Option<&str>,
) -> Result<Vec<Event>, CliError> {
    let channel = Uuid::parse_str(channel_id)
        .map_err(|_| CliError::Usage(format!("invalid UUID: {channel_id}")))?;
    if max_events == 0 || max_events > MAX_VERIFIED_EVENTS {
        return Err(CliError::Usage(format!(
            "--max-events must be between 1 and {MAX_VERIFIED_EVENTS}"
        )));
    }
    if since.is_some_and(|value| value < 0) {
        return Err(CliError::Usage(
            "--since must be a non-negative Unix timestamp".into(),
        ));
    }

    let requested_kinds = match kinds {
        Some(raw) => {
            let parsed: Result<Vec<u16>, _> = raw
                .split(',')
                .map(str::trim)
                .map(str::parse::<u16>)
                .collect();
            let parsed = parsed
                .map_err(|_| CliError::Usage("--kinds must be comma-separated integers".into()))?;
            if parsed.is_empty() {
                return Err(CliError::Usage("--kinds must not be empty".into()));
            }
            parsed
        }
        None => MESSAGE_KINDS.to_vec(),
    };
    let mut filter = serde_json::json!({
        "kinds": requested_kinds,
        "#h": [channel.to_string()],
    });
    if let Some(since) = since {
        filter["since"] = serde_json::json!(since);
    }

    let raw_events = client.query_all_bounded(filter, max_events).await?;
    let mut verified = Vec::with_capacity(raw_events.len());
    for raw in raw_events {
        let event = verify_raw_event(raw).await?;
        if channel_tag(&event)? != channel {
            return Err(CliError::Other(format!(
                "verified event {} does not belong to channel {channel}",
                event.id.to_hex()
            )));
        }
        if !requested_kinds.contains(&event.kind.as_u16()) {
            return Err(CliError::Other(format!(
                "verified event {} has kind {} outside the requested filter",
                event.id.to_hex(),
                event.kind.as_u16()
            )));
        }
        if since.is_some_and(|value| event.created_at.as_secs() < value as u64) {
            return Err(CliError::Other(format!(
                "verified event {} predates the inclusive --since boundary",
                event.id.to_hex()
            )));
        }
        verified.push(event);
    }
    verified.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(verified)
}

/// Retrieve a complete, bounded channel history and verify every event before stdout.
pub async fn cmd_get_verified(
    client: &BuzzClient,
    channel_id: &str,
    max_events: u32,
    since: Option<i64>,
    kinds: Option<&str>,
) -> Result<(), CliError> {
    let verified = get_verified_events(client, channel_id, max_events, since, kinds).await?;
    println!(
        "{}",
        serde_json::to_string(&verified)
            .map_err(|error| CliError::Other(format!("event serialization failed: {error}")))?
    );
    Ok(())
}

/// Publish a previously signed message event without rebuilding or re-signing it.
pub async fn cmd_publish_event(
    client: &BuzzClient,
    channel_id: &str,
    reply_to: Option<&str>,
    event_file: &str,
) -> Result<(), CliError> {
    let expected_channel = Uuid::parse_str(channel_id)
        .map_err(|_| CliError::Usage(format!("invalid UUID: {channel_id}")))?;
    let raw = read_bounded_event_input(event_file, MAX_SIGNED_EVENT_BYTES)?;
    let value = serde_json::from_str(&raw)
        .map_err(|error| CliError::Usage(format!("signed event is not valid JSON: {error}")))?;
    let event = verify_raw_event(value).await.map_err(|error| match error {
        CliError::Other(message) => CliError::Usage(message),
        other => other,
    })?;
    if event.pubkey != client.keys().public_key() {
        return Err(CliError::Usage(
            "signed event pubkey does not match the configured identity".into(),
        ));
    }
    if !PUBLISHABLE_MESSAGE_KINDS.contains(&event.kind.as_u16()) {
        return Err(CliError::Usage(format!(
            "signed event kind {} is not publishable by this command",
            event.kind.as_u16()
        )));
    }
    if channel_tag(&event)? != expected_channel {
        return Err(CliError::Usage(format!(
            "signed event channel does not match --channel {expected_channel}"
        )));
    }
    validate_thread_expectation(&event, reply_to)?;
    if event.kind.as_u16() == 45003 && reply_to.is_none() {
        return Err(CliError::Usage(
            "forum comments require --reply-to for parent verification".into(),
        ));
    }

    let expected_id = event.id.to_hex();
    let response = client.submit_event(event).await?;
    let normalized = normalize_write_response(&response);
    let parsed: serde_json::Value = serde_json::from_str(&normalized)
        .map_err(|error| CliError::Other(format!("relay response is not JSON: {error}")))?;
    if parsed.get("accepted").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(CliError::Other(
            "relay did not accept the signed event".into(),
        ));
    }
    if parsed.get("event_id").and_then(serde_json::Value::as_str) != Some(expected_id.as_str()) {
        return Err(CliError::Other(
            "relay acknowledgement event_id does not match submitted event".into(),
        ));
    }
    println!("{normalized}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::Router;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    fn signed_message(keys: &Keys, channel: Uuid, content: &str) -> Event {
        EventBuilder::new(Kind::Custom(9), content)
            .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
            .sign_with_keys(keys)
            .unwrap()
    }

    fn signed_message_at(keys: &Keys, channel: Uuid, content: &str, created_at: u64) -> Event {
        EventBuilder::new(Kind::Custom(9), content)
            .tags([Tag::parse(["h", &channel.to_string()]).unwrap()])
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[tokio::test]
    async fn verification_rejects_forged_body_id_and_signature() {
        let keys = Keys::generate();
        let event = signed_message(&keys, Uuid::new_v4(), "genuine");
        assert!(verify_raw_event(serde_json::to_value(&event).unwrap())
            .await
            .is_ok());

        for (field, value) in [
            ("content", serde_json::json!("forged")),
            ("id", serde_json::json!("0".repeat(64))),
            ("sig", serde_json::json!("0".repeat(128))),
        ] {
            let mut forged = serde_json::to_value(&event).unwrap();
            forged[field] = value;
            assert!(
                verify_raw_event(forged).await.is_err(),
                "accepted forged {field}"
            );
        }
    }

    #[test]
    fn publish_policy_binds_channel_and_parent() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let parent = "a".repeat(64);
        let event = EventBuilder::new(Kind::Custom(9), "reply")
            .tags([
                Tag::parse(["h", &channel.to_string()]).unwrap(),
                Tag::parse(["e", &parent, "", "reply"]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();

        assert_eq!(channel_tag(&event).unwrap(), channel);
        assert!(validate_thread_expectation(&event, Some(&parent)).is_ok());
        assert!(validate_thread_expectation(&event, None).is_err());
        assert!(validate_thread_expectation(&event, Some(&"b".repeat(64))).is_err());
    }

    #[test]
    fn channel_policy_rejects_malformed_and_duplicate_h_tags() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4().to_string();
        let malformed = EventBuilder::new(Kind::Custom(9), "message")
            .tags([Tag::parse(["h"]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(channel_tag(&malformed).is_err());

        let duplicate = EventBuilder::new(Kind::Custom(9), "message")
            .tags([
                Tag::parse(["h", &channel]).unwrap(),
                Tag::parse(["h", &channel]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .unwrap();
        assert!(channel_tag(&duplicate).is_err());
    }

    async fn event_relay(query_events: Vec<Event>) -> (String, Arc<Mutex<Vec<Vec<u8>>>>) {
        #[derive(Clone)]
        struct RelayState {
            query_events: Vec<Event>,
            submitted: Arc<Mutex<Vec<Vec<u8>>>>,
        }
        let submitted = Arc::new(Mutex::new(Vec::new()));
        let state = RelayState {
            query_events,
            submitted: submitted.clone(),
        };
        let app = Router::new()
            .route(
                "/query",
                post(|State(state): State<RelayState>| async move {
                    (
                        StatusCode::OK,
                        serde_json::to_string(&state.query_events).unwrap(),
                    )
                }),
            )
            .route(
                "/events",
                post(|State(state): State<RelayState>, body: Bytes| async move {
                    let event: Event = serde_json::from_slice(&body).unwrap();
                    state.submitted.lock().unwrap().push(body.to_vec());
                    (
                        StatusCode::OK,
                        serde_json::json!({
                            "event_id": event.id.to_hex(),
                            "accepted": true,
                            "message": "saved",
                        })
                        .to_string(),
                    )
                }),
            )
            .with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), submitted)
    }

    async fn paginated_query_relay(query_events: Vec<Event>, honor_cursor: bool) -> String {
        let app = Router::new().route(
            "/query",
            post(move |body: Bytes| {
                let query_events = query_events.clone();
                async move {
                    let filters: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
                    let filter = &filters[0];
                    let limit = filter["limit"].as_u64().unwrap() as usize;
                    let until = filter.get("until").and_then(serde_json::Value::as_u64);
                    let before_id = filter.get("before_id").and_then(serde_json::Value::as_str);
                    let since = filter.get("since").and_then(serde_json::Value::as_u64);
                    let mut page = query_events;
                    page.sort_by(|left, right| {
                        right
                            .created_at
                            .cmp(&left.created_at)
                            .then_with(|| left.id.cmp(&right.id))
                    });
                    page.retain(|event| {
                        if since.is_some_and(|boundary| event.created_at.as_secs() < boundary) {
                            return false;
                        }
                        if !honor_cursor {
                            return true;
                        }
                        match until {
                            Some(boundary) if event.created_at.as_secs() > boundary => false,
                            Some(boundary) if event.created_at.as_secs() == boundary => {
                                before_id.is_none_or(|id| event.id.to_hex().as_str() > id)
                            }
                            _ => true,
                        }
                    });
                    page.truncate(limit);
                    (StatusCode::OK, serde_json::to_string(&page).unwrap())
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn write_event_file(event: &Event) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("buzz-signed-event-{}.json", Uuid::new_v4()));
        std::fs::write(&path, serde_json::to_vec(event).unwrap()).unwrap();
        path
    }

    #[tokio::test]
    async fn verified_get_accepts_genuine_events_and_rejects_forged_channel_data() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let genuine = signed_message(&keys, channel, "genuine");
        let (url, _) = event_relay(vec![genuine.clone()]).await;
        let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();
        let events = get_verified_events(&client, &channel.to_string(), 2, None, None)
            .await
            .unwrap();
        assert_eq!(events, vec![genuine]);

        let mut forged = serde_json::to_value(signed_message(&keys, channel, "original")).unwrap();
        forged["content"] = serde_json::json!("forged");
        let app = Router::new().route(
            "/query",
            post(move || {
                let forged = forged.clone();
                async move { (StatusCode::OK, serde_json::json!([forged]).to_string()) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let relay_url = format!("http://{address}");
        let cli_keys = Keys::generate();
        let client = BuzzClient::new(relay_url.clone(), cli_keys.clone(), None, None).unwrap();
        assert!(
            get_verified_events(&client, &channel.to_string(), 2, None, None)
                .await
                .is_err()
        );
        assert_ne!(
            crate::run_from_args([
                "buzz",
                "--relay",
                &relay_url,
                "--private-key",
                &cli_keys.secret_key().to_secret_hex(),
                "messages",
                "get-verified",
                "--channel",
                &channel.to_string(),
                "--max-events",
                "2",
            ])
            .await,
            0
        );
    }

    #[tokio::test]
    async fn verified_get_rechecks_kind_and_inclusive_since_filters() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let event = signed_message(&keys, channel, "filtered");
        let created_at = event.created_at.as_secs() as i64;
        let (url, _) = event_relay(vec![event]).await;
        let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();

        assert!(get_verified_events(
            &client,
            &channel.to_string(),
            2,
            Some(created_at),
            Some("9"),
        )
        .await
        .is_ok());
        assert!(get_verified_events(
            &client,
            &channel.to_string(),
            2,
            Some(created_at + 1),
            Some("9"),
        )
        .await
        .is_err());
        assert!(
            get_verified_events(&client, &channel.to_string(), 2, None, Some("45001"),)
                .await
                .is_err()
        );

        let overflow_a = signed_message(&keys, channel, "overflow a");
        let overflow_b = signed_message(&keys, channel, "overflow b");
        let (url, _) = event_relay(vec![overflow_a, overflow_b]).await;
        let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();
        assert!(
            get_verified_events(&client, &channel.to_string(), 1, None, Some("9"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn verified_get_preserves_all_same_second_events_across_composite_pages() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let expected: Vec<Event> = (0..501)
            .map(|index| {
                signed_message_at(&keys, channel, &format!("message {index}"), 1_800_000_000)
            })
            .collect();
        let url = paginated_query_relay(expected.clone(), true).await;
        let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();

        let actual = get_verified_events(&client, &channel.to_string(), 600, None, Some("9"))
            .await
            .unwrap();
        let actual_ids: std::collections::HashSet<_> =
            actual.iter().map(|event| event.id).collect();
        let expected_ids: std::collections::HashSet<_> =
            expected.iter().map(|event| event.id).collect();

        assert_eq!(actual.len(), 501);
        assert_eq!(actual_ids.len(), 501);
        assert_eq!(actual_ids, expected_ids);
    }

    #[tokio::test]
    async fn verified_get_rejects_a_relay_that_ignores_the_composite_cursor() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let events: Vec<Event> = (0..501)
            .map(|index| {
                signed_message_at(&keys, channel, &format!("message {index}"), 1_800_000_000)
            })
            .collect();
        let url = paginated_query_relay(events, false).await;
        let client = BuzzClient::new(url, Keys::generate(), None, None).unwrap();

        let result = get_verified_events(&client, &channel.to_string(), 501, None, Some("9")).await;

        assert!(
            result.is_err(),
            "ignored cursor must not return a partial set"
        );
    }

    #[tokio::test]
    async fn publish_retries_the_exact_persisted_event() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let event = signed_message(&keys, channel, "persist me exactly");
        let path = write_event_file(&event);
        let (url, submitted) = event_relay(Vec::new()).await;
        let client = BuzzClient::new(url, keys, None, None).unwrap();

        for _ in 0..2 {
            cmd_publish_event(&client, &channel.to_string(), None, path.to_str().unwrap())
                .await
                .unwrap();
        }
        let bodies = submitted.lock().unwrap();
        assert_eq!(bodies.len(), 2);
        assert_eq!(bodies[0], bodies[1]);
        let first: Event = serde_json::from_slice(&bodies[0]).unwrap();
        assert_eq!(first.id, event.id);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn publish_rejects_wrong_signer_and_oversized_file_before_network() {
        let signer = Keys::generate();
        let configured = Keys::generate();
        let channel = Uuid::new_v4();
        let event = signed_message(&signer, channel, "wrong signer");
        let path = write_event_file(&event);
        let (url, submitted) = event_relay(Vec::new()).await;
        let client = BuzzClient::new(url, configured, None, None).unwrap();
        assert!(
            cmd_publish_event(&client, &channel.to_string(), None, path.to_str().unwrap(),)
                .await
                .is_err()
        );
        assert!(submitted.lock().unwrap().is_empty());
        std::fs::remove_file(&path).unwrap();

        std::fs::write(&path, vec![b'x'; MAX_SIGNED_EVENT_BYTES + 1]).unwrap();
        assert!(
            cmd_publish_event(&client, &channel.to_string(), None, path.to_str().unwrap(),)
                .await
                .is_err()
        );
        assert!(submitted.lock().unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn actual_cli_sign_is_no_write_then_publish_and_verified_get_succeed() {
        let keys = Keys::generate();
        let private_key = keys.secret_key().to_secret_hex();
        let channel = Uuid::new_v4();
        let stored = signed_message(&keys, channel, "stored event");
        let path = write_event_file(&stored);
        let (url, submitted) = event_relay(vec![stored.clone()]).await;

        let sign_exit = crate::run_from_args([
            "buzz",
            "--relay",
            &url,
            "--private-key",
            &private_key,
            "messages",
            "sign",
            "--channel",
            &channel.to_string(),
            "--content",
            "sign only",
        ])
        .await;
        assert_eq!(sign_exit, 0);
        assert!(submitted.lock().unwrap().is_empty());

        let publish_exit = crate::run_from_args([
            "buzz",
            "--relay",
            &url,
            "--private-key",
            &private_key,
            "messages",
            "publish-event",
            "--channel",
            &channel.to_string(),
            "--event-file",
            path.to_str().unwrap(),
        ])
        .await;
        assert_eq!(publish_exit, 0);
        assert_eq!(submitted.lock().unwrap().len(), 1);

        let get_exit = crate::run_from_args([
            "buzz",
            "--relay",
            &url,
            "--private-key",
            &private_key,
            "messages",
            "get-verified",
            "--channel",
            &channel.to_string(),
            "--max-events",
            "2",
        ])
        .await;
        assert_eq!(get_exit, 0);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn actual_cli_reply_sign_rejects_a_forged_parent_without_publication() {
        let keys = Keys::generate();
        let private_key = keys.secret_key().to_secret_hex();
        let channel = Uuid::new_v4();
        let parent = signed_message(&Keys::generate(), channel, "authentic parent");
        let parent_id = parent.id.to_hex();
        let mut forged = serde_json::to_value(parent).unwrap();
        forged["content"] = serde_json::json!("forged parent");
        let forged: Event = serde_json::from_value(forged).unwrap();
        let (url, submitted) = event_relay(vec![forged]).await;

        let exit = crate::run_from_args([
            "buzz",
            "--relay",
            &url,
            "--private-key",
            &private_key,
            "messages",
            "sign",
            "--channel",
            &channel.to_string(),
            "--content",
            "reply",
            "--reply-to",
            &parent_id,
        ])
        .await;
        assert_ne!(exit, 0);
        assert!(submitted.lock().unwrap().is_empty());
    }
}
