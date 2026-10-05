//! `buzz prompts` — agent questions as NIP-AR artifacts (`buzz.agent_prompt`).
//!
//! A prompt is a kind-45010 artifact anchored (`root`) to a message in its
//! channel. Desktop renders it as a question card under that message; the
//! first answer is published as the artifact's next revision.

use nostr::{EventBuilder, Kind, Tag};
use serde_json::{Map, Value};

use crate::client::{normalize_write_response, BuzzClient};
use crate::error::CliError;
use crate::validate::{read_file_or_stdin, validate_hex64, validate_uuid};

/// NIP-AR channel artifact revision.
const KIND_ARTIFACT: u16 = 45010;
/// Artifact type the desktop question card renders.
const AGENT_PROMPT_TYPE: &str = "buzz.agent_prompt";
/// Desktop shows at most four questions (Claude Code AskUserQuestion parity).
const MAX_QUESTIONS: usize = 4;
/// Options plus "Other" must fit the desktop's 1–9 number-key shortcuts.
const MAX_OPTIONS: usize = 8;
/// NIP-AR `title` limit.
const MAX_TITLE_BYTES: usize = 512;

/// Build the content of a new, open prompt from a JSON document holding at
/// least `questions`. Missing envelope fields are filled in; unfamiliar
/// fields are kept. Returns the content and the title (the first question).
///
/// This checks the shape the desktop needs to render a card. The desktop
/// validates again (and falls back to the title) because relay content is
/// untrusted.
pub fn build_prompt_content(input: &str) -> Result<(String, String), CliError> {
    let mut doc: Map<String, Value> = match serde_json::from_str(input) {
        Ok(Value::Object(doc)) => doc,
        Ok(_) => return Err(usage("prompt file must be a JSON object")),
        Err(e) => return Err(usage(&format!("prompt file is not valid JSON: {e}"))),
    };
    for (key, expected) in [("version", Value::from(1)), ("kind", "question".into())] {
        match doc.get(key) {
            None => {
                doc.insert(key.into(), expected);
            }
            Some(value) if *value == expected => {}
            Some(_) => return Err(usage(&format!("\"{key}\" must be {expected}"))),
        }
    }
    match doc.get("state") {
        None => {
            doc.insert("state".into(), "open".into());
        }
        Some(Value::String(state)) if state == "open" => {}
        Some(_) => return Err(usage("a new prompt must have \"state\": \"open\"")),
    }
    if doc.contains_key("answer") || doc.contains_key("answeredBy") {
        return Err(usage("a new prompt must not carry an answer"));
    }
    let questions = doc
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| usage("\"questions\" must be an array"))?;
    if questions.is_empty() || questions.len() > MAX_QUESTIONS {
        return Err(usage(&format!(
            "\"questions\" must hold 1 to {MAX_QUESTIONS} questions"
        )));
    }
    let mut ids = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        ids.push(check_question(index, question)?);
    }
    if (1..ids.len()).any(|i| ids[..i].contains(&ids[i])) {
        return Err(usage("question ids must be unique"));
    }
    let title = truncate_to_bytes(
        questions[0]
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        MAX_TITLE_BYTES,
    );
    let content = serde_json::to_string(&Value::Object(doc))
        .map_err(|e| CliError::Other(format!("prompt serialization failed: {e}")))?;
    Ok((content, title))
}

/// The desktop's per-field caps (`agentPromptContent.ts`), in UTF-16 code
/// units as JavaScript counts them. Text over a cap would make the whole card
/// fall back to its title, so reject it here.
const MAX_ID: usize = 64;
const MAX_HEADER: usize = 40;
const MAX_QUESTION: usize = 2000;
const MAX_LABEL: usize = 200;
const MAX_DESCRIPTION: usize = 1000;
const MAX_PREVIEW: usize = 10_000;

/// A required (or, with `optional`, absent-or-null) string field that is
/// non-blank and within `max` once trimmed. Previews keep their whitespace,
/// so they are measured untrimmed.
fn check_text(
    value: Option<&Value>,
    path: &str,
    max: usize,
    optional: bool,
    trim: bool,
) -> Result<(), CliError> {
    let text = match value {
        None | Some(Value::Null) if optional => return Ok(()),
        Some(Value::String(text)) => text,
        _ => return Err(usage(&format!("{path} must be a non-empty string"))),
    };
    if text.trim().is_empty() {
        return Err(usage(&format!("{path} must not be blank")));
    }
    let measured = if trim { text.trim() } else { text.as_str() };
    if measured.encode_utf16().count() > max {
        return Err(usage(&format!("{path} must be at most {max} characters")));
    }
    Ok(())
}

