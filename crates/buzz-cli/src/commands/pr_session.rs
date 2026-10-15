//! Durable coding-thread context carried by the review's own signed event.

use crate::{client::BuzzClient, error::CliError, validate::validate_hex64};
use nostr::Tag;

pub(crate) const THREAD_ENV: &str = "BUZZ_GIT_ORIGIN_THREAD_ID";

/// Validate explicit and inherited context and build its atomic event tags.
pub(crate) fn context_tags(
    thread: Option<&str>,
    inherited_thread: Option<&str>,
    channel: Option<&str>,
    inherited_channel: Option<&str>,
    linear_issue: Option<&str>,
) -> Result<Vec<Tag>, CliError> {
    if let (Some(explicit), Some(inherited)) = (thread, inherited_thread) {
        if !explicit.eq_ignore_ascii_case(inherited) {
            return Err(CliError::Usage(
                "--thread conflicts with the coding session thread".into(),
            ));
        }
    }
    let Some(thread) = thread.or(inherited_thread) else {
        if linear_issue.is_some() {
            return Err(CliError::Usage(
                "--linear-issue requires a coding session or --thread and --channel".into(),
            ));
        }
        return Ok(vec![]);
    };
    validate_hex64(thread)?;
    let channel = match (channel, inherited_channel) {
        (Some(explicit), Some(inherited)) if explicit != inherited => {
            return Err(CliError::Usage(
                "--channel conflicts with the coding session channel".into(),
            ));
        }
        (Some(channel), _) | (_, Some(channel)) => channel,
        _ => {
            return Err(CliError::Usage(
                "--thread requires --channel outside a coding session".into(),
            ))
        }
    };
    uuid::Uuid::parse_str(channel)
        .map_err(|_| CliError::Usage("invalid coding session channel".into()))?;
    let mut tags = vec![
        Tag::parse(["e", &thread.to_ascii_lowercase(), "", "buzz-session"])
            .map_err(|error| CliError::Usage(error.to_string()))?,
    ];
    if let Some(issue) = linear_issue {
        let mut url = url::Url::parse(issue)
            .map_err(|_| CliError::Usage("invalid Linear issue URL".into()))?;
        let parts: Vec<_> = url
            .path()
            .strip_suffix('/')
            .unwrap_or(url.path())
            .split('/')
            .collect();
        let valid_id = parts.get(3).is_some_and(|id| {
            id.split_once('-').is_some_and(|(team, number)| {
                team.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    && team.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    && !number.is_empty()
                    && number.bytes().all(|byte| byte.is_ascii_digit())
            })
        });
        if url.scheme() != "https"
            || url.host_str() != Some("linear.app")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !(parts.len() == 4 || parts.len() == 5)
            || parts[1].is_empty()
            || parts[2] != "issue"
            || !valid_id
        {
            return Err(CliError::Usage(
                "expected an HTTPS linear.app workspace issue URL".into(),
            ));
        }
        url.set_query(None);
        url.set_fragment(None);
        tags.push(
            Tag::parse(["r", url.as_str(), "linear-issue"])
                .map_err(|error| CliError::Usage(error.to_string()))?,
        );
    }
    Ok(tags)
}

/// Require an existing canonical thread in the selected channel before publication.
pub(crate) async fn verify_thread(
    client: &BuzzClient,
    tags: &[Tag],
    channel: &str,
) -> Result<(), CliError> {
    let Some(thread) = tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.first().map(String::as_str) == Some("e")
            && parts.get(3).map(String::as_str) == Some("buzz-session"))
        .then(|| parts.get(1))
        .flatten()
    }) else {
        return Ok(());
    };
    let response = client
        .query(&serde_json::json!({"kinds": [9, 11], "ids": [thread], "#h": [channel], "limit": 1}))
        .await?;
    let events: Vec<nostr::Event> = serde_json::from_str(&response)
        .map_err(|error| CliError::Other(format!("invalid thread response: {error}")))?;
    if !events.iter().any(|event| {
        event.id.to_hex() == *thread
            && matches!(event.kind.as_u16(), 9 | 11)
            && event.tags.iter().any(|tag| {
                tag.as_slice().first().map(String::as_str) == Some("h")
                    && tag.as_slice().get(1).map(String::as_str) == Some(channel)
            })
            && buzz_core::nip10::parse_thread_markers(&event.tags)
                .resolve()
                .is_none()
    }) {
        return Err(CliError::Usage(
            "coding session thread root was not found in this channel; no review was published"
                .into(),
        ));
    }
    Ok(())
}

