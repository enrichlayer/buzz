use super::*;

#[tokio::test]
async fn idle_resets_on_stdout_activity() {
    use tokio::io::AsyncWriteExt;

    // Start the real pipe before pausing time; process scheduling must not
    // consume the idle window this test is measuring.
    let mut client = AcpClient::spawn(
        "bash",
        &[
            "-c".into(),
            "printf 'ready\\n'; while IFS= read -r line; do printf '%s\\n' \"$line\"; done".into(),
        ],
        &[],
        false,
    )
    .await
    .expect("spawn pipe fixture");
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), client.reader.next())
            .await
            .expect("fixture startup")
            .unwrap()
            .unwrap(),
        "ready"
    );
    let mut stdin = client.stdin.take().expect("fixture stdin");
    let observer = ObserverHandle::in_process();
    client.set_observer(Some(observer.clone()), 0);
    tokio::time::pause();
    let idle = std::time::Duration::from_millis(200);
    let max_duration = std::time::Duration::from_secs(10);
    let deadline = tokio::time::Instant::now() + max_duration;
    let mut read = Box::pin(client.read_until_response_with_idle_timeout(
        "test",
        999,
        idle,
        deadline,
        max_duration,
    ));
    assert!(futures_util::poll!(&mut read).is_pending());
    for received in 1..=5 {
        tokio::time::advance(std::time::Duration::from_millis(150)).await;
        let notification = b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_thought_chunk\",\"content\":{\"text\":\"thinking\"}}}}\n";
        stdin
            .write_all(notification)
            .await
            .expect("write notification");
        let io_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            // Keep the driver runnable while waiting for real pipe I/O so
            // paused Tokio time advances only at our explicit steps.
            assert!(futures_util::poll!(&mut read).is_pending());
            if observer
                .snapshot()
                .iter()
                .filter(|event| event.kind == "acp_read")
                .count()
                == received
            {
                break;
            }
            assert!(
                std::time::Instant::now() < io_deadline,
                "fixture pipe did not deliver notification"
            );
            tokio::task::yield_now().await;
        }
    }
    tokio::time::advance(idle - std::time::Duration::from_millis(1)).await;
    assert!(futures_util::poll!(&mut read).is_pending());
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    assert!(matches!(read.await, Err(AcpError::IdleTimeout(value)) if value == idle));
}

#[cfg(unix)]
#[tokio::test]
async fn claude_version_timeout_kills_launcher_children() {
    let dir = std::env::temp_dir().join(format!("buzz-acp-hang-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create dir");
    let pidfile = dir.join("child.pid");
    // A launcher that starts a child holding stdout open, then hangs.
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c")
        .arg(format!("sleep 300 & echo $! > {}; wait", pidfile.display()));
    configure_version_probe(&mut cmd);
    let child = cmd.spawn().expect("spawn launcher");
    let version = claude_version_within(child, std::time::Duration::from_millis(500)).await;
    assert_eq!(version, None);
    let grandchild = std::fs::read_to_string(&pidfile).expect("pidfile");
    let grandchild = nix::unistd::Pid::from_raw(grandchild.trim().parse().expect("pid"));
    let mut alive = true;
    for _ in 0..50 {
        alive = launcher_child_is_running(grandchild);
        if !alive {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    std::fs::remove_dir_all(&dir).expect("remove dir");
    assert!(
        !alive,
        "the launcher's child must not outlive the timeout; process state: {:?}",
        std::fs::read_to_string(format!("/proc/{}/stat", grandchild.as_raw()))
    );
}

#[cfg(unix)]
fn launcher_child_is_running(pid: nix::unistd::Pid) -> bool {
    match nix::sys::signal::kill(pid, None) {
        Err(nix::errno::Errno::ESRCH) => return false,
        Err(error) => panic!("cannot inspect launcher child: {error}"),
        Ok(()) => {}
    }
    #[cfg(target_os = "linux")]
    {
        // Container PID 1 may not reap an orphan immediately. A zombie has
        // already exited and closed its pipes; kill(pid, 0) alone sees its
        // retained process-table entry and misreports it as a live child.
        let stat = match std::fs::read_to_string(format!("/proc/{}/stat", pid.as_raw())) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => panic!("cannot read launcher child state: {error}"),
        };
        let (_, fields) = stat.rsplit_once(") ").expect("process stat fields");
        fields.split_whitespace().next().expect("process state") != "Z"
    }
    #[cfg(not(target_os = "linux"))]
    true
}

#[cfg(unix)]
#[tokio::test]
async fn launcher_child_liveness_rejects_a_live_process() {
    let mut child = tokio::process::Command::new("sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn liveness control");
    let pid = nix::unistd::Pid::from_raw(child.id().expect("child pid") as i32);
    assert!(launcher_child_is_running(pid));
    child.kill().await.expect("kill and reap liveness control");
    assert!(!launcher_child_is_running(pid));
}
