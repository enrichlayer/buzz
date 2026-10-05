//! Pure conversions between claude-agent-acp's AskUserQuestion form
//! elicitation and `buzz.agent_prompt` content.
//!
//! The request shape is `askUserQuestionsToCreateRequest` and the response
//! shape is what `applyAskElicitationResponse` reads, both in
//! claude-agent-acp's `dist/elicitation.js` (0.84.0): one field per question
//! keyed `question_<n>` — a titled `oneOf` string enum for single-select, an
//! array with titled `anyOf` items for multi-select, `const` = option label —
//! plus an optional free-text `question_<n>_custom` ("Other"). For a single
//! question the question text is the request `message`; with several, each
//! field's `description`. The header is the field `title`; an option's
//! preview rides in `_meta["_claude/askUserQuestionOption"].preview`.

use std::collections::BTreeMap;

use buzz_sdk::agent_prompt::{
    build_open_prompt, truncate_utf16, utf16_len, MAX_DESCRIPTION, MAX_HEADER, MAX_LABEL,
    MAX_OPTIONS, MAX_PREVIEW, MAX_QUESTION, MAX_QUESTIONS,
};
use serde_json::{json, Map, Value};

/// `_meta` key carrying an option's preview (claude-agent-acp `OPTION_META_KEY`).
const OPTION_META_KEY: &str = "_claude/askUserQuestionOption";

/// One question of an open card, kept to map the answer back.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AskQuestion {
    /// Form field key (`question_<n>`), also the card's question id.
    pub field: String,
    pub multi_select: bool,
    /// Whether a typed "Other" answer is allowed (the form has
    /// `question_<n>_custom`).
    pub allow_other: bool,
    /// Options as `(label shown on the card, exact enum const)`. The card
    /// trims labels; the agent needs the const it sent back verbatim.
    pub options: Vec<(String, String)>,
}

/// A card built from an elicitation.
#[derive(Debug, Clone)]
pub(crate) struct AskPrompt {
    pub questions: Vec<AskQuestion>,
    /// Open `buzz.agent_prompt` content.
    pub content: String,
    /// Artifact title: the first question.
    pub title: String,
}

/// Why an elicitation is not turned into a card.
#[derive(Debug, PartialEq)]
pub(crate) enum Unsupported {
    /// Not the AskUserQuestion shape (an MCP server form, the refusal
    /// fallback dialog, URL mode, ...). Answered with `decline`.
    NotAskUserQuestion(&'static str),
    /// AskUserQuestion, but the card cannot represent it losslessly (too many
    /// questions or options, an over-long or duplicate label). Answered with
    /// an error so the agent hears the question was not shown, not "skipped".
    Unrenderable(String),
}

fn custom_field(field: &str) -> String {
    format!("{field}_custom")
}

/// Convert an `elicitation/create` request's params into card content.
pub(crate) fn ask_prompt_from_request(params: &Value) -> Result<AskPrompt, Unsupported> {
    use Unsupported::NotAskUserQuestion as Not;
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return Err(Not("not a form elicitation"));
    }
    let properties = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object)
        .ok_or(Not("form has no properties"))?;
    let count = (0..)
        .take_while(|n| properties.contains_key(&format!("question_{n}")))
        .count();
    if count == 0 {
        return Err(Not("no question_<n> fields"));
    }
    let known = |key: &str| {
        (0..count).any(|n| key == format!("question_{n}") || key == format!("question_{n}_custom"))
    };
    if !properties.keys().all(|key| known(key)) {
        return Err(Not("fields beyond question_<n> and question_<n>_custom"));
    }
    if count > MAX_QUESTIONS {
        return Err(Unsupported::Unrenderable(format!(
            "{count} questions; a card holds at most {MAX_QUESTIONS}"
        )));
    }
    let message = params.get("message").and_then(Value::as_str);
    let mut questions = Vec::new();
    let mut card_questions = Vec::new();
    for n in 0..count {
        let field = format!("question_{n}");
        let schema = &properties[&field];
        let (multi_select, enum_options) = match schema.get("type").and_then(Value::as_str) {
            Some("string") => (false, schema.get("oneOf")),
            Some("array") => (true, schema.pointer("/items/anyOf")),
            _ => return Err(Not("question field is neither a string nor an array")),
        };
        let enum_options = enum_options
            .and_then(Value::as_array)
            .ok_or(Not("question field has no titled enum"))?;
        let allow_other = properties
            .get(&custom_field(&field))
            .is_some_and(|custom| custom.get("type").and_then(Value::as_str) == Some("string"));
        let header = display_text(schema.get("title"), MAX_HEADER)
            .unwrap_or_else(|| format!("Question {}", n + 1));
        let question_source = if count == 1 {
            message
        } else {
            schema.get("description").and_then(Value::as_str)
        };
        let question = display_text(question_source.map(Value::from).as_ref(), MAX_QUESTION)
            .unwrap_or_else(|| header.clone());
        let (options, card_options) = options_from_enum(&field, enum_options)?;
        card_questions.push(json!({
            "id": field,
            "header": header,
            "question": question,
            "multiSelect": multi_select,
            "allowOther": allow_other,
            "options": card_options,
        }));
        questions.push(AskQuestion {
            field,
            multi_select,
            allow_other,
            options,
        });
    }
    let mut doc = Map::new();
    doc.insert("questions".into(), Value::Array(card_questions));
    let (content, title) =
        build_open_prompt(doc).map_err(|e| Unsupported::Unrenderable(e.to_string()))?;
    Ok(AskPrompt {
        questions,
        content,
        title,
    })
}

