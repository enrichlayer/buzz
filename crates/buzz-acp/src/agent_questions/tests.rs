//! Fixtures are the exact request shapes claude-agent-acp 0.84.0's
//! `askUserQuestionsToCreateRequest` emits, and the asserted responses are
//! what its `applyAskElicitationResponse` reads.

use super::*;
use serde_json::json;
use std::sync::Mutex;

/// One question: the question text is `message`, no field description.
pub(crate) fn single_question_request() -> Value {
    json!({
        "mode": "form", "sessionId": "s-1", "toolCallId": "toolu_1",
        "message": "Which auth method should the endpoint use?",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "title": "Auth method", "oneOf": [
                {"const": "API key (Recommended)", "title": "API key (Recommended)",
                 "description": "Matches v2"},
                {"const": "OAuth", "title": "OAuth", "description": "Third-party apps",
                 "_meta": {"_claude/askUserQuestionOption": {"preview": "Authorization: Bearer ..."}}}
            ]},
            "question_0_custom": {"type": "string", "title": "Other",
                "description": "Type your own answer, or add a note to the option you chose above (optional)."}
        }}
    })
}

/// Two questions: each field carries its question as `description`; the
/// second is multi-select.
fn two_question_request() -> Value {
    json!({
        "mode": "form", "sessionId": "s-1", "toolCallId": "toolu_2",
        "message": "Please answer the following questions.",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "title": "Auth method",
                "description": "Which auth method?", "oneOf": [
                {"const": " Padded ", "title": " Padded "},
                {"const": "OAuth", "title": "OAuth"}
            ]},
            "question_0_custom": {"type": "string", "title": "Other",
                "description": "Type your own answer, or add a note to the option you chose above (optional)."},
            "question_1": {"type": "array", "title": "Clients",
                "description": "Which clients need access?",
                "items": {"anyOf": [
                    {"const": "Web", "title": "Web"},
                    {"const": "CLI", "title": "CLI"},
                    {"const": "Mobile", "title": "Mobile"}
                ]}},
            "question_1_custom": {"type": "string", "title": "Other",
                "description": "Type your own answer to add to your selection above (optional)."}
        }}
    })
}

fn card(content: &str) -> Value {
    serde_json::from_str(content).expect("card json")
}

#[test]
fn single_question_becomes_a_card() {
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let doc = card(&prompt.content);
    assert_eq!(doc["state"], "open");
    let q = &doc["questions"][0];
    assert_eq!(q["id"], "question_0");
    assert_eq!(q["header"], "Auth method");
    assert_eq!(q["question"], "Which auth method should the endpoint use?");
    assert_eq!(q["multiSelect"], false);
    assert_eq!(q["allowOther"], true);
    assert_eq!(q["options"][0]["description"], "Matches v2");
    assert_eq!(q["options"][1]["preview"], "Authorization: Bearer ...");
    assert!(q["options"][0].get("preview").is_none());
    assert_eq!(prompt.title, "Which auth method should the endpoint use?");
}

#[test]
fn several_questions_use_field_descriptions_and_keep_consts() {
    let prompt = ask_prompt_from_request(&two_question_request()).expect("card");
    let doc = card(&prompt.content);
    assert_eq!(doc["questions"][0]["question"], "Which auth method?");
    assert_eq!(doc["questions"][0]["options"][0]["label"], "Padded");
    assert_eq!(doc["questions"][1]["multiSelect"], true);
    assert_eq!(doc["questions"][1]["header"], "Clients");
    assert_eq!(prompt.title, "Which auth method?");
    assert_eq!(
        prompt.questions[0].options[0],
        ("Padded".to_string(), " Padded ".to_string())
    );
}

#[test]
fn missing_custom_field_disallows_other_and_missing_title_gets_a_header() {
    let mut request = single_question_request();
    let properties = request["requestedSchema"]["properties"]
        .as_object_mut()
        .expect("properties");
    properties.remove("question_0_custom");
    properties["question_0"]
        .as_object_mut()
        .expect("field")
        .remove("title");
    let doc = card(&ask_prompt_from_request(&request).expect("card").content);
    assert_eq!(doc["questions"][0]["allowOther"], false);
    assert_eq!(doc["questions"][0]["header"], "Question 1");
}

