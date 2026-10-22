//! Review notes an external reviewer can publish on a pull request: comments,
//! inline findings, verdicts and review requests.
//!
//! These are the same labelled kind:1 notes Buzz Desktop signs
//! (`desktop/src/features/projects/projectPullRequests.mjs`), so a worker that
//! posts through this CLI is read by the existing review workspace without a
//! new event kind. The desktop trusts a verdict only when its signer is a
//! requested reviewer or the repository owner and its `c` tag is the current
//! head; the CLI cannot grant that trust, it only produces well-formed notes.

use crate::client::BuzzClient;
use crate::commands::with_git_provenance;
use crate::error::CliError;
use crate::validate::{sdk_err, validate_content_size, validate_hex64, validate_repo_id};
use buzz_sdk::GitRepoCoord;
use nostr::{EventBuilder, Kind, Tag};

/// `t` label of a note that requests reviewers (`p` tags name them).
pub(crate) const REVIEW_REQUEST_LABEL: &str = "review-request";
/// `t` label of an approving verdict on one head (`c` tag).
pub(crate) const APPROVAL_LABEL: &str = "approval";
/// `t` label of a changes-requested verdict on one head (`c` tag).
pub(crate) const CHANGES_REQUESTED_LABEL: &str = "changes-requested";
/// `t` label of a comment anchored to a diff line (`file`/`side`/`line`).
pub(crate) const INLINE_COMMENT_LABEL: &str = "inline-comment";

/// Longest anchor path the desktop accepts
/// (`normalizeProjectPullRequestCommentAnchor`).
const MAX_ANCHOR_PATH: usize = 4_096;

pub(crate) fn tag(parts: &[&str]) -> Result<Tag, CliError> {
    Tag::parse(parts.iter().copied()).map_err(|error| CliError::Usage(error.to_string()))
}

/// A git commit id as NIP-34 carries it: 40 hex characters.
pub(crate) fn validate_commit(commit: &str) -> Result<(), CliError> {
    if commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CliError::Usage(
            "expected a 40-character hex commit id".into(),
        ))
    }
}

pub(crate) fn repo_coord(owner: &str, id: &str) -> Result<GitRepoCoord, CliError> {
    validate_hex64(owner)?;
    validate_repo_id(id)?;
    Ok(GitRepoCoord {
        owner: owner.to_ascii_lowercase(),
        id: id.to_string(),
    })
}

/// `p` tags: the repository owner first, then explicit recipients, no repeats.
pub(crate) fn recipient_tags(owner: &str, to: &[String]) -> Result<Vec<Tag>, CliError> {
    let mut recipients = vec![owner.to_ascii_lowercase()];
    for recipient in to {
        validate_hex64(recipient)?;
        let recipient = recipient.to_ascii_lowercase();
        if !recipients.contains(&recipient) {
            recipients.push(recipient);
        }
    }
    recipients
        .iter()
        .map(|pubkey| tag(&["p", pubkey]))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReviewDecision {
    Approve,
    RequestChanges,
}

impl ReviewDecision {
    pub(crate) fn from_flags(approve: bool, request_changes: bool) -> Result<Self, CliError> {
        match (approve, request_changes) {
            (true, false) => Ok(Self::Approve),
            (false, true) => Ok(Self::RequestChanges),
            _ => Err(CliError::Usage(
                "pass exactly one of --approve or --request-changes".into(),
            )),
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Approve => APPROVAL_LABEL,
            Self::RequestChanges => CHANGES_REQUESTED_LABEL,
        }
    }

    /// Same default content as the desktop's review dialog.
    pub(crate) fn default_content(self) -> &'static str {
        match self {
            Self::Approve => "Approved these changes",
            Self::RequestChanges => "Requested changes",
        }
    }
}

/// A diff line a comment is anchored to; the desktop's `normalizeProjectPullRequestCommentAnchor`
/// rejects anything looser, so the CLI refuses it before signing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommentAnchor {
    pub path: String,
    pub side: String,
    pub line: u64,
}

impl CommentAnchor {
    pub(crate) fn new(path: &str, side: &str, line: u64) -> Result<Self, CliError> {
        let unsafe_path = path.is_empty()
            || path.len() > MAX_ANCHOR_PATH
            || path.starts_with('/')
            || path.contains('\\')
            || path.contains('\0')
            || path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..");
        if unsafe_path {
            return Err(CliError::Usage(
                "--file must be a relative repository path without empty, '.' or '..' segments"
                    .into(),
            ));
        }
        if side != "old" && side != "new" {
            return Err(CliError::Usage("--side must be 'old' or 'new'".into()));
        }
        if line == 0 {
            return Err(CliError::Usage("--line must be 1 or greater".into()));
        }
        Ok(Self {
            path: path.to_string(),
            side: side.to_string(),
            line,
        })
    }

