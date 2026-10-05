//! `buzz.agent_prompt` artifacts: an agent's question rendered as a card.
//!
//! A prompt is a NIP-AR artifact (kind 45010) anchored (`root`) to a message
//! in its channel. Its JSON content is defined in `docs/plans/question-card.md`
//! and validated by the desktop's `agentPromptContent.ts`; the limits and
//! answer rules here mirror that parser so a writer never publishes a card the
//! desktop cannot render, and a reader accepts exactly the answers the desktop
//! accepts.

use nostr::Tag;
use serde_json::{Map, Value};

use crate::SdkError;

/// Artifact type the desktop question card renders.
pub const AGENT_PROMPT_TYPE: &str = "buzz.agent_prompt";
/// Desktop shows at most four questions (Claude Code AskUserQuestion parity).
pub const MAX_QUESTIONS: usize = 4;
/// Options plus "Other" must fit the desktop's 1–9 number-key shortcuts.
pub const MAX_OPTIONS: usize = 8;
/// NIP-AR `title` limit, in UTF-8 bytes.
pub const MAX_TITLE_BYTES: usize = 512;
/// Question id limit (UTF-16 units, as JavaScript counts).
pub const MAX_ID: usize = 64;
/// Header chip limit (UTF-16 units).
pub const MAX_HEADER: usize = 40;
/// Question text limit (UTF-16 units).
pub const MAX_QUESTION: usize = 2000;
/// Option label limit (UTF-16 units).
pub const MAX_LABEL: usize = 200;
/// Option description limit (UTF-16 units).
pub const MAX_DESCRIPTION: usize = 1000;
/// Option preview limit (UTF-16 units, measured untrimmed).
pub const MAX_PREVIEW: usize = 10_000;
/// Typed "Other" answer limit (UTF-16 units).
pub const MAX_OTHER_ANSWER: usize = 2000;

/// Length of `text` in UTF-16 code units, the unit JavaScript's `length` uses.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Longest prefix of `text` that is at most `max` UTF-16 units, cut on a char
/// boundary.
pub fn truncate_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

fn truncate_to_bytes(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

fn invalid(message: &str) -> SdkError {
    SdkError::InvalidInput(message.to_string())
}

/// Build the content of a new, open prompt from a JSON document holding at
/// least `questions`. See [`build_open_prompt`].
pub fn build_prompt_content(input: &str) -> Result<(String, String), SdkError> {
    match serde_json::from_str(input) {
        Ok(Value::Object(doc)) => build_open_prompt(doc),
        Ok(_) => Err(invalid("prompt file must be a JSON object")),
        Err(e) => Err(invalid(&format!("prompt file is not valid JSON: {e}"))),
    }
}

/// Build the content of a new, open prompt. Missing envelope fields
/// (`version`, `kind`, `state`) are filled in; unfamiliar fields are kept.
/// Returns the serialized content and the artifact title (the first
/// question, capped at [`MAX_TITLE_BYTES`]).
///
/// Rejects anything the desktop card cannot render. The desktop validates
/// again, because relay content is untrusted.
pub fn build_open_prompt(mut doc: Map<String, Value>) -> Result<(String, String), SdkError> {
    for (key, expected) in [("version", Value::from(1)), ("kind", "question".into())] {
        match doc.get(key) {
            None => {
                doc.insert(key.into(), expected);
            }
            Some(value) if *value == expected => {}
            Some(_) => return Err(invalid(&format!("\"{key}\" must be {expected}"))),
        }
    }
    match doc.get("state") {
        None => {
            doc.insert("state".into(), "open".into());
        }
        Some(Value::String(state)) if state == "open" => {}
        Some(_) => return Err(invalid("a new prompt must have \"state\": \"open\"")),
    }
    if doc.contains_key("answer") || doc.contains_key("answeredBy") {
        return Err(invalid("a new prompt must not carry an answer"));
    }
    let questions = check_questions(doc.get("questions"))?;
    let title = truncate_to_bytes(questions[0].question.trim(), MAX_TITLE_BYTES);
    let content = serde_json::to_string(&Value::Object(doc))
        .map_err(|e| invalid(&format!("prompt serialization failed: {e}")))?;
    Ok((content, title))
}

/// A question as the desktop reads it: trimmed id, flags and labels.
struct CheckedQuestion {
    id: String,
    question: String,
    multi_select: bool,
    allow_other: bool,
    labels: Vec<String>,
}

fn check_questions(value: Option<&Value>) -> Result<Vec<CheckedQuestion>, SdkError> {
    let questions = value
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("\"questions\" must be an array"))?;
    if questions.is_empty() || questions.len() > MAX_QUESTIONS {
        return Err(invalid(&format!(
            "\"questions\" must hold 1 to {MAX_QUESTIONS} questions"
        )));
    }
    let mut checked: Vec<CheckedQuestion> = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let question = check_question(index, question)?;
        if checked.iter().any(|q| q.id == question.id) {
            return Err(invalid("question ids must be unique"));
        }
        checked.push(question);
    }
    Ok(checked)
}