pub(crate) fn answer(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
    pairs
        .iter()
        .map(|(id, choices)| {
            (
                id.to_string(),
                choices.iter().map(|c| c.to_string()).collect(),
            )
        })
        .collect()
}

#[test]
fn answers_map_back_to_the_shape_claude_reads() {
    let single = ask_prompt_from_request(&single_question_request()).expect("card");
    assert_eq!(
        accept_content(&single.questions, &answer(&[("question_0", &["OAuth"])])),
        json!({"question_0": "OAuth"})
    );
    assert_eq!(
        accept_content(&single.questions, &answer(&[("question_0", &["mTLS"])])),
        json!({"question_0_custom": "mTLS"})
    );
    let two = ask_prompt_from_request(&two_question_request()).expect("card");
    assert_eq!(
        accept_content(
            &two.questions,
            &answer(&[
                ("question_0", &["Padded"]),
                ("question_1", &["Web", "Mobile", "Desktop app"]),
            ])
        ),
        json!({
            "question_0": " Padded ",
            "question_1": ["Web", "Mobile"],
            "question_1_custom": "Desktop app",
        })
    );
    assert_eq!(
        accept_content(
            &two.questions,
            &answer(&[("question_0", &["OAuth"]), ("question_1", &["Only typed"])])
        ),
        json!({"question_0": "OAuth", "question_1_custom": "Only typed"})
    );
}

#[test]
fn only_answers_to_the_agents_own_questions_conform() {
    let two = ask_prompt_from_request(&two_question_request()).expect("card");
    let conforms = |pairs: &[(&str, &[&str])]| answer_conforms(&two.questions, &answer(pairs));
    assert!(conforms(&[
        ("question_0", &["OAuth"]),
        ("question_1", &["Web", "Mobile", "Desktop app"]),
    ]));
    assert!(conforms(&[
        ("question_0", &["mTLS"]),
        ("question_1", &["CLI"])
    ]));
    // A different set of questions.
    assert!(!conforms(&[("question_0", &["OAuth"])]));
    assert!(!conforms(&[
        ("question_0", &["OAuth"]),
        ("question_1", &["Web"]),
        ("question_2", &["Web"]),
    ]));
    // Single-select rewritten as multi-select.
    assert!(!conforms(&[
        ("question_0", &["Padded", "OAuth"]),
        ("question_1", &["Web"]),
    ]));
    // Empty, duplicated, or two typed answers.
    assert!(!conforms(&[
        ("question_0", &["OAuth"]),
        ("question_1", &[])
    ]));
    assert!(!conforms(&[
        ("question_0", &["OAuth"]),
        ("question_1", &["Web", "Web"])
    ]));
    assert!(!conforms(&[
        ("question_0", &["OAuth"]),
        ("question_1", &["Desktop", "Watch"]),
    ]));
    // An invented label where "Other" is not allowed.
    let mut request = single_question_request();
    request["requestedSchema"]["properties"]
        .as_object_mut()
        .expect("properties")
        .remove("question_0_custom");
    let closed = ask_prompt_from_request(&request).expect("card");
    assert!(answer_conforms(
        &closed.questions,
        &answer(&[("question_0", &["OAuth"])])
    ));
    assert!(!answer_conforms(
        &closed.questions,
        &answer(&[("question_0", &["mTLS"])])
    ));
}

#[test]
fn other_elicitations_are_declined() {
    let refusal_fallback = json!({"mode": "form", "sessionId": "s", "message": "Retry?",
        "requestedSchema": {"type": "object", "properties": {"choice": {"type": "string",
            "oneOf": [{"const": "retry_fallback", "title": "Retry"}]}}}});
    let mcp_form = json!({"mode": "form", "sessionId": "s", "message": "Token?",
        "requestedSchema": {"type": "object", "properties": {
            "question_0": {"type": "string", "oneOf": [{"const": "a", "title": "a"}]},
            "token": {"type": "string"}}}});
    let url = json!({"mode": "url", "sessionId": "s", "message": "Log in",
        "url": "https://example.com", "elicitationId": "e"});
    let free_text = json!({"mode": "form", "sessionId": "s", "message": "Name?",
        "requestedSchema": {"type": "object", "properties": {"question_0": {"type": "string"}}}});
    for (name, request) in [
        ("refusal fallback", refusal_fallback),
        ("mcp form", mcp_form),
        ("url", url),
        ("free text", free_text),
    ] {
        assert!(
            matches!(
                ask_prompt_from_request(&request),
                Err(Unsupported::NotAskUserQuestion(_))
            ),
            "{name}"
        );
    }
}