/// Filter relay candidates by the signed session marker, never a bare e reference.
pub(crate) async fn list_thread_reviews(
    client: &BuzzClient,
    mut filter: serde_json::Value,
    thread: &str,
    limit: Option<u32>,
) -> Result<String, CliError> {
    // A full relay page cannot establish completeness. Fail visibly rather
    // than let unrelated references hide a valid review behind its boundary.
    filter["limit"] = serde_json::json!(1000);
    let response = client.query(&filter).await?;
    let events: Vec<nostr::Event> = serde_json::from_str(&response)
        .map_err(|error| CliError::Other(format!("invalid review response: {error}")))?;
    if events.len() >= 1000 {
        return Err(CliError::Other(
            "too many thread review candidates; narrow the query".into(),
        ));
    }
    let thread = thread.to_ascii_lowercase();
    let mut scoped: Vec<_> = events
        .into_iter()
        .filter(|event| {
            let markers: Vec<_> = event
                .tags
                .iter()
                .filter(|tag| {
                    let parts = tag.as_slice();
                    parts.first().map(String::as_str) == Some("e")
                        && parts.get(3).map(String::as_str) == Some("buzz-session")
                })
                .collect();
            event.kind.as_u16() == 1618
                && markers.len() == 1
                && markers[0].as_slice().get(1) == Some(&thread)
        })
        .collect();
    if let Some(limit) = limit {
        scoped.truncate(limit as usize);
    }
    serde_json::to_string(&scoped).map_err(|error| CliError::Other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    const CHANNEL: &str = "4978b750-109a-4aa4-8bbb-c9402217813c";

    #[tokio::test]
    async fn thread_list_filters_actual_relay_response_and_rejects_saturation() {
        use axum::{extract::State, routing::post, Json, Router};
        use nostr::{EventBuilder, Keys, Kind};
        use std::sync::{Arc, Mutex};
        let keys = Keys::generate();
        let thread = "a".repeat(64);
        let event = |tags: Vec<Tag>| {
            EventBuilder::new(Kind::from(1618), "Review")
                .tags(tags)
                .sign_with_keys(&keys)
                .unwrap()
        };
        let marker = Tag::parse(["e", &thread, "", "buzz-session"]).unwrap();
        let valid = event(vec![marker.clone()]);
        let ordinary = event(vec![Tag::parse(["e", &thread, "", "root"]).unwrap()]);
        let wrong = event(vec![Tag::parse(["e", &thread, "", "mention"]).unwrap()]);
        let ambiguous = event(vec![
            marker,
            Tag::parse(["e", &"b".repeat(64), "", "buzz-session"]).unwrap(),
        ]);
        type TestState = Arc<Mutex<Vec<nostr::Event>>>;
        let state: TestState =
            Arc::new(Mutex::new(vec![ordinary, wrong, ambiguous, valid.clone()]));
        let app = Router::new().route("/query", post(|State(state): State<TestState>, Json(filter): Json<serde_json::Value>| async move {
            assert_eq!(filter["limit"], 1000);
            Json(state.lock().unwrap().clone())
        })).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BuzzClient::new(url, keys, None, None).unwrap();
        let filter = serde_json::json!({"kinds": [1618], "#e": [thread]});
        let response =
            list_thread_reviews(&client, filter.clone(), &thread.to_uppercase(), Some(1))
                .await
                .unwrap();
        let scoped: Vec<nostr::Event> = serde_json::from_str(&response).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, valid.id);
        *state.lock().unwrap() = vec![valid; 1000];
        assert!(list_thread_reviews(&client, filter, &thread, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("too many"));
        server.abort();
    }

    #[test]
    fn session_context_is_atomic_and_normalized() {
        let thread = "AB".repeat(32);
        let tags = context_tags(
            None,
            Some(&thread),
            None,
            Some(CHANNEL),
            Some("https://linear.app/acme/issue/DEV-1/fix?view=test#detail"),
        )
        .unwrap();
        assert_eq!(
            tags[0].as_slice(),
            &["e", &thread.to_lowercase(), "", "buzz-session"]
        );
        assert_eq!(
            tags[1].as_slice(),
            &[
                "r",
                "https://linear.app/acme/issue/DEV-1/fix",
                "linear-issue"
            ]
        );
    }

    #[test]
    fn missing_or_conflicting_context_fails_closed() {
        let thread = "a".repeat(64);
        assert!(context_tags(Some(&thread), None, None, None, None).is_err());
        assert!(context_tags(
            None,
            None,
            None,
            None,
            Some("https://linear.app/acme/issue/DEV-1")
        )
        .is_err());
        assert!(context_tags(
            Some(&thread),
            Some(&"b".repeat(64)),
            Some(CHANNEL),
            Some(CHANNEL),
            None
        )
        .is_err());
        assert!(context_tags(Some(&thread), None, Some(CHANNEL), Some("different"), None).is_err());
        assert!(context_tags(None, None, None, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_unsafe_or_non_issue_links() {
        for url in [
            "http://linear.app/acme/issue/DEV-1",
            "https://linear.app.evil.test/acme/issue/DEV-1",
            "https://user@linear.app/acme/issue/DEV-1",
            "https://linear.app/acme/project/DEV-1",
            "https://linear.app/acme/issue/nope",
            "https://linear.app/",
        ] {
            assert!(
                context_tags(Some(&"a".repeat(64)), None, Some(CHANNEL), None, Some(url)).is_err(),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn opening_a_review_verifies_the_thread_before_one_signed_publish() {
        use axum::{body::Bytes, extract::State, routing::post, Router};
        use nostr::{EventBuilder, Keys, Kind};
        use std::sync::{Arc, Mutex};
        type TestState = Arc<Mutex<(Vec<nostr::Event>, Vec<nostr::Event>)>>;
        let state: TestState = Arc::new(Mutex::new((vec![], vec![])));
        let app = Router::new()
            .route(
                "/query",
                post(|State(state): State<TestState>| async move {
                    serde_json::to_string(&state.lock().unwrap().0).unwrap()
                }),
            )
            .route(
                "/events",
                post(|State(state): State<TestState>, body: Bytes| async move {
                    let event: nostr::Event = serde_json::from_slice(&body).unwrap();
                    let id = event.id.to_hex();
                    state.lock().unwrap().1.push(event);
                    serde_json::json!({"event_id": id, "accepted": true, "message": ""}).to_string()
                }),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let keys = Keys::generate();
        let client = BuzzClient::new(url, keys.clone(), None, None).unwrap();
        for (kind, channel, is_reply, accepted) in [
            (9u16, CHANNEL, false, true),
            (9, "wrong-channel", false, false),
            (9, CHANNEL, true, false),
            (1, CHANNEL, false, false),
        ] {
            let mut tags = vec![Tag::parse(["h", channel]).unwrap()];
            if is_reply {
                tags.push(Tag::parse(["e", &"a".repeat(64), "", "reply"]).unwrap());
            }
            let root = EventBuilder::new(Kind::from(kind), "Coding task")
                .tags(tags)
                .sign_with_keys(&keys)
                .unwrap();
            state.lock().unwrap().0 = vec![root.clone()];
            let result = super::super::pr::cmd_open_pr(
                &client,
                &keys.public_key().to_hex(),
                "demo",
                "Review",
                None,
                None,
                &"a".repeat(40),
                &["https://example.com/repo.git".into()],
                Some("fix"),
                None,
                None,
                &[],
                &[],
                Some(CHANNEL),
                None,
                Some(&root.id.to_hex()),
                Some("https://linear.app/acme/issue/DEV-1"),
            )
            .await;
            assert_eq!(
                result.is_ok(),
                accepted,
                "kind={kind}, channel={channel}, reply={is_reply}: {result:?}"
            );
        }
        let published = &state.lock().unwrap().1;
        assert_eq!(
            published.len(),
            1,
            "invalid context must never reach /events"
        );
        assert!(published[0].verify().is_ok());
        assert!(published[0]
            .tags
            .iter()
            .any(|tag| tag.as_slice().get(3).map(String::as_str) == Some("buzz-session")));
        assert!(published[0]
            .tags
            .iter()
            .any(|tag| tag.as_slice()
                == ["r", "https://linear.app/acme/issue/DEV-1", "linear-issue"]));
        server.abort();
    }
}
