use std::{
    fs,
    time::{Duration, Instant},
};

fn process_is_running(pid: u32) -> bool {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    match kill(Pid::from_raw(pid as i32), None) {
        Err(Errno::ESRCH) => return false,
        Err(error) => panic!("cannot inspect child {pid}: {error}"),
        Ok(()) => {}
    }
    #[cfg(target_os = "linux")]
    {
        // A container init may retain an orphan's zombie entry after its
        // executable and pipes have exited. kill(pid, 0) still succeeds then.
        let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => panic!("cannot inspect child {pid} state: {error}"),
        };
        let (_, fields) = stat.rsplit_once(") ").expect("process stat fields");
        fields.split_whitespace().next().expect("process state") != "Z"
    }
    #[cfg(not(target_os = "linux"))]
    true
}

pub(super) fn assert_dead(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while process_is_running(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !process_is_running(pid),
        "child {pid} survived; state: {:?}",
        fs::read_to_string(format!("/proc/{pid}/stat"))
    );
}

#[cfg(target_os = "linux")]
#[test]
fn liveness_distinguishes_live_and_unreaped_exited_children() {
    use std::process::Command;
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let pid = child.id();
    let live = process_is_running(pid);
    child.kill().unwrap();
    // Do not call try_wait: deliberately retain the exited child until the
    // liveness check observes the real Linux zombie that container PID 1 can
    // retain. Reap it before either assertion, including the negative control.
    let deadline = Instant::now() + Duration::from_secs(2);
    let zombie_observed = loop {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        if stat.rsplit_once(") ").unwrap().1.starts_with("Z ") {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let exited = process_is_running(pid);
    child.wait().unwrap();
    assert!(live, "a running child must be detected");
    assert!(
        zombie_observed,
        "the control must exercise an unreaped exited child"
    );
    assert!(
        !exited,
        "an unreaped exited child must not be reported as running"
    );
    assert!(
        !process_is_running(pid),
        "a reaped child must remain stopped"
    );
}