/// A required (or, with `optional`, absent-or-null) string field that is
/// non-blank and within `max` once trimmed. Previews keep their whitespace,
/// so they are measured untrimmed.
fn check_text(
    value: Option<&Value>,
    path: &str,
    max: usize,
    optional: bool,
    trim: bool,
) -> Result<(), SdkError> {
    let text = match value {
        None | Some(Value::Null) if optional => return Ok(()),
        Some(Value::String(text)) => text,
        _ => return Err(invalid(&format!("{path} must be a non-empty string"))),
    };
    if text.trim().is_empty() {
        return Err(invalid(&format!("{path} must not be blank")));
    }
    let measured = if trim { text.trim() } else { text.as_str() };
    if utf16_len(measured) > max {
        return Err(invalid(&format!("{path} must be at most {max} characters")));
    }
    Ok(())
}

fn trimmed(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn check_question(index: usize, question: &Value) -> Result<CheckedQuestion, SdkError> {
    let at = |field: &str| format!("questions[{index}].{field}");
    for (field, max) in [
        ("id", MAX_ID),
        ("header", MAX_HEADER),
        ("question", MAX_QUESTION),
    ] {
        check_text(question.get(field), &at(field), max, false, true)?;
    }
    let flag = |name: &str, default: bool| match question.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid(&format!("{} must be a boolean", at(name)))),
    };
    let multi_select = flag("multiSelect", false)?;
    let allow_other = flag("allowOther", true)?;
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .filter(|options| !options.is_empty() && options.len() <= MAX_OPTIONS)
        .ok_or_else(|| {
            invalid(&format!(
                "{} must hold 1 to {MAX_OPTIONS} options",
                at("options")
            ))
        })?;
    let mut labels: Vec<String> = Vec::new();
    for (option_index, option) in options.iter().enumerate() {
        let path = |field: &str| format!("{}[{option_index}].{field}", at("options"));
        check_text(option.get("label"), &path("label"), MAX_LABEL, false, true)?;
        check_text(
            option.get("description"),
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
        let label = trimmed(option.get("label"));
        if labels.contains(&label) {
            return Err(invalid(&format!("{} labels must be unique", at("options"))));
        }
        labels.push(label);
    }
    Ok(CheckedQuestion {
        id: trimmed(question.get("id")),
        question: trimmed(question.get("question")),
        multi_select,
        allow_other,
        labels,
    })
}

/// The lifecycle state of a valid prompt revision.
#[derive(Debug, Clone, PartialEq)]
pub enum PromptState {
    /// Waiting for an answer.
    Open,
    /// Answered: question id → choices (each a label or the typed "Other").
    Answered(std::collections::BTreeMap<String, Vec<String>>),
    /// Withdrawn by the asker; no answer will be accepted.
    Cancelled,
}

