use super::*;
use nostr::{EventBuilder, Kind};

const QUESTION: &str = r#"{"questions":[{"id":"question_0","header":"Auth method",
    "question":"Which auth method?","multiSelect":false,
    "options":[{"label":"API key (Recommended)","description":"Matches v2"},
               {"label":"OAuth","preview":"Authorization: Bearer ..."}]}],
    "session":"s-1"}"#;
const ANSWERER: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const AGENT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn rejected(input: &str) -> bool {
    matches!(build_prompt_content(input), Err(SdkError::InvalidInput(_)))
}

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
        ("long label", QUESTION.replace("OAuth", &"o".repeat(201))),
        (
            "long description",
            QUESTION.replace("Matches v2", &"d".repeat(1001)),
        ),
        ("blank description", QUESTION.replace("Matches v2", "  ")),
        (
            "blank preview",
            QUESTION.replace("Authorization: Bearer ...", " "),
        ),
        (
            "long preview",
            QUESTION.replace("Authorization: Bearer ...", &"p".repeat(10_001)),
        ),
        (
            "wrong version",
            QUESTION.replace(r#"{"questions""#, r#"{"version":2,"questions""#),
        ),
    ] {
        assert!(rejected(&input), "{name} should be rejected");
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
fn truncate_utf16_counts_like_javascript() {
    assert_eq!(truncate_utf16("abc", 2), "ab");
    assert_eq!(truncate_utf16("🔑🔑", 3), "🔑");
    assert_eq!(truncate_utf16("🔑🔑", 4), "🔑🔑");
    assert_eq!(utf16_len("🔑a"), 3);
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
fn the_relay_accepts_the_built_envelopes() {
    let (content, title) = build_prompt_content(QUESTION).expect("valid prompt");
    let d = uuid::Uuid::new_v4().to_string();
    let channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
    let root = "a".repeat(64);
    let create = EventBuilder::new(Kind::Custom(45010), content.clone())
        .tags(build_prompt_tags(&d, channel, &root, &title).expect("tags"))
        .sign_with_keys(&nostr::Keys::generate())
        .expect("sign");
    buzz_core::artifact::validate(&create).expect("create envelope");
    let prev = create.id.to_hex();
    let update = EventBuilder::new(Kind::Custom(45010), content)
        .tags(build_prompt_update_tags(&d, channel, &title, Some(&root), &prev).expect("tags"))
        .sign_with_keys(&nostr::Keys::generate())
        .expect("sign");
    let envelope = buzz_core::artifact::validate(&update).expect("update envelope");
    assert_eq!(envelope.op, buzz_core::artifact::ArtifactOp::Update);
    assert!(envelope.root.is_some());
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

fn with_state(state: &str, extra: &str) -> String {
    let (content, _) = build_prompt_content(QUESTION).expect("valid prompt");
    content.replace(r#""state":"open""#, &format!(r#""state":"{state}"{extra}"#))
}

#[test]
fn parses_open_and_cancelled_prompts() {
    let (open, _) = build_prompt_content(QUESTION).expect("valid prompt");
    assert_eq!(parse_prompt_state(&open, AGENT), Some(PromptState::Open));
    assert_eq!(
        parse_prompt_state(&with_state("cancelled", ""), AGENT),
        Some(PromptState::Cancelled)
    );
    assert_eq!(parse_prompt_state(&with_state("closed", ""), AGENT), None);
    assert_eq!(parse_prompt_state("{", AGENT), None);
}

#[test]
fn answered_prompts_need_a_valid_answer_from_their_signer() {
    let answered = |answer: &str| {
        with_state(
            "answered",
            &format!(r#","answer":{answer},"answeredBy":"{ANSWERER}""#),
        )
    };
    let oauth = answered(r#"{"question_0":["OAuth"]}"#);
    let expected = PromptState::Answered(
        [("question_0".to_string(), vec!["OAuth".to_string()])]
            .into_iter()
            .collect(),
    );
    assert_eq!(parse_prompt_state(&oauth, ANSWERER), Some(expected));
    assert!(parse_prompt_state(&oauth, &ANSWERER.to_uppercase()).is_some());
    // A channel writer signing with their own key cannot credit someone else.
    assert_eq!(parse_prompt_state(&oauth, AGENT), None);
    for (name, answer) in [
        ("other text", r#"{"question_0":["Session cookies"]}"#),
        ("padded other", r#"{"question_0":[" padded "]}"#),
        (
            "two picks",
            r#"{"question_0":["OAuth","API key (Recommended)"]}"#,
        ),
        ("empty", r#"{"question_0":[]}"#),
        ("extra key", r#"{"question_0":["OAuth"],"x":["y"]}"#),
        ("non-string", r#"{"question_0":[1]}"#),
    ] {
        let valid = name == "other text";
        assert_eq!(
            parse_prompt_state(&answered(answer), ANSWERER).is_some(),
            valid,
            "{name}"
        );
    }
}

#[test]
fn multi_select_answers_allow_one_other() {
    let multi = QUESTION.replace(r#""multiSelect":false"#, r#""multiSelect":true"#);
    let (content, _) = build_prompt_content(&multi).expect("valid prompt");
    let answered = |answer: &str| {
        content.replace(
            r#""state":"open""#,
            &format!(r#""state":"answered","answer":{answer},"answeredBy":"{ANSWERER}""#),
        )
    };
    let ok = answered(r#"{"question_0":["OAuth","API key (Recommended)","mTLS"]}"#);
    assert!(parse_prompt_state(&ok, ANSWERER).is_some());
    for bad in [
        r#"{"question_0":["mTLS","JWT"]}"#,
        r#"{"question_0":["OAuth","OAuth"]}"#,
    ] {
        assert!(
            parse_prompt_state(&answered(bad), ANSWERER).is_none(),
            "{bad}"
        );
    }
    let strict = content.replace(
        r#""multiSelect":true"#,
        r#""multiSelect":true,"allowOther":false"#,
    );
    let strict = strict.replace(
        r#""state":"open""#,
        &format!(
            r#""state":"answered","answer":{{"question_0":["mTLS"]}},"answeredBy":"{ANSWERER}""#
        ),
    );
    assert!(parse_prompt_state(&strict, ANSWERER).is_none());
}
