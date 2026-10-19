use super::*;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use nostr::Keys;
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

#[derive(Clone)]
struct Relay {
    keys: Keys,
    owner: String,
    events: Arc<Mutex<Vec<Event>>>,
    reject_policy: Arc<AtomicBool>,
    revoked: Arc<AtomicBool>,
    changed_members: Arc<AtomicBool>,
    forge_directory: Arc<AtomicBool>,
    posts: Arc<AtomicUsize>,
}

async fn query(State(state): State<Relay>, Json(filters): Json<Vec<Value>>) -> Json<Vec<Event>> {
    assert_eq!(filters.len(), 1);
    let filter = &filters[0];
    assert_eq!(filter["consistency"], "strong");
    let events = state.events.lock().unwrap();
    if filter["kinds"][0] == 30177 && state.forge_directory.load(Ordering::SeqCst) {
        return Json(vec![EventBuilder::new(Kind::Custom(30177), "{}")
            .tag(Tag::parse(["d", filter["#d"][0].as_str().unwrap()]).unwrap())
            .sign_with_keys(&Keys::generate())
            .unwrap()]);
    }
    if filter["kinds"][0] == 39002 {
        let channel = filter["#d"][0].as_str().unwrap();
        let mut tags = vec![
            Tag::parse(["d", channel]).unwrap(),
            Tag::parse(["p", &state.owner]).unwrap(),
        ];
        if !state.revoked.load(Ordering::SeqCst) {
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
        if state.changed_members.load(Ordering::SeqCst) {
            tags.push(Tag::parse(["p", &"ab".repeat(32)]).unwrap());
        }
        return Json(vec![EventBuilder::new(Kind::Custom(39002), "")
            .tags(tags)
            .custom_created_at(Timestamp::from(100))
            .sign_with_keys(&state.keys)
            .unwrap()]);
    }
    let mut matches: Vec<_> = events
        .iter()
        .filter(|event| {
            if let Some(id) = filter["ids"][0].as_str() {
                return event.id.to_hex() == id;
            }
            event.kind.as_u16() as u64 == filter["kinds"][0].as_u64().unwrap()
                && filter["authors"][0].as_str() == Some(event.pubkey.to_hex().as_str())
                && filter["#d"][0]
                    .as_str()
                    .is_none_or(|d| event.tags.iter().any(|tag| tag.as_slice() == ["d", d]))
        })
        .cloned()
        .collect();
    matches.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    matches.truncate(1);
    Json(matches)
}

async fn publish(State(state): State<Relay>, Json(event): Json<Event>) -> Json<Value> {
    buzz_core::verify_event(&event).unwrap();
    state.posts.fetch_add(1, Ordering::SeqCst);
    if event.kind.as_u16() == 30177 {
        let content: Value = serde_json::from_str(&event.content).unwrap();
        if content["respond_to"] == "allowlist" && state.reject_policy.swap(false, Ordering::SeqCst)
        {
            return Json(json!({"event_id":event.id, "accepted":false}));
        }
    }
    state.events.lock().unwrap().push(event.clone());
    Json(json!({"event_id":event.id, "accepted":true}))
}

struct Fixture {
    _root: tempfile::TempDir,
    file: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    client: BuzzClient,
    relay: Relay,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        let owner = Keys::generate();
        let relay = Relay {
            keys: Keys::generate(),
            owner: owner.public_key().to_hex(),
            events: Arc::new(Mutex::new(Vec::new())),
            reject_policy: Arc::new(AtomicBool::new(false)),
            revoked: Arc::new(AtomicBool::new(false)),
            changed_members: Arc::new(AtomicBool::new(false)),
            forge_directory: Arc::new(AtomicBool::new(false)),
            posts: Arc::new(AtomicUsize::new(0)),
        };
        let relay_key = relay.keys.public_key().to_hex();
        let router = Router::new()
            .route(
                "/",
                get(move || {
                    let key = relay_key.clone();
                    async move { Json(json!({"self":key})) }
                }),
            )
            .route("/query", post(query))
            .route("/events", post(publish))
            .with_state(relay.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = BuzzClient::new(
            format!("http://{}", listener.local_addr().unwrap()),
            owner,
            None,
            None,
        )
        .unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let rig = b"version: '1'\nname: engineering\npods: []\n";
        let agent = b"version: '1'\nname: manager\n";
        fs::write(root.path().join("rig.yaml"), rig).unwrap();
        fs::write(root.path().join("agent.yaml"), agent).unwrap();
        let file = root.path().join("agents.json");
        let document = json!({"version":1,"relay":client.relay_url(),"owner":relay.owner,
            "channel":uuid::Uuid::new_v4().to_string(),"runtime":{"cohort":"openrig","rig_id":"existing-rig",
                "rig_spec":{"path":"rig.yaml","sha256":hex::encode(Sha256::digest(rig))},
                "agent_specs":[{"path":"agent.yaml","sha256":hex::encode(Sha256::digest(agent))}]},
            "agents":[{"key":"manager","seat":"engineering.manager","runtime_id":"original-runtime",
                "display_name":"Manager","adoption":null,
                "invocation":{"respond_to":"allowlist","allowlist":[Keys::generate().public_key().to_hex()]}}]});
        fs::write(&file, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
        let state_dir = root.path().join("identities");
        Self {
            _root: root,
            file,
            state_dir,
            client,
            relay,
            server,
        }
    }
    fn manifest(&self) -> Manifest {
        manifest::load(&self.file).unwrap()
    }
    fn edit(&self, edit: impl FnOnce(&mut Value)) {
        let mut document: Value = serde_json::from_slice(&fs::read(&self.file).unwrap()).unwrap();
        edit(&mut document);
        fs::write(&self.file, serde_json::to_vec(&document).unwrap()).unwrap();
    }
    async fn plan(&self) -> Plan {
        make_plan(&self.client, &self.manifest(), &self.state_dir)
            .await
            .unwrap()
    }
    async fn apply(&self) -> Result<Value, CliError> {
        let plan = self.plan().await;
        apply(
            &self.client,
            &self.file,
            &self.state_dir,
            &digest(&plan).unwrap(),
        )
        .await
    }
    fn posts(&self) -> usize {
        self.relay.posts.load(Ordering::SeqCst)
    }

    async fn cli(&self, action: &str, extra: &[&str]) -> i32 {
        let mut args = vec![
            "buzz".to_string(),
            "--relay".into(),
            self.client.relay_url().into(),
            "--private-key".into(),
            self.client.keys().secret_key().to_secret_hex(),
            "agents".into(),
            "config".into(),
            action.into(),
            "--file".into(),
            self.file.to_string_lossy().into_owned(),
        ];
        if action != "validate" {
            args.extend([
                "--state-dir".into(),
                self.state_dir.to_string_lossy().into_owned(),
            ]);
        }
        args.extend(extra.iter().map(|item| item.to_string()));
        crate::run_from_args(args).await
    }
}

#[tokio::test]
async fn real_cli_dispatch_exercises_validate_plan_apply_and_status() {
    let fixture = Fixture::new().await;
    assert_eq!(fixture.cli("validate", &[]).await, 0);
    assert_eq!(fixture.cli("plan", &[]).await, 0);
    assert!(!fixture.state_dir.exists());
    let plan = digest(&fixture.plan().await).unwrap();
    assert_eq!(fixture.cli("apply", &["--plan", &plan]).await, 0);
    assert_eq!(fixture.cli("status", &[]).await, 0);
    assert_eq!(fixture.cli("apply", &["--plan", &plan]).await, 5);
}

#[tokio::test]
async fn invalid_duplicate_or_escaping_configurations_fail_before_effects() {
    let fixture = Fixture::new().await;
    let original: Value = serde_json::from_slice(&fs::read(&fixture.file).unwrap()).unwrap();
    let edits: Vec<fn(&mut Value)> = vec![
        |doc| doc["runtime"]["rig_spec"]["path"] = json!("../rig.yaml"),
        |doc| doc["runtime"]["rig_spec"]["path"] = json!("/tmp/rig.yaml"),
        |doc| doc["runtime"]["cohort"] = json!("local"),
        |doc| doc["agents"][0]["key"] = json!("../manager"),
        |doc| doc["agents"][0]["key"] = json!("Manager"),
        |doc| doc["agents"][0]["seat"] = json!("manager"),
        |doc| doc["agents"][0]["invocation"]["allowlist"] = json!([]),
        |doc| doc["agents"][0]["invocation"]["respond_to"] = json!("anyone"),
        |doc| doc["agents"][0]["invocation"]["respond_to"] = json!("unknown"),
        |doc| {
            let second = doc["agents"][0].clone();
            doc["agents"].as_array_mut().unwrap().push(second);
        },
        |doc| doc["relay"] = json!("https://user:secret@buzz.example.com"),
    ];
    for edit in edits {
        let mut document = original.clone();
        edit(&mut document);
        fs::write(&fixture.file, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(validate_file(&fixture.file).is_err());
        assert!(!fixture.state_dir.exists());
        assert_eq!(fixture.posts(), 0);
    }
    fs::write(&fixture.file, serde_json::to_vec(&original).unwrap()).unwrap();
    // Reject a non-file before opening it (in particular, no FIFO/socket hang).
    let socket_path = fixture.file.parent().unwrap().join("socket");
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    fixture.edit(|doc| doc["runtime"]["rig_spec"]["path"] = json!("socket"));
    assert!(validate_file(&fixture.file).is_err());
    fs::write(&fixture.file, vec![b' '; 128 * 1024 + 1]).unwrap();
    assert!(validate_file(&fixture.file).is_err());
}

#[tokio::test]
async fn validate_is_local_strict_bounded_and_pins_spec_bytes() {
    let fixture = Fixture::new().await;
    let validated = validate_file(&fixture.file).unwrap();
    assert_eq!(
        validated["runtime"]["canonical_spec_validation"],
        "pending_protected_operator"
    );
    assert_eq!(fixture.posts(), 0);
    assert!(!fixture.state_dir.exists());
    // Exercise the real CLI route with a deliberately unusable credential.
    let code = crate::run_from_args([
        "buzz",
        "--private-key",
        "invalid",
        "agents",
        "config",
        "validate",
        "--file",
        fixture.file.to_str().unwrap(),
    ])
    .await;
    assert_eq!(code, 0);
    for field in [
        "private_key",
        "auth_tag",
        "env",
        "launch_command",
        "receipt",
    ] {
        fixture.edit(|document| {
            document["agents"][0][field] = json!("secret-sentinel");
        });
        assert!(validate_file(&fixture.file).is_err());
        fixture.edit(|document| {
            document["agents"][0].as_object_mut().unwrap().remove(field);
        });
    }
    fs::write(fixture.file.parent().unwrap().join("rig.yaml"), "changed").unwrap();
    assert!(validate_file(&fixture.file).is_err());
    assert!(!fixture.state_dir.exists());
}

#[tokio::test]
async fn partial_policy_failure_replays_exact_events_and_keeps_runtime_pending() {
    let fixture = Fixture::new().await;
    fixture.relay.reject_policy.store(true, Ordering::SeqCst);
    assert!(fixture.apply().await.is_err());
    let manifest = fixture.manifest();
    let journal_path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    let original = fs::read(&journal_path).unwrap();
    let policy_path = fs::read_dir(&fixture.state_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("config-policy-manager-")
                && path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .ends_with(".intent.json")
        })
        .unwrap();
    let policy_before = fs::read(&policy_path).unwrap();
    let result = fixture.apply().await.unwrap();
    assert_eq!(fs::read(journal_path).unwrap(), original);
    assert_eq!(fs::read(policy_path).unwrap(), policy_before);
    assert_eq!(result["configuration_applied"], true);
    assert_eq!(
        result["runtime"]["effective_runtime_policy"],
        "pending_protected_operator"
    );
    assert_eq!(result["runtime"]["presence"], "unknown");
    let handoff: SignedHandoff =
        serde_json::from_slice(&fs::read(result["handoff_file"].as_str().unwrap()).unwrap())
            .unwrap();
    verify_handoff(&handoff, &manifest).unwrap();
    let public = result.to_string() + &serde_json::to_string(&handoff).unwrap();
    assert!(!public.contains("private_key"));
    assert!(!public.contains("auth_tag"));
    assert!(!public.contains(&fixture.client.keys().secret_key().to_secret_hex()));
    let private_journal: Value = serde_json::from_slice(&original).unwrap();
    assert!(!public.contains(private_journal["private_key"].as_str().unwrap()));
    let auth: Vec<String> =
        serde_json::from_str(private_journal["auth_tag"].as_str().unwrap()).unwrap();
    assert!(!public.contains(&auth[3]));
    let posts = fixture.posts();
    let repeated = fixture.apply().await.unwrap();
    assert_eq!(repeated["agents"], result["agents"]);
    assert_eq!(fixture.posts(), posts);
    // The requested team policy has exactly the declared authors; no inferred
    // team-wide access or runtime gate change is claimed by this configuration.
    assert_eq!(
        handoff.handoff["agents"][0]["invocation"],
        json!(manifest.agents[0].invocation)
    );
    let current = directory(
        &fixture.client,
        result["agents"][0]["pubkey"].as_str().unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(policy_matches(&current, &manifest.agents[0]));
    let mut other_policy = manifest.agents[0].clone();
    other_policy.invocation.allowlist = vec![Keys::generate().public_key().to_hex()];
    assert!(!policy_matches(&current, &other_policy));
}

#[tokio::test]
async fn stale_plan_scope_or_binding_changes_do_not_publish() {
    let fixture = Fixture::new().await;
    let plan = fixture.plan().await;
    assert!(!fixture.state_dir.exists(), "plan must not create journals");
    fixture.relay.changed_members.store(true, Ordering::SeqCst);
    assert!(apply(
        &fixture.client,
        &fixture.file,
        &fixture.state_dir,
        &digest(&plan).unwrap()
    )
    .await
    .is_err());
    assert_eq!(fixture.posts(), 0);
    fixture.apply().await.unwrap();
    let posts = fixture.posts();
    fixture.edit(|document| document["agents"][0]["runtime_id"] = json!("replacement"));
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    fixture.edit(|document| document["agents"][0]["runtime_id"] = json!("original-runtime"));
    fixture.edit(|document| document["runtime"]["rig_id"] = json!("replacement-rig"));
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    fixture.edit(|document| document["runtime"]["rig_id"] = json!("existing-rig"));
    fixture.edit(|document| document["owner"] = json!(Keys::generate().public_key().to_hex()));
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn adoption_requires_existing_private_journal_and_exact_pubkey() {
    let fixture = Fixture::new().await;
    fixture.edit(|document| {
        document["agents"][0]["adoption"] =
            json!({"expected_pubkey":Keys::generate().public_key().to_hex()})
    });
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    assert!(!fixture.state_dir.exists());
    fixture.edit(|document| document["agents"][0]["adoption"] = Value::Null);
    let manifest = fixture.manifest();
    let receipt = enrollment::provision(
        &fixture.client,
        fixture.state_dir.clone(),
        manifest.channel.clone(),
        manifest.agents[0].runtime_id.clone(),
        "openrig".into(),
        "Manager".into(),
    )
    .await
    .unwrap();
    assert!(make_plan(&fixture.client, &manifest, &fixture.state_dir)
        .await
        .is_err());
    fixture.edit(|document| {
        document["agents"][0]["adoption"] = json!({"expected_pubkey":receipt["pubkey"]})
    });
    let applied = fixture.apply().await.unwrap();
    assert_eq!(applied["agents"][0]["pubkey"], receipt["pubkey"]);
    fixture.edit(|document| {
        document["agents"][0]["adoption"] =
            json!({"expected_pubkey":Keys::generate().public_key().to_hex()})
    });
    let posts = fixture.posts();
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn completed_revoked_or_lost_identity_is_never_recreated() {
    let fixture = Fixture::new().await;
    fixture.apply().await.unwrap();
    let posts = fixture.posts();
    fixture.relay.revoked.store(true, Ordering::SeqCst);
    fixture.relay.events.lock().unwrap().clear();
    assert!(fixture.apply().await.is_err());
    assert_eq!(fixture.posts(), posts);
    let manifest = fixture.manifest();
    let path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    fs::remove_file(path).unwrap();
    assert!(make_plan(&fixture.client, &manifest, &fixture.state_dir)
        .await
        .is_err());
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn delegated_auth_and_arbitrary_handoff_receipts_are_denied() {
    let fixture = Fixture::new().await;
    let keys = Keys::generate();
    let auth =
        buzz_sdk::nip_oa::compute_auth_tag(fixture.client.keys(), &keys.public_key(), "").unwrap();
    let delegated = BuzzClient::new(
        fixture.client.relay_url().into(),
        keys,
        Some(buzz_sdk::nip_oa::parse_auth_tag(&auth).unwrap()),
        Some(auth),
    )
    .unwrap();
    assert!(
        make_plan(&delegated, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    assert_eq!(fixture.posts(), 0);
    let result = fixture.apply().await.unwrap();
    let path = std::path::Path::new(result["handoff_file"].as_str().unwrap());
    let mut handoff: SignedHandoff = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    handoff.handoff["verification"]["protected_runtime"] = json!("ready");
    fs::write(path, serde_json::to_vec(&handoff).unwrap()).unwrap();
    assert!(execute(
        AgentsConfigCmd::Status {
            file: fixture.file.clone(),
            state_dir: fixture.state_dir.clone()
        },
        &fixture.client
    )
    .await
    .is_err());
}

#[tokio::test]
async fn apply_lock_is_exclusive_and_released_without_stale_lock_recovery() {
    let fixture = Fixture::new().await;
    let lock = state::lock(&fixture.state_dir).unwrap();
    let plan = fixture.plan().await;
    assert!(apply(
        &fixture.client,
        &fixture.file,
        &fixture.state_dir,
        &digest(&plan).unwrap()
    )
    .await
    .is_err());
    assert_eq!(fixture.posts(), 0);
    drop(lock);
    fixture.apply().await.unwrap();
}

#[tokio::test]
async fn crash_before_binding_and_later_policy_change_preserve_identity() {
    let fixture = Fixture::new().await;
    let manifest = fixture.manifest();
    enrollment::private_dir(&fixture.state_dir).unwrap();
    let hash = digest(&manifest).unwrap();
    state::save_new(
        &fixture
            .state_dir
            .join(format!("config-{}.intent.json", hash)),
        &manifest,
    )
    .unwrap();
    let journal_path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    enrollment::persist_new(
        &journal_path,
        &enrollment::make_journal(&fixture.client, binding(&manifest, &manifest.agents[0]))
            .unwrap(),
    )
    .unwrap();
    let original = fs::read(&journal_path).unwrap();
    let first = fixture.apply().await.unwrap();
    assert_eq!(fs::read(&journal_path).unwrap(), original);
    fixture.edit(|doc| {
        doc["agents"][0]["invocation"]["respond_to"] = json!("anyone");
        doc["agents"][0]["invocation"]["allowlist"] = json!([]);
    });
    let second = fixture.apply().await.unwrap();
    assert_eq!(first["agents"][0]["pubkey"], second["agents"][0]["pubkey"]);
    assert_eq!(
        second["runtime"]["effective_runtime_policy"],
        "pending_protected_operator"
    );
    assert_eq!(fs::read(&journal_path).unwrap(), original);
    // A lost credential after completed provisioning cannot cause a replay.
    let posts = fixture.posts();
    fs::remove_file(journal_path.with_extension("credential.json")).unwrap();
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn competing_policy_during_partial_apply_is_not_overwritten() {
    let fixture = Fixture::new().await;
    fixture.relay.reject_policy.store(true, Ordering::SeqCst);
    assert!(fixture.apply().await.is_err());
    let plan = fixture.plan().await;
    let pubkey = plan.agents[0].pubkey.as_ref().unwrap();
    let current = directory(&fixture.client, pubkey).await.unwrap().unwrap();
    let concurrent = fixture
        .client
        .sign_event(
            EventBuilder::new(Kind::Custom(30177), current.content.clone())
                .tag(Tag::parse(["d", pubkey.as_str()]).unwrap())
                .custom_created_at(Timestamp::from(current.created_at.as_secs() + 5)),
        )
        .unwrap();
    fixture
        .relay
        .events
        .lock()
        .unwrap()
        .push(concurrent.clone());
    let posts = fixture.posts();
    assert!(fixture.apply().await.is_err());
    assert_eq!(fixture.posts(), posts);
    assert_eq!(
        directory(&fixture.client, pubkey).await.unwrap(),
        Some(concurrent)
    );
}

#[tokio::test]
async fn forged_remote_policy_and_replaced_private_key_fail_readback() {
    let fixture = Fixture::new().await;
    fixture.apply().await.unwrap();
    let posts = fixture.posts();
    fixture.relay.forge_directory.store(true, Ordering::SeqCst);
    assert!(
        make_plan(&fixture.client, &fixture.manifest(), &fixture.state_dir)
            .await
            .is_err()
    );
    fixture.relay.forge_directory.store(false, Ordering::SeqCst);
    let manifest = fixture.manifest();
    let journal_path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    let replacement =
        enrollment::make_journal(&fixture.client, binding(&manifest, &manifest.agents[0])).unwrap();
    fs::write(journal_path, serde_json::to_vec(&replacement).unwrap()).unwrap();
    fs::remove_file(fixture.state_dir.join("config-enrolled-manager.json")).unwrap();
    assert!(make_plan(&fixture.client, &manifest, &fixture.state_dir)
        .await
        .is_err());
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn oversized_reconciliation_intent_cannot_poison_its_recovery_journal() {
    let fixture = Fixture::new().await;
    let _lock = state::lock(&fixture.state_dir).unwrap();
    let path = fixture.state_dir.join("oversized-intent.json");
    assert!(state::save_new(&path, &json!({"content":"x".repeat(512 * 1024)})).is_err());
    assert!(!path.exists());
    assert_eq!(fixture.posts(), 0);
}

#[tokio::test]
async fn completed_a_b_a_reversion_preserves_key_and_signed_generations() {
    let fixture = Fixture::new().await;
    let original_manifest: Value =
        serde_json::from_slice(&fs::read(&fixture.file).unwrap()).unwrap();
    let first = fixture.apply().await.unwrap();
    let first_generation = fs::read(first["handoff_generation_file"].as_str().unwrap()).unwrap();
    let manifest = fixture.manifest();
    let journal_path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    let original_journal = fs::read(&journal_path).unwrap();
    // Crash after exact completion history is synced but before active progress
    // advances. A fresh approved B transition must recover that completion.
    let active = fixture.state_dir.join("config-policy-manager.active.json");
    let mut progress = state::read_private::<PolicyProgress>(&active)
        .unwrap()
        .unwrap();
    progress.completed = false;
    fs::write(&active, serde_json::to_vec(&progress).unwrap()).unwrap();
    fixture.edit(|doc| {
        doc["agents"][0]["invocation"]["respond_to"] = json!("anyone");
        doc["agents"][0]["invocation"]["allowlist"] = json!([]);
    });
    fixture.apply().await.unwrap();
    fs::write(
        &fixture.file,
        serde_json::to_vec(&original_manifest).unwrap(),
    )
    .unwrap();
    let reverted = fixture.apply().await.unwrap();
    assert_eq!(
        first["agents"][0]["pubkey"],
        reverted["agents"][0]["pubkey"]
    );
    assert_eq!(fs::read(&journal_path).unwrap(), original_journal);
    assert_ne!(
        first["agents"][0]["directory_event"],
        reverted["agents"][0]["directory_event"]
    );
    assert_ne!(
        first["handoff_generation_file"],
        reverted["handoff_generation_file"]
    );
    assert_eq!(
        fs::read(first["handoff_generation_file"].as_str().unwrap()).unwrap(),
        first_generation
    );
    let envelope: SignedHandoff = serde_json::from_slice(
        &fs::read(reverted["handoff_generation_file"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    verify_handoff(&envelope, &fixture.manifest()).unwrap();
    let policy = directory(
        &fixture.client,
        reverted["agents"][0]["pubkey"].as_str().unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(policy_matches(&policy, &fixture.manifest().agents[0]));
    let posts = fixture.posts();
    fixture.apply().await.unwrap();
    assert_eq!(fixture.posts(), posts);
}

#[tokio::test]
async fn already_matching_policy_and_profile_refresh_get_current_signed_handoff() {
    let fixture = Fixture::new().await;
    let first = fixture.apply().await.unwrap();
    let manifest = fixture.manifest();
    let path =
        enrollment::journal_path(&fixture.state_dir, &binding(&manifest, &manifest.agents[0]));
    let private: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let keys = Keys::parse(private["private_key"].as_str().unwrap()).unwrap();
    let original_profile: Event = serde_json::from_value(private["profile"].clone()).unwrap();
    let profile = EventBuilder::new(
        Kind::Metadata,
        json!({"name":"Manager","about":"updated"}).to_string(),
    )
    .tag(buzz_sdk::nip_oa::parse_auth_tag(private["auth_tag"].as_str().unwrap()).unwrap())
    .custom_created_at(Timestamp::from(original_profile.created_at.as_secs() + 5))
    .sign_with_keys(&keys)
    .unwrap();
    let pubkey = first["agents"][0]["pubkey"].as_str().unwrap();
    let current = directory(&fixture.client, pubkey).await.unwrap().unwrap();
    let policy = fixture
        .client
        .sign_event(
            EventBuilder::new(Kind::Custom(30177), current.content.clone())
                .tag(Tag::parse(["d", pubkey]).unwrap())
                .custom_created_at(Timestamp::from(current.created_at.as_secs() + 5)),
        )
        .unwrap();
    fixture
        .relay
        .events
        .lock()
        .unwrap()
        .extend([profile.clone(), policy.clone()]);
    let status = execute(
        AgentsConfigCmd::Status {
            file: fixture.file.clone(),
            state_dir: fixture.state_dir.clone(),
        },
        &fixture.client,
    )
    .await
    .unwrap();
    assert_eq!(status["handoff_current"], false);
    let posts = fixture.posts();
    let refreshed = fixture.apply().await.unwrap();
    assert_eq!(
        fixture.posts(),
        posts,
        "already matching policy must not be republished"
    );
    assert_eq!(refreshed["agents"][0]["profile_event"], profile.id.to_hex());
    assert_eq!(
        refreshed["agents"][0]["directory_event"],
        policy.id.to_hex()
    );
    assert_ne!(
        first["handoff_generation_file"],
        refreshed["handoff_generation_file"]
    );
    let status = execute(
        AgentsConfigCmd::Status {
            file: fixture.file.clone(),
            state_dir: fixture.state_dir.clone(),
        },
        &fixture.client,
    )
    .await
    .unwrap();
    assert_eq!(status["handoff_current"], true);
    let envelope: SignedHandoff = serde_json::from_slice(
        &fs::read(refreshed["handoff_generation_file"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    verify_handoff(&envelope, &manifest).unwrap();
}
