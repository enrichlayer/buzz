use crate::client::BuzzClient;
use crate::commands::with_git_provenance;
use crate::error::CliError;
use crate::validate::{
    read_file_or_stdin, read_or_stdin, sdk_err, validate_hex64, validate_repo_id,
};
use buzz_sdk::{GitPrUpdateMeta, GitPullRequestMeta, GitRepoCoord, GitStatusMeta};

pub(crate) fn read_optional_body(
    body: Option<&str>,
    body_file: Option<&str>,
) -> Result<String, CliError> {
    match (body, body_file) {
        (Some(_), Some(_)) => Err(CliError::Usage(
            "--body and --body-file are mutually exclusive".into(),
        )),
        (Some(value), None) => read_or_stdin(value),
        (None, Some(path)) => read_file_or_stdin(path),
        (None, None) => Ok(String::new()),
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_open_pr(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    subject: &str,
    body: Option<&str>,
    body_file: Option<&str>,
    commit: &str,
    clone_urls: &[String],
    branch_name: Option<&str>,
    merge_base: Option<&str>,
    euc: Option<&str>,
    labels: &[String],
    to: &[String],
    channel: Option<&str>,
    revision_of: Option<&str>,
    thread: Option<&str>,
    linear_issue: Option<&str>,
    mirror_of: Option<&str>,
) -> Result<(), CliError> {
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;
    let content = read_optional_body(body, body_file)?;
    let inherited_thread = std::env::var(super::pr_session::THREAD_ENV).ok();
    let inherited_channel = std::env::var(super::GIT_ORIGIN_CHANNEL_ENV).ok();
    // A mirrored review has no coding thread of its own; its Linear link is
    // then a plain provenance claim rather than a session association.
    let detached_issue = mirror_of.is_some() && thread.is_none() && inherited_thread.is_none();
    let mut session_tags = super::pr_session::context_tags(
        thread,
        inherited_thread.as_deref(),
        channel,
        inherited_channel.as_deref(),
        if detached_issue { None } else { linear_issue },
    )?;
    if let Some(source) = mirror_of {
        session_tags.push(super::pr_session::mirror_tag(source)?);
        if detached_issue {
            if let Some(issue) = linear_issue {
                session_tags.push(super::pr_session::linear_issue_tag(issue)?);
            }
        }
    }
    if !session_tags.is_empty() {
        super::pr_session::verify_thread(
            client,
            &mut session_tags,
            channel.or(inherited_channel.as_deref()).unwrap_or_default(),
        )
        .await?;
    }

    let repo = GitRepoCoord {
        owner: repo_owner.to_string(),
        id: repo_id.to_string(),
    };
    let meta = GitPullRequestMeta {
        euc: euc.map(str::to_string),
        recipients: to.to_vec(),
        channel_id: channel.map(str::to_string),
        subject: subject.to_string(),
        labels: labels.to_vec(),
        commit: commit.to_string(),
        clone_urls: clone_urls.to_vec(),
        branch_name: branch_name.map(str::to_string),
        merge_base: merge_base.map(str::to_string),
        revision_of: revision_of.map(str::to_string),
    };

    let builder = with_git_provenance(
        buzz_sdk::build_git_pull_request(&repo, &content, &meta)
            .map_err(sdk_err)?
            .tags(session_tags),
    )?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let resp = client.submit_event(event).await?;
    // `link` renders as a rich preview card in Buzz Desktop when included in
    // a chat message — agents announce PRs with it (see base_prompt.md).
    let link = crate::links::pull_request_link(&event_id, repo_owner, repo_id);
    crate::client::print_create_response(&resp, "link", &link);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_update_pr(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    pr: &str,
    pr_author: &str,
    commit: &str,
    clone_urls: &[String],
    body: Option<&str>,
    body_file: Option<&str>,
    merge_base: Option<&str>,
    euc: Option<&str>,
    to: &[String],
) -> Result<(), CliError> {
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;
    validate_hex64(pr)?;
    validate_hex64(pr_author)?;
    let content = read_optional_body(body, body_file)?;

    let repo = GitRepoCoord {
        owner: repo_owner.to_string(),
        id: repo_id.to_string(),
    };
    let meta = GitPrUpdateMeta {
        euc: euc.map(str::to_string),
        recipients: to.to_vec(),
        pr_event: pr.to_string(),
        pr_author: pr_author.to_string(),
        commit: commit.to_string(),
        clone_urls: clone_urls.to_vec(),
        merge_base: merge_base.map(str::to_string),
    };

    let builder = with_git_provenance(
        buzz_sdk::build_git_pr_update(&repo, &content, &meta).map_err(sdk_err)?,
    )?;
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{resp}");
    Ok(())
}

pub async fn cmd_get_pr(client: &BuzzClient, event: &str) -> Result<(), CliError> {
    validate_hex64(event)?;
    let filter = serde_json::json!({
        "kinds": [1618],
        "ids": [event]
    });
    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_list_prs(
    client: &BuzzClient,
    repo_owner: &str,
    repo_id: &str,
    author: Option<&str>,
    thread: Option<&str>,
    label: Option<&str>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    validate_hex64(repo_owner)?;
    validate_repo_id(repo_id)?;

    let a_value = format!("30617:{repo_owner}:{repo_id}");
    let mut filter = serde_json::json!({
        "kinds": [1618],
        "#a": [a_value]
    });

    if let Some(thread) = thread {
        validate_hex64(thread)?;
        filter["#e"] = serde_json::json!([thread.to_ascii_lowercase()]);
    }
    if let Some(pk) = author {
        validate_hex64(pk)?;
        filter["authors"] = serde_json::json!([pk]);
    }
    if let Some(l) = label {
        filter["#t"] = serde_json::json!([l]);
    }
    if let Some(n) = limit {
        filter["limit"] = serde_json::json!(n);
    }

    let resp = if let Some(thread) = thread {
        super::pr_session::list_thread_reviews(client, filter, thread, limit).await?
    } else {
        client.query(&filter).await?
    };
    println!("{resp}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_pr_status(
    client: &BuzzClient,
    pr: &str,
    status: &str,
    body: Option<&str>,
    body_file: Option<&str>,
    repo_owner: Option<&str>,
    repo_id: Option<&str>,
    euc: Option<&str>,
    to: &[String],
    merge_commit: Option<&str>,
) -> Result<(), CliError> {
    validate_hex64(pr)?;
    let status = crate::commands::patches::parse_status(status)?;
    let content = read_optional_body(body, body_file)?;

    let repo = match (repo_owner, repo_id) {
        (Some(owner), Some(id)) => {
            validate_hex64(owner)?;
            validate_repo_id(id)?;
            Some(GitRepoCoord {
                owner: owner.to_string(),
                id: id.to_string(),
            })
        }
        (None, None) => None,
        _ => {
            return Err(CliError::Usage(
                "--repo-owner and --repo-id must be given together".into(),
            ))
        }
    };

    // Mirrors patch/issue status: default a `p` tag to the repo owner when
    // known; callers can add PR author/reviewers with repeated `--to`.
    let mut recipients = Vec::new();
    if let Some(ref repo) = repo {
        recipients.push(repo.owner.clone());
    }
    for recipient in to {
        validate_hex64(recipient)?;
        if !recipients.contains(recipient) {
            recipients.push(recipient.clone());
        }
    }

    let meta = GitStatusMeta {
        root_event: pr.to_string(),
        accepted_revision_root: None,
        repo,
        euc: euc.map(str::to_string),
        recipients,
        applied_patches: vec![],
        merge_commit: merge_commit.map(str::to_string),
        applied_as_commits: vec![],
    };

    let builder =
        with_git_provenance(buzz_sdk::build_git_status(status, &content, &meta).map_err(sdk_err)?)?;
    let event = client.sign_event(builder)?;
    let resp = client.submit_event(event).await?;
    println!("{resp}");
    Ok(())
}

pub async fn dispatch(cmd: crate::PrCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::PrCmd;
    match cmd {
        PrCmd::Open {
            repo_owner,
            repo_id,
            subject,
            body,
            body_file,
            commit,
            clone,
            branch_name,
            merge_base,
            euc,
            label,
            to,
            channel,
            revision_of,
            thread,
            linear_issue,
            mirror_of,
        } => {
            cmd_open_pr(
                client,
                &repo_owner,
                &repo_id,
                &subject,
                body.as_deref(),
                body_file.as_deref(),
                &commit,
                &clone,
                branch_name.as_deref(),
                merge_base.as_deref(),
                euc.as_deref(),
                &label,
                &to,
                channel.as_deref(),
                revision_of.as_deref(),
                thread.as_deref(),
                linear_issue.as_deref(),
                mirror_of.as_deref(),
            )
            .await
        }
        PrCmd::Update {
            repo_owner,
            repo_id,
            pr,
            pr_author,
            commit,
            clone,
            body,
            body_file,
            merge_base,
            euc,
            to,
        } => {
            cmd_update_pr(
                client,
                &repo_owner,
                &repo_id,
                &pr,
                &pr_author,
                &commit,
                &clone,
                body.as_deref(),
                body_file.as_deref(),
                merge_base.as_deref(),
                euc.as_deref(),
                &to,
            )
            .await
        }
        PrCmd::Get { event } => cmd_get_pr(client, &event).await,
        PrCmd::List {
            repo_owner,
            repo_id,
            author,
            thread,
            label,
            limit,
        } => {
            cmd_list_prs(
                client,
                &repo_owner,
                &repo_id,
                author.as_deref(),
                thread.as_deref(),
                label.as_deref(),
                limit,
            )
            .await
        }
        PrCmd::Status {
            pr,
            status,
            body,
            body_file,
            repo_owner,
            repo_id,
            euc,
            to,
            merge_commit,
        } => {
            cmd_pr_status(
                client,
                &pr,
                &status,
                body.as_deref(),
                body_file.as_deref(),
                repo_owner.as_deref(),
                repo_id.as_deref(),
                euc.as_deref(),
                &to,
                merge_commit.as_deref(),
            )
            .await
        }
        PrCmd::Comment {
            repo_owner,
            repo_id,
            pr,
            body,
            body_file,
            reply_to,
            commit,
            file,
            side,
            line,
            to,
        } => {
            let content = read_optional_body(body.as_deref(), body_file.as_deref())?;
            let anchor = super::pr_review::CommentAnchor::from_options(
                file.as_deref(),
                side.as_deref(),
                line,
            )?;
            super::pr_review::cmd_pr_comment(
                client,
                &repo_owner,
                &repo_id,
                &pr,
                &content,
                reply_to.as_deref(),
                &to,
                commit.as_deref(),
                anchor.as_ref(),
            )
            .await
        }
        PrCmd::Review {
            repo_owner,
            repo_id,
            pr,
            commit,
            approve,
            request_changes,
            body,
            body_file,
            to,
        } => {
            let decision = super::pr_review::ReviewDecision::from_flags(approve, request_changes)?;
            let content = read_optional_body(body.as_deref(), body_file.as_deref())?;
            super::pr_review::cmd_pr_review(
                client,
                &repo_owner,
                &repo_id,
                &pr,
                decision,
                &commit,
                &content,
                &to,
            )
            .await
        }
        PrCmd::RequestReview {
            repo_owner,
            repo_id,
            pr,
            reviewer,
            body,
            body_file,
        } => {
            let content = read_optional_body(body.as_deref(), body_file.as_deref())?;
            super::pr_review::cmd_pr_request_review(
                client,
                &repo_owner,
                &repo_id,
                &pr,
                &reviewer,
                &content,
            )
            .await
        }
        PrCmd::Bundle(sub) => dispatch_bundle(sub, client).await,
    }
}

async fn dispatch_bundle(cmd: crate::PrBundleCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::PrBundleCmd;
    match cmd {
        PrBundleCmd::Open {
            repo_owner,
            repo_id,
            subject,
            body,
            body_file,
            member,
            reviewer,
            workspace,
            linear_issue,
        } => {
            let content = read_optional_body(body.as_deref(), body_file.as_deref())?;
            super::pr_bundle::cmd_bundle_open(
                client,
                &repo_owner,
                &repo_id,
                &subject,
                &content,
                &member,
                &reviewer,
                workspace.as_deref(),
                linear_issue.as_deref(),
            )
            .await
        }
        PrBundleCmd::Review {
            repo_owner,
            repo_id,
            bundle,
            member_head,
            member_verdict,
            approve,
            request_changes,
            body,
            body_file,
            to,
        } => {
            let decision = super::pr_review::ReviewDecision::from_flags(approve, request_changes)?;
            let content = read_optional_body(body.as_deref(), body_file.as_deref())?;
            super::pr_bundle::cmd_bundle_review(
                client,
                &repo_owner,
                &repo_id,
                &bundle,
                decision,
                &member_head,
                &member_verdict,
                &content,
                &to,
            )
            .await
        }
        PrBundleCmd::Get { event } => super::pr_bundle::cmd_bundle_get(client, &event).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_optional_body_rejects_body_and_body_file_together() {
        assert!(read_optional_body(Some("body"), Some("file.md")).is_err());
    }

    #[test]
    fn read_optional_body_defaults_empty() {
        assert_eq!(read_optional_body(None, None).unwrap(), "");
    }
}