/// Parse the state of prompt content from a revision signed by `signer`
/// (lowercase hex). Mirrors the desktop's `parseAgentPrompt`: `None` means
/// the content is not a renderable prompt. An answered revision must carry a
/// valid answer for every question and name its own signer as `answeredBy`,
/// because content is writer-controlled and the signature is the only proof
/// of who answered.
pub fn parse_prompt_state(content: &str, signer: &str) -> Option<PromptState> {
    let doc: Value = serde_json::from_str(content).ok()?;
    if doc.get("version") != Some(&Value::from(1))
        || doc.get("kind").and_then(Value::as_str) != Some("question")
    {
        return None;
    }
    let questions = check_questions(doc.get("questions")).ok()?;
    match doc.get("state").and_then(Value::as_str)? {
        "open" => Some(PromptState::Open),
        "cancelled" => Some(PromptState::Cancelled),
        "answered" => {
            let answered_by = doc.get("answeredBy").and_then(Value::as_str)?;
            let is_hex = answered_by.len() == 64
                && answered_by
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            if !is_hex || answered_by != signer.to_ascii_lowercase() {
                return None;
            }
            let answer = doc.get("answer").and_then(Value::as_object)?;
            if answer.len() != questions.len() {
                return None;
            }
            let mut choices_by_id = std::collections::BTreeMap::new();
            for question in &questions {
                let choices = answer
                    .get(&question.id)?
                    .as_array()?
                    .iter()
                    .map(|choice| choice.as_str().map(str::to_string))
                    .collect::<Option<Vec<_>>>()?;
                if !is_valid_question_answer(question, &choices) {
                    return None;
                }
                choices_by_id.insert(question.id.clone(), choices);
            }
            Some(PromptState::Answered(choices_by_id))
        }
        _ => None,
    }
}

/// Whether `choices` is a complete, valid answer (desktop
/// `isValidQuestionAnswer`): at least one choice, exactly one for a
/// single-select, no duplicates, and at most one typed "Other" answer that is
/// already trimmed, non-empty and within [`MAX_OTHER_ANSWER`].
fn is_valid_question_answer(question: &CheckedQuestion, choices: &[String]) -> bool {
    if choices.is_empty() || (!question.multi_select && choices.len() != 1) {
        return false;
    }
    if (1..choices.len()).any(|i| choices[..i].contains(&choices[i])) {
        return false;
    }
    let others: Vec<&String> = choices
        .iter()
        .filter(|choice| !question.labels.contains(choice))
        .collect();
    match others.as_slice() {
        [] => true,
        [other] => {
            question.allow_other
                && !other.is_empty()
                && other.trim() == other.as_str()
                && utf16_len(other) <= MAX_OTHER_ANSWER
        }
        _ => false,
    }
}

fn tags<const N: usize>(rows: [[&str; 2]; N]) -> Result<Vec<Tag>, SdkError> {
    rows.into_iter()
        .map(|tag| Tag::parse(tag).map_err(|e| SdkError::InvalidTag(e.to_string())))
        .collect()
}

/// Envelope tags for creating prompt artifact `d` in `channel`, anchored to
/// the message `root`.
pub fn build_prompt_tags(
    d: &str,
    channel: &str,
    root: &str,
    title: &str,
) -> Result<Vec<Tag>, SdkError> {
    tags([
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", AGENT_PROMPT_TYPE],
        ["title", title],
        ["op", "create"],
        ["root", root],
    ])
}

/// Envelope tags for updating prompt artifact `d` whose current head is
/// `prev`, keeping its `title` and `root`.
pub fn build_prompt_update_tags(
    d: &str,
    channel: &str,
    title: &str,
    root: Option<&str>,
    prev: &str,
) -> Result<Vec<Tag>, SdkError> {
    let mut envelope = tags([
        ["ar", "1"],
        ["d", d],
        ["h", channel],
        ["type", AGENT_PROMPT_TYPE],
        ["title", title],
        ["op", "update"],
        ["prev", prev],
    ])?;
    if let Some(root) = root {
        envelope.extend(tags([["root", root]])?);
    }
    Ok(envelope)
}

#[cfg(test)]
#[path = "agent_prompt_tests.rs"]
mod tests;
