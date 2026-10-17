import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
test("installer preserves old app and restores it if final placement fails", () => {
  for (const failure of [false, true]) {
    const root = mkdtempSync(path.join(tmpdir(), "buzz-install-fixture-"));
    try {
      for (const p of [
        "scripts",
        "bin",
        "desktop/scripts",
        "desktop/src-tauri",
        "home/Applications/Buzz Local Coding.app",
      ])
        mkdirSync(path.join(root, p), { recursive: true });
      copyFileSync(
        new URL("./install-local-macos.sh", import.meta.url),
        path.join(root, "scripts/install-local-macos.sh"),
      );
      writeFileSync(
        path.join(root, "bin/activate-hermit"),
        `export PATH="${root}/bin:$PATH"\n`,
      );
      writeFileSync(
        path.join(root, "desktop/scripts/demo-build-config.mjs"),
        "",
      );
      writeFileSync(
        path.join(root, "home/Applications/Buzz Local Coding.app/old"),
        "old",
      );
      mkdirSync(
        path.join(
          root,
          "home/Applications/.buzz-local-backup.older/Buzz Local Coding.app",
        ),
        { recursive: true },
      );
      // Same prefix, but not something this installer created: never deleted.
      mkdirSync(path.join(root, "home/Applications/.buzz-local-backup.notes"));
      writeFileSync(
        path.join(root, "home/Applications/.buzz-local-backup.notes/keep.txt"),
        "user data",
      );
      const scripts = {
        uname: "echo Darwin",
        git: "exit 0",
        rustc: 'echo "host: aarch64-apple-darwin"',
        cargo:
          'mkdir -p "$CARGO_TARGET_DIR/debug"; for x in buzz-acp buzz-agent buzz-backend-kubernetes buzz-dev-mcp git-credential-nostr buzz; do touch "$CARGO_TARGET_DIR/debug/$x"; done',
        pnpm: 'if [ "$1" = tauri ]; then a="$CARGO_TARGET_DIR/debug/bundle/macos/Buzz Local Coding.app"; mkdir -p "$a/Contents/MacOS"; echo new > "$a/new"; touch "$a/Contents/MacOS/buzz-desktop" "$a/Contents/MacOS/buzz-acp"; fi',
        pgrep: '[ "$APP_RUNNING" = 1 ]',
        codesign: 'printf "%s\\n" "$*" >> "$HOME/signing.log"',
        ditto: '/bin/cp -R "$1" "$2"',
        mv: 'if [ "$FAIL_INSTALL" = 1 ] && echo "$1" | /usr/bin/grep -q "/.buzz-local-install."; then exit 1; fi; /bin/mv "$@"',
      };
      for (const [name, body] of Object.entries(scripts))
        writeFileSync(
          path.join(root, "bin", name),
          "#!/bin/sh\n" + body + "\n",
          { mode: 0o755 },
        );
      const result = spawnSync(
        "bash",
        [path.join(root, "scripts/install-local-macos.sh")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: path.join(root, "home"),
            PATH: path.join(root, "bin") + ":" + process.env.PATH,
            FAIL_INSTALL: failure ? "1" : "0",
            BUZZ_LOCAL_ROOT_TARGET: path.join(root, "root-target"),
            BUZZ_LOCAL_DESKTOP_TARGET: path.join(root, "desktop-target"),
          },
        },
      );
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const app = path.join(root, "home/Applications/Buzz Local Coding.app");
      assert.ok(existsSync(path.join(app, failure ? "old" : "new")));
      const signing = readFileSync(path.join(root, "home/signing.log"), "utf8")
        .trim()
        .split("\n");
      const entitled = signing.filter((line) =>
        line.includes("--entitlements"),
      );
      assert.equal(entitled.length, 1, "only the app bundle gets entitlements");
      assert.match(entitled[0], /--options runtime .*Buzz Local Coding\.app$/);
      assert.ok(
        signing.some((line) => /MacOS\/buzz-acp$/.test(line)),
        "helpers are signed individually",
      );
      assert.ok(
        signing.indexOf(entitled[0]) >
          signing.findIndex((line) => /MacOS\/buzz-acp$/.test(line)),
        "helpers are signed before the app",
      );
      assert.ok(signing.every((line) => !line.includes("--deep --sign")));
      if (!failure) {
        const backups = readdirSync(
          path.join(root, "home/Applications"),
        ).filter(
          (n) =>
            n.startsWith(".buzz-local-backup.") &&
            n !== ".buzz-local-backup.notes",
        );
        assert.equal(backups.length, 1, "only the newest backup is kept");
        const [backup] = backups;
        assert.notEqual(backup, ".buzz-local-backup.older");
        assert.equal(
          readFileSync(
            path.join(
              root,
              "home/Applications/.buzz-local-backup.notes/keep.txt",
            ),
            "utf8",
          ),
          "user data",
          "unrelated directories sharing the prefix are not deleted",
        );
        assert.match(
          result.stdout,
          /Latest previous app backup: .*\.buzz-local-backup\./,
        );
        assert.ok(
          existsSync(
            path.join(
              root,
              "home/Applications",
              backup,
              "Buzz Local Coding.app/old",
            ),
          ),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("installer refuses to replace a running Local Coding app", () => {
  const root = mkdtempSync(path.join(tmpdir(), "buzz-install-running-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    copyFileSync(
      new URL("./install-local-macos.sh", import.meta.url),
      path.join(root, "scripts/install-local-macos.sh"),
    );
    for (const [name, body] of Object.entries({
      uname: "echo Darwin",
      git: "exit 0",
      pgrep: '[ "$2" = "Buzz Local Coding.app/Contents/MacOS" ]',
      pnpm: 'touch "$HOME/built"',
    }))
      writeFileSync(path.join(root, "bin", name), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    const result = spawnSync(
      "bash",
      [path.join(root, "scripts/install-local-macos.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Buzz Local Coding is running\. Quit it/);
    assert.equal(existsSync(path.join(root, "built")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function lockFixture(prefix, prepareLock) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "Applications"));
  const lock = path.join(root, "Applications/.buzz-local-install.lock");
  prepareLock(lock);
  copyFileSync(
    new URL("./install-local-macos.sh", import.meta.url),
    path.join(root, "scripts/install-local-macos.sh"),
  );
  writeFileSync(path.join(root, "bin/activate-hermit"), "");
  for (const [name, body] of Object.entries({
    uname: "echo Darwin",
    git: "exit 0",
    pgrep: "exit 1",
    // Stop right after the lock is taken; the EXIT trap must release it.
    pnpm: 'touch "$HOME/install-started"; exit 42',
  }))
    writeFileSync(path.join(root, "bin", name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  const result = spawnSync(
    "bash",
    [path.join(root, "scripts/install-local-macos.sh")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      },
    },
  );
  const lockPresent = (() => {
    try {
      lstatSync(lock);
      return true;
    } catch {
      return false;
    }
  })();
  const started = existsSync(path.join(root, "install-started"));
  rmSync(root, { recursive: true, force: true });
  return { result, lockPresent, started };
}

test("installer does not steal a live holder's lock", () => {
  const { result, lockPresent, started } = lockFixture(
    "buzz-install-locking-",
    (lock) => symlinkSync(String(process.pid), lock),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`running \\(pid ${process.pid}\\)`));
  assert.equal(lockPresent, true, "the active lock is not stolen");
  assert.equal(started, false);
});

test("installer recovers a lock left by an exited holder", () => {
  const dead = spawnSync("true").pid;
  for (const [label, prepare] of [
    ["dead pid", (lock) => symlinkSync(String(dead), lock)],
    // An interrupted acquisition by the earlier directory-lock installer.
    ["empty legacy directory", (lock) => mkdirSync(lock)],
  ]) {
    const { result, lockPresent, started } = lockFixture(
      "buzz-install-stale-",
      prepare,
    );
    assert.equal(result.status, 42, `${label}: ${result.stderr}`);
    assert.equal(started, true, `${label}: install proceeds`);
    assert.equal(lockPresent, false, `${label}: lock released on exit`);
  }
});

test("installer releases its lock when dependency installation fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "buzz-install-cleanup-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    copyFileSync(
      new URL("./install-local-macos.sh", import.meta.url),
      path.join(root, "scripts/install-local-macos.sh"),
    );
    writeFileSync(path.join(root, "bin/activate-hermit"), "");
    for (const [name, body] of Object.entries({
      uname: "echo Darwin",
      git: "exit 0",
      pgrep: "exit 1",
      pnpm: "exit 42",
    }))
      writeFileSync(path.join(root, "bin", name), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });

    const result = spawnSync(
      "bash",
      [path.join(root, "scripts/install-local-macos.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        },
      },
    );

    assert.equal(result.status, 42);
    assert.equal(
      existsSync(path.join(root, "Applications/.buzz-local-install.lock")),
      false,
      "the EXIT trap releases the lock",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
