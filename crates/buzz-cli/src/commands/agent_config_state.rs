//! Private local reconciliation state. Stable keys cannot be rebound to another
//! identity, community, channel, rig or seat. No host receipt import is trusted.

use super::{
    agent_config_manifest::{usage, Agent, Manifest},
    agent_enrollment as enrollment,
};
use crate::error::CliError;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

// One bounded manifest or signed handoff plus <=64 agents fits below this cap.
const MAX_STATE_BYTES: u64 = 512 * 1024;

#[derive(Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct StableBinding {
    pub version: u32,
    pub key: String,
    pub relay: String,
    pub owner: String,
    pub channel: String,
    pub cohort: String,
    pub runtime_id: String,
    pub rig_id: String,
    pub seat: String,
    pub pubkey: Option<String>,
}

impl StableBinding {
    pub fn new(manifest: &Manifest, agent: &Agent) -> Self {
        Self {
            version: 1,
            key: agent.key.clone(),
            relay: manifest.relay.clone(),
            owner: manifest.owner.clone(),
            channel: manifest.channel.clone(),
            cohort: manifest.runtime.cohort.clone(),
            runtime_id: agent.runtime_id.clone(),
            rig_id: manifest.runtime.rig_id.clone(),
            seat: agent.seat.clone(),
            pubkey: None,
        }
    }

    pub fn path(&self, state: &Path) -> PathBuf {
        state.join(format!("config-binding-{}.json", self.key))
    }

    pub fn check(&self, state: &Path) -> Result<Option<String>, CliError> {
        match read_private::<Self>(&self.path(state))? {
            Some(existing) => {
                let mut expected = self.clone();
                expected.pubkey = existing.pubkey.clone();
                if existing != expected || existing.pubkey.is_none() {
                    return Err(CliError::Conflict(
                        "stable agent key cannot be rebound; preserve its original enrollment"
                            .into(),
                    ));
                }
                Ok(existing.pubkey)
            }
            None => Ok(None),
        }
    }
}

pub(super) fn directory_exists(state: &Path) -> Result<bool, CliError> {
    let metadata = match fs::symlink_metadata(state) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(usage("cannot inspect private configuration state")),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(usage(
                "configuration state must be a real private directory (0700)",
            ));
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err(usage(
            "configuration state currently requires Unix private-file permissions",
        ))
    }
}

pub(super) fn read_private<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, CliError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(usage("cannot inspect configuration journal")),
    };
    if !metadata.is_file() || metadata.len() > MAX_STATE_BYTES {
        return Err(usage(
            "configuration journal must be a bounded regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(usage("configuration journal is not private"));
        }
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| usage("cannot read configuration journal"))?
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| usage("cannot read configuration journal"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(usage("configuration journal exceeds size limit"));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| usage("invalid configuration journal"))
}

pub(super) fn save_new<T: Serialize + DeserializeOwned + PartialEq>(
    path: &Path,
    value: &T,
) -> Result<(), CliError> {
    if serde_json::to_vec(value)
        .map_err(|_| usage("cannot serialize configuration journal"))?
        .len() as u64
        > MAX_STATE_BYTES
    {
        return Err(usage(
            "configuration journal exceeds size limit; nothing written",
        ));
    }
    // Bound retained intents rather than deleting recovery evidence automatically.
    if read_private::<T>(path)?.is_none() {
        let parent = path.parent().ok_or_else(|| usage("missing state parent"))?;
        if fs::read_dir(parent)
            .map_err(|_| usage("cannot inspect state capacity"))?
            .take(1024)
            .count()
            >= 1024
        {
            return Err(usage(
                "configuration state capacity reached; retain journals for operator reconciliation",
            ));
        }
        enrollment::persist_new(path, value)?;
    }
    if read_private::<T>(path)?.as_ref() != Some(value) {
        return Err(CliError::Conflict(
            "existing configuration journal has different intent".into(),
        ));
    }
    Ok(())
}

pub(super) fn lock(state: &Path) -> Result<fs::File, CliError> {
    enrollment::private_dir(state)?;
    let path = state.join(".config.lock");
    if fs::symlink_metadata(&path).is_ok() {
        // Validate file kind/permissions without parsing the empty lock file.
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| usage("invalid configuration lock"))?;
        if !metadata.is_file() {
            return Err(usage("configuration lock must be a real private file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(usage("configuration lock is not private"));
            }
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).read(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|_| usage("cannot open configuration lock"))?;
    file.try_lock().map_err(|_| {
        CliError::Conflict("another configuration apply owns this state directory".into())
    })?;
    Ok(file)
}

/// Advance a private local progress/latest pointer only after its immutable
/// intent or completion history has been synced. Callers hold the apply lock.
pub(super) fn replace_private<T: Serialize + DeserializeOwned + PartialEq>(
    path: &Path,
    value: &T,
) -> Result<(), CliError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| usage("cannot serialize configuration journal"))?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(usage(
            "configuration journal exceeds size limit; nothing written",
        ));
    }
    if read_private::<T>(path)?.is_none() {
        return save_new(path, value);
    }
    let parent = path.parent().ok_or_else(|| usage("missing state parent"))?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temp)
            .map_err(|_| usage("cannot stage configuration progress"))?;
        file.write_all(&bytes)
            .map_err(|_| usage("cannot write configuration progress"))?;
        file.sync_all()
            .map_err(|_| usage("cannot sync configuration progress"))?;
        fs::rename(&temp, path).map_err(|_| usage("cannot advance configuration progress"))?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| usage("cannot sync configuration state"))
    })();
    let cleanup = match fs::remove_file(&temp) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(usage("cannot clean staged configuration progress")),
    };
    result.and(cleanup)
}
