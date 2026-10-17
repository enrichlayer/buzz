use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{AgentDefinition, ManagedAgentRecord};

pub(crate) const ACP_OUTPUT_MODE_ENV_VAR: &str = "BUZZ_ACP_OUTPUT_MODE";

/// Controls how much user-visible progress a managed agent is asked to publish.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOutputMode {
    /// Preserve the historical behavior: publish the harness's full visible output.
    #[default]
    Full,
    /// Prefer concise progress and outcome messages while preserving required interaction.
    Summary,
}

impl AgentOutputMode {
    pub(crate) const fn is_full(&self) -> bool {
        matches!(self, Self::Full)
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Summary => "summary",
        }
    }
}

pub(crate) fn apply_agent_output_mode_env(
    command: &mut std::process::Command,
    mode: AgentOutputMode,
) {
    command.env(ACP_OUTPUT_MODE_ENV_VAR, mode.as_str());
}

pub(crate) fn insert_agent_output_mode_env(
    policy_env: &mut BTreeMap<String, String>,
    mode: AgentOutputMode,
) {
    policy_env.insert(
        ACP_OUTPUT_MODE_ENV_VAR.to_string(),
        mode.as_str().to_string(),
    );
}

/// Linked instances inherit the current definition on restart. Orphaned and
/// definition-less instances retain the last mode stored on their record.
pub(crate) fn effective_agent_output_mode(
    record: &ManagedAgentRecord,
    definitions: &[AgentDefinition],
) -> AgentOutputMode {
    record
        .persona_id
        .as_deref()
        .and_then(|id| definitions.iter().find(|definition| definition.id == id))
        .map(|definition| definition.output_mode)
        .unwrap_or(record.output_mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_wire_values_are_stable() {
        assert_eq!(AgentOutputMode::default(), AgentOutputMode::Full);
        assert_eq!(AgentOutputMode::Full.as_str(), "full");
        assert_eq!(AgentOutputMode::Summary.as_str(), "summary");
        assert_eq!(
            serde_json::to_string(&AgentOutputMode::Summary).unwrap_or_default(),
            "\"summary\""
        );
    }

    #[test]
    fn malformed_wire_values_are_rejected() {
        for value in [serde_json::json!("compact"), serde_json::Value::Null] {
            assert!(serde_json::from_value::<AgentOutputMode>(value).is_err());
        }
    }

    #[test]
    fn launch_env_overwrites_an_ambient_value() {
        let mut command = std::process::Command::new("true");
        command.env(ACP_OUTPUT_MODE_ENV_VAR, "summary");
        apply_agent_output_mode_env(&mut command, AgentOutputMode::Full);
        let value = command
            .get_envs()
            .find(|(key, _)| *key == ACP_OUTPUT_MODE_ENV_VAR)
            .and_then(|(_, value)| value)
            .and_then(std::ffi::OsStr::to_str);
        assert_eq!(value, Some("full"));
    }
}
