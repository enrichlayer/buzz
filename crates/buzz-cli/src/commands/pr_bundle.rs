//! Review bundles: several stacked pull requests reviewed as one unit.
//!
//! A bundle root is a kind:1 note labelled `review-bundle` whose `e` tags with
//! the `bundle-member` marker list the member pull requests in stack order,
//! parent first; tag order is part of the signed event, so the order needs no
//! extra index. A bundle verdict is a kind:1 note rooted at the bundle whose
//! `member-head` tags pin the head every member was reviewed at, so a restack
//! that moves any member head makes the verdict historical, exactly as a
//! per-PR verdict is tied to its `c` tag. Per-member findings and verdicts stay
//! ordinary review notes on each member (`pr_review.rs`); the bundle verdict
//! may reference them with `member-verdict` markers.

use super::pr_review::{note, recipient_tags, repo_coord, tag, validate_commit, ReviewDecision};
use crate::client::BuzzClient;
use crate::error::CliError;
use crate::validate::{sdk_err, validate_hex64};
use buzz_sdk::GitRepoCoord;
use nostr::Tag;

/// `t` label of a bundle root.
pub(crate) const BUNDLE_LABEL: &str = "review-bundle";
/// `t` label of an approving bundle verdict.
pub(crate) const BUNDLE_APPROVAL_LABEL: &str = "bundle-approval";
/// `t` label of a changes-requested bundle verdict.
pub(crate) const BUNDLE_CHANGES_REQUESTED_LABEL: &str = "bundle-changes-requested";
/// `e` marker of a member pull request on the bundle root.
pub(crate) const MEMBER_MARKER: &str = "bundle-member";
/// `e` marker of a per-member verdict note referenced by a bundle verdict.
pub(crate) const MEMBER_VERDICT_MARKER: &str = "member-verdict";
/// Subject length the SDK allows for a pull request; bundles match it.
const MAX_SUBJECT: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BundleMember {
    pub pr: String,
    pub bookmark: Option<String>,
}

/// `<pr event id>` or `<pr event id>:<bookmark>`.
pub(crate) fn parse_member(spec: &str) -> Result<BundleMember, CliError> {
    let (pr, bookmark) = match spec.split_once(':') {
        Some((pr, bookmark)) => (pr, Some(bookmark)),
        None => (spec, None),
    };
    validate_hex64(pr)?;
    let bookmark = match bookmark {
        Some(name) if name.is_empty() || name.contains(char::is_whitespace) => {
            return Err(CliError::Usage(
                "a member bookmark must be a single branch name".into(),
            ))
        }
        Some(name) => Some(name.to_string()),
        None => None,
    };
    Ok(BundleMember {
        pr: pr.to_ascii_lowercase(),
        bookmark,
    })
}

/// `<pr event id>:<40-hex commit>`.
pub(crate) fn parse_member_head(spec: &str) -> Result<(String, String), CliError> {
    let Some((pr, commit)) = spec.split_once(':') else {
        return Err(CliError::Usage(
            "--member-head takes <pr event id>:<commit>".into(),
        ));
    };
    validate_hex64(pr)?;
    validate_commit(commit)?;
    Ok((pr.to_ascii_lowercase(), commit.to_string()))
}

fn bundle_decision_label(decision: ReviewDecision) -> &'static str {
    match decision {
        ReviewDecision::Approve => BUNDLE_APPROVAL_LABEL,
        ReviewDecision::RequestChanges => BUNDLE_CHANGES_REQUESTED_LABEL,
    }
}

