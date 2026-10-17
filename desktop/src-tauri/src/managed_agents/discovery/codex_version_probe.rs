use std::path::Path;
use std::process::Command;

// Preserve the failing stage for regression diagnostics while callers continue
// to classify all probe errors as unavailable. This is the production probe.
pub(super) fn probe_codex_acp_version_result(
    binary_path: &Path,
    augmented_path: Option<&str>,
) -> Result<(u64, u64, u64), String> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    use std::time::{Duration, Instant};
    const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

    // A regular file returns EOF at its current size even when a descendant
    // inherits its descriptor, bounding the post-exit read cross-platform.
    let mut tmp = tempfile::tempfile().map_err(|error| format!("create probe output: {error}"))?;

    let mut command = Command::new(binary_path);
    command.arg("--version");
    if let Some(path) = augmented_path {
        command.env("PATH", path);
    }
    crate::util::configure_no_window(&mut command);
    let mut child = command
        .stdout(
            tmp.try_clone()
                .map_err(|error| format!("clone probe output: {error}"))?,
        )
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("spawn version probe: {error}"))?;

    // Poll until the deadline rather than blocking on stdout EOF.
    let deadline = Instant::now() + VERSION_PROBE_TIMEOUT;
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("version probe exceeded its five-second deadline".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait for version probe: {error}"));
            }
        }
    };

    if !exit_status.success() {
        return Err(format!("version probe exited with {exit_status}"));
    }

    // Read at most 4 KiB from the regular file without blocking.
    tmp.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind probe output: {error}"))?;
    let mut buf = Vec::with_capacity(128);
    let _ = (&mut tmp as &mut dyn std::io::Read)
        .take(4096)
        .read_to_end(&mut buf);

    let stdout = String::from_utf8_lossy(&buf);
    // Output format: "<package-name> <major>.<minor>.<patch>"
    let version_str = stdout
        .split_whitespace()
        .last()
        .ok_or("version probe produced no version token")?;
    let mut components = version_str.split('.');
    let major = components
        .next()
        .ok_or("version probe returned fewer than three version components")?
        .parse::<u64>()
        .map_err(|error| format!("invalid major version component: {error}"))?;
    let minor = components
        .next()
        .ok_or("version probe returned fewer than three version components")?
        .parse::<u64>()
        .map_err(|error| format!("invalid minor version component: {error}"))?;
    let patch = components
        .next()
        .ok_or("version probe returned fewer than three version components")?
        .parse::<u64>()
        .map_err(|error| format!("invalid patch version component: {error}"))?;
    if components.next().is_some() {
        return Err("version probe returned more than three version components".into());
    }
    Ok((major, minor, patch))
}
