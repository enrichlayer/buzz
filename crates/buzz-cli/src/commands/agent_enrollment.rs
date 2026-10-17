//! Owner-side provisioning for external runtimes. Persist identity and exact
//! signed events before the first network write; never give an owner key to a
//! runtime. The launcher receives only the private journal's agent credential.

use crate::{client::BuzzClient, error::CliError};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_JOURNAL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Binding {
    relay: String,
    owner: String,
    channel: String,
    runtime_id: String,
    cohort: String,
    display_name: String,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    binding: Binding,
    private_key: String,
    auth_tag: String,
    profile: Event,
    directory: Event,
    membership: Event,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct RuntimeCredential {
    version: u32,
    relay: String,
    channel: String,
    owner: String,
    cohort: String,
    runtime_id: String,
    private_key: String,
    auth_tag: String,
}

fn failure(message: impl ToString) -> CliError {
    CliError::Other(message.to_string())
}

fn bounded(value: &str, limit: usize, label: &str) -> Result<(), CliError> {
    if value.trim().is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(CliError::Usage(format!("invalid {label}")));
    }
    Ok(())
}

fn make_journal(owner: &BuzzClient, binding: Binding) -> Result<Journal, CliError> {
    let keys = Keys::generate();
    let pubkey = keys.public_key().to_hex();
    let auth_tag = buzz_sdk::nip_oa::compute_auth_tag(owner.keys(), &keys.public_key(), "")
        .map_err(failure)?;
    let agent = BuzzClient::new(
        binding.relay.clone(),
        keys.clone(),
        Some(buzz_sdk::nip_oa::parse_auth_tag(&auth_tag).map_err(failure)?),
        Some(auth_tag.clone()),
    )?;
    let profile = agent.sign_event(EventBuilder::new(
        Kind::Metadata,
        json!({
            "name": binding.display_name,
            "display_name": binding.display_name,
            "about": format!("{} agent; runtime {}", binding.cohort, binding.runtime_id),
            "bot": true,
        })
        .to_string(),
    ))?;
    let directory = owner.sign_event(
        EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_MANAGED_AGENT as u16),
            json!({
                "name": binding.display_name,
                "parallelism": 1,
                "respond_to": "owner-only",
            })
            .to_string(),
        )
        .tag(Tag::parse(["d", &pubkey]).map_err(failure)?),
    )?;
    let membership = owner.sign_event(
        buzz_sdk::build_add_member(
            uuid::Uuid::parse_str(&binding.channel).map_err(failure)?,
            &pubkey,
            Some(buzz_sdk::MemberRole::Bot),
        )
        .map_err(failure)?,
    )?;
    Ok(Journal {
        version: 1,
        binding,
        private_key: keys.secret_key().to_secret_hex(),
        auth_tag,
        profile,
        directory,
        membership,
    })
}

// Unix is the initial external-runtime target (macOS laptops and Linux Factory).
// Refuse on other platforms until their private-file ACL implementation exists.
#[cfg(unix)]
fn private_dir(path: &Path) -> Result<(), CliError> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(failure(error)),
    }
    let metadata = fs::symlink_metadata(path).map_err(failure)?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(failure(
            "enrollment directory must be a real private directory (mode 0700)",
        ));
    }
    Ok(())
}
#[cfg(not(unix))]
fn private_dir(_: &Path) -> Result<(), CliError> {
    Err(failure(
        "external enrollment currently requires Unix private-file permissions",
    ))
}