/// Tags of a bundle root. Members keep the order given; a repeated member is
/// an error because stack order would be ambiguous.
pub(crate) fn bundle_root_tags(
    repo: &GitRepoCoord,
    subject: &str,
    members: &[BundleMember],
    reviewers: &[String],
    workspace: Option<&str>,
    linear_issue: Option<&Tag>,
) -> Result<Vec<Tag>, CliError> {
    if subject.trim().is_empty() || subject.len() > MAX_SUBJECT {
        return Err(CliError::Usage(format!(
            "--subject must be 1 to {MAX_SUBJECT} characters"
        )));
    }
    if members.len() < 2 {
        return Err(CliError::Usage(
            "a bundle needs at least two --member pull requests".into(),
        ));
    }
    let mut tags = vec![
        tag(&["a", &repo.to_a_tag_value().map_err(sdk_err)?])?,
        tag(&["subject", subject])?,
        tag(&["t", BUNDLE_LABEL])?,
    ];
    let mut seen: Vec<&str> = Vec::new();
    for member in members {
        if seen.contains(&member.pr.as_str()) {
            return Err(CliError::Usage(format!(
                "member {} is listed twice",
                member.pr
            )));
        }
        seen.push(&member.pr);
        tags.push(tag(&["e", &member.pr, "", MEMBER_MARKER])?);
        if let Some(bookmark) = &member.bookmark {
            tags.push(tag(&["bookmark", &member.pr, bookmark])?);
        }
    }
    tags.extend(recipient_tags(&repo.owner, reviewers)?);
    if let Some(workspace) = workspace {
        if workspace.is_empty() || workspace.contains(char::is_whitespace) {
            return Err(CliError::Usage("--workspace must be one identifier".into()));
        }
        tags.push(tag(&["workspace", workspace])?);
    }
    if let Some(issue) = linear_issue {
        tags.push(issue.clone());
    }
    Ok(tags)
}