#[test]
fn questions_the_card_cannot_hold_are_unrenderable() {
    let mut nine = single_question_request();
    nine["requestedSchema"]["properties"]["question_0"]["oneOf"] = (0..9)
        .map(|i| json!({"const": format!("o{i}"), "title": format!("o{i}")}))
        .collect();
    let mut long_label = single_question_request();
    long_label["requestedSchema"]["properties"]["question_0"]["oneOf"][0]["const"] =
        json!("x".repeat(201));
    let mut duplicate = single_question_request();
    duplicate["requestedSchema"]["properties"]["question_0"]["oneOf"][1]["const"] =
        json!(" API key (Recommended)");
    let mut five = json!({"mode": "form", "sessionId": "s", "message": "m",
        "requestedSchema": {"type": "object", "properties": {}}});
    for n in 0..5 {
        five["requestedSchema"]["properties"][format!("question_{n}")] =
            json!({"type": "string", "oneOf": [{"const": "a", "title": "a"}]});
    }
    for (name, request) in [
        ("nine options", nine),
        ("long label", long_label),
        ("duplicate trimmed label", duplicate),
        ("five questions", five),
    ] {
        assert!(
            matches!(
                ask_prompt_from_request(&request),
                Err(Unsupported::Unrenderable(_))
            ),
            "{name}"
        );
    }
}

pub(crate) const CHANNEL: &str = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";

/// In-memory relay: records submitted events; once `answer_after` head reads
/// have seen the card open, it lands `answer` as a revision signed by the
/// answerer.
pub(crate) struct FakeRelay {
    events: Mutex<Vec<Event>>,
    head_reads: Mutex<usize>,
    answer_after: usize,
    answer: Option<(Keys, Value)>,
    /// Applied to the answered revision's content, to play a client that
    /// rewrites the questions while answering.
    rewrite: Option<fn(&mut serde_json::Map<String, Value>)>,
}

impl FakeRelay {
    pub(crate) fn new(answer_after: usize, answer: Option<(Keys, Value)>) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            head_reads: Mutex::new(0),
            answer_after,
            answer,
            rewrite: None,
        })
    }

    fn rewriting(
        answer: (Keys, Value),
        rewrite: fn(&mut serde_json::Map<String, Value>),
    ) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            head_reads: Mutex::new(0),
            answer_after: 1,
            answer: Some(answer),
            rewrite: Some(rewrite),
        })
    }

    pub(crate) fn submitted(&self) -> Vec<Event> {
        self.events.lock().expect("lock").clone()
    }

    fn current(&self, d: &str) -> Option<Event> {
        let events = self.events.lock().expect("lock");
        events
            .iter()
            .rev()
            .find(|e| {
                e.kind.as_u16() == KIND_ARTIFACT && e.tags.iter().any(|t| t.as_slice() == ["d", d])
            })
            .cloned()
    }

    fn answered(&self, d: &str, head: &Event, keys: &Keys, answer: &Value) -> Event {
        let mut content: serde_json::Map<String, Value> =
            serde_json::from_str(&head.content).expect("content");
        content.insert("state".into(), "answered".into());
        content.insert("answer".into(), answer.clone());
        content.insert("answeredBy".into(), keys.public_key().to_hex().into());
        if let Some(rewrite) = self.rewrite {
            rewrite(&mut content);
        }
        let tags =
            build_prompt_update_tags(d, CHANNEL, "t", None, &head.id.to_hex()).expect("tags");
        let content = serde_json::to_string(&content).expect("json");
        EventBuilder::new(Kind::Custom(KIND_ARTIFACT), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign")
    }

    /// Wait until `count` events have been submitted.
    pub(crate) async fn wait_for(&self, count: usize) -> Vec<Event> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let events = self.submitted();
                if events.len() >= count {
                    return events;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("events submitted in time")
    }
}