fn check_question(index: usize, question: &Value) -> Result<String, CliError> {
    let at = |field: &str| format!("questions[{index}].{field}");
    for (field, max) in [
        ("id", MAX_ID),
        ("header", MAX_HEADER),
        ("question", MAX_QUESTION),
    ] {
        check_text(question.get(field), &at(field), max, false, true)?;
    }
    for flag in ["multiSelect", "allowOther"] {
        if question.get(flag).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(&format!("{} must be a boolean", at(flag))));
        }
    }
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty() && options.len() <= MAX_OPTIONS)
        .ok_or_else(|| {
            usage(&format!(
                "{} must hold 1 to {MAX_OPTIONS} options",
                at("options")
            ))
        })?;
    let mut labels: Vec<&str> = Vec::new();
    for (option_index, option) in options.iter().enumerate() {
        let path = |field: &str| format!("{}[{option_index}].{field}", at("options"));
        check_text(option.get("label"), &path("label"), MAX_LABEL, false, true)?;
        let description = option.get("description");
        check_text(
            description,
            &path("description"),
            MAX_DESCRIPTION,
            true,
            true,
        )?;
        check_text(
            option.get("preview"),
            &path("preview"),
            MAX_PREVIEW,
            true,
            false,
        )?;
        let label = option
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if labels.contains(&label) {
            return Err(usage(&format!("{} labels must be unique", at("options"))));
        }
        labels.push(label);
    }
    Ok(question
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string())
}