    pub(crate) fn from_options(
        path: Option<&str>,
        side: Option<&str>,
        line: Option<u64>,
    ) -> Result<Option<Self>, CliError> {
        match (path, side, line) {
            (None, None, None) => Ok(None),
            (Some(path), Some(side), Some(line)) => Self::new(path, side, line).map(Some),
            _ => Err(CliError::Usage(
                "--file, --side and --line must be given together".into(),
            )),
        }
    }
}

fn root_tags(repo: &GitRepoCoord, pr: &str) -> Result<Vec<Tag>, CliError> {
    validate_hex64(pr)?;
    Ok(vec![
        tag(&["e", &pr.to_ascii_lowercase(), "", "root"])?,
        tag(&["a", &repo.to_a_tag_value().map_err(sdk_err)?])?,
    ])
}

/// Tags of a general or inline comment. A reply must repeat the discussion
/// starter's commit and anchor, or the desktop will not attach it.
pub(crate) fn comment_tags(
    repo: &GitRepoCoord,
    pr: &str,
    reply_to: Option<&str>,
    to: &[String],
    commit: Option<&str>,
    anchor: Option<&CommentAnchor>,
) -> Result<Vec<Tag>, CliError> {
    let mut tags = root_tags(repo, pr)?;
    if let Some(starter) = reply_to {
        validate_hex64(starter)?;
        tags.push(tag(&["e", &starter.to_ascii_lowercase(), "", "reply"])?);
    }
    tags.extend(recipient_tags(&repo.owner, to)?);
    if let Some(commit) = commit {
        validate_commit(commit)?;
        tags.push(tag(&["c", &commit.to_ascii_lowercase()])?);
    }
    if let Some(anchor) = anchor {
        if commit.is_none() {
            return Err(CliError::Usage(
                "an inline comment needs --commit for the head it anchors to".into(),
            ));
        }
        tags.push(tag(&["file", &anchor.path])?);
        tags.push(tag(&["side", &anchor.side])?);
        tags.push(tag(&["line", &anchor.line.to_string()])?);
        tags.push(tag(&["t", INLINE_COMMENT_LABEL])?);
    }
    Ok(tags)
}

/// Tags of a verdict on one head.
pub(crate) fn review_tags(
    repo: &GitRepoCoord,
    pr: &str,
    to: &[String],
    decision: ReviewDecision,
    commit: &str,
) -> Result<Vec<Tag>, CliError> {
    validate_commit(commit)?;
    let mut tags = root_tags(repo, pr)?;
    tags.extend(recipient_tags(&repo.owner, to)?);
    tags.push(tag(&["t", decision.label()])?);
    tags.push(tag(&["c", &commit.to_ascii_lowercase()])?);
    Ok(tags)
}

/// Tags of a review request; the `p` tags are the requested reviewers.
pub(crate) fn review_request_tags(
    repo: &GitRepoCoord,
    pr: &str,
    reviewers: &[String],
) -> Result<Vec<Tag>, CliError> {
    if reviewers.is_empty() {
        return Err(CliError::Usage("pass at least one --reviewer".into()));
    }
    let mut tags = root_tags(repo, pr)?;
    let mut seen = Vec::new();
    for reviewer in reviewers {
        validate_hex64(reviewer)?;
        let reviewer = reviewer.to_ascii_lowercase();
        if !seen.contains(&reviewer) {
            tags.push(tag(&["p", &reviewer])?);
            seen.push(reviewer);
        }
    }
    tags.push(tag(&["t", REVIEW_REQUEST_LABEL])?);
    Ok(tags)
}

/// A labelled kind:1 note with session provenance, ready to sign.
pub(crate) fn note(content: &str, tags: Vec<Tag>) -> Result<EventBuilder, CliError> {
    validate_content_size(content)?;
    with_git_provenance(EventBuilder::new(Kind::Custom(1), content).tags(tags))
}