fn read_journal(path: &Path, binding: &Binding) -> Result<Journal, CliError> {
    let metadata = fs::symlink_metadata(path).map_err(failure)?;
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
        return Err(failure("invalid enrollment journal file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(failure("enrollment journal is not private"));
        }
    }
    let mut body = Vec::new();
    fs::File::open(path)
        .map_err(failure)?
        .take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(failure)?;
    if body.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(failure("enrollment journal exceeds size limit"));
    }
    let journal: Journal =
        serde_json::from_slice(&body).map_err(|_| failure("invalid enrollment journal JSON"))?;
    // The first launch owns the profile name. Later launches can change their
    // task label without renaming or rotating an already enrolled identity.
    let mut expected = binding.clone();
    expected.display_name = journal.binding.display_name.clone();
    if journal.version != 1 || journal.binding != expected {
        return Err(failure(
            "enrollment binding differs; refusing to rotate or retarget the existing identity",
        ));
    }
    let keys = Keys::parse(&journal.private_key).map_err(|_| failure("invalid enrollment key"))?;
    let actual_owner = buzz_sdk::nip_oa::verify_auth_tag(&journal.auth_tag, &keys.public_key())
        .map_err(failure)?;
    if actual_owner.to_hex() != binding.owner
        || journal.profile.pubkey != keys.public_key()
        || journal.directory.pubkey != actual_owner
        || journal.membership.pubkey != actual_owner
    {
        return Err(failure("enrollment journal ownership mismatch"));
    }
    for event in [&journal.profile, &journal.directory, &journal.membership] {
        buzz_core::verify_event(event).map_err(failure)?;
    }
    // A valid owner signature alone does not authorize replaying an unrelated
    // command. Bind the journal's provisioning events to this exact agent and
    // channel before any of them can be published again.
    let pubkey = keys.public_key().to_hex();
    if journal.profile.kind != Kind::Metadata
        || journal.directory.kind.as_u16() != buzz_core::kind::KIND_MANAGED_AGENT as u16
        || serde_json::to_value(&journal.directory.tags).map_err(failure)? != json!([["d", pubkey]])
        || journal.membership.kind.as_u16() != 9000
        || !journal.membership.content.is_empty()
        || serde_json::to_value(&journal.membership.tags).map_err(failure)?
            != json!([["h", binding.channel], ["p", pubkey], ["role", "bot"]])
    {
        return Err(failure("enrollment journal event scope mismatch"));
    }
    Ok(journal)
}

fn persist_new(path: &Path, value: &impl Serialize) -> Result<(), CliError> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("missing enrollment parent"))?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp).map_err(failure)?;
        file.write_all(&serde_json::to_vec(value).map_err(failure)?)
            .map_err(failure)?;
        file.sync_all().map_err(failure)?;
        // Atomic create-if-absent: concurrent launches converge on one identity.
        match fs::hard_link(&temp, path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(failure(error)),
        }
        fs::File::open(parent)
            .map_err(failure)?
            .sync_all()
            .map_err(failure)
    })();
    let cleanup = fs::remove_file(&temp).map_err(failure);
    result.and(cleanup)
}

fn journal_path(dir: &Path, binding: &Binding) -> PathBuf {
    // Display name is not identity. Subsequent launches retain the first name;
    // cohort prevents a reused provider ID crossing lanes.
    let id = json!([
        binding.relay,
        binding.owner,
        binding.cohort,
        binding.runtime_id
    ]);
    dir.join(format!(
        "{}.json",
        hex::encode(Sha256::digest(id.to_string()))
    ))
}

async fn publish_exact(client: &BuzzClient, event: &Event) -> Result<(), CliError> {
    let filter = json!({"kinds": [event.kind.as_u16()], "ids": [event.id.to_hex()], "limit": 1,
        "consistency": "strong"});
    let found: Vec<Event> = serde_json::from_str(&client.query(&filter).await?).map_err(failure)?;
    if found.iter().any(|stored| stored == event) {
        return Ok(());
    }
    let receipt: serde_json::Value =
        serde_json::from_str(&client.submit_event(event.clone()).await?).map_err(failure)?;
    if receipt.get("accepted").and_then(|value| value.as_bool()) != Some(true)
        || receipt.get("event_id").and_then(|value| value.as_str())
            != Some(event.id.to_hex().as_str())
    {
        return Err(failure(
            "enrollment event was not accepted; signed journal retained for recovery",
        ));
    }
    Ok(())
}

