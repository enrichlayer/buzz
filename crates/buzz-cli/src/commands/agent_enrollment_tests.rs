use super::*;

fn owner() -> BuzzClient {
    BuzzClient::new("http://localhost:3000".into(), Keys::generate(), None, None).unwrap()
}
fn binding(owner: &BuzzClient) -> Binding {
    Binding {
        relay: owner.relay_url().into(),
        owner: owner.keys().public_key().to_hex(),
        channel: uuid::Uuid::new_v4().to_string(),
        runtime_id: "session-123".into(),
        cohort: "local".into(),
        display_name: "Local agent".into(),
    }
}

#[test]
fn restart_and_concurrent_creation_keep_the_first_key_and_exact_events() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("private");
    private_dir(&dir).unwrap();
    let owner = owner();
    let binding = binding(&owner);
    let path = journal_path(&dir, &binding);
    let first = make_journal(&owner, binding.clone()).unwrap();
    persist_new(&path, &first).unwrap();
    let competing = make_journal(&owner, binding.clone()).unwrap();
    persist_new(&path, &competing).unwrap();
    let resumed = read_journal(&path, &binding).unwrap();
    assert_eq!(resumed.private_key, first.private_key);
    assert_eq!(resumed.profile, first.profile);
    assert_eq!(resumed.directory, first.directory);
    assert_eq!(resumed.membership, first.membership);
    assert_ne!(resumed.private_key, competing.private_key);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
}

#[test]
fn existing_identity_cannot_be_renamed_or_retargeted_by_accident() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner();
    let mut binding = binding(&owner);
    let path = temp.path().join("state.json");
    persist_new(&path, &make_journal(&owner, binding.clone()).unwrap()).unwrap();
    binding.display_name = "A later task label".into();
    let existing = read_journal(&path, &binding).unwrap();
    assert_eq!(existing.binding.display_name, "Local agent");
    binding.channel = uuid::Uuid::new_v4().to_string();
    assert!(read_journal(&path, &binding).is_err());
}

#[test]
fn journal_rejects_tampering_and_credentials_for_another_identity() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner();
    let binding = binding(&owner);
    let mut journal = make_journal(&owner, binding.clone()).unwrap();
    journal.private_key = Keys::generate().secret_key().to_secret_hex();
    let path = temp.path().join("state.json");
    persist_new(&path, &journal).unwrap();
    assert!(read_journal(&path, &binding).is_err());
}

#[test]
fn valid_owner_signature_cannot_replay_a_different_membership_command() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner();
    let binding = binding(&owner);
    let mut journal = make_journal(&owner, binding.clone()).unwrap();
    let agent = journal.profile.pubkey.to_hex();
    journal.membership = owner
        .sign_event(
            buzz_sdk::build_add_member(
                uuid::Uuid::new_v4(),
                &agent,
                Some(buzz_sdk::MemberRole::Bot),
            )
            .unwrap(),
        )
        .unwrap();
    let path = temp.path().join("state.json");
    persist_new(&path, &journal).unwrap();
    assert!(read_journal(&path, &binding)
        .err()
        .unwrap()
        .to_string()
        .contains("event scope mismatch"));
}

#[test]
fn cohort_and_owner_are_part_of_runtime_identity() {
    let owner = owner();
    let mut binding = binding(&owner);
    let first = journal_path(Path::new("/private"), &binding);
    binding.cohort = "herdr".into();
    assert_ne!(first, journal_path(Path::new("/private"), &binding));
    binding.cohort = "local".into();
    binding.display_name = "Changed name".into();
    assert_eq!(first, journal_path(Path::new("/private"), &binding));
}

#[cfg(unix)]
#[test]
fn refuses_public_directory_and_symlinked_journal_without_changing_them() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(private_dir(temp.path()).is_err());
    let owner = owner();
    let binding = binding(&owner);
    let original = temp.path().join("original");
    persist_new(&original, &make_journal(&owner, binding.clone()).unwrap()).unwrap();
    let link = temp.path().join("link");
    symlink(&original, &link).unwrap();
    assert!(read_journal(&link, &binding).is_err());
    assert!(read_journal(&original, &binding).is_ok());
}

