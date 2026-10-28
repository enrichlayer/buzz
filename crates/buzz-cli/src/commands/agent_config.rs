//! Declarative enrollment and public runtime handoff. This command never starts
//! a process, imports a purported host receipt, or equates enrollment with life.

use super::{
    agent_config_handoff::{self as handoff, pending, verify_handoff, SignedHandoff, HANDOFF_TAG},
    agent_config_manifest as manifest, agent_config_state as state, agent_enrollment as enrollment,
};
use crate::{client::BuzzClient, error::CliError, AgentsConfigCmd};
use manifest::{digest, usage, Agent, Manifest};
use nostr::{Event, EventBuilder, Kind, PublicKey, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Snapshot {
    key: String,
    binding_recorded: bool,
    pubkey: Option<String>,
    credential_present: bool,
    profile_event: Option<String>,
    directory_event: Option<String>,
    member: bool,
    policy_matches: bool,
}

#[derive(Serialize)]
struct Plan {
    version: u32,
    manifest_sha256: String,
    membership_event: String,
    agents: Vec<Snapshot>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PolicyIntent {
    version: u32,
    manifest_sha256: String,
    key: String,
    pubkey: String,
    base_event: String,
    event: Event,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PolicyProgress {
    intent: PolicyIntent,
    completed: bool,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct EnrollmentMarker {
    version: u32,
    pubkey: String,
    profile: String,
    directory: String,
    membership: String,
}

fn enrollment_marker(journal: &enrollment::Journal) -> EnrollmentMarker {
    EnrollmentMarker {
        version: 1,
        pubkey: journal.profile.pubkey.to_hex(),
        profile: journal.profile.id.to_hex(),
        directory: journal.directory.id.to_hex(),
        membership: journal.membership.id.to_hex(),
    }
}

fn binding(manifest: &Manifest, agent: &Agent) -> enrollment::Binding {
    enrollment::Binding {
        relay: manifest.relay.clone(),
        owner: manifest.owner.clone(),
        channel: manifest.channel.clone(),
        runtime_id: agent.runtime_id.clone(),
        cohort: manifest.runtime.cohort.clone(),
        display_name: agent.display_name.clone(),
    }
}

fn require_scope(client: &BuzzClient, manifest: &Manifest) -> Result<(), CliError> {
    if client.auth_tag_owner_hex().is_some() {
        return Err(CliError::Auth(
            "configuration requires the owner identity, not an agent delegation".into(),
        ));
    }
    if client.relay_url() != manifest.relay || client.keys().public_key().to_hex() != manifest.owner
    {
        return Err(CliError::Auth(
            "configuration relay/owner differs from the authenticated CLI scope".into(),
        ));
    }
    Ok(())
}

/// Read at most one signed head at an exact author/kind/address coordinate.
pub(super) async fn query_one(
    client: &BuzzClient,
    filter: Value,
    author: &PublicKey,
    kind: u16,
    d: Option<&str>,
) -> Result<Option<Event>, CliError> {
    let body = client.query_bounded(&filter, 1024 * 1024).await?;
    if body.len() > 1024 * 1024 {
        return Err(usage("configuration readback exceeds size limit"));
    }
    let mut events: Vec<Event> =
        serde_json::from_str(&body).map_err(|_| usage("invalid configuration event readback"))?;
    if events.len() > 1 {
        return Err(usage("ambiguous configuration event head"));
    }
    let Some(event) = events.pop() else {
        return Ok(None);
    };
    if &event.pubkey != author
        || event.kind.as_u16() != kind
        || buzz_core::verify_event(&event).is_err()
        || d.is_some_and(|expected| {
            let tags: Vec<_> = event
                .tags
                .iter()
                .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("d"))
                .collect();
            tags.len() != 1 || tags[0].as_slice().get(1).map(String::as_str) != Some(expected)
        })
    {
        return Err(usage("configuration readback signature or scope mismatch"));
    }
    Ok(Some(event))
}

/// Resolve the scoped relay signer and require its signed owner membership.
pub(super) async fn membership(
    client: &BuzzClient,
    manifest: &Manifest,
) -> Result<Event, CliError> {
    let info: Value = serde_json::from_str(&client.get_public_bounded("/", 1024 * 1024).await?)
        .map_err(|_| usage("invalid relay identity readback"))?;
    let relay = info
        .get("self")
        .and_then(Value::as_str)
        .and_then(|key| PublicKey::parse(key).ok())
        .ok_or_else(|| usage("relay info missing self key"))?;
    let event = query_one(
        client,
        json!({"kinds":[39002], "authors":[relay.to_hex()],
        "#d":[manifest.channel], "limit":1, "consistency":"strong"}),
        &relay,
        39002,
        Some(&manifest.channel),
    )
    .await?
    .ok_or_else(|| CliError::Auth("channel membership not confirmed".into()))?;
    if !enrollment::valid_membership(&event, &relay, &manifest.channel, &manifest.owner) {
        return Err(CliError::Auth(
            "owner channel membership not confirmed".into(),
        ));
    }
    Ok(event)
}

/// Read the explicitly expected owner's directory, independent of reader identity.
pub(super) async fn directory(
    client: &BuzzClient,
    owner: &PublicKey,
    pubkey: &str,
) -> Result<Option<Event>, CliError> {
    query_one(
        client,
        json!({"kinds":[30177], "authors":[owner.to_hex()],
        "#d":[pubkey], "limit":1, "consistency":"strong"}),
        owner,
        30177,
        Some(pubkey),
    )
    .await
}

/// Compare public directory policy to the normalized selected configuration.
pub(super) fn policy_matches(event: &Event, agent: &Agent) -> bool {
    let Ok(content) = serde_json::from_str::<Value>(&event.content) else {
        return false;
    };
    content.get("name").and_then(Value::as_str) == Some(agent.display_name.as_str())
        && content
            .get("parallelism")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0)
        && content.get("respond_to") == Some(&json!(agent.invocation.respond_to))
        && content
            .get("respond_to_allowlist")
            .cloned()
            .unwrap_or_else(|| json!([]))
            == json!(agent.invocation.allowlist)
}

fn local_identity(
    manifest: &Manifest,
    agent: &Agent,
    state_dir: &Path,
) -> Result<(bool, Option<enrollment::Journal>, bool), CliError> {
    let stable = state::StableBinding::new(manifest, agent);
    let recorded_key = stable.check(state_dir)?;
    let recorded = recorded_key.is_some();
    let path = enrollment::journal_path(state_dir, &binding(manifest, agent));
    let exists = match std::fs::symlink_metadata(&path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(usage("cannot inspect enrollment identity")),
    };
    if !exists {
        if recorded || agent.adoption.is_some() {
            return Err(CliError::Conflict(
                "existing agent journal is missing; refusing identity replacement".into(),
            ));
        }
        return Ok((false, None, false));
    }
    let journal = enrollment::read_journal(&path, &binding(manifest, agent))?;
    if journal.binding.display_name != agent.display_name {
        return Err(CliError::Conflict(
            "display name differs from the durable enrollment; names do not select identities"
                .into(),
        ));
    }
    let pubkey = journal.profile.pubkey.to_hex();
    let intent_path = state_dir.join(format!("config-{}.intent.json", digest(manifest)?));
    let own_pending_intent =
        state::read_private::<Manifest>(&intent_path)?.as_ref() == Some(manifest);
    if agent
        .adoption
        .as_ref()
        .is_some_and(|adoption| adoption.expected_pubkey != pubkey)
        || recorded_key
            .as_ref()
            .is_some_and(|expected| expected != &pubkey)
        || (!recorded && agent.adoption.is_none() && !own_pending_intent)
    {
        return Err(CliError::Conflict(
            "adoption requires the exact pubkey from the verified private enrollment journal"
                .into(),
        ));
    }
    let credential =
        state::read_private::<Value>(&path.with_extension("credential.json"))?.is_some();
    if let Some(marker) = state::read_private::<EnrollmentMarker>(
        &state_dir.join(format!("config-enrolled-{}.json", agent.key)),
    )? {
        if marker != enrollment_marker(&journal) || !credential {
            return Err(CliError::Conflict("completed enrollment credential is missing or identity differs; refusing reprovisioning".into()));
        }
    }
    Ok((recorded, Some(journal), credential))
}

async fn make_plan(
    client: &BuzzClient,
    manifest: &Manifest,
    state_dir: &Path,
) -> Result<Plan, CliError> {
    require_scope(client, manifest)?;
    state::directory_exists(state_dir)?;
    let members = membership(client, manifest).await?;
    let mut snapshots = Vec::new();
    for agent in &manifest.agents {
        let (recorded, journal, credential) = local_identity(manifest, agent, state_dir)?;
        let mut snapshot = Snapshot {
            key: agent.key.clone(),
            binding_recorded: recorded,
            pubkey: None,
            credential_present: credential,
            profile_event: None,
            directory_event: None,
            member: false,
            policy_matches: false,
        };
        if let Some(journal) = journal {
            let public = journal.profile.pubkey;
            let pubkey = public.to_hex();
            let profile = query_one(
                client,
                json!({"kinds":[0], "authors":[pubkey],
                "limit":1, "consistency":"strong"}),
                &public,
                0,
                None,
            )
            .await?;
            let policy = directory(client, &client.keys().public_key(), &pubkey).await?;
            snapshot.pubkey = Some(pubkey.clone());
            snapshot.profile_event = profile.map(|event| event.id.to_hex());
            snapshot.directory_event = policy.as_ref().map(|event| event.id.to_hex());
            snapshot.policy_matches = policy
                .as_ref()
                .is_some_and(|event| policy_matches(event, agent));
            snapshot.member = members.tags.iter().any(|tag| {
                tag.as_slice().first().map(String::as_str) == Some("p")
                    && tag.as_slice().get(1).map(String::as_str) == Some(pubkey.as_str())
            });
        }
        snapshots.push(snapshot);
    }
    Ok(Plan {
        version: 1,
        manifest_sha256: digest(manifest)?,
        membership_event: members.id.to_hex(),
        agents: snapshots,
    })
}

pub(crate) fn validate_file(file: &Path) -> Result<Value, CliError> {
    let manifest = manifest::load(file)?;
    Ok(
        json!({"valid":true, "manifest_sha256":digest(&manifest)?, "agents":manifest.agents.len(),
        "spec_bytes_verified":true, "runtime":pending()}),
    )
}

fn public_plan(plan: &Plan) -> Result<Value, CliError> {
    Ok(json!({"plan_sha256":digest(plan)?, "plan":plan, "runtime":pending()}))
}

fn verify_policy_intent(
    client: &BuzzClient,
    intent: &PolicyIntent,
    agent: &Agent,
    pubkey: &str,
) -> Result<(), CliError> {
    if intent.version != 1
        || intent.key != agent.key
        || intent.pubkey != pubkey
        || intent.event.pubkey != client.keys().public_key()
        || intent.event.kind.as_u16() != 30177
        || buzz_core::verify_event(&intent.event).is_err()
        || serde_json::to_value(&intent.event.tags).map_err(|_| usage("invalid policy tags"))?
            != json!([["d", pubkey]])
    {
        return Err(usage("policy journal signature, intent or scope mismatch"));
    }
    Ok(())
}

fn completion_path(state_dir: &Path, intent: &PolicyIntent) -> std::path::PathBuf {
    state_dir.join(format!(
        "config-policy-{}-{}.completed.json",
        intent.key, intent.event.id
    ))
}

fn complete_policy(state_dir: &Path, active: &Path, intent: &PolicyIntent) -> Result<(), CliError> {
    // Keep exact readback history before advancing the mutable progress pointer.
    state::save_new(&completion_path(state_dir, intent), &intent.event)?;
    state::replace_private(
        active,
        &PolicyProgress {
            intent: intent.clone(),
            completed: true,
        },
    )
}

async fn publish_policy(
    client: &BuzzClient,
    state_dir: &Path,
    active: &Path,
    current: &Event,
    intent: &PolicyIntent,
) -> Result<Event, CliError> {
    // NIP-33 has no conditional write; check immediately before publication and
    // require exact signed head readback afterward. Concurrent writers still
    // require the existing single-publisher discipline.
    if directory(client, &client.keys().public_key(), &intent.pubkey)
        .await?
        .as_ref()
        .map(|event| event.id)
        != Some(current.id)
    {
        return Err(CliError::Conflict(
            "directory changed before policy publication".into(),
        ));
    }
    enrollment::publish_exact(client, &intent.event).await?;
    if directory(client, &client.keys().public_key(), &intent.pubkey)
        .await?
        .as_ref()
        != Some(&intent.event)
    {
        return Err(CliError::Conflict(
            "policy ACK is not current-head readback; journal retained".into(),
        ));
    }
    complete_policy(state_dir, active, intent)?;
    Ok(intent.event.clone())
}

async fn reconcile_policy(
    client: &BuzzClient,
    manifest: &Manifest,
    agent: &Agent,
    pubkey: &str,
    state_dir: &Path,
) -> Result<Event, CliError> {
    let current = directory(client, &client.keys().public_key(), pubkey)
        .await?
        .ok_or_else(|| {
            CliError::Conflict(
                "managed directory is absent; refusing to resurrect a removed agent".into(),
            )
        })?;
    let hash = digest(manifest)?;
    let active = state_dir.join(format!("config-policy-{}.active.json", agent.key));
    if let Some(progress) = state::read_private::<PolicyProgress>(&active)? {
        verify_policy_intent(client, &progress.intent, agent, pubkey)?;
        let completion =
            state::read_private::<Event>(&completion_path(state_dir, &progress.intent))?;
        if let Some(ref event) = completion {
            if event != &progress.intent.event {
                return Err(usage("policy completion differs from its signed intent"));
            }
        }
        if progress.completed {
            if completion.is_none() {
                return Err(usage("completed policy is missing its durable readback"));
            }
        } else if completion.is_some() || current == progress.intent.event {
            // Crash after readback/completion persistence: finish the local
            // pointer before considering a newly approved desired generation.
            complete_policy(state_dir, &active, &progress.intent)?;
        } else {
            if current.id.to_hex() != progress.intent.base_event {
                return Err(CliError::Conflict("directory changed during pending reconciliation; retain the journal for owner inspection".into()));
            }
            if progress.intent.manifest_sha256 != hash
                || !policy_matches(&progress.intent.event, agent)
            {
                return Err(CliError::Conflict(
                    "another desired policy is pending; reconcile its original configuration first"
                        .into(),
                ));
            }
            return publish_policy(client, state_dir, &active, &current, &progress.intent).await;
        }
    }
    if policy_matches(&current, agent) {
        return Ok(current);
    }
    // Desired state is not an operation ID. A completed A -> B -> A transition
    // gets another immutable intent bound to the freshly approved current head.
    let path = state_dir.join(format!(
        "config-policy-{}-{}-{}.intent.json",
        agent.key, hash, current.id
    ));
    let intent = match state::read_private::<PolicyIntent>(&path)? {
        Some(intent) => intent,
        None => {
            let mut content: Value = serde_json::from_str(&current.content)
                .map_err(|_| usage("invalid existing directory policy"))?;
            let object = content
                .as_object_mut()
                .ok_or_else(|| usage("invalid existing directory policy"))?;
            // Explicit public projection from Desktop's ManagedAgentEventContent.
            const PUBLIC_FIELDS: &[&str] = &[
                "name",
                "persona_id",
                "system_prompt",
                "model",
                "provider",
                "persona_source_version",
                "parallelism",
                "respond_to",
                "respond_to_allowlist",
            ];
            if object
                .keys()
                .any(|key| !PUBLIC_FIELDS.contains(&key.as_str()))
                || object.get("name").and_then(Value::as_str) != Some(agent.display_name.as_str())
                || object
                    .get("parallelism")
                    .and_then(Value::as_u64)
                    .is_none_or(|count| count == 0)
            {
                return Err(CliError::Conflict(
                    "existing directory projection cannot be safely reconciled".into(),
                ));
            }
            object.insert("respond_to".into(), json!(agent.invocation.respond_to));
            object.insert(
                "respond_to_allowlist".into(),
                json!(agent.invocation.allowlist),
            );
            let now = Timestamp::now().as_secs();
            if current.created_at.as_secs() > now + 60 {
                return Err(CliError::Conflict(
                    "directory head is ahead of this clock; policy not published".into(),
                ));
            }
            let event = client.sign_event(
                EventBuilder::new(Kind::Custom(30177), content.to_string())
                    .tag(
                        Tag::parse(["d", pubkey])
                            .map_err(|_| usage("invalid policy coordinate"))?,
                    )
                    .custom_created_at(Timestamp::from(now.max(current.created_at.as_secs() + 1))),
            )?;
            let intent = PolicyIntent {
                version: 1,
                manifest_sha256: hash.clone(),
                key: agent.key.clone(),
                pubkey: pubkey.into(),
                base_event: current.id.to_hex(),
                event,
            };
            state::save_new(&path, &intent)?;
            intent
        }
    };
    verify_policy_intent(client, &intent, agent, pubkey)?;
    if intent.manifest_sha256 != hash
        || intent.base_event != current.id.to_hex()
        || !policy_matches(&intent.event, agent)
    {
        return Err(usage(
            "policy generation differs from approved configuration/head",
        ));
    }
    state::replace_private(
        &active,
        &PolicyProgress {
            intent: intent.clone(),
            completed: false,
        },
    )?;
    publish_policy(client, state_dir, &active, &current, &intent).await
}

async fn apply(
    client: &BuzzClient,
    file: &Path,
    state_dir: &Path,
    expected_plan: &str,
) -> Result<Value, CliError> {
    let manifest = manifest::load(file)?;
    require_scope(client, &manifest)?;
    let _lock = state::lock(state_dir)?;
    let plan = make_plan(client, &manifest, state_dir).await?;
    if digest(&plan)? != expected_plan {
        return Err(CliError::Conflict(
            "plan is stale; run config plan again before applying".into(),
        ));
    }
    let hash = digest(&manifest)?;
    state::save_new(
        &state_dir.join(format!("config-{}.intent.json", hash)),
        &manifest,
    )?;
    let mut receipts = Vec::new();
    for (agent, snapshot) in manifest.agents.iter().zip(&plan.agents) {
        if snapshot.credential_present
            && (!snapshot.member
                || snapshot.profile_event.is_none()
                || snapshot.directory_event.is_none())
        {
            return Err(CliError::Conflict(
                "completed agent was revoked or removed; no provisioning events replayed".into(),
            ));
        }
        let mut stable = state::StableBinding::new(&manifest, agent);
        // Persist the key before recording its immutable binding or touching
        // the relay. A crash here resumes the same signed identity from intent.
        let journal_path = enrollment::journal_path(state_dir, &binding(&manifest, agent));
        if snapshot.pubkey.is_none() {
            enrollment::persist_new(
                &journal_path,
                &enrollment::make_journal(client, binding(&manifest, agent))?,
            )?;
        }
        let journal = enrollment::read_journal(&journal_path, &binding(&manifest, agent))?;
        stable.pubkey = Some(journal.profile.pubkey.to_hex());
        state::save_new(&stable.path(state_dir), &stable)?;
        let enrolled = enrollment::provision(
            client,
            state_dir.to_path_buf(),
            manifest.channel.clone(),
            agent.runtime_id.clone(),
            manifest.runtime.cohort.clone(),
            agent.display_name.clone(),
        )
        .await?;
        state::save_new(
            &state_dir.join(format!("config-enrolled-{}.json", agent.key)),
            &enrollment_marker(&journal),
        )?;
        let pubkey = enrolled
            .get("pubkey")
            .and_then(Value::as_str)
            .ok_or_else(|| usage("missing enrollment receipt"))?;
        let policy = reconcile_policy(client, &manifest, agent, pubkey, state_dir).await?;
        receipts.push(
            json!({"key":agent.key, "seat":agent.seat, "runtime_id":agent.runtime_id,
            "pubkey":pubkey, "display_name":agent.display_name, "invocation":agent.invocation,
            "policy_sha256":digest(&agent.invocation)?, "directory_event":policy.id.to_hex(),
            "enrollment_events":enrolled["events"]}),
        );
    }
    let final_plan = make_plan(client, &manifest, state_dir).await?;
    if final_plan
        .agents
        .iter()
        .zip(&receipts)
        .any(|(agent, receipt)| {
            !agent.member
                || !agent.policy_matches
                || agent.profile_event.is_none()
                || agent.directory_event.as_deref() != receipt["directory_event"].as_str()
        })
    {
        return Err(CliError::Conflict(
            "configuration changed during apply; handoff not completed".into(),
        ));
    }
    for (receipt, snapshot) in receipts.iter_mut().zip(&final_plan.agents) {
        receipt["profile_event"] = json!(snapshot.profile_event);
    }
    // Re-read all referenced bytes at the handoff boundary as well.
    if manifest::load(file)? != manifest {
        return Err(CliError::Conflict(
            "manifest changed during apply; handoff not completed".into(),
        ));
    }
    let handoff = json!({"version":1, "operation":"openrig-runtime-handoff", "manifest_sha256":hash,
        "relay":manifest.relay, "owner":manifest.owner, "channel":manifest.channel,
        "runtime":manifest.runtime, "membership_event":final_plan.membership_event,
        "agents":receipts, "verification":pending()});
    let handoff_path = state_dir.join(format!("config-{}.handoff.json", hash));
    let handoff_hash = digest(&handoff)?;
    let generation_path = state_dir.join(format!("config-{}-{}.handoff.json", hash, handoff_hash));
    // Keep immutable signed generations, then atomically advance the latest
    // pointer. Returning to the same desired config can observe newer heads.
    if let Some(existing) = state::read_private::<SignedHandoff>(&handoff_path)? {
        verify_handoff(&existing, &manifest)?;
    }
    let envelope = if let Some(existing) = state::read_private::<SignedHandoff>(&generation_path)? {
        verify_handoff(&existing, &manifest)?;
        if existing.handoff != handoff {
            return Err(usage("handoff generation differs from its digest"));
        }
        existing
    } else {
        let authorization = client
            .sign_event(EventBuilder::new(Kind::TextNote, handoff.to_string()).tag(
                Tag::parse(["t", HANDOFF_TAG]).map_err(|_| usage("invalid handoff domain"))?,
            ))?;
        let envelope = SignedHandoff {
            handoff,
            authorization,
        };
        state::save_new(&generation_path, &envelope)?;
        envelope
    };
    state::replace_private(&handoff_path, &envelope)?;
    Ok(
        json!({"configuration_applied":true, "manifest_sha256":hash, "agents":receipts,
        "handoff_file":handoff_path, "handoff_generation_file":generation_path,
        "handoff_sha256":handoff_hash, "authorization_event_id":envelope.authorization.id,
        "runtime":pending()}),
    )
}

pub(super) async fn execute(
    command: AgentsConfigCmd,
    client: &BuzzClient,
) -> Result<Value, CliError> {
    match command {
        AgentsConfigCmd::Validate { file } => validate_file(&file),
        AgentsConfigCmd::VerifyHandoff {
            file,
            handoff,
            expected,
        } => handoff::verify_files(&file, &handoff, &expected),
        AgentsConfigCmd::VerifyHeads {
            file,
            handoff,
            expected,
        } => super::agent_config_heads::verify_files(client, &file, &handoff, &expected).await,
        AgentsConfigCmd::Plan { file, state_dir } => {
            let manifest = manifest::load(&file)?;
            public_plan(&make_plan(client, &manifest, &state_dir).await?)
        }
        AgentsConfigCmd::Apply {
            file,
            state_dir,
            plan,
        } => apply(client, &file, &state_dir, &plan).await,
        AgentsConfigCmd::Status { file, state_dir } => {
            let manifest = manifest::load(&file)?;
            let plan = make_plan(client, &manifest, &state_dir).await?;
            let hash = digest(&manifest)?;
            let handoff_file = state_dir.join(format!("config-{}.handoff.json", hash));
            let handoff = state::read_private::<SignedHandoff>(&handoff_file)?;
            if let Some(ref envelope) = handoff {
                verify_handoff(envelope, &manifest)?;
            }
            let exists = handoff.is_some();
            let current = handoff.as_ref().is_some_and(|envelope| {
                envelope.handoff["membership_event"] == plan.membership_event
                    && envelope.handoff["agents"].as_array().is_some_and(|agents| {
                        agents.len() == plan.agents.len()
                            && agents.iter().zip(&plan.agents).all(|(receipt, snapshot)| {
                                receipt["key"] == snapshot.key
                                    && receipt["pubkey"].as_str() == snapshot.pubkey.as_deref()
                                    && receipt["directory_event"].as_str()
                                        == snapshot.directory_event.as_deref()
                                    && receipt["profile_event"].as_str()
                                        == snapshot.profile_event.as_deref()
                            })
                    })
            });
            Ok(
                json!({"manifest_sha256":hash, "agents":plan.agents, "membership_event":plan.membership_event,
                "handoff_recorded":exists, "handoff_current":current, "runtime":pending()}),
            )
        }
    }
}

#[cfg(all(test, unix))]
#[path = "agent_config_tests.rs"]
mod tests;
