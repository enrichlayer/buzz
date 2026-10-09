//! Permission cards are a strict, owner-only specialization of agent prompts.
use crate::agent_questions::{AskPrompt, AskQuestion, QuestionAsker};
use serde_json::{json, Value};

pub(super) fn permission_prompt(msg: &Value, asker: &QuestionAsker) -> Result<AskPrompt, String> {
    let owner = asker.permission_owner.ok_or("no permission owner")?;
    let params = &msg["params"];
    let tool = params
        .get("toolCall")
        .or_else(|| params.pointer("/subject/toolCall"))
        .filter(|v| v.is_object())
        .ok_or("missing tool call")?;
    if tool.to_string().len() > 64_000 {
        return Err("tool call is too large to review".into());
    }
    let options = params["options"].as_array().ok_or("missing options")?;
    let option = |kind: &str| -> Result<String, String> {
        let found: Vec<_> = options.iter().filter(|v| v["kind"] == kind).collect();
        if found.len() != 1 {
            return Err(format!("expected exactly one {kind} option"));
        }
        found[0]["optionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or("missing option ID".into())
    };
    let allow = option("allow_once")?;
    // Deny can always cancel, even when the adapter offers no reject option.
    let deny = option("reject_once").unwrap_or_default();
    if !deny.is_empty() && allow == deny {
        return Err("ambiguous permission options".into());
    }
    let title = "Allow this agent action?".to_string();
    let command = tool.pointer("/rawInput/command").and_then(Value::as_str);
    let cwd = tool
        .pointer("/rawInput/cwd")
        .and_then(Value::as_str)
        .filter(|v| std::path::Path::new(v).is_absolute())
        .unwrap_or(&asker.permission_cwd);
    let permission = json!({
        "version": 1, "ownerPubkey": owner.to_hex(), "agentPubkey": asker.agent_pubkey(),
        "requestId": msg["id"], "sessionId": params["sessionId"],
        "cwd": cwd, "command": command, "toolCall": tool,
    });
    let mut doc = json!({"permission": permission, "questions": [{
        "id": "permission", "header": "Permission", "question": title,
        "multiSelect": false, "allowOther": false,
        "options": [{"label": "Allow once"}, {"label": "Deny"}]
    }]})
    .as_object()
    .cloned()
    .ok_or("could not construct permission prompt")?;
    doc.insert("kind".into(), "question".into());
    let (content, _) = buzz_sdk::agent_prompt::build_open_prompt(doc).map_err(|e| e.to_string())?;
    Ok(AskPrompt {
        title,
        content,
        questions: vec![AskQuestion {
            field: "permission".into(),
            multi_select: false,
            allow_other: false,
            options: vec![("Allow once".into(), allow), ("Deny".into(), deny)],
        }],
    })
}