impl QuestionRelay for FakeRelay {
    fn submit<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.events.lock().expect("lock").push(event.clone());
            Ok(())
        })
    }

    fn head<'a>(&'a self, _: Uuid, d: &'a str) -> BoxFuture<'a, Result<Option<Event>, String>> {
        Box::pin(async move {
            let Some(head) = self.current(d) else {
                return Ok(None);
            };
            let open =
                parse_prompt_state(&head.content, &head.pubkey.to_hex()) == Some(PromptState::Open);
            let Some((keys, answer)) = self.answer.as_ref().filter(|_| open) else {
                return Ok(Some(head));
            };
            let reads = {
                let mut reads = self.head_reads.lock().expect("lock");
                *reads += 1;
                *reads
            };
            if reads < self.answer_after {
                return Ok(Some(head));
            }
            let answered = self.answered(d, &head, keys, answer);
            self.events.lock().expect("lock").push(answered.clone());
            Ok(Some(answered))
        })
    }
}

pub(crate) fn asker(relay: Arc<dyn QuestionRelay>, thread_root: Option<EventId>) -> QuestionAsker {
    QuestionAsker::new(
        relay,
        Keys::generate(),
        Uuid::parse_str(CHANNEL).expect("uuid"),
        thread_root,
        Some("Fizz".into()),
    )
    .with_poll_interval(Duration::from_millis(10))
}

pub(crate) fn tag<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some(name))
        .and_then(|t| t.as_slice().get(1).map(String::as_str))
}

#[tokio::test]
async fn posts_an_anchor_and_a_card_then_returns_the_first_answer() {
    let answerer = Keys::generate();
    let relay = FakeRelay::new(3, Some((answerer, json!({"question_0": ["OAuth"]}))));
    let root = EventId::from_hex(&"b".repeat(64)).expect("id");
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let handle = asker(relay.clone(), Some(root)).ask(&prompt);
    let outcome = tokio::time::timeout(Duration::from_secs(5), handle.outcome_rx)
        .await
        .expect("answered in time")
        .expect("outcome");
    assert_eq!(
        outcome,
        QuestionOutcome::Answered(answer(&[("question_0", &["OAuth"])]))
    );
    let events = relay.submitted();
    let (anchor, create) = (&events[0], &events[1]);
    assert_eq!(anchor.kind.as_u16(), 9);
    assert_eq!(
        anchor.content,
        "Fizz asks: Which auth method should the endpoint use?"
    );
    assert_eq!(tag(anchor, "h"), Some(CHANNEL));
    assert_eq!(tag(anchor, "e"), Some(root.to_hex().as_str()));
    buzz_core::artifact::validate(create).expect("relay-valid create");
    assert_eq!(tag(create, "type"), Some("buzz.agent_prompt"));
    assert_eq!(tag(create, "root"), Some(anchor.id.to_hex().as_str()));
    assert_eq!(tag(create, "op"), Some("create"));
}

/// Re-signs answered heads with a stranger's key, so `answeredBy` no longer
/// names the signer.
struct ForgedAnswers(Arc<FakeRelay>);

impl QuestionRelay for ForgedAnswers {
    fn submit<'a>(&'a self, event: &'a Event) -> BoxFuture<'a, Result<(), String>> {
        self.0.submit(event)
    }

    fn head<'a>(&'a self, c: Uuid, d: &'a str) -> BoxFuture<'a, Result<Option<Event>, String>> {
        Box::pin(async move {
            Ok(self.0.head(c, d).await?.map(|head| {
                EventBuilder::new(head.kind, head.content.clone())
                    .tags(head.tags.iter().cloned())
                    .sign_with_keys(&Keys::generate())
                    .expect("sign")
            }))
        })
    }
}

