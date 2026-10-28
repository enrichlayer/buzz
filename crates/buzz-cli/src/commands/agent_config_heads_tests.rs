//! Synthetic producer-to-reader exercises of the real authenticated dispatcher.
use super::*;
use std::path::PathBuf;

struct HeadFixture {
    fixture: Fixture,
    reader: BuzzClient,
    auth_tag: String,
    handoff: PathBuf,
    expected: PathBuf,
}

impl HeadFixture {
    async fn new() -> Self {
        let fixture = Fixture::new().await;
        let applied = fixture.apply().await.unwrap();
        let manifest = fixture.manifest();
        let agent = &manifest.agents[0];
        let handoff = fixture.file.with_file_name("chosen-handoff.json");
        fs::copy(
            applied["handoff_generation_file"].as_str().unwrap(),
            &handoff,
        )
        .unwrap();
        let expected = fixture.file.with_file_name("independent-scope.json");
        fs::write(
            &expected,
            serde_json::to_vec(&json!({"version":1,
                "relay":manifest.relay,"owner":manifest.owner,"channel":manifest.channel,
                "cohort":manifest.runtime.cohort,"rig_id":manifest.runtime.rig_id,
                "handoff_sha256":applied["handoff_sha256"],
                "authorization_event_id":applied["authorization_event_id"],
                "agents":[{"key":agent.key,"seat":agent.seat,"runtime_id":agent.runtime_id,
                    "pubkey":applied["agents"][0]["pubkey"]}]}))
            .unwrap(),
        )
        .unwrap();
        // Only fixture setup reads its newly created synthetic credential. The
        // consumer gets ordinary existing Buzz auth, then the journal is gone.
        let journal: Value = serde_json::from_slice(
            &fs::read(enrollment::journal_path(
                &fixture.state_dir,
                &binding(&manifest, agent),
            ))
            .unwrap(),
        )
        .unwrap();
        let auth_tag = journal["auth_tag"].as_str().unwrap().to_owned();
        let reader = BuzzClient::new(
            fixture.client.relay_url().into(),
            Keys::parse(journal["private_key"].as_str().unwrap()).unwrap(),
            Some(buzz_sdk::nip_oa::parse_auth_tag(&auth_tag).unwrap()),
            Some(auth_tag.clone()),
        )
        .unwrap();
        assert_ne!(reader.keys().public_key().to_hex(), manifest.owner);
        fs::remove_dir_all(&fixture.state_dir).unwrap();
        fixture.relay.reads.lock().unwrap().clear();
        Self {
            fixture,
            reader,
            auth_tag,
            handoff,
            expected,
        }
    }

    async fn verify(&self) -> Result<Value, CliError> {
        execute(
            AgentsConfigCmd::VerifyHeads {
                file: self.fixture.file.clone(),
                handoff: self.handoff.clone(),
                expected: self.expected.clone(),
            },
            &self.reader,
        )
        .await
    }

    async fn cli(&self, private_key: String) -> i32 {
        crate::run_from_args(vec![
            "buzz".into(),
            "--relay".into(),
            self.reader.relay_url().into(),
            "--private-key".into(),
            private_key,
            "--auth-tag".into(),
            self.auth_tag.clone(),
            "agents".into(),
            "config".into(),
            "verify-heads".into(),
            "--file".into(),
            self.fixture.file.to_string_lossy().into_owned(),
            "--handoff".into(),
            self.handoff.to_string_lossy().into_owned(),
            "--expected".into(),
            self.expected.to_string_lossy().into_owned(),
        ])
        .await
    }

    async fn head(&self, kind: u16) -> Event {
        let manifest = self.fixture.manifest();
        let pubkey = self.reader.keys().public_key();
        match kind {
            39002 => membership(&self.reader, &manifest).await.unwrap(),
            30177 => directory(
                &self.reader,
                &PublicKey::parse(&manifest.owner).unwrap(),
                &pubkey.to_hex(),
            )
            .await
            .unwrap()
            .unwrap(),
            0 => query_one(
                &self.reader,
                json!({"kinds":[0],"authors":[pubkey.to_hex()],"limit":1,"consistency":"strong"}),
                &pubkey,
                0,
                None,
            )
            .await
            .unwrap()
            .unwrap(),
            _ => panic!("unsupported fixture kind"),
        }
    }

    fn override_head(&self, kind: u16, events: Vec<Event>) {
        self.fixture
            .relay
            .overrides
            .lock()
            .unwrap()
            .insert(kind, events);
    }

