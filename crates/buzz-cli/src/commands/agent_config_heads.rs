//! Authenticated observations of public signed heads, separate from offline
//! handoff verification and protected-host activation or native authority.

use super::{
    agent_config::{directory, membership, policy_matches, query_one},
    agent_config_handoff::verified_inputs,
    agent_config_manifest::usage,
};
use crate::{client::BuzzClient, error::CliError};
use nostr::PublicKey;
use serde_json::{json, Value};
use std::path::Path;

/// Match sequential strong reads to a selected handoff without private state.
pub(super) async fn verify_files(
    client: &BuzzClient,
    file: &Path,
    handoff: &Path,
    expected: &Path,
) -> Result<Value, CliError> {
    let (manifest, mut verified) = verified_inputs(file, handoff, expected)?;
    if client.relay_url() != manifest.relay {
        return Err(CliError::Auth(
            "head verification relay differs from independently expected community".into(),
        ));
    }
    // The reader can be a managed agent. Directory authority comes from the
    // independently pinned owner, never the authenticated reader's identity.
    let owner = PublicKey::parse(&manifest.owner).map_err(|_| usage("invalid expected owner"))?;
    let members = membership(client, &manifest).await?;
    if verified["membership_event"] != members.id.to_hex() {
        return Err(CliError::Conflict(
            "selected handoff membership is not the observed signed head".into(),
        ));
    }
    let mut heads = Vec::with_capacity(manifest.agents.len());
    for agent in &manifest.agents {
        let receipt = verified["agents"]
            .as_array()
            .and_then(|agents| agents.iter().find(|receipt| receipt["key"] == agent.key))
            .ok_or_else(|| usage("verified agent projection is missing"))?;
        let pubkey = receipt["pubkey"]
            .as_str()
            .ok_or_else(|| usage("verified agent public key is missing"))?;
        if !members.tags.iter().any(|tag| {
            tag.as_slice().first().map(String::as_str) == Some("p")
                && tag.as_slice().get(1).map(String::as_str) == Some(pubkey)
        }) {
            return Err(CliError::Auth(
                "selected agent channel membership not confirmed".into(),
            ));
        }
        let author = PublicKey::parse(pubkey).map_err(|_| usage("invalid verified agent key"))?;
        let profile = query_one(
            client,
            json!({"kinds":[0], "authors":[pubkey], "limit":1, "consistency":"strong"}),
            &author,
            0,
            None,
        )
        .await?
        .ok_or_else(|| CliError::Conflict("selected agent profile is absent".into()))?;
        let policy = directory(client, &owner, pubkey)
            .await?
            .ok_or_else(|| CliError::Conflict("selected agent directory is absent".into()))?;
        if receipt["profile_event"] != profile.id.to_hex()
            || receipt["directory_event"] != policy.id.to_hex()
        {
            return Err(CliError::Conflict(
                "selected handoff profile or directory is not the observed signed head".into(),
            ));
        }
        if !policy_matches(&policy, agent) {
            return Err(CliError::Conflict(
                "observed directory policy differs from the selected manifest".into(),
            ));
        }
        heads.push(json!({"key":agent.key, "pubkey":pubkey,
            "profile_event":profile.id, "profile_author":profile.pubkey,
            "directory_event":policy.id, "directory_author":policy.pubkey,
            "directory_policy_matches":true}));
    }
    verified["current_signed_heads_match"] = json!(true);
    verified["observed_heads"] = json!({"membership_event":members.id,
        "membership_author":members.pubkey, "agents":heads});
    // Strong reads are sequential; this result is neither an atomic relay
    // snapshot nor a durable native generation/request fence.
    verified["verification"]["current_heads"] = json!("matched_sequential_strong_reads");
    verified["verification"]["activation"] = json!("pending_protected_operator");
    Ok(verified)
}