#[tokio::test]
async fn an_answer_not_signed_by_its_answerer_is_ignored() {
    let relay = FakeRelay::new(
        1,
        Some((Keys::generate(), json!({"question_0": ["OAuth"]}))),
    );
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let handle = asker(Arc::new(ForgedAnswers(relay)), None).ask(&prompt);
    let waited = tokio::time::timeout(Duration::from_millis(300), handle.outcome_rx).await;
    assert!(
        waited.is_err(),
        "a forged answer must not resolve the question"
    );
}

async fn assert_unresolved(request: Value, relay: Arc<dyn QuestionRelay>) {
    let prompt = ask_prompt_from_request(&request).expect("card");
    let handle = asker(relay, None).ask(&prompt);
    let waited = tokio::time::timeout(Duration::from_millis(300), handle.outcome_rx).await;
    assert!(
        waited.is_err(),
        "a rewritten card must not resolve the question"
    );
}

#[tokio::test]
async fn an_answer_that_makes_a_single_select_multi_select_is_ignored() {
    let both = json!({"question_0": ["API key (Recommended)", "OAuth"]});
    let relay = FakeRelay::rewriting((Keys::generate(), both), |content| {
        content["questions"][0]["multiSelect"] = true.into();
    });
    assert_unresolved(single_question_request(), relay).await;
}

#[tokio::test]
async fn an_answer_with_an_invented_option_is_ignored() {
    // The agent's question does not allow "Other", so a label it did not
    // offer can only be an option the answering client added.
    let mut request = single_question_request();
    request["requestedSchema"]["properties"]
        .as_object_mut()
        .expect("properties")
        .remove("question_0_custom");
    let invented = json!({"question_0": ["Basic auth"]});
    let relay = FakeRelay::rewriting((Keys::generate(), invented), |content| {
        content["questions"][0]["options"]
            .as_array_mut()
            .expect("options")
            .push(json!({"label": "Basic auth"}));
    });
    assert_unresolved(request, relay).await;
}

#[tokio::test]
async fn cancelling_withdraws_the_open_card() {
    let relay = FakeRelay::new(0, None);
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let handle = asker(relay.clone(), None).ask(&prompt);
    relay.wait_for(2).await;
    handle.cancel_tx.send(()).expect("task alive");
    let events = relay.wait_for(3).await;
    let (create, cancelled) = (&events[1], &events[2]);
    buzz_core::artifact::validate(cancelled).expect("relay-valid update");
    assert_eq!(tag(cancelled, "op"), Some("update"));
    assert_eq!(tag(cancelled, "prev"), Some(create.id.to_hex().as_str()));
    assert_eq!(tag(cancelled, "root"), tag(create, "root"));
    assert_eq!(tag(cancelled, "title"), tag(create, "title"));
    assert_eq!(
        parse_prompt_state(&cancelled.content, &cancelled.pubkey.to_hex()),
        Some(PromptState::Cancelled)
    );
    assert!(handle.outcome_rx.await.is_err(), "no outcome after cancel");
}

#[tokio::test]
async fn dropping_the_handle_also_withdraws_the_card() {
    let relay = FakeRelay::new(0, None);
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let handle = asker(relay.clone(), None).ask(&prompt);
    relay.wait_for(2).await;
    drop(handle);
    let events = relay.wait_for(3).await;
    assert_eq!(
        parse_prompt_state(&events[2].content, &events[2].pubkey.to_hex()),
        Some(PromptState::Cancelled)
    );
}

#[tokio::test]
async fn a_card_withdrawn_elsewhere_resolves_as_withdrawn() {
    let relay = FakeRelay::new(0, None);
    let prompt = ask_prompt_from_request(&single_question_request()).expect("card");
    let handle = asker(relay.clone(), None).ask(&prompt);
    let events = relay.wait_for(2).await;
    // Another client withdraws it.
    let d = tag(&events[1], "d").expect("d").to_string();
    asker(relay.clone(), None).withdraw(&d).await;
    let outcome = tokio::time::timeout(Duration::from_secs(5), handle.outcome_rx)
        .await
        .expect("resolved")
        .expect("outcome");
    assert_eq!(outcome, QuestionOutcome::Withdrawn);
}