    /// Pin a deliberately bad current event in a valid owner-signed artifact.
    /// This isolates signature/scope/member/policy guards from the ID guard.
    fn select_head(&self, kind: u16, event: &Event) {
        let mut envelope: SignedHandoff =
            serde_json::from_slice(&fs::read(&self.handoff).unwrap()).unwrap();
        match kind {
            39002 => envelope.handoff["membership_event"] = json!(event.id),
            30177 => envelope.handoff["agents"][0]["directory_event"] = json!(event.id),
            0 => envelope.handoff["agents"][0]["profile_event"] = json!(event.id),
            _ => panic!("unsupported fixture kind"),
        }
        envelope.authorization = EventBuilder::new(Kind::TextNote, envelope.handoff.to_string())
            .tag(Tag::parse(["t", HANDOFF_TAG]).unwrap())
            .sign_with_keys(self.fixture.client.keys())
            .unwrap();
        fs::write(&self.handoff, serde_json::to_vec(&envelope).unwrap()).unwrap();
        let mut expected: Value =
            serde_json::from_slice(&fs::read(&self.expected).unwrap()).unwrap();
        expected["handoff_sha256"] = json!(hex::encode(Sha256::digest(
            envelope.authorization.content.as_bytes()
        )));
        expected["authorization_event_id"] = json!(envelope.authorization.id);
        fs::write(&self.expected, serde_json::to_vec(&expected).unwrap()).unwrap();
        handoff::verify_files(&self.fixture.file, &self.handoff, &self.expected).unwrap();
    }
}