type Options = (Vec<(String, String)>, Vec<Value>);

fn options_from_enum(field: &str, enum_options: &[Value]) -> Result<Options, Unsupported> {
    if enum_options.is_empty() || enum_options.len() > MAX_OPTIONS {
        return Err(Unsupported::Unrenderable(format!(
            "{field} has {} options; a card holds 1 to {MAX_OPTIONS}",
            enum_options.len()
        )));
    }
    let mut options = Vec::new();
    let mut card_options = Vec::new();
    for option in enum_options {
        let value =
            option
                .get("const")
                .and_then(Value::as_str)
                .ok_or(Unsupported::NotAskUserQuestion(
                    "enum option without a const",
                ))?;
        // Labels are the answer: truncating one would change what the agent
        // gets back, so an unrenderable label rejects the card instead.
        let label = value.trim();
        if label.is_empty() || utf16_len(label) > MAX_LABEL {
            return Err(Unsupported::Unrenderable(format!(
                "{field} has an empty or over-long option label"
            )));
        }
        let mut card_option = Map::new();
        card_option.insert("label".into(), label.into());
        if let Some(description) = display_text(option.get("description"), MAX_DESCRIPTION) {
            card_option.insert("description".into(), description.into());
        }
        let preview = option
            .get("_meta")
            .and_then(|meta| meta.get(OPTION_META_KEY))
            .and_then(|meta| meta.get("preview"))
            .and_then(Value::as_str)
            .filter(|preview| !preview.trim().is_empty());
        if let Some(preview) = preview {
            card_option.insert(
                "preview".into(),
                truncate_utf16(preview, MAX_PREVIEW).into(),
            );
        }
        options.push((label.to_string(), value.to_string()));
        card_options.push(Value::Object(card_option));
    }
    Ok((options, card_options))
}

/// Display-only text, trimmed and cut to the card's cap; `None` when blank.
fn display_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    let text = truncate_utf16(text, max).trim_end();
    (!text.is_empty()).then(|| text.to_string())
}

/// Whether `answer` is a valid answer to the agent's own `questions`, not
/// just to whatever questions the answered revision carries: exactly these
/// question ids; one choice for single-select, one or more distinct choices
/// for multi-select; every choice one of the question's option labels,
/// except at most one typed "Other" where the question allows it. A
/// revision that rewrote the questions (a single-select made multi-select,
/// an invented option) is ignored like a forged one.
pub(crate) fn answer_conforms(
    questions: &[AskQuestion],
    answer: &BTreeMap<String, Vec<String>>,
) -> bool {
    answer.len() == questions.len()
        && questions.iter().all(|question| {
            let Some(choices) = answer.get(&question.field) else {
                return false;
            };
            let count_ok = if question.multi_select {
                !choices.is_empty()
            } else {
                choices.len() == 1
            };
            let distinct = choices
                .iter()
                .enumerate()
                .all(|(i, choice)| !choices[..i].contains(choice));
            let others = choices
                .iter()
                .filter(|choice| !question.options.iter().any(|(label, _)| label == *choice))
                .collect::<Vec<_>>();
            let others_ok = match others.as_slice() {
                [] => true,
                [other] => question.allow_other && !other.trim().is_empty(),
                _ => false,
            };
            count_ok && distinct && others_ok
        })
}

/// The `content` of an `accept` response for an answer that
/// [`answer_conforms`] to `questions`, in the shape
/// `applyAskElicitationResponse` reads: a picked option is its exact const
/// (an array of consts for multi-select); a typed "Other" answer goes in
/// `question_<n>_custom`.
pub(crate) fn accept_content(
    questions: &[AskQuestion],
    answer: &BTreeMap<String, Vec<String>>,
) -> Value {
    let mut content = Map::new();
    for question in questions {
        let Some(choices) = answer.get(&question.field) else {
            continue;
        };
        let mut picks = Vec::new();
        let mut other = None;
        for choice in choices {
            match question.options.iter().find(|(label, _)| label == choice) {
                Some((_, value)) => picks.push(value.clone()),
                None => other = Some(choice.clone()),
            }
        }
        if question.multi_select {
            if !picks.is_empty() {
                content.insert(question.field.clone(), picks.into());
            }
        } else if let Some(pick) = picks.into_iter().next() {
            content.insert(question.field.clone(), pick.into());
        }
        if let Some(other) = other {
            content.insert(custom_field(&question.field), other.into());
        }
    }
    Value::Object(content)
}