async fn publish_note(
    client: &BuzzClient,
    content: &str,
    tags: Vec<Tag>,
    link: &str,
) -> Result<(), CliError> {
    let event = client.sign_event(note(content, tags)?)?;
    let resp = client.submit_event(event).await?;
    crate::client::print_create_response(&resp, "link", link);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_pr_comment(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    pr: &str,
    content: &str,
    reply_to: Option<&str>,
    to: &[String],
    commit: Option<&str>,
    anchor: Option<&CommentAnchor>,
) -> Result<(), CliError> {
    if content.trim().is_empty() {
        return Err(CliError::Usage("a comment needs a body".into()));
    }
    let repo = repo_coord(repo_owner, repo_id)?;
    let tags = comment_tags(&repo, pr, reply_to, to, commit, anchor)?;
    let link = crate::links::pull_request_link(pr, &repo.owner, &repo.id);
    publish_note(client, content, tags, &link).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn cmd_pr_review(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    pr: &str,
    decision: ReviewDecision,
    commit: &str,
    content: &str,
    to: &[String],
) -> Result<(), CliError> {
    let repo = repo_coord(repo_owner, repo_id)?;
    let tags = review_tags(&repo, pr, to, decision, commit)?;
    let content = if content.trim().is_empty() {
        decision.default_content()
    } else {
        content
    };
    let link = crate::links::pull_request_link(pr, &repo.owner, &repo.id);
    publish_note(client, content, tags, &link).await
}

pub(crate) async fn cmd_pr_request_review(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    pr: &str,
    reviewers: &[String],
    content: &str,
) -> Result<(), CliError> {
    let repo = repo_coord(repo_owner, repo_id)?;
    let tags = review_request_tags(&repo, pr, reviewers)?;
    let content = if content.trim().is_empty() {
        "Requested a review"
    } else {
        content
    };
    let link = crate::links::pull_request_link(pr, &repo.owner, &repo.id);
    publish_note(client, content, tags, &link).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const AUTHOR: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PR: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const HEAD: &str = "1111111111111111111111111111111111111111";

    fn repo() -> GitRepoCoord {
        repo_coord(OWNER, "demo").unwrap()
    }

    fn slices(tags: &[Tag]) -> Vec<Vec<String>> {
        tags.iter().map(|tag| tag.as_slice().to_vec()).collect()
    }

    #[test]
    fn verdict_carries_root_repo_recipients_label_and_head() {
        let tags =
            review_tags(&repo(), PR, &[AUTHOR.into()], ReviewDecision::Approve, HEAD).unwrap();
        assert_eq!(
            slices(&tags),
            vec![
                vec!["e", PR, "", "root"],
                vec!["a", &format!("30617:{OWNER}:demo")],
                vec!["p", OWNER],
                vec!["p", AUTHOR],
                vec!["t", "approval"],
                vec!["c", HEAD],
            ]
            .into_iter()
            .map(|parts| parts.into_iter().map(String::from).collect::<Vec<_>>())
            .collect::<Vec<_>>()
        );
        assert!(review_tags(&repo(), PR, &[], ReviewDecision::RequestChanges, "abc").is_err());
        assert!(ReviewDecision::from_flags(true, true).is_err());
        assert!(ReviewDecision::from_flags(false, false).is_err());
        assert_eq!(
            ReviewDecision::from_flags(false, true).unwrap().label(),
            "changes-requested"
        );
    }

    #[test]
    fn inline_comment_needs_a_full_anchor_and_a_head() {
        let anchor = CommentAnchor::new("src/price.ts", "new", 3).unwrap();
        let tags = comment_tags(&repo(), PR, None, &[], Some(HEAD), Some(&anchor)).unwrap();
        let tags = slices(&tags);
        assert!(tags.contains(&vec!["file".into(), "src/price.ts".into()]));
        assert!(tags.contains(&vec!["side".into(), "new".into()]));
        assert!(tags.contains(&vec!["line".into(), "3".into()]));
        assert!(tags.contains(&vec!["t".into(), "inline-comment".into()]));
        assert!(comment_tags(&repo(), PR, None, &[], None, Some(&anchor)).is_err());
        assert!(CommentAnchor::from_options(Some("a.ts"), None, Some(1)).is_err());
        assert!(CommentAnchor::from_options(None, None, None)
            .unwrap()
            .is_none());
        for path in ["", "/abs.ts", "a/../b.ts", "a//b.ts", "a\\b.ts", "./a.ts"] {
            assert!(CommentAnchor::new(path, "old", 1).is_err(), "{path:?}");
        }
        assert!(CommentAnchor::new("a.ts", "left", 1).is_err());
        assert!(CommentAnchor::new("a.ts", "old", 0).is_err());
    }

    #[test]
    fn reply_points_at_the_discussion_starter_and_keeps_the_root() {
        let starter = "e".repeat(64);
        let tags = comment_tags(&repo(), PR, Some(&starter), &[], Some(HEAD), None).unwrap();
        let tags = slices(&tags);
        assert_eq!(tags[0], vec!["e", PR, "", "root"]);
        assert_eq!(tags[2], vec!["e", &starter, "", "reply"]);
        assert!(!tags.iter().any(|tag| tag[0] == "t"));
    }

    #[test]
    fn review_request_names_each_reviewer_once() {
        let tags =
            review_request_tags(&repo(), PR, &[AUTHOR.into(), AUTHOR.to_uppercase()]).unwrap();
        let tags = slices(&tags);
        assert_eq!(tags.iter().filter(|tag| tag[0] == "p").count(), 1);
        assert_eq!(tags.last().unwrap(), &vec!["t", "review-request"]);
        assert!(review_request_tags(&repo(), PR, &[]).is_err());
    }

    #[test]
    fn notes_are_kind_one_and_signable() {
        let tags = review_tags(&repo(), PR, &[], ReviewDecision::Approve, HEAD).unwrap();
        let event = note("ok", tags)
            .unwrap()
            .sign_with_keys(&nostr::Keys::generate())
            .unwrap();
        assert_eq!(event.kind.as_u16(), 1);
        assert!(event.verify().is_ok());
    }
}
