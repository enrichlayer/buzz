//! Channel-scoped Linear mirrors. Source identity never grants Buzz permissions.

use nostr::Event;
use serde_json::Value;
use uuid::Uuid;

use crate::kind::{KIND_LINEAR_PROJECT, KIND_LINEAR_TASK};

/// Maximum serialized mirror record, including its full source description.
pub const MAX_LINEAR_RECORD_BYTES: usize = 128 * 1024;

/// Validated source identity, used by publishers to construct canonical tags.
#[derive(Debug, PartialEq, Eq)]
pub struct LinearRecordIdentity {
    /// Linear organization UUID, not its mutable display name.
    pub organization: Uuid,
    /// Linear project UUID.
    pub project: Uuid,
    /// Linear issue UUID, or the project UUID for project records.
    pub entity: Uuid,
    /// The registered mirror event kind.
    pub kind: u32,
}

impl LinearRecordIdentity {
    /// Scope replacement identity to the destination channel as well as source.
    pub fn d_tag(&self, channel: Uuid) -> String {
        format!("linear:{channel}:{}:{}", self.organization, self.entity)
    }
}

fn uuid_field(value: &Value, field: &str) -> Result<Uuid, String> {
    value[field]
        .as_str()
        .and_then(|text| Uuid::parse_str(text).ok())
        .ok_or_else(|| format!("Linear {field} must be a UUID"))
}

/// Validate a complete mirror payload without trusting source text as authority.
pub fn validate_linear_record(content: &str) -> Result<LinearRecordIdentity, String> {
    if content.len() > MAX_LINEAR_RECORD_BYTES {
        return Err("Linear record exceeds 128 KiB; refusing to truncate source data".into());
    }
    let payload: Value = serde_json::from_str(content).map_err(|_| "invalid Linear record JSON")?;
    if payload["schema"] != "buzz.linear-record.v1" || payload["source"]["provider"] != "linear" {
        return Err("unsupported Linear record schema".into());
    }
    let source = &payload["source"];
    let organization = uuid_field(source, "organizationId")?;
    let project = uuid_field(source, "projectId")?;
    let entity = uuid_field(&payload["record"], "id")?;
    let workspace = source["workspace"].as_str().unwrap_or_default();
    if workspace.is_empty()
        || workspace.len() > 100
        || !workspace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("invalid Linear workspace URL key".into());
    }
    for (value, label) in [
        (&payload["observedAt"], "observedAt"),
        (&payload["record"]["updatedAt"], "updatedAt"),
    ] {
        let valid = value
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        if valid.is_none() {
            return Err(format!("invalid Linear {label} timestamp"));
        }
    }
    let kind = match payload["type"].as_str() {
        Some("project") if entity == project => KIND_LINEAR_PROJECT,
        Some("issue") if uuid_field(&payload["record"]["project"], "id")? == project => {
            KIND_LINEAR_TASK
        }
        _ => return Err("Linear entity does not belong to its declared project".into()),
    };
    Ok(LinearRecordIdentity {
        organization,
        project,
        entity,
        kind,
    })
}

fn one_tag<'a>(event: &'a Event, name: &str) -> Result<&'a str, String> {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == name));
    let value = tags
        .next()
        .and_then(|tag| {
            let values = tag.as_slice();
            (values.len() == 2).then(|| values[1].as_str())
        })
        .ok_or_else(|| format!("Linear event requires exactly one {name} tag"))?;
    if tags.next().is_some() {
        return Err(format!("ambiguous Linear {name} tag"));
    }
    Ok(value)
}

/// Validate the signed source/channel binding before generic ingestion.
pub fn validate_linear_event(event: &Event) -> Result<LinearRecordIdentity, String> {
    let identity = validate_linear_record(&event.content)?;
    let channel =
        Uuid::parse_str(one_tag(event, "h")?).map_err(|_| "invalid Linear channel UUID")?;
    if u32::from(event.kind.as_u16()) != identity.kind
        || one_tag(event, "d")? != identity.d_tag(channel)
        || one_tag(event, "l")? != identity.project.to_string()
    {
        return Err(
            "Linear event kind, channel or project binding does not match its payload".into(),
        );
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "schema":"buzz.linear-record.v1", "type":"issue", "observedAt":"2026-10-15T00:00:00Z",
            "source":{"provider":"linear", "workspace":"acme", "organizationId":Uuid::from_u128(1), "projectId":Uuid::from_u128(2)},
            "record":{"id":Uuid::from_u128(3), "project":{"id":Uuid::from_u128(2)}, "updatedAt":"2026-10-14T00:00:00Z", "description":"Full acceptance criteria"}
        })
    }

    fn event(payload: Value, channel: Uuid, d_channel: Uuid, extra: Vec<Tag>) -> Event {
        let identity = validate_linear_record(&payload.to_string()).unwrap();
        let mut tags = vec![
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["d", &identity.d_tag(d_channel)]).unwrap(),
            Tag::parse(["l", &identity.project.to_string()]).unwrap(),
        ];
        tags.extend(extra);
        EventBuilder::new(Kind::Custom(identity.kind as u16), payload.to_string())
            .tags(tags)
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }

    #[test]
    fn binds_source_and_private_channel_without_repository() {
        let channel = Uuid::from_u128(4);
        let record = validate_linear_event(&event(payload(), channel, channel, vec![])).unwrap();
        assert_eq!(record.kind, KIND_LINEAR_TASK);
        assert_ne!(record.d_tag(channel), record.d_tag(Uuid::from_u128(5)));
        assert!(
            validate_linear_event(&event(payload(), channel, Uuid::from_u128(5), vec![])).is_err()
        );
        assert!(validate_linear_event(&event(
            payload(),
            channel,
            channel,
            vec![Tag::parse(["h", &channel.to_string()]).unwrap()]
        ))
        .is_err());
    }

    #[test]
    fn rejects_bad_source_scope_and_unbounded_content() {
        let mut foreign = payload();
        foreign["record"]["project"]["id"] = json!(Uuid::from_u128(9));
        assert!(validate_linear_record(&foreign.to_string()).is_err());
        let mut malformed = payload();
        malformed["record"]["updatedAt"] = json!("not a timestamp");
        assert!(validate_linear_record(&malformed.to_string()).is_err());
        let mut large = payload();
        large["record"]["description"] = json!("x".repeat(MAX_LINEAR_RECORD_BYTES));
        assert!(validate_linear_record(&large.to_string()).is_err());
    }
}