/// Tags of a bundle verdict: rooted at the bundle, one `member-head` per
/// reviewed member, optional references to the per-member verdict notes.
pub(crate) fn bundle_verdict_tags(
    repo: &GitRepoCoord,
    bundle: &str,
    to: &[String],
    decision: ReviewDecision,
    member_heads: &[(String, String)],
    member_verdicts: &[String],
) -> Result<Vec<Tag>, CliError> {
    validate_hex64(bundle)?;
    if member_heads.is_empty() {
        return Err(CliError::Usage(
            "a bundle verdict needs one --member-head per reviewed member".into(),
        ));
    }
    let mut tags = vec![
        tag(&["e", &bundle.to_ascii_lowercase(), "", "root"])?,
        tag(&["a", &repo.to_a_tag_value().map_err(sdk_err)?])?,
    ];
    tags.extend(recipient_tags(&repo.owner, to)?);
    tags.push(tag(&["t", bundle_decision_label(decision)])?);
    let mut seen: Vec<&str> = Vec::new();
    for (pr, commit) in member_heads {
        if seen.contains(&pr.as_str()) {
            return Err(CliError::Usage(format!(
                "member {pr} has two heads in this verdict"
            )));
        }
        seen.push(pr);
        tags.push(tag(&["member-head", pr, commit])?);
    }
    for verdict in member_verdicts {
        validate_hex64(verdict)?;
        tags.push(tag(&[
            "e",
            &verdict.to_ascii_lowercase(),
            "",
            MEMBER_VERDICT_MARKER,
        ])?);
    }
    Ok(tags)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_bundle_open(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    subject: &str,
    content: &str,
    members: &[String],
    reviewers: &[String],
    workspace: Option<&str>,
    linear_issue: Option<&str>,
) -> Result<(), CliError> {
    let repo = repo_coord(repo_owner, repo_id)?;
    let members = members
        .iter()
        .map(|spec| parse_member(spec))
        .collect::<Result<Vec<_>, _>>()?;
    let issue = linear_issue
        .map(super::pr_session::linear_issue_tag)
        .transpose()?;
    let tags = bundle_root_tags(
        &repo,
        subject,
        &members,
        reviewers,
        workspace,
        issue.as_ref(),
    )?;
    let content = if content.trim().is_empty() {
        subject
    } else {
        content
    };
    let event = client.sign_event(note(content, tags)?)?;
    let event_id = event.id.to_hex();
    let resp = client.submit_event(event).await?;
    let link = crate::links::bundle_link(&event_id, &repo.owner, &repo.id);
    crate::client::print_create_response(&resp, "link", &link);
    Ok(())
}

/// A verdict counts only while it pins every member of the bundle and nothing
/// outside it (`reviewBundles.ts`); the CLI refuses the note instead of
/// publishing one the reader would ignore.
pub(crate) fn check_head_coverage(
    members: &[String],
    heads: &[(String, String)],
) -> Result<(), CliError> {
    for member in members {
        if !heads.iter().any(|(pr, _)| pr == member) {
            return Err(CliError::Usage(format!(
                "bundle member {member} has no --member-head; a bundle verdict pins every member"
            )));
        }
    }
    for (pr, _) in heads {
        if !members.contains(pr) {
            return Err(CliError::Usage(format!(
                "{pr} is not a member of this bundle"
            )));
        }
    }
    Ok(())
}

/// Member pull requests of a bundle root, in stack order, read from the relay.
async fn bundle_members(client: &BuzzClient, bundle: &str) -> Result<Vec<String>, CliError> {
    let response = client
        .query(&serde_json::json!({"ids": [bundle], "limit": 1}))
        .await?;
    let events: Vec<nostr::Event> = serde_json::from_str(&response)
        .map_err(|error| CliError::Other(format!("invalid bundle response: {error}")))?;
    let root = events
        .iter()
        .find(|event| event.id.to_hex() == bundle)
        .ok_or_else(|| {
            CliError::Usage(
                "--bundle root was not found on the relay; no verdict was published".into(),
            )
        })?;
    let tags: Vec<&[String]> = root.tags.iter().map(|tag| tag.as_slice()).collect();
    let labelled = tags.iter().any(|parts| {
        parts.first().map(String::as_str) == Some("t")
            && parts.get(1).map(String::as_str) == Some(BUNDLE_LABEL)
    });
    if !labelled {
        return Err(CliError::Usage(
            "--bundle is not a review bundle root".into(),
        ));
    }
    Ok(tags
        .iter()
        .filter(|parts| {
            parts.first().map(String::as_str) == Some("e")
                && parts.get(3).map(String::as_str) == Some(MEMBER_MARKER)
        })
        .filter_map(|parts| parts.get(1).map(|pr| pr.to_ascii_lowercase()))
        .collect())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_bundle_review(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    bundle: &str,
    decision: ReviewDecision,
    member_heads: &[String],
    member_verdicts: &[String],
    content: &str,
    to: &[String],
) -> Result<(), CliError> {
    let repo = repo_coord(repo_owner, repo_id)?;
    let heads = member_heads
        .iter()
        .map(|spec| parse_member_head(spec))
        .collect::<Result<Vec<_>, _>>()?;
    validate_hex64(bundle)?;
    let members = bundle_members(client, &bundle.to_ascii_lowercase()).await?;
    check_head_coverage(&members, &heads)?;
    let tags = bundle_verdict_tags(&repo, bundle, to, decision, &heads, member_verdicts)?;
    let content = if content.trim().is_empty() {
        decision.default_content()
    } else {
        content
    };
    let event = client.sign_event(note(content, tags)?)?;
    let resp = client.submit_event(event).await?;
    let link = crate::links::bundle_link(bundle, &repo.owner, &repo.id);
    crate::client::print_create_response(&resp, "link", &link);
    Ok(())
}

/// Print the signed bundle root and every note rooted at it.
pub(crate) async fn cmd_bundle_get(client: &BuzzClient, bundle: &str) -> Result<(), CliError> {
    validate_hex64(bundle)?;
    let bundle = bundle.to_ascii_lowercase();
    let resp = client
        .query_multi(&[
            serde_json::json!({"kinds": [1], "ids": [bundle], "limit": 1}),
            serde_json::json!({"kinds": [1], "#e": [bundle], "limit": 500}),
        ])
        .await?;
    println!("{resp}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REVIEWER: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const HEAD_A: &str = "1111111111111111111111111111111111111111";
    const HEAD_B: &str = "2222222222222222222222222222222222222222";

    fn repo() -> GitRepoCoord {
        repo_coord(OWNER, "demo").unwrap()
    }

    fn member(fill: char, bookmark: Option<&str>) -> BundleMember {
        BundleMember {
            pr: fill.to_string().repeat(64),
            bookmark: bookmark.map(String::from),
        }
    }

    fn slices(tags: &[Tag]) -> Vec<Vec<String>> {
        tags.iter().map(|tag| tag.as_slice().to_vec()).collect()
    }

    #[test]
    fn member_specs_parse_with_optional_bookmark() {
        let plain = parse_member(&"d".repeat(64)).unwrap();
        assert_eq!(plain, member('d', None));
        let named = parse_member(&format!("{}:feature/DEV-1-a", "D".repeat(64))).unwrap();
        assert_eq!(named, member('d', Some("feature/DEV-1-a")));
        assert!(parse_member(&format!("{}:", "d".repeat(64))).is_err());
        assert!(parse_member("nothex").is_err());
        let (pr, commit) =
            parse_member_head(&format!("{}:{}", "d".repeat(64), HEAD_A.to_uppercase())).unwrap();
        assert_eq!(
            (pr.as_str(), commit.as_str()),
            ("d".repeat(64).as_str(), HEAD_A)
        );
        assert!(parse_member_head(&"d".repeat(64)).is_err());
    }

    #[test]
    fn bundle_root_keeps_member_order_and_refuses_repeats() {
        let issue =
            Tag::parse(["r", "https://linear.app/acme/issue/DEV-1", "linear-issue"]).unwrap();
        let tags = bundle_root_tags(
            &repo(),
            "Stack DEV-1",
            &[member('d', Some("feature/a")), member('e', None)],
            &[REVIEWER.into()],
            Some("ws-1"),
            Some(&issue),
        )
        .unwrap();
        let tags = slices(&tags);
        let members: Vec<_> = tags
            .iter()
            .filter(|tag| tag[0] == "e" && tag.get(3).map(String::as_str) == Some(MEMBER_MARKER))
            .map(|tag| tag[1].clone())
            .collect();
        assert_eq!(members, vec!["d".repeat(64), "e".repeat(64)]);
        assert!(tags.contains(&vec!["bookmark".into(), "d".repeat(64), "feature/a".into()]));
        assert!(tags.contains(&vec!["t".into(), BUNDLE_LABEL.into()]));
        assert!(tags.contains(&vec!["p".into(), OWNER.into()]));
        assert!(tags.contains(&vec!["p".into(), REVIEWER.into()]));
        assert!(tags.contains(&vec!["workspace".into(), "ws-1".into()]));
        assert!(tags.contains(&vec![
            "r".into(),
            "https://linear.app/acme/issue/DEV-1".into(),
            "linear-issue".into()
        ]));
        assert!(bundle_root_tags(&repo(), "one", &[member('d', None)], &[], None, None).is_err());
        assert!(bundle_root_tags(
            &repo(),
            "dup",
            &[member('d', None), member('d', None)],
            &[],
            None,
            None
        )
        .is_err());
        assert!(bundle_root_tags(
            &repo(),
            "",
            &[member('d', None), member('e', None)],
            &[],
            None,
            None
        )
        .is_err());
        assert!(bundle_root_tags(
            &repo(),
            "ws",
            &[member('d', None), member('e', None)],
            &[],
            Some("two words"),
            None
        )
        .is_err());
    }

    #[test]
    fn bundle_verdict_pins_every_member_head() {
        let bundle = "f".repeat(64);
        let tags = bundle_verdict_tags(
            &repo(),
            &bundle,
            &[],
            ReviewDecision::RequestChanges,
            &[
                ("d".repeat(64), HEAD_A.into()),
                ("e".repeat(64), HEAD_B.into()),
            ],
            &["9".repeat(64)],
        )
        .unwrap();
        let tags = slices(&tags);
        assert_eq!(tags[0], vec!["e", &bundle, "", "root"]);
        assert!(tags.contains(&vec!["t".into(), BUNDLE_CHANGES_REQUESTED_LABEL.into()]));
        assert!(tags.contains(&vec!["member-head".into(), "d".repeat(64), HEAD_A.into()]));
        assert!(tags.contains(&vec!["member-head".into(), "e".repeat(64), HEAD_B.into()]));
        assert!(tags.contains(&vec![
            "e".into(),
            "9".repeat(64),
            "".into(),
            MEMBER_VERDICT_MARKER.into()
        ]));
        assert!(
            bundle_verdict_tags(&repo(), &bundle, &[], ReviewDecision::Approve, &[], &[]).is_err()
        );
        assert!(bundle_verdict_tags(
            &repo(),
            &bundle,
            &[],
            ReviewDecision::Approve,
            &[
                ("d".repeat(64), HEAD_A.into()),
                ("d".repeat(64), HEAD_B.into())
            ],
            &[]
        )
        .is_err());
    }

    #[test]
    fn a_verdict_covers_every_member_and_nothing_else() {
        let members = ["d".repeat(64), "e".repeat(64)];
        let head = |fill: char, commit: &str| (fill.to_string().repeat(64), commit.to_string());
        check_head_coverage(&members, &[head('d', HEAD_A), head('e', HEAD_B)]).unwrap();
        check_head_coverage(&members, &[head('e', HEAD_B), head('d', HEAD_A)]).unwrap();
        let missing = check_head_coverage(&members, &[head('d', HEAD_A)]).unwrap_err();
        assert!(
            missing.to_string().contains("has no --member-head"),
            "{missing}"
        );
        let stranger = check_head_coverage(
            &members,
            &[head('d', HEAD_A), head('e', HEAD_B), head('f', HEAD_A)],
        )
        .unwrap_err();
        assert!(stranger.to_string().contains("not a member"), "{stranger}");
    }

    #[tokio::test]
    async fn bundle_open_and_verdict_publish_signed_notes_the_relay_accepts() {
        use axum::{body::Bytes, extract::State, routing::post, Router};
        use std::sync::{Arc, Mutex};
        type Published = Arc<Mutex<Vec<nostr::Event>>>;
        let published: Published = Arc::new(Mutex::new(vec![]));
        let app = Router::new()
            .route(
                "/query",
                post(|State(state): State<Published>| async move {
                    serde_json::to_string(&*state.lock().unwrap()).unwrap()
                }),
            )
            .route(
                "/events",
                post(|State(state): State<Published>, body: Bytes| async move {
                    let event: nostr::Event = serde_json::from_slice(&body).unwrap();
                    let id = event.id.to_hex();
                    state.lock().unwrap().push(event);
                    serde_json::json!({"event_id": id, "accepted": true, "message": ""}).to_string()
                }),
            )
            .with_state(published.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let keys = nostr::Keys::generate();
        let client = BuzzClient::new(url, keys.clone(), None, None).unwrap();
        let members = [format!("{}:feature/a", "d".repeat(64)), "e".repeat(64)];
        cmd_bundle_open(
            &client,
            OWNER,
            "demo",
            "Stack DEV-1",
            "",
            &members,
            &[REVIEWER.into()],
            Some("ws-1"),
            Some("https://linear.app/acme/issue/DEV-1?x=1"),
        )
        .await
        .unwrap();
        assert!(cmd_bundle_open(
            &client,
            OWNER,
            "demo",
            "Half",
            "",
            &members[..1],
            &[],
            None,
            None
        )
        .await
        .is_err());
        let root_id = published.lock().unwrap()[0].id.to_hex();
        // A verdict that leaves a member unpinned, pins a stranger, or names a
        // root the relay does not hold is refused before anything is signed.
        for (bundle, heads) in [
            (
                root_id.clone(),
                vec![format!("{}:{HEAD_A}", "d".repeat(64))],
            ),
            (
                root_id.clone(),
                vec![
                    format!("{}:{HEAD_A}", "d".repeat(64)),
                    format!("{}:{HEAD_B}", "e".repeat(64)),
                    format!("{}:{HEAD_A}", "f".repeat(64)),
                ],
            ),
            ("f".repeat(64), vec![format!("{}:{HEAD_A}", "d".repeat(64))]),
        ] {
            assert!(cmd_bundle_review(
                &client,
                OWNER,
                "demo",
                &bundle,
                ReviewDecision::Approve,
                &heads,
                &[],
                "",
                &[]
            )
            .await
            .is_err());
        }
        cmd_bundle_review(
            &client,
            OWNER,
            "demo",
            &root_id,
            ReviewDecision::Approve,
            &[
                format!("{}:{HEAD_A}", "d".repeat(64)),
                format!("{}:{HEAD_B}", "e".repeat(64)),
            ],
            &[],
            "",
            &[],
        )
        .await
        .unwrap();
        let events = published.lock().unwrap();
        assert_eq!(
            events.len(),
            2,
            "the invalid bundle and the refused verdicts must never reach /events"
        );
        for event in events.iter() {
            assert!(event.verify().is_ok());
            assert_eq!(event.kind.as_u16(), 1);
        }
        assert!(events[0]
            .tags
            .iter()
            .any(|tag| tag.as_slice()
                == ["r", "https://linear.app/acme/issue/DEV-1", "linear-issue"]));
        assert!(events[1]
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["e", root_id.as_str(), "", "root"]));
        assert_eq!(events[1].content, "Approved these changes");
        server.abort();
    }
}
