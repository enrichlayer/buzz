use super::*;
use nostr::{EventBuilder, Keys, Tag, Timestamp};
use std::fs;

struct Fixture {
    root: tempfile::TempDir,
    file: std::path::PathBuf,
    handoff: std::path::PathBuf,
    expected: std::path::PathBuf,
    owner: Keys,
    agent: String,
}

impl Fixture {
    fn new(adopt: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let owner = Keys::generate();
        let agent = Keys::generate().public_key().to_hex();
        fs::write(
            root.path().join("rig.yaml"),
            b"name: existing-rig\npods: []\n",
        )
        .unwrap();
        fs::write(root.path().join("manager.yaml"), b"name: manager\n").unwrap();
        let reference = |name: &str| json!({"path":name, "sha256":hex::encode(Sha256::digest(fs::read(root.path().join(name)).unwrap()))});
        let file = root.path().join("agents.json");
        fs::write(&file, serde_json::to_vec_pretty(&json!({"version":1,
            "relay":"https://example.invalid", "owner":owner.public_key().to_hex(),
            "channel":"12345678-1234-4234-8234-123456789abc",
            "runtime":{"cohort":"openrig", "rig_id":"existing-rig",
                "rig_spec":reference("rig.yaml"), "agent_specs":[reference("manager.yaml")]},
            "agents":[{"key":"manager", "seat":"engineering.manager", "runtime_id":"existing-runtime",
                "display_name":"Manager 🐝 \"quoted\"", "adoption":if adopt {json!({"expected_pubkey":agent})} else {Value::Null},
                "invocation":{"respond_to":"allowlist", "allowlist":[Keys::generate().public_key().to_hex(), Keys::generate().public_key().to_hex()]}}]})).unwrap()).unwrap();
        let fixture = Self {
            handoff: root.path().join("handoff.json"),
            expected: root.path().join("expected.json"),
            root,
            file,
            owner,
            agent,
        };
        let manifest = manifest::load(&fixture.file).unwrap();
        let agent = &manifest.agents[0];
        let body = json!({"version":1, "operation":"openrig-runtime-handoff", "manifest_sha256":digest(&manifest).unwrap(),
            "relay":manifest.relay,"owner":manifest.owner,"channel":manifest.channel,"runtime":manifest.runtime,
            "membership_event":"01".repeat(32), "agents":[{"key":agent.key, "seat":agent.seat,
                "runtime_id":agent.runtime_id, "pubkey":fixture.agent, "display_name":agent.display_name,
                "invocation":agent.invocation,"policy_sha256":digest(&agent.invocation).unwrap(),
                "directory_event":"02".repeat(32),"profile_event":"03".repeat(32),
                "enrollment_events":{"profile":"04".repeat(32),"directory":"05".repeat(32),"membership":"06".repeat(32)}}],
            "verification":pending()});
        fixture.sign(
            body,
            Kind::TextNote,
            vec![Tag::parse(["t", HANDOFF_TAG]).unwrap()],
            &fixture.owner,
        );
        let envelope = fixture.envelope();
        fixture.write_expected(json!({"version":1,"relay":manifest.relay,"owner":manifest.owner,
            "channel":manifest.channel,"cohort":"openrig","rig_id":"existing-rig",
            "handoff_sha256":hex::encode(Sha256::digest(envelope.authorization.content.as_bytes())),
            "authorization_event_id":envelope.authorization.id,
            "agents":[{"key":"manager","seat":"engineering.manager","runtime_id":"existing-runtime","pubkey":fixture.agent}]}));
        fixture
    }
    fn envelope(&self) -> SignedHandoff {
        serde_json::from_slice(&fs::read(&self.handoff).unwrap()).unwrap()
    }
    fn expected_value(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.expected).unwrap()).unwrap()
    }
    fn write_expected(&self, value: Value) {
        fs::write(&self.expected, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
    fn sign(&self, body: Value, kind: Kind, tags: Vec<Tag>, keys: &Keys) {
        let authorization = EventBuilder::new(kind, body.to_string())
            .tags(tags)
            .custom_created_at(Timestamp::from(100))
            .sign_with_keys(keys)
            .unwrap();
        fs::write(
            &self.handoff,
            serde_json::to_vec_pretty(&SignedHandoff {
                handoff: body,
                authorization,
            })
            .unwrap(),
        )
        .unwrap();
    }
    fn edit_signed(&self, edit: impl FnOnce(&mut Value)) {
        let mut body = self.envelope().handoff;
        edit(&mut body);
        self.sign(
            body,
            Kind::TextNote,
            vec![Tag::parse(["t", HANDOFF_TAG]).unwrap()],
            &self.owner,
        );
        self.pin_generation();
    }
    fn pin_generation(&self) {
        let envelope = self.envelope();
        let mut expected = self.expected_value();
        expected["handoff_sha256"] = json!(hex::encode(Sha256::digest(
            envelope.authorization.content.as_bytes()
        )));
        expected["authorization_event_id"] = json!(envelope.authorization.id);
        self.write_expected(expected);
    }
    fn verify(&self) -> Result<Value, CliError> {
        verify_files(&self.file, &self.handoff, &self.expected)
    }
    async fn dispatch(&self) -> i32 {
        // Deliberately invalid relay credentials: the local command must return
        // before key parsing, HTTP client construction or any relay operation.
        crate::run_from_args([
            "buzz",
            "--relay",
            "not-a-relay",
            "--private-key",
            "not-a-key",
            "--auth-tag",
            "not-a-tag",
            "agents",
            "config",
            "verify-handoff",
            "--file",
            self.file.to_str().unwrap(),
            "--handoff",
            self.handoff.to_str().unwrap(),
            "--expected",
            self.expected.to_str().unwrap(),
        ])
        .await
    }
}

#[tokio::test]
async fn offline_dispatch_verifies_selected_manager_and_leaves_native_proofs_pending() {
    for adopt in [false, true] {
        let fixture = Fixture::new(adopt);
        let before: Vec<_> = fs::read_dir(fixture.root.path())
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                (path.clone(), fs::read(path).unwrap())
            })
            .collect();
        let result = fixture.verify().unwrap();
        assert_eq!(result["signed_configuration_verified"], true);
        assert_eq!(result["agents"].as_array().unwrap().len(), 1);
        assert_eq!(result["agents"][0]["pubkey"], fixture.agent);
        assert_eq!(result["verification"]["current_heads"], "not_verified");
        assert_eq!(
            result["verification"]["native_custody"],
            "pending_protected_operator"
        );
        assert_eq!(
            result["verification"]["canonical_spec_validation"],
            "pending_protected_operator"
        );
        assert_eq!(
            result["verification"]["generation_freshness"],
            "not_verified"
        );
        assert_eq!(fixture.dispatch().await, 0);
        assert_eq!(
            fs::read_dir(fixture.root.path()).unwrap().count(),
            before.len()
        );
        for (path, bytes) in before {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
}

#[test]
fn normalized_typed_manifest_and_exact_signed_content_hashes_match() {
    let fixture = Fixture::new(false);
    let before = fixture.verify().unwrap();
    let document: Value = serde_json::from_slice(&fs::read(&fixture.file).unwrap()).unwrap();
    fs::write(&fixture.file, document.to_string()).unwrap();
    assert_eq!(fixture.verify().unwrap(), before);
    let manifest = manifest::load(&fixture.file).unwrap();
    assert_eq!(before["manifest_sha256"], digest(&manifest).unwrap());
    let invocation_bytes = serde_json::to_string(&manifest.agents[0].invocation).unwrap();
    assert!(invocation_bytes.starts_with("{\"respond_to\":\"allowlist\",\"allowlist\":["));
    assert_eq!(
        before["agents"][0]["policy_sha256"],
        hex::encode(Sha256::digest(invocation_bytes.as_bytes()))
    );
    // Signed content may have different insignificant whitespace from the
    // envelope body; its raw bytes, not host reserialization, identify it.
    let mut envelope = fixture.envelope();
    envelope.authorization = EventBuilder::new(
        Kind::TextNote,
        serde_json::to_string_pretty(&envelope.handoff).unwrap(),
    )
    .tag(Tag::parse(["t", HANDOFF_TAG]).unwrap())
    .sign_with_keys(&fixture.owner)
    .unwrap();
    fs::write(&fixture.handoff, serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert!(fixture.verify().is_err());
    fixture.pin_generation();
    let result = fixture.verify().unwrap();
    assert_eq!(
        result["handoff_sha256"],
        hex::encode(Sha256::digest(envelope.authorization.content.as_bytes()))
    );
    assert_ne!(
        result["handoff_sha256"],
        hex::encode(Sha256::digest(envelope.handoff.to_string().as_bytes()))
    );
    let mut changed = document;
    changed["agents"][0]["invocation"]["allowlist"]
        .as_array_mut()
        .unwrap()
        .reverse();
    fs::write(&fixture.file, changed.to_string()).unwrap();
    assert!(fixture.verify().is_err());
}

#[test]
fn independent_scope_and_generation_pins_are_all_required() {
    let fixture = Fixture::new(false);
    let original = fixture.expected_value();
    for (field, bad) in [
        ("version", json!(2)),
        ("relay", json!("https://other.invalid")),
        ("owner", json!(Keys::generate().public_key().to_hex())),
        ("channel", json!(uuid::Uuid::new_v4().to_string())),
        ("cohort", json!("other")),
        ("rig_id", json!("other-rig")),
        ("handoff_sha256", json!("00".repeat(32))),
        ("authorization_event_id", json!("00".repeat(32))),
    ] {
        let mut value = original.clone();
        value[field] = bad;
        fixture.write_expected(value);
        assert!(fixture.verify().is_err(), "accepted wrong {field}");
    }
    for field in [
        "version",
        "relay",
        "owner",
        "channel",
        "cohort",
        "rig_id",
        "handoff_sha256",
        "authorization_event_id",
        "agents",
    ] {
        let mut value = original.clone();
        value.as_object_mut().unwrap().remove(field);
        fixture.write_expected(value);
        assert!(fixture.verify().is_err(), "accepted missing {field}");
    }
    for field in ["key", "seat", "runtime_id", "pubkey"] {
        let mut value = original.clone();
        value["agents"][0][field] = json!("wrong");
        fixture.write_expected(value);
        assert!(fixture.verify().is_err(), "accepted wrong expected {field}");
    }
    let mut value = original.clone();
    value["agents"] = json!([]);
    fixture.write_expected(value);
    assert!(fixture.verify().is_err());
    let mut value = original.clone();
    value["agents"]
        .as_array_mut()
        .unwrap()
        .push(original["agents"][0].clone());
    fixture.write_expected(value);
    assert!(fixture.verify().is_err());
    let mut value = original.clone();
    value["credential"] = json!("unsupported");
    fixture.write_expected(value);
    assert!(fixture.verify().is_err());
    fixture.write_expected(original);
    assert!(fixture.verify().is_ok());
}

#[test]
fn signature_id_domain_kind_and_content_equality_are_checked() {
    for mutation in [
        "id",
        "sig",
        "content",
        "envelope",
        "kind",
        "tag",
        "extra-tag",
        "signer",
    ] {
        let fixture = Fixture::new(false);
        let envelope = fixture.envelope();
        if ["kind", "tag", "extra-tag", "signer"].contains(&mutation) {
            let tags = match mutation {
                "tag" => vec![Tag::parse(["t", "wrong-domain"]).unwrap()],
                "extra-tag" => vec![
                    Tag::parse(["t", HANDOFF_TAG]).unwrap(),
                    Tag::parse(["t", "extra"]).unwrap(),
                ],
                _ => vec![Tag::parse(["t", HANDOFF_TAG]).unwrap()],
            };
            let keys = if mutation == "signer" {
                Keys::generate()
            } else {
                fixture.owner.clone()
            };
            fixture.sign(
                envelope.handoff,
                if mutation == "kind" {
                    Kind::Custom(2)
                } else {
                    Kind::TextNote
                },
                tags,
                &keys,
            );
        } else {
            let mut value = serde_json::to_value(envelope).unwrap();
            match mutation {
                "id" => value["authorization"]["id"] = json!("00".repeat(32)),
                "sig" => value["authorization"]["sig"] = json!("00".repeat(64)),
                "content" => value["authorization"]["content"] = json!("{}"),
                "envelope" => {
                    value["handoff"]["owner"] = json!(Keys::generate().public_key().to_hex())
                }
                _ => unreachable!(),
            }
            fs::write(&fixture.handoff, value.to_string()).unwrap();
        }
        fixture.pin_generation();
        assert!(fixture.verify().is_err(), "accepted {mutation}");
    }
}

#[test]
fn signed_receipts_cannot_change_manifest_policy_or_identity_contract() {
    for mutation in [
        "key",
        "seat",
        "runtime_id",
        "pubkey",
        "display_name",
        "invocation",
        "policy_sha256",
        "directory_event",
        "profile_event",
        "enrollment_events",
        "unknown",
        "duplicate",
        "missing",
        "verification",
        "membership",
    ] {
        let fixture = Fixture::new(true);
        fixture.edit_signed(|body| match mutation {
            "invocation" => body["agents"][0]["invocation"]["allowlist"] = json!([]),
            "enrollment_events" => {
                body["agents"][0]["enrollment_events"]["profile"] = json!("bad-id")
            }
            "unknown" => body["agents"][0]["unknown"] = json!(true),
            "duplicate" => {
                let agent = body["agents"][0].clone();
                body["agents"].as_array_mut().unwrap().push(agent);
            }
            "missing" => body["agents"] = json!([]),
            "verification" => body["verification"]["protected_runtime"] = json!("ready"),
            "membership" => body["membership_event"] = json!("bad-id"),
            "pubkey" => body["agents"][0]["pubkey"] = json!(Keys::generate().public_key().to_hex()),
            field => body["agents"][0][field] = json!("different"),
        });
        assert!(fixture.verify().is_err(), "accepted signed {mutation}");
    }
}

#[tokio::test]
async fn bounded_strict_inputs_and_spec_bytes_fail_through_dispatch() {
    let fixture = Fixture::new(false);
    let original = fs::read(&fixture.handoff).unwrap();
    let mut envelope: Value = serde_json::from_slice(&original).unwrap();
    envelope["unknown"] = json!(true);
    fs::write(&fixture.handoff, envelope.to_string()).unwrap();
    assert_eq!(fixture.dispatch().await, 1);
    fs::write(&fixture.handoff, vec![b' '; MAX_HANDOFF_BYTES as usize + 1]).unwrap();
    assert_eq!(fixture.dispatch().await, 1);
    fs::write(&fixture.handoff, original).unwrap();
    fs::write(
        &fixture.expected,
        vec![b' '; MAX_EXPECTED_BYTES as usize + 1],
    )
    .unwrap();
    assert_eq!(fixture.dispatch().await, 1);
    let fixture = Fixture::new(false);
    fs::write(fixture.root.path().join("manager.yaml"), b"changed\n").unwrap();
    assert_eq!(fixture.dispatch().await, 1);
}

#[test]
fn selected_communicators_must_be_unique_in_both_signed_and_expected_sets() {
    let fixture = Fixture::new(false);
    let reporter = Keys::generate().public_key().to_hex();
    let mut document: Value = serde_json::from_slice(&fs::read(&fixture.file).unwrap()).unwrap();
    let mut second = document["agents"][0].clone();
    second["key"] = json!("reporter");
    second["seat"] = json!("engineering.reporter");
    second["runtime_id"] = json!("reporter-runtime");
    document["agents"].as_array_mut().unwrap().push(second);
    fs::write(&fixture.file, document.to_string()).unwrap();
    let manifest = manifest::load(&fixture.file).unwrap();
    fixture.edit_signed(|body| {
        body["manifest_sha256"] = json!(digest(&manifest).unwrap());
        let mut second = body["agents"][0].clone();
        second["key"] = json!("reporter");
        second["seat"] = json!("engineering.reporter");
        second["runtime_id"] = json!("reporter-runtime");
        second["pubkey"] = json!(reporter);
        body["agents"].as_array_mut().unwrap().push(second);
    });
    let mut expected = fixture.expected_value();
    expected["agents"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"reporter",
        "seat":"engineering.reporter", "runtime_id":"reporter-runtime", "pubkey":reporter}));
    fixture.write_expected(expected.clone());
    assert!(fixture.verify().is_ok());
    let original = fixture.envelope().handoff;
    fixture.edit_signed(|body| body["agents"][1] = body["agents"][0].clone());
    // Bind the uniqueness guard in the same shared verifier the producer uses,
    // independent of the consumer's later expected-agent completeness check.
    assert!(verify_handoff(&fixture.envelope(), &manifest).is_err());
    fixture.edit_signed(|body| *body = original.clone());
    let mut duplicate = fixture.expected_value();
    duplicate["agents"][1] = duplicate["agents"][0].clone();
    fixture.write_expected(duplicate);
    assert!(fixture.verify().is_err());
    fixture.write_expected(expected);
    fixture.pin_generation();
    fixture.edit_signed(|body| body["agents"][1]["pubkey"] = body["agents"][0]["pubkey"].clone());
    assert!(verify_handoff(&fixture.envelope(), &manifest).is_err());
}

#[test]
fn unknown_nested_fields_and_signed_top_level_changes_are_rejected() {
    for field in [
        "operation",
        "version",
        "manifest_sha256",
        "relay",
        "owner",
        "channel",
        "runtime",
        "unsupported",
    ] {
        let fixture = Fixture::new(false);
        fixture.edit_signed(|body| {
            body[field] = match field {
                "version" => json!(2),
                "runtime" => {
                    let mut runtime = body["runtime"].clone();
                    runtime["extra"] = json!(true);
                    runtime
                }
                _ => json!("wrong"),
            }
        });
        assert!(fixture.verify().is_err(), "accepted signed {field}");
    }
    let fixture = Fixture::new(false);
    let mut expected = fixture.expected_value();
    expected["agents"][0]["credential"] = json!("unsupported");
    fixture.write_expected(expected);
    assert!(fixture.verify().is_err());
    let fixture = Fixture::new(false);
    let mut envelope: Value = serde_json::from_slice(&fs::read(&fixture.handoff).unwrap()).unwrap();
    envelope["authorization"]["unsupported"] = json!(true);
    fs::write(&fixture.handoff, envelope.to_string()).unwrap();
    assert!(fixture.verify().is_err());
}
