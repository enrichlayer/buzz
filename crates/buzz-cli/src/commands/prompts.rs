//! `buzz prompts` — agent questions as NIP-AR artifacts (`buzz.agent_prompt`).
//!
//! A prompt is a kind-45010 artifact anchored (`root`) to a message in its
//! channel. Desktop renders it as a question card under that message; the
//! first answer is published as the artifact's next revision.

use buzz_sdk::agent_prompt::{build_prompt_content, build_prompt_tags};
use nostr::{EventBuilder, Kind};
use serde_json::{Map, Value};

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{read_file_or_stdin, sdk_err, validate_hex64, validate_uuid};

/// NIP-AR channel artifact revision.
const KIND_ARTIFACT: u16 = 45010;

/// `buzz prompts ask`: post a question card under a message.
pub async fn cmd_ask(
    client: &BuzzClient,
    channel: &str,
    root: &str,
    file: &str,
) -> Result<(), CliError> {
    validate_uuid(channel)?;
    validate_hex64(root)?;
    let root = root.to_lowercase();
    // Validation and caps are shared with buzz-acp (`buzz_sdk::agent_prompt`).
    let (content, title) = build_prompt_content(&read_file_or_stdin(file)?).map_err(sdk_err)?;
    let d = uuid::Uuid::new_v4().to_string();
    let tags = build_prompt_tags(&d, &channel.to_lowercase(), &root, &title).map_err(sdk_err)?;
    let event =
        client.sign_event(EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content).tags(tags))?;
    let resp = client.submit_event(event).await?;
    let mut output: Value = serde_json::from_str(&normalize_write_response(&resp))
        .unwrap_or_else(|_| Value::Object(Map::new()));
    if let Value::Object(fields) = &mut output {
        fields.insert("artifact".into(), d.into());
    }
    println!("{output}");
    Ok(())
}

pub async fn dispatch(cmd: crate::PromptsCmd, client: &BuzzClient) -> Result<(), CliError> {
    match cmd {
        crate::PromptsCmd::Ask {
            channel,
            root,
            file,
        } => cmd_ask(client, &channel, &root, &file).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_prompts_are_usage_errors() {
        let err = build_prompt_content(r#"{"questions":[]}"#).map_err(sdk_err);
        assert!(matches!(err, Err(CliError::Usage(_))));
    }
}