fn truncate_to_bytes(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn usage(message: &str) -> CliError {
    CliError::Usage(message.to_string())
}

/// Envelope tags for creating prompt artifact `d` in `channel`, anchored to
/// the message `root`.
pub fn build_prompt_tags(
    d: &str,
    channel: &str,
    root: &str,
    title: &str,
) -> Result<Vec<Tag>, CliError> {
    [
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", AGENT_PROMPT_TYPE],
        ["title", title],
        ["op", "create"],
        ["root", root],
    ]
    .into_iter()
    .map(|tag| Tag::parse(tag).map_err(|e| CliError::Other(format!("invalid tag: {e}"))))
    .collect()
}

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
    let (content, title) = build_prompt_content(&read_file_or_stdin(file)?)?;
    let d = uuid::Uuid::new_v4().to_string();
    let tags = build_prompt_tags(&d, &channel.to_lowercase(), &root, &title)?;
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

    const QUESTION: &str = r#"{"questions":[{"id":"question_0","header":"Auth method",
        "question":"Which auth method?","multiSelect":false,
        "options":[{"label":"API key (Recommended)","description":"Matches v2"},
                   {"label":"OAuth","preview":"Authorization: Bearer ..."}]}],
        "session":"s-1"}"#;

    #[test]
    fn fills_the_envelope_and_keeps_unfamiliar_fields() {
        let (content, title) = build_prompt_content(QUESTION).expect("valid prompt");
        let doc: Value = serde_json::from_str(&content).expect("json");
        assert_eq!(doc["version"], 1);
        assert_eq!(doc["kind"], "question");
        assert_eq!(doc["state"], "open");
        assert_eq!(doc["session"], "s-1");
        assert_eq!(doc["questions"][0]["options"][1]["label"], "OAuth");
        assert_eq!(title, "Which auth method?");
    }

    #[test]
    fn rejects_prompts_the_card_cannot_render() {
        let five = format!(
            r#"{{"questions":[{}]}}"#,
            [r#"{"id":"q","header":"h","question":"q","options":[{"label":"a"}]}"#; 5].join(",")
        );
        let nine_options = format!(
            r#"{{"questions":[{{"id":"q","header":"h","question":"q","options":[{}]}}]}}"#,
            (0..9)
                .map(|i| format!(r#"{{"label":"o{i}"}}"#))
                .collect::<Vec<_>>()
                .join(",")
        );
        for (name, input) in [
            ("not json", "{".to_string()),
            ("array", "[]".to_string()),
            ("no questions", r#"{"questions":[]}"#.to_string()),
            ("five questions", five),
            ("nine options", nine_options),
            (
                "duplicate ids",
                r#"{"questions":[{"id":"q","header":"h","question":"q","options":[{"label":"a"}]},
                    {"id":"q","header":"h","question":"q","options":[{"label":"a"}]}]}"#
                    .to_string(),
            ),
            (
                "duplicate labels",
                r#"{"questions":[{"id":"q","header":"h","question":"q",
                    "options":[{"label":"a"},{"label":"a"}]}]}"#
                    .to_string(),
            ),
            (
                "blank header",
                r#"{"questions":[{"id":"q","header":" ","question":"q","options":[{"label":"a"}]}]}"#
                    .to_string(),
            ),
            (
                "string flag",
                r#"{"questions":[{"id":"q","header":"h","question":"q","multiSelect":"yes",
                    "options":[{"label":"a"}]}]}"#
                    .to_string(),
            ),
            (
                "already answered",
                QUESTION.replace(r#""session""#, r#""state":"answered","session""#),
            ),
            (
                "long question",
                QUESTION.replace("Which auth method?", &"q".repeat(2001)),
            ),
            (
                "long header",
                QUESTION.replace("Auth method", &"h".repeat(41)),
            ),
            (
                "long label",
                QUESTION.replace("OAuth", &"o".repeat(201)),
            ),
            (
                "long description",
                QUESTION.replace("Matches v2", &"d".repeat(1001)),
            ),
            (
                "blank description",
                QUESTION.replace("Matches v2", "  "),
            ),
            (
                "blank preview",
                QUESTION.replace("Authorization: Bearer ...", " "),
            ),
            (
                "long preview",
                QUESTION.replace("Authorization: Bearer ...", &"p".repeat(10_001)),
            ),
            ("wrong version", QUESTION.replace(r#"{"questions""#, r#"{"version":2,"questions""#)),
        ] {
            assert!(
                matches!(build_prompt_content(&input), Err(CliError::Usage(_))),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn limits_match_the_desktop_at_the_boundary() {
        // JavaScript counts UTF-16 units: 20 astral emoji are 40 units.
        let input = QUESTION
            .replace("Auth method", &"🔑".repeat(20))
            .replace("OAuth", &"o".repeat(200))
            .replace(
                "Authorization: Bearer ...",
                &format!("  {}", "p".repeat(9_998)),
            );
        assert!(build_prompt_content(&input).is_ok());
        let over = QUESTION.replace("Auth method", &format!("{}x", "🔑".repeat(20)));
        assert!(build_prompt_content(&over).is_err());
    }

    #[test]
    fn title_is_capped_on_a_char_boundary() {
        let long = "é".repeat(400);
        let input = QUESTION.replace("Which auth method?", &long);
        let (_, title) = build_prompt_content(&input).expect("valid prompt");
        assert!(title.len() <= MAX_TITLE_BYTES);
        assert_eq!(title, "é".repeat(MAX_TITLE_BYTES / 2));
    }

    #[test]
    fn the_relay_accepts_the_built_envelope() {
        let (content, title) = build_prompt_content(QUESTION).expect("valid prompt");
        let d = uuid::Uuid::new_v4().to_string();
        let tags = build_prompt_tags(
            &d,
            "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
            &"a".repeat(64),
            &title,
        )
        .expect("tags");
        let event = EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content)
            .tags(tags)
            .sign_with_keys(&nostr::Keys::generate())
            .expect("sign");
        buzz_core::artifact::validate(&event).expect("relay envelope validation");
    }

    #[test]
    fn tags_form_a_nip_ar_create_anchored_to_the_root() {
        let d = "04737c81-e5e8-4412-bb47-f446813cfeba";
        let channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
        let root = "a".repeat(64);
        let tags = build_prompt_tags(d, channel, &root, "Which auth method?").expect("tags");
        let tags: Vec<Vec<String>> = tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert_eq!(
            tags,
            vec![
                vec!["ar", "1"],
                vec!["d", d],
                vec!["h", channel],
                vec!["type", "buzz.agent_prompt"],
                vec!["title", "Which auth method?"],
                vec!["op", "create"],
                vec!["root", root.as_str()],
            ]
        );
    }
}