#[tokio::test]
async fn manager_reader_matches_producer_heads_without_private_state_or_writes() {
    let test = HeadFixture::new().await;
    let paths = [&test.fixture.file, &test.handoff, &test.expected];
    let before: Vec<_> = paths.iter().map(|path| fs::read(path).unwrap()).collect();
    let posts = test.fixture.posts();
    let result = test.verify().await.unwrap();
    assert_eq!(result["current_signed_heads_match"], true);
    assert_eq!(
        result["observed_heads"]["membership_event"],
        result["membership_event"]
    );
    let observed = &result["observed_heads"]["agents"][0];
    assert_eq!(
        observed["profile_event"],
        result["agents"][0]["profile_event"]
    );
    assert_eq!(
        observed["directory_event"],
        result["agents"][0]["directory_event"]
    );
    assert_eq!(observed["directory_author"], test.fixture.relay.owner);
    assert_eq!(
        observed["profile_author"],
        test.reader.keys().public_key().to_hex()
    );
    assert_eq!(
        result["verification"]["current_heads"],
        "matched_sequential_strong_reads"
    );
    assert_eq!(
        result["verification"]["generation_freshness"],
        "not_verified"
    );
    for field in [
        "native_custody",
        "canonical_spec_validation",
        "protected_runtime",
        "effective_runtime_policy",
        "activation",
    ] {
        assert_eq!(result["verification"][field], "pending_protected_operator");
    }
    assert_eq!(result["verification"]["presence"], "unknown");
    assert_eq!(
        test.cli(test.reader.keys().secret_key().to_secret_hex())
            .await,
        0
    );
    let reads = test.fixture.relay.reads.lock().unwrap().clone();
    assert!(reads
        .iter()
        .any(|filter| filter["kinds"][0] == 30177
            && filter["authors"][0] == test.fixture.relay.owner));
    assert_ne!(test.cli("invalid-key".into()).await, 0);
    assert_eq!(*test.fixture.relay.reads.lock().unwrap(), reads);
    assert_eq!(test.fixture.posts(), posts);
    assert!(!test.fixture.state_dir.exists());
    for (path, bytes) in paths.iter().zip(before) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[tokio::test]
async fn stale_profile_directory_or_membership_rejects_even_with_matching_policy() {
    for kind in [0, 30177, 39002] {
        let test = HeadFixture::new().await;
        let old = test.head(kind).await;
        let keys = match kind {
            0 => test.reader.keys(),
            30177 => test.fixture.client.keys(),
            _ => &test.fixture.relay.keys,
        };
        let refreshed = EventBuilder::new(old.kind, old.content.clone())
            .tags(old.tags.iter().cloned())
            .custom_created_at(Timestamp::from(old.created_at.as_secs() + 1))
            .sign_with_keys(keys)
            .unwrap();
        test.override_head(kind, vec![refreshed]);
        let error = test.verify().await.unwrap_err().to_string();
        assert!(
            error.contains("observed signed head"),
            "kind {kind}: {error}"
        );
    }
}

#[tokio::test]
async fn absent_or_ambiguous_current_heads_fail_closed() {
    for kind in [0, 30177, 39002] {
        let test = HeadFixture::new().await;
        let head = test.head(kind).await;
        test.override_head(kind, vec![head.clone(), head]);
        assert!(test
            .verify()
            .await
            .unwrap_err()
            .to_string()
            .contains("ambiguous"));
        test.override_head(kind, vec![]);
        assert!(test.verify().await.is_err(), "missing kind {kind}");
    }
}

#[tokio::test]
async fn revoked_owner_or_selected_manager_is_rejected_even_when_head_is_pinned() {
    for revoke_owner in [false, true] {
        let test = HeadFixture::new().await;
        let manifest = test.fixture.manifest();
        let retained = if revoke_owner {
            test.reader.keys().public_key().to_hex()
        } else {
            manifest.owner
        };
        let head = EventBuilder::new(Kind::Custom(39002), "")
            .tags([
                Tag::parse(["d", &manifest.channel]).unwrap(),
                Tag::parse(["p", &retained]).unwrap(),
            ])
            .sign_with_keys(&test.fixture.relay.keys)
            .unwrap();
        test.select_head(39002, &head);
        test.override_head(39002, vec![head]);
        let error = test.verify().await.unwrap_err().to_string();
        assert!(
            error.contains("channel membership not confirmed"),
            "{error}"
        );
    }
}

#[tokio::test]
async fn wrong_directory_owner_membership_signer_or_channel_cannot_be_pinned_into_authority() {
    for case in [
        "directory-owner",
        "directory-coordinate",
        "membership-signer",
        "membership-channel",
    ] {
        let test = HeadFixture::new().await;
        let kind = if case.starts_with("directory") {
            30177
        } else {
            39002
        };
        let old = test.head(kind).await;
        let tags = if case.ends_with("coordinate") || case.ends_with("channel") {
            vec![
                Tag::parse(["d", &uuid::Uuid::new_v4().to_string()]).unwrap(),
                Tag::parse(["p", &test.fixture.relay.owner]).unwrap(),
                Tag::parse(["p", &test.reader.keys().public_key().to_hex()]).unwrap(),
            ]
        } else {
            old.tags.iter().cloned().collect()
        };
        let stranger = Keys::generate();
        let keys = if case.ends_with("owner") || case.ends_with("signer") {
            &stranger
        } else if kind == 30177 {
            test.fixture.client.keys()
        } else {
            &test.fixture.relay.keys
        };
        let head = EventBuilder::new(old.kind, old.content)
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap();
        test.select_head(kind, &head);
        test.override_head(kind, vec![head]);
        let error = test.verify().await.unwrap_err().to_string();
        assert!(
            error.contains("signature or scope mismatch"),
            "{case}: {error}"
        );
    }
}

#[tokio::test]
async fn invalid_current_signatures_are_not_saved_by_matching_pinned_ids() {
    for kind in [0, 30177, 39002] {
        let test = HeadFixture::new().await;
        let mut head = test.head(kind).await;
        head.content.push('!');
        test.override_head(kind, vec![head]);
        assert!(test
            .verify()
            .await
            .unwrap_err()
            .to_string()
            .contains("signature or scope mismatch"));
    }
}

#[tokio::test]
async fn signed_current_directory_must_enforce_the_exact_selected_finite_policy() {
    let test = HeadFixture::new().await;
    let old = test.head(30177).await;
    let mut content: Value = serde_json::from_str(&old.content).unwrap();
    content["respond_to_allowlist"] = json!([Keys::generate().public_key().to_hex()]);
    let head = EventBuilder::new(old.kind, content.to_string())
        .tags(old.tags.iter().cloned())
        .sign_with_keys(test.fixture.client.keys())
        .unwrap();
    test.select_head(30177, &head);
    test.override_head(30177, vec![head]);
    assert!(test
        .verify()
        .await
        .unwrap_err()
        .to_string()
        .contains("directory policy differs"));
}

#[tokio::test]
async fn independent_scope_and_authenticated_relay_must_match_before_reads() {
    let test = HeadFixture::new().await;
    let original = fs::read(&test.expected).unwrap();
    for (field, replacement) in [
        ("owner", Keys::generate().public_key().to_hex()),
        ("channel", uuid::Uuid::new_v4().to_string()),
        ("relay", "https://other.example.com".into()),
    ] {
        let mut expected: Value = serde_json::from_slice(&original).unwrap();
        expected[field] = json!(replacement);
        fs::write(&test.expected, serde_json::to_vec(&expected).unwrap()).unwrap();
        assert!(test
            .verify()
            .await
            .unwrap_err()
            .to_string()
            .contains("independent expected scope"));
    }
    fs::write(&test.expected, original).unwrap();
    // The alias serves the same fixture data: dropping the relay scope guard
    // would accept it, instead of failing only because a server is unavailable.
    let alias = BuzzClient::new(
        test.reader.relay_url().replace("127.0.0.1", "localhost"),
        test.reader.keys().clone(),
        None,
        None,
    )
    .unwrap();
    let error = crate::commands::agent_config_heads::verify_files(
        &alias,
        &test.fixture.file,
        &test.handoff,
        &test.expected,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("independently expected community"));
    assert!(test.fixture.relay.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn oversized_metadata_events_and_errors_refuse_through_real_head_dispatch() {
    let fixture = HeadFixture::new().await;
    let before = fixture.fixture.relay.posts.load(Ordering::SeqCst);
    for path in ["/", "/query"] {
        for status in [200, 403] {
            for chunked in [false, true] {
                *fixture.fixture.relay.raw_read.lock().unwrap() = Some(RawRead {
                    path,
                    status,
                    chunked,
                });
                let error = fixture.verify().await.unwrap_err();
                assert!(
                    error.to_string().contains("exceeds 1048576 byte limit"),
                    "{path} {status} {chunked}: {error}"
                );
            }
        }
    }
    assert_eq!(fixture.fixture.relay.posts.load(Ordering::SeqCst), before);
}
