//! Offline verification of the existing owner-signed configuration handoff.
//! Expected scope is supplied independently; signatures confer no native authority.

use super::agent_config_manifest::{
    self as manifest, digest, usage, Invocation, Manifest, Runtime,
};
use crate::error::CliError;
use nostr::{Event, Kind};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

pub(super) const HANDOFF_TAG: &str = "buzz-agent-config-handoff-v1";
const MAX_HANDOFF_BYTES: u64 = 512 * 1024;
const MAX_EXPECTED_BYTES: u64 = 128 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct SignedHandoff {
    pub handoff: Value,
    pub authorization: Event,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Handoff {
    version: u32,
    operation: String,
    manifest_sha256: String,
    relay: String,
    owner: String,
    channel: String,
    runtime: Runtime,
    membership_event: String,
    agents: Vec<AgentReceipt>,
    verification: Verification,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentReceipt {
    key: String,
    seat: String,
    runtime_id: String,
    pubkey: String,
    display_name: String,
    invocation: Invocation,
    policy_sha256: String,
    directory_event: String,
    profile_event: String,
    enrollment_events: EnrollmentEvents,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentEvents {
    profile: String,
    directory: String,
    membership: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Verification {
    canonical_spec_validation: String,
    protected_runtime: String,
    effective_runtime_policy: String,
    presence: String,
    messaging_evidence: String,
}

pub(super) fn pending() -> Value {
    json!({"canonical_spec_validation":"pending_protected_operator",
        "protected_runtime":"pending_protected_operator", "effective_runtime_policy":"pending_protected_operator",
        "presence":"unknown", "messaging_evidence":"not_verified"})
}

fn sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Shared producer/consumer check of the signed public contract and normalized manifest.
pub(super) fn verify_handoff(
    envelope: &SignedHandoff,
    manifest: &Manifest,
) -> Result<Handoff, CliError> {
    let event = &envelope.authorization;
    let signed: Handoff = serde_json::from_str(&event.content)
        .map_err(|_| usage("invalid signed handoff content or unsupported field"))?;
    let content: Value = serde_json::from_str(&event.content)
        .map_err(|_| usage("invalid signed handoff content"))?;
    if buzz_core::verify_event(event).is_err()
        || event.pubkey.to_hex() != manifest.owner
        || event.kind != Kind::TextNote
        || content != envelope.handoff
        || serde_json::to_value(&event.tags).map_err(|_| usage("invalid handoff tags"))?
            != json!([["t", HANDOFF_TAG]])
        || signed.operation != "openrig-runtime-handoff"
        || signed.version != 1
        || signed.manifest_sha256 != digest(manifest)?
        || signed.relay != manifest.relay
        || signed.owner != manifest.owner
        || signed.channel != manifest.channel
        || signed.runtime != manifest.runtime
        || json!(signed.verification) != pending()
        || !sha256_hex(&signed.membership_event)
        || signed.agents.len() != manifest.agents.len()
    {
        return Err(usage(
            "handoff authorization signature, configuration or scope mismatch",
        ));
    }
    let mut keys = HashSet::new();
    let mut pubkeys = HashSet::new();
    for receipt in &signed.agents {
        let agent = manifest
            .agents
            .iter()
            .find(|agent| agent.key == receipt.key)
            .ok_or_else(|| usage("handoff agent differs from the manifest"))?;
        if !keys.insert(&receipt.key)
            || !pubkeys.insert(&receipt.pubkey)
            || !manifest::hex_key(&receipt.pubkey)
            || receipt.pubkey == manifest.owner
            || receipt.seat != agent.seat
            || receipt.runtime_id != agent.runtime_id
            || receipt.display_name != agent.display_name
            || receipt.invocation != agent.invocation
            || receipt.policy_sha256 != digest(&agent.invocation)?
            || agent
                .adoption
                .as_ref()
                .is_some_and(|adoption| adoption.expected_pubkey != receipt.pubkey)
            || [
                &receipt.directory_event,
                &receipt.profile_event,
                &receipt.enrollment_events.profile,
                &receipt.enrollment_events.directory,
                &receipt.enrollment_events.membership,
            ]
            .iter()
            .any(|id| !sha256_hex(id))
        {
            return Err(usage(
                "handoff agent identity, policy or event reference mismatch",
            ));
        }
    }
    Ok(signed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedScope {
    version: u32,
    relay: String,
    owner: String,
    channel: String,
    cohort: String,
    rig_id: String,
    handoff_sha256: String,
    authorization_event_id: String,
    agents: Vec<ExpectedIdentity>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedIdentity {
    key: String,
    seat: String,
    runtime_id: String,
    pubkey: String,
}

fn verify_expected(
    envelope: &SignedHandoff,
    manifest: &Manifest,
    expected: &ExpectedScope,
) -> Result<Value, CliError> {
    let handoff_sha256 = hex::encode(Sha256::digest(envelope.authorization.content.as_bytes()));
    // Pin expected authority before accepting any identity asserted by the artifact.
    if expected.version != 1
        || expected.relay != manifest.relay
        || expected.owner != manifest.owner
        || expected.channel != manifest.channel
        || expected.cohort != manifest.runtime.cohort
        || expected.rig_id != manifest.runtime.rig_id
        || !sha256_hex(&expected.handoff_sha256)
        || expected.handoff_sha256 != handoff_sha256
        || !sha256_hex(&expected.authorization_event_id)
        || expected.authorization_event_id != envelope.authorization.id.to_hex()
        || expected.agents.len() != manifest.agents.len()
    {
        return Err(usage(
            "independent expected scope or handoff generation mismatch",
        ));
    }
    let signed = verify_handoff(envelope, manifest)?;
    let mut keys = HashSet::new();
    for identity in &expected.agents {
        let receipt = signed
            .agents
            .iter()
            .find(|agent| agent.key == identity.key)
            .ok_or_else(|| usage("independent expected agent is missing"))?;
        if !keys.insert(&identity.key)
            || !manifest::hex_key(&identity.pubkey)
            || identity.seat != receipt.seat
            || identity.runtime_id != receipt.runtime_id
            || identity.pubkey != receipt.pubkey
        {
            return Err(usage("independent expected agent identity mismatch"));
        }
    }
    let agents: Vec<_> = signed.agents.iter().map(|agent| json!({
        "key":agent.key, "seat":agent.seat, "runtime_id":agent.runtime_id,
        "pubkey":agent.pubkey, "invocation":agent.invocation, "policy_sha256":agent.policy_sha256,
        "directory_event":agent.directory_event, "profile_event":agent.profile_event
    })).collect();
    Ok(
        json!({"signed_configuration_verified":true, "spec_bytes_verified":true,
        "manifest_sha256":signed.manifest_sha256, "handoff_sha256":handoff_sha256,
        "authorization_event_id":envelope.authorization.id, "relay":signed.relay,
        "owner":signed.owner, "channel":signed.channel, "runtime":signed.runtime,
        "membership_event":signed.membership_event, "agents":agents,
        "verification":{"canonical_spec_validation":"pending_protected_operator",
            "native_custody":"pending_protected_operator", "current_heads":"not_verified",
            "generation_freshness":"not_verified", "protected_runtime":"pending_protected_operator",
            "effective_runtime_policy":"pending_protected_operator", "presence":"unknown",
            "messaging_evidence":"not_verified"}}),
    )
}

/// Verify bounded public inputs locally, without credentials, relay reads or state writes.
pub(crate) fn verify_files(
    file: &Path,
    handoff: &Path,
    expected: &Path,
) -> Result<Value, CliError> {
    Ok(verified_inputs(file, handoff, expected)?.1)
}

/// Load and verify once so an authenticated reader uses the same normalized inputs.
pub(super) fn verified_inputs(
    file: &Path,
    handoff: &Path,
    expected: &Path,
) -> Result<(Manifest, Value), CliError> {
    let manifest = manifest::load(file)?;
    let bytes = manifest::read_bounded(handoff, MAX_HANDOFF_BYTES)?;
    let envelope: SignedHandoff = serde_json::from_slice(&bytes)
        .map_err(|_| usage("invalid handoff envelope or unsupported field"))?;
    // nostr::Event owns signature parsing. Require its seven canonical JSON
    // fields as well, so library tolerance for extensions cannot expand v1.
    let raw: Value =
        serde_json::from_slice(&bytes).map_err(|_| usage("invalid handoff envelope"))?;
    if raw["authorization"] != json!(envelope.authorization) {
        return Err(usage("unsupported handoff authorization field or encoding"));
    }
    let expected: ExpectedScope =
        serde_json::from_slice(&manifest::read_bounded(expected, MAX_EXPECTED_BYTES)?)
            .map_err(|_| usage("invalid independent expected scope or unsupported field"))?;
    let projection = verify_expected(&envelope, &manifest, &expected)?;
    Ok((manifest, projection))
}

#[cfg(test)]
#[path = "agent_config_handoff_tests.rs"]
mod tests;