#[tokio::test]
async fn delegated_agent_cannot_mint_an_owner_identity() {
    let keys = Keys::generate();
    let owner = owner();
    let auth = buzz_sdk::nip_oa::compute_auth_tag(owner.keys(), &keys.public_key(), "").unwrap();
    let agent = BuzzClient::new(
        owner.relay_url().into(),
        keys,
        Some(buzz_sdk::nip_oa::parse_auth_tag(&auth).unwrap()),
        Some(auth),
    )
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert!(enroll(
        &agent,
        dir.path().join("unused"),
        uuid::Uuid::new_v4().to_string(),
        "session".into(),
        "local".into(),
        "Agent".into()
    )
    .await
    .is_err());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[derive(Clone)]
struct Relay {
    keys: Keys,
    events: std::sync::Arc<std::sync::Mutex<Vec<Event>>>,
    reject_directory: std::sync::Arc<std::sync::atomic::AtomicBool>,
    revoked: std::sync::Arc<std::sync::atomic::AtomicBool>,
    posts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

async fn relay_query(
    axum::extract::State(state): axum::extract::State<Relay>,
    axum::Json(filters): axum::Json<Vec<serde_json::Value>>,
) -> axum::Json<Vec<Event>> {
    assert_eq!(filters.len(), 1);
    let filter = &filters[0];
    assert_eq!(filter["consistency"], "strong");
    let events = state.events.lock().unwrap();
    if filter["kinds"][0] == 39002 {
        let channel = filter["#d"][0].as_str().unwrap();
        let mut tags = vec![Tag::parse(["d", channel]).unwrap()];
        if !state.revoked.load(std::sync::atomic::Ordering::SeqCst) {
            for event in events.iter().filter(|event| event.kind.as_u16() == 9000) {
                tags.extend(
                    event
                        .tags
                        .iter()
                        .filter(|tag| tag.as_slice()[0] == "p")
                        .cloned(),
                );
            }
        }
        return axum::Json(vec![EventBuilder::new(Kind::Custom(39002), "")
            .tags(tags)
            .sign_with_keys(&state.keys)
            .unwrap()]);
    }
    axum::Json(
        events
            .iter()
            .filter(|event| Some(event.id.to_hex().as_str()) == filter["ids"][0].as_str())
            .cloned()
            .collect(),
    )
}

async fn relay_post(
    axum::extract::State(state): axum::extract::State<Relay>,
    axum::Json(event): axum::Json<Event>,
) -> axum::Json<serde_json::Value> {
    buzz_core::verify_event(&event).unwrap();
    state
        .posts
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if event.kind.as_u16() == 30177
        && state
            .reject_directory
            .swap(false, std::sync::atomic::Ordering::SeqCst)
    {
        return axum::Json(json!({"event_id": event.id.to_hex(), "accepted": false}));
    }
    state.events.lock().unwrap().push(event.clone());
    axum::Json(json!({"event_id": event.id.to_hex(), "accepted": true}))
}

#[tokio::test]
async fn production_enrollment_recovers_partial_publish_and_does_not_regrant_revoked_membership() {
    use axum::{
        routing::{get, post},
        Router,
    };
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };
    let state = Relay {
        keys: Keys::generate(),
        events: Arc::new(Mutex::new(Vec::new())),
        reject_directory: Arc::new(AtomicBool::new(true)),
        revoked: Arc::new(AtomicBool::new(false)),
        posts: Arc::new(AtomicUsize::new(0)),
    };
    let relay_key = state.keys.public_key().to_hex();
    let router = Router::new()
        .route(
            "/",
            get(move || {
                let key = relay_key.clone();
                async move { axum::Json(json!({"self": key})) }
            }),
        )
        .route("/query", post(relay_query))
        .route("/events", post(relay_post))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let owner = BuzzClient::new(
        format!("http://{}", listener.local_addr().unwrap()),
        Keys::generate(),
        None,
        None,
    )
    .unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("identities");
    let channel = uuid::Uuid::new_v4().to_string();
    let run = || {
        enroll(
            &owner,
            dir.clone(),
            channel.clone(),
            "real-runtime-id".into(),
            "local".into(),
            "Local".into(),
        )
    };
    assert!(run().await.is_err());
    let path = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
    let before = fs::read(&path).unwrap();
    assert_eq!(state.events.lock().unwrap().len(), 1);
    run().await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(state.events.lock().unwrap().len(), 3);
    let credential: serde_json::Value =
        serde_json::from_slice(&fs::read(path.with_extension("credential.json")).unwrap()).unwrap();
    assert!(credential.get("membership").is_none());
    assert!(credential.get("directory").is_none());
    assert_ne!(
        credential["private_key"],
        owner.keys().secret_key().to_secret_hex()
    );
    let posts = state.posts.load(Ordering::SeqCst);
    run().await.unwrap();
    assert_eq!(state.posts.load(Ordering::SeqCst), posts);
    state.revoked.store(true, Ordering::SeqCst);
    // Original commands may have aged out of history. A completed identity
    // must not gain membership again by replaying its provisioning journal.
    state.events.lock().unwrap().clear();
    assert!(run().await.is_err());
    assert_eq!(state.posts.load(Ordering::SeqCst), posts);
    server.abort();
}

#[test]
fn membership_evidence_requires_the_actual_relay_signature_and_exact_channel() {
    let relay = Keys::generate();
    let impostor = Keys::generate();
    let channel = uuid::Uuid::new_v4().to_string();
    let member = Keys::generate().public_key().to_hex();
    let event = EventBuilder::new(Kind::Custom(39002), "")
        .tags([
            Tag::parse(["d", &channel]).unwrap(),
            Tag::parse(["p", &member]).unwrap(),
        ])
        .sign_with_keys(&relay)
        .unwrap();
    assert!(valid_membership(
        &event,
        &relay.public_key(),
        &channel,
        &member
    ));
    assert!(!valid_membership(
        &event,
        &impostor.public_key(),
        &channel,
        &member
    ));
    assert!(!valid_membership(
        &event,
        &relay.public_key(),
        &uuid::Uuid::new_v4().to_string(),
        &member
    ));
    let mut corrupt = serde_json::to_value(&event).unwrap();
    corrupt["content"] = "tampered".into();
    let corrupt: Event = serde_json::from_value(corrupt).unwrap();
    assert!(!valid_membership(
        &corrupt,
        &relay.public_key(),
        &channel,
        &member
    ));
}
