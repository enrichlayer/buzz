//! Public configuration only. OpenRig owns the AgentSpec/RigSpec grammar;
//! this wrapper pins their bytes without inventing another topology schema.

use crate::{client::normalize_relay_url, error::CliError};
use nostr::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

const MAX_MANIFEST_BYTES: u64 = 128 * 1024;
const MAX_SPEC_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: u32,
    pub relay: String,
    pub owner: String,
    pub channel: String,
    pub runtime: Runtime,
    pub agents: Vec<Agent>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Runtime {
    pub cohort: String,
    pub rig_id: String,
    pub rig_spec: SpecReference,
    pub agent_specs: Vec<SpecReference>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct SpecReference {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Agent {
    pub key: String,
    pub seat: String,
    pub runtime_id: String,
    pub display_name: String,
    pub adoption: Option<Adoption>,
    pub invocation: Invocation,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Adoption {
    pub expected_pubkey: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Invocation {
    pub respond_to: RespondTo,
    pub allowlist: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RespondTo {
    OwnerOnly,
    Allowlist,
    Anyone,
}

pub(super) fn usage(message: &str) -> CliError {
    CliError::Usage(message.into())
}

pub(super) fn digest(value: &impl Serialize) -> Result<String, CliError> {
    let bytes = serde_json::to_vec(value).map_err(|_| usage("cannot serialize configuration"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(super) fn bounded(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn slug(value: &str) -> bool {
    bounded(value, 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

pub(super) fn hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && PublicKey::from_hex(value).is_ok()
}

fn reference(base: &Path, spec: &SpecReference) -> Result<(), CliError> {
    let path = Path::new(&spec.path);
    if !bounded(&spec.path, 512)
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || spec.sha256.len() != 64
        || !spec
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(usage(
            "spec references require a relative contained path and lowercase SHA-256",
        ));
    }
    let root = base
        .canonicalize()
        .map_err(|_| usage("cannot resolve manifest directory"))?;
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|_| usage("cannot resolve referenced spec"))?;
    if !resolved.starts_with(&root) {
        return Err(usage("referenced spec escapes the manifest directory"));
    }
    let bytes = read_bounded(&resolved, MAX_SPEC_BYTES)?;
    if hex::encode(Sha256::digest(bytes)) != spec.sha256 {
        return Err(usage(
            "referenced spec digest differs; refresh the configuration before planning",
        ));
    }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, CliError> {
    let metadata = fs::metadata(path).map_err(|_| usage("cannot inspect configuration input"))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(usage("configuration input must be a bounded regular file"));
    }
    let file = fs::File::open(path).map_err(|_| usage("cannot read configuration input"))?;
    if !file
        .metadata()
        .map_err(|_| usage("cannot inspect configuration input"))?
        .is_file()
    {
        return Err(usage("configuration input must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| usage("cannot read configuration input"))?;
    if bytes.len() as u64 > limit {
        return Err(usage("configuration input exceeds size limit"));
    }
    Ok(bytes)
}

pub(super) fn load(path: &Path) -> Result<Manifest, CliError> {
    let bytes = read_bounded(path, MAX_MANIFEST_BYTES)?;
    let mut manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| usage("invalid manifest JSON or unsupported field"))?;
    let relay = url::Url::parse(&normalize_relay_url(&manifest.relay))
        .map_err(|_| usage("invalid relay URL"))?;
    if !matches!(relay.scheme(), "http" | "https")
        || relay.host_str().is_none()
        || !relay.username().is_empty()
        || relay.password().is_some()
        || relay.query().is_some()
        || relay.fragment().is_some()
        || relay.path() != "/"
    {
        return Err(usage(
            "relay must be an HTTP(S)/WS(S) origin without credentials",
        ));
    }
    manifest.relay = normalize_relay_url(relay.as_str());
    manifest.channel = uuid::Uuid::parse_str(&manifest.channel)
        .map_err(|_| usage("invalid channel UUID"))?
        .to_string();
    if manifest.version != 1
        || !hex_key(&manifest.owner)
        || manifest.runtime.cohort != "openrig"
        || !bounded(&manifest.runtime.rig_id, 128)
        || manifest.agents.is_empty()
        || manifest.agents.len() > 64
        || manifest.runtime.agent_specs.is_empty()
        || manifest.runtime.agent_specs.len() > 64
    {
        return Err(usage(
            "invalid version, identity, OpenRig runtime or agent/spec count (1..64)",
        ));
    }
    let base = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut paths = std::collections::HashSet::new();
    for spec in std::iter::once(&manifest.runtime.rig_spec).chain(&manifest.runtime.agent_specs) {
        if !paths.insert(&spec.path) {
            return Err(usage("duplicate spec reference"));
        }
        reference(base, spec)?;
    }
    let mut keys = std::collections::HashSet::new();
    let mut seats = std::collections::HashSet::new();
    let mut runtimes = std::collections::HashSet::new();
    for agent in &manifest.agents {
        let seat: Vec<_> = agent.seat.split('.').collect();
        if !slug(&agent.key)
            || agent.key != agent.key.to_ascii_lowercase()
            || seat.len() != 2
            || !seat.iter().all(|part| slug(part))
            || !bounded(&agent.runtime_id, 256)
            || !bounded(&agent.display_name, 120)
            || !keys.insert(&agent.key)
            || !seats.insert(&agent.seat)
            || !runtimes.insert(&agent.runtime_id)
            || agent
                .adoption
                .as_ref()
                .is_some_and(|adopt| !hex_key(&adopt.expected_pubkey))
        {
            return Err(usage(
                "invalid or duplicate agent key, qualified seat, runtime ID or adoption key",
            ));
        }
        let mut authors = std::collections::HashSet::new();
        if agent.invocation.allowlist.len() > 64
            || agent
                .invocation
                .allowlist
                .iter()
                .any(|author| !hex_key(author) || !authors.insert(author))
            || match agent.invocation.respond_to {
                RespondTo::Allowlist => agent.invocation.allowlist.is_empty(),
                _ => !agent.invocation.allowlist.is_empty(),
            }
        {
            return Err(usage("allowlist mode requires 1..64 distinct pubkeys; other modes require an empty allowlist"));
        }
    }
    Ok(manifest)
}
