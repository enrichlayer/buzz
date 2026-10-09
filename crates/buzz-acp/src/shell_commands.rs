//! Explicit human shell commands. Never infer executable intent from chat text.
use nostr::{Event, Keys, PublicKey};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt};

/// Signed event metadata marking deliberate human shell execution.
pub const TAG: &str = "buzz.shell";
const OUTPUT_LIMIT: usize = 4_000;

/// Recognize explicit execution metadata without inferring intent from prose.
pub fn is_request(event: &Event) -> bool {
    event
        .tags
        .iter()
        .any(|t| t.as_slice().first().map(String::as_str) == Some(TAG))
}

/// Validate the signed owner, destination and bounded command before execution.
pub fn command(
    event: &Event,
    owner: Option<PublicKey>,
    agent: PublicKey,
    channel: uuid::Uuid,
) -> Result<String, String> {
    if owner != Some(event.pubkey) || event.verify().is_err() || event.kind.as_u16() != 9 {
        return Err("Only the agent's owner may run a direct command.".into());
    }
    let tags: Vec<_> = event
        .tags
        .iter()
        .filter(|t| t.as_slice()[0] == TAG)
        .collect();
    if tags.len() != 1 {
        return Err("Ambiguous shell request.".into());
    }
    let tag = tags[0].as_slice();
    if tag.len() != 4 || tag[1] != "1" || tag[2] != agent.to_hex() {
        return Err("Shell request targets a different agent or protocol version.".into());
    }
    let recipients: Vec<_> = event
        .tags
        .iter()
        .filter(|t| t.as_slice()[0] == "p")
        .collect();
    if recipients.len() != 1 || recipients[0].as_slice().get(1) != Some(&agent.to_hex()) {
        return Err("Address exactly one agent to run a command.".into());
    }
    let channels: Vec<_> = event
        .tags
        .iter()
        .filter(|t| t.as_slice()[0] == "h")
        .collect();
    if channels.len() != 1 || channels[0].as_slice().get(1) != Some(&channel.to_string()) {
        return Err("Shell request has a different channel.".into());
    }
    let command = &tag[3];
    if command.trim().is_empty() || command.len() > 16_000 || command.contains('\0') {
        return Err("Command must contain 1–16000 bytes and no NUL characters.".into());
    }
    Ok(command.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Durable execution receipt used for replay protection and thread context.
pub struct ShellResult {
    pub command: String,
    pub cwd: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub status: String,
    pub truncated: bool,
}

impl ShellResult {
    /// Render literal command and output using collision-safe Markdown fences.
    pub fn message(&self) -> String {
        // Longer than any backtick run in command/output; output remains data.
        let longest = |marker| {
            self.command
                .split(|c| c != marker)
                .chain(self.output.split(|c| c != marker))
                .map(str::len)
                .max()
                .unwrap_or(0)
        };
        let ticks = longest('`');
        let tildes = longest('~');
        let (marker, length) = if ticks <= tildes {
            ("`", ticks)
        } else {
            ("~", tildes)
        };
        let fence = marker.repeat(3.max(length + 1));
        format!("Human command · {}{}\n\nWorking directory: {}\n\n{}bash\n{}\n{}\n\n{}text\n{}\n{}\n\n{}Output is available as conversation context for your next message.",
            self.status, self.exit_code.map(|n| format!(" · exit {n}")).unwrap_or_default(), self.cwd,
            fence, self.command, fence, fence, self.output, fence,
            if self.truncated { "Output truncated at the capture limit. " } else { "" })
    }
}

async fn capture(mut reader: impl AsyncRead + Unpin) -> (String, bool) {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buf = [0; 4096];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let keep = n.min(OUTPUT_LIMIT.saturating_sub(output.len()));
        output.extend_from_slice(&buf[..keep]);
        truncated |= keep < n;
    }
    let mut output = String::from_utf8_lossy(&output).into_owned();
    if output.len() > OUTPUT_LIMIT {
        let mut end = OUTPUT_LIMIT;
        while !output.is_char_boundary(end) {
            end -= 1;
        }
        output.truncate(end);
        truncated = true;
    }
    (output, truncated)
}

#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.0 as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

/// The caller holds the conversation's worker slot; commands cannot overlap
/// model tools in the same conversation. Dropping the future kills the group.
#[cfg(unix)]
async fn execute(
    command: &str,
    cwd: &str,
    timeout: Duration,
    cancelled: impl std::future::Future<Output = ()>,
) -> Result<ShellResult, String> {
    let mut process = tokio::process::Command::new("/bin/bash");
    process
        .args(["-c", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = process
        .spawn()
        .map_err(|e| format!("Could not start Bash: {e}"))?;
    let group = ProcessGroup(child.id().ok_or("Bash has no process ID")?);
    let stdout = capture(child.stdout.take().ok_or("Bash stdout missing")?);
    let stderr = capture(child.stderr.take().ok_or("Bash stderr missing")?);
    tokio::pin!(stdout, stderr);
    // Drain both pipes concurrently. Deadline also covers children retaining pipes.
    let work = async { tokio::join!(child.wait(), &mut stdout, &mut stderr) };
    let (exit_code, status, output, truncated) = tokio::select! {
        (exit, out, err) = work => {
            let code = exit.map_err(|e| e.to_string())?.code();
            (code, if code == Some(0) { "completed" } else { "failed" }, format!("{}{}{}", out.0, if err.0.is_empty() { "" } else { "\n[stderr]\n" }, err.0), out.1 || err.1)
        }
        _ = tokio::time::sleep(timeout) => (None, "timed out", "Command stopped at its time limit.".into(), false),
        _ = cancelled => (None, "cancelled", "Command stopped by session control.".into(), false),
    };
    drop(group);
    let _ = child.wait().await;
    Ok(ShellResult {
        command: command.into(),
        cwd: cwd.into(),
        output,
        exit_code,
        status: status.into(),
        truncated,
    })
}

#[cfg(not(unix))]
async fn execute(
    _command: &str,
    _cwd: &str,
    _timeout: Duration,
    _cancelled: impl std::future::Future<Output = ()>,
) -> Result<ShellResult, String> {
    Err("Direct Bash commands are available on Unix agent hosts only.".into())
}

/// Claim before execution. A restart never re-executes an uncertain command.
/// Completed receipts can be re-published if the relay was temporarily down.
pub async fn run(
    event: &Event,
    keys: &Keys,
    owner: Option<PublicKey>,
    channel: uuid::Uuid,
    cwd: &str,
    cancelled: impl std::future::Future<Output = ()>,
) -> Result<ShellResult, String> {
    let command = command(event, owner, keys.public_key(), channel)?;
    let home = std::env::var_os("HOME").ok_or("No home directory for command receipts")?;
    let dir = Path::new(&home)
        .join(".buzz")
        .join("shell-receipts")
        .join(keys.public_key().to_hex());
    run_claimed(event, &command, cwd, &dir, cancelled).await
}

async fn run_claimed(
    event: &Event,
    command: &str,
    cwd: &str,
    dir: &Path,
    cancelled: impl std::future::Future<Output = ()>,
) -> Result<ShellResult, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", event.id.to_hex()));
    // Only fresh intent may start a process. Existing claims remain readable
    // for relay retries, including after a restart.
    let now = nostr::Timestamp::now().as_secs();
    if !path.exists()
        && (event.created_at.as_secs() > now + 60
            || now.saturating_sub(event.created_at.as_secs()) > 600)
    {
        return Err("Command request expired; send it again to run it.".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = match options.open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|_| "This command was already started; its outcome is uncertain after interruption. It was not run again.".into());
        }
        Err(e) => return Err(e.to_string()),
    };
    file.write_all(b"started")
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    let result = execute(command, cwd, Duration::from_secs(120), cancelled).await?;
    let mut receipt = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut receipt, &result).map_err(|e| e.to_string())?;
    receipt.as_file().sync_all().map_err(|e| e.to_string())?;
    receipt.persist(&path).map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(owner: &Keys, agent: PublicKey, channel: uuid::Uuid, command: &str) -> Event {
        nostr::EventBuilder::new(nostr::Kind::Custom(9), format!("!{command}"))
            .tags([
                nostr::Tag::parse(["h", &channel.to_string()]).unwrap(),
                nostr::Tag::parse(["p", &agent.to_hex()]).unwrap(),
                nostr::Tag::parse([TAG, "1", &agent.to_hex(), command]).unwrap(),
            ])
            .sign_with_keys(owner)
            .unwrap()
    }
    #[test]
    fn only_signed_owner_and_exact_target_can_execute() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let channel = uuid::Uuid::new_v4();
        let event = request(&owner, agent.public_key(), channel, "pwd");
        assert_eq!(
            command(
                &event,
                Some(owner.public_key()),
                agent.public_key(),
                channel
            )
            .unwrap(),
            "pwd"
        );
        assert!(command(
            &event,
            Some(agent.public_key()),
            agent.public_key(),
            channel
        )
        .is_err());
        assert!(command(
            &event,
            Some(owner.public_key()),
            owner.public_key(),
            channel
        )
        .is_err());
        assert!(command(
            &event,
            Some(owner.public_key()),
            agent.public_key(),
            uuid::Uuid::new_v4()
        )
        .is_err());
        let mut tampered = event.clone();
        tampered.content.push('x');
        assert!(command(
            &tampered,
            Some(owner.public_key()),
            agent.public_key(),
            channel
        )
        .is_err());
    }
    #[tokio::test]
    async fn replay_returns_receipt_without_running_again_and_stale_intent_fails() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let event = request(
            &owner,
            agent.public_key(),
            uuid::Uuid::new_v4(),
            "echo x >> count",
        );
        for _ in 0..2 {
            run_claimed(
                &event,
                "echo x >> count",
                cwd,
                &dir.path().join("receipts"),
                std::future::pending(),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("count")).unwrap(),
            "x\n"
        );
        let mut stale = event;
        stale.created_at = nostr::Timestamp::from(1);
        stale.id = nostr::EventId::all_zeros();
        assert!(run_claimed(
            &stale,
            "exit 0",
            cwd,
            &dir.path().join("receipts"),
            std::future::pending()
        )
        .await
        .unwrap_err()
        .contains("expired"));
    }
    #[tokio::test]
    async fn shell_captures_failure_and_limits_output() {
        let result = execute(
            "printf ok; printf error >&2; exit 7",
            "/tmp",
            Duration::from_secs(2),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.status, "failed");
        assert!(result.output.contains("ok") && result.output.contains("error"));
        let result = execute(
            "yes x | head -c 100000",
            "/tmp",
            Duration::from_secs(2),
            std::future::pending(),
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(result.output.len() <= OUTPUT_LIMIT);
    }
    #[tokio::test]
    async fn shell_cancellation_stops_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let result = execute(
            "(sleep 1; touch should-not-exist) & wait",
            dir.path().to_str().unwrap(),
            Duration::from_secs(3),
            tokio::time::sleep(Duration::from_millis(100)),
        )
        .await
        .unwrap();
        assert_eq!(result.status, "cancelled");
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(!dir.path().join("should-not-exist").exists());
    }
}
