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
      const scripts = {
        uname: "echo Darwin",
        git: "exit 0",
        rustc: 'echo "host: aarch64-apple-darwin"',
        cargo:
          'mkdir -p "$CARGO_TARGET_DIR/debug"; for x in buzz-acp buzz-agent buzz-backend-kubernetes buzz-dev-mcp git-credential-nostr buzz; do touch "$CARGO_TARGET_DIR/debug/$x"; done',
        pnpm: 'if [ "$1" = tauri ]; then mkdir -p "$CARGO_TARGET_DIR/debug/bundle/macos/Buzz Local Coding.app"; echo new > "$CARGO_TARGET_DIR/debug/bundle/macos/Buzz Local Coding.app/new"; fi',
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
      assert.match(
        readFileSync(path.join(root, "home/signing.log"), "utf8"),
        /--entitlements/,
      );
      if (!failure) {
        const backup = readdirSync(path.join(root, "home/Applications")).find(
          (n) => n.startsWith(".buzz-local-backup."),
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
