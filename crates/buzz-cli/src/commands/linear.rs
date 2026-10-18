//! Signing and acknowledged publication for a durable external Linear sync worker.

use buzz_core::linear::{validate_linear_event, validate_linear_record, MAX_LINEAR_RECORD_BYTES};
use clap::Subcommand;
use nostr::{EventBuilder, Kind, Tag, Timestamp};
use serde_json::json;
use uuid::Uuid;

use crate::client::{normalize_write_response, BuzzClient};
use crate::commands::message_transport::{channel_tag, read_bounded_event_input, verify_raw_event};
use crate::error::CliError;

/// Agent-facing transport. The worker owns the durable outbox and source cursor.
#[derive(Subcommand)]
pub enum LinearCmd {
    /// Sign a validated mirror record without publishing; persist the result before sending.
    SignRecord {
        /// Destination private channel UUID.
        #[arg(long)]
        channel: Uuid,
        /// Complete mirror record JSON file, or '-' for stdin.
        #[arg(long)]
        record_file: String,
        /// Persisted monotonic publication time, in Unix seconds.
        #[arg(long)]
        created_at: u64,
    },
    /// Publish the exact persisted signed record and verify it is the accepted current head.
    PublishRecord {
        /// Expected destination private channel UUID.
        #[arg(long)]
        channel: Uuid,
        /// Signed event JSON file, or '-' for stdin.
        #[arg(long)]
        event_file: String,
    },
}

async fn require_private_channel(client: &BuzzClient, channel: Uuid) -> Result<(), CliError> {
    let raw = client
        .query(&json!({"kinds":[39000], "#d":[channel.to_string()], "limit":2}))
        .await?;
    let events: Vec<nostr::Event> = serde_json::from_str(&raw)
        .map_err(|_| CliError::Other("invalid channel metadata response".into()))?;
    if events.len() != 1
        || !events[0]
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["private"])
    {
        return Err(CliError::Auth(
            "Linear mirror destination must be an accessible private channel".into(),
        ));
    }
    Ok(())
}

/// Dispatch Linear transport operations using the configured integration identity.
pub async fn dispatch(command: LinearCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        LinearCmd::SignRecord {
            channel,
            record_file,
            created_at,
        } => {
            let content = read_bounded_event_input(&record_file, MAX_LINEAR_RECORD_BYTES)?;
            let identity = validate_linear_record(&content).map_err(CliError::Usage)?;
            let tags = [
                ["h".to_owned(), channel.to_string()],
                ["d".to_owned(), identity.d_tag(channel)],
                ["l".to_owned(), identity.project.to_string()],
            ]
            .into_iter()
            .map(Tag::parse)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CliError::Usage(format!("invalid Linear tags: {error}")))?;
            let event = client.sign_event(
                EventBuilder::new(Kind::Custom(identity.kind as u16), content)
                    .tags(tags)
                    .custom_created_at(Timestamp::from(created_at)),
            )?;
            validate_linear_event(&event).map_err(CliError::Usage)?;
            println!(
                "{}",
                serde_json::to_string(&event)
                    .map_err(|error| CliError::Other(error.to_string()))?
            );
        }
        LinearCmd::PublishRecord {
            channel,
            event_file,
        } => {
            let raw = read_bounded_event_input(&event_file, MAX_LINEAR_RECORD_BYTES * 2)?;
            let event = verify_raw_event(
                serde_json::from_str(&raw)
                    .map_err(|_| CliError::Usage("invalid signed Linear event JSON".into()))?,
            )
            .await?;
            let identity = validate_linear_event(&event).map_err(CliError::Usage)?;
            if event.pubkey != client.keys().public_key() || channel_tag(&event)? != channel {
                return Err(CliError::Auth(
                    "Linear event does not match the configured signer and channel".into(),
                ));
            }
            require_private_channel(client, channel).await?;
            let expected_id = event.id.to_hex();
            let response = normalize_write_response(&client.submit_event(event).await?);
            let receipt: serde_json::Value = serde_json::from_str(&response).map_err(|_| {
                CliError::Other("invalid Linear publication acknowledgement".into())
            })?;
            if receipt["accepted"] != true
                || receipt["event_id"].as_str() != Some(expected_id.as_str())
            {
                return Err(CliError::Other(
                    "Linear record was not acknowledged with its exact event ID".into(),
                ));
            }
            // An accepted duplicate may be dominated by another replaceable head.
            // Read the address, not the historical event ID, before checkpointing.
            let current = client
                .query(&json!({
                    "kinds":[identity.kind], "authors":[client.keys().public_key().to_hex()],
                    "#h":[channel.to_string()], "#d":[identity.d_tag(channel)], "limit":2
                }))
                .await?;
            let heads: Vec<nostr::Event> = serde_json::from_str(&current)
                .map_err(|_| CliError::Other("invalid Linear head readback".into()))?;
            if heads.len() != 1 || heads[0].id.to_hex() != expected_id {
                return Err(CliError::Conflict("Linear publication is not the current head; retain the outbox for reconciliation".into()));
            }
            println!("{response}");
        }
    }
    Ok(())
}