/// Provision one runtime with its own agent key, profile, directory and membership.
/// Only an owner identity may call this; the returned receipt never contains keys.
pub(super) async fn enroll(
    owner: &BuzzClient,
    state_dir: PathBuf,
    channel: String,
    runtime_id: String,
    cohort: String,
    display_name: String,
) -> Result<(), CliError> {
    if owner.auth_tag_owner_hex().is_some() {
        return Err(CliError::Auth(
            "enrollment requires the owner identity, not an agent delegation".into(),
        ));
    }
    bounded(&runtime_id, 256, "runtime ID")?;
    bounded(&display_name, 120, "display name")?;
    if !["local", "herdr", "factory"].contains(&cohort.as_str()) {
        return Err(CliError::Usage("invalid cohort".into()));
    }
    let channel = uuid::Uuid::parse_str(&channel)
        .map_err(failure)?
        .to_string();
    let binding = Binding {
        relay: owner.relay_url().to_string(),
        owner: owner.keys().public_key().to_hex(),
        channel,
        runtime_id,
        cohort,
        display_name,
    };
    private_dir(&state_dir)?;
    let path = journal_path(&state_dir, &binding);
    if !path.try_exists().map_err(failure)? {
        persist_new(&path, &make_journal(owner, binding.clone())?)?;
    }
    let journal = read_journal(&path, &binding)?;
    let agent = BuzzClient::new(
        binding.relay.clone(),
        Keys::parse(&journal.private_key).map_err(|_| failure("invalid enrollment key"))?,
        Some(buzz_sdk::nip_oa::parse_auth_tag(&journal.auth_tag).map_err(failure)?),
        Some(journal.auth_tag.clone()),
    )?;
    let credential_path = path.with_extension("credential.json");
    // A completed enrollment is never provisioned again, even if the relay has
    // pruned the original commands. Replaying an old add-member command could
    // otherwise undo an administrator's subsequent revocation.
    if !credential_path.try_exists().map_err(failure)? {
        publish_exact(&agent, &journal.profile).await?;
        publish_exact(owner, &journal.directory).await?;
        publish_exact(owner, &journal.membership).await?;
    }
    // A command ACK is not proof of current, readable membership. In particular,
    // a previously enrolled but subsequently revoked runtime must fail here.
    let info: serde_json::Value =
        serde_json::from_str(&agent.get_public("/").await?).map_err(failure)?;
    let relay_key = nostr::PublicKey::parse(
        info.get("self")
            .and_then(|v| v.as_str())
            .ok_or_else(|| failure("relay info missing self key"))?,
    )
    .map_err(failure)?;
    let members: Vec<Event> = serde_json::from_str(&agent.query(&json!({
        "kinds": [39002], "authors": [relay_key.to_hex()], "#d": [binding.channel], "limit": 1,
        "consistency": "strong"
    })).await?).map_err(failure)?;
    let pubkey = agent.keys().public_key().to_hex();
    if !members
        .iter()
        .any(|event| valid_membership(event, &relay_key, &binding.channel, &pubkey))
    {
        return Err(failure(
            "agent channel membership not confirmed; enrollment journal retained",
        ));
    }
    // Never stage the owner-signed provisioning journal into a runtime. Its
    // credential contains only the delegated agent identity and public binding.
    let credential = RuntimeCredential {
        version: 1,
        relay: binding.relay.clone(),
        channel: binding.channel.clone(),
        owner: binding.owner.clone(),
        cohort: binding.cohort.clone(),
        runtime_id: binding.runtime_id.clone(),
        private_key: journal.private_key.clone(),
        auth_tag: journal.auth_tag.clone(),
    };
    persist_new(&credential_path, &credential)?;
    let metadata = fs::symlink_metadata(&credential_path).map_err(failure)?;
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
        return Err(failure("invalid runtime credential file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(failure("runtime credential file is not private"));
        }
    }
    let mut credential_body = Vec::new();
    fs::File::open(&credential_path)
        .map_err(failure)?
        .take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut credential_body)
        .map_err(failure)?;
    if credential_body.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(failure("runtime credential exceeds size limit"));
    }
    let stored: RuntimeCredential = serde_json::from_slice(&credential_body)
        .map_err(|_| failure("invalid runtime credential file"))?;
    if stored != credential {
        return Err(failure(
            "runtime credential differs from enrollment; refusing replacement",
        ));
    }
    println!(
        "{}",
        json!({"enrolled": true, "pubkey": pubkey, "owner": binding.owner,
        "relay": binding.relay, "channel": binding.channel, "cohort": binding.cohort,
        "display_name": journal.binding.display_name,
        "runtime_id": binding.runtime_id, "credentials_file": credential_path,
        "events": {"profile": journal.profile.id, "directory": journal.directory.id, "membership": journal.membership.id}})
    );
    Ok(())
}

fn valid_membership(
    event: &Event,
    relay_key: &nostr::PublicKey,
    channel: &str,
    pubkey: &str,
) -> bool {
    if event.kind.as_u16() != 39002
        || &event.pubkey != relay_key
        || buzz_core::verify_event(event).is_err()
    {
        return false;
    }
    let d: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("d"))
        .collect();
    if d.len() != 1 || d[0].as_slice().get(1).map(String::as_str) != Some(channel) {
        return false;
    }
    event.tags.iter().any(|tag| {
        tag.as_slice().first().map(String::as_str) == Some("p")
            && tag.as_slice().get(1).map(String::as_str) == Some(pubkey)
    })
}

#[cfg(all(test, unix))]
#[path = "agent_enrollment_tests.rs"]
mod tests;
