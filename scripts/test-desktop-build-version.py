#!/usr/bin/env python3
"""Exercise Cargo invalidation with the production metadata emitter, without Tauri dependencies."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class BuildVersionTest(unittest.TestCase):
    def test_clock_regression(self):
        with tempfile.TemporaryDirectory(prefix="buzz-version-clock-") as temporary:
            binary = str(Path(temporary) / "clock-test")
            subprocess.run(["rustc", "--edition=2021", "--test", str(ROOT / "desktop/src-tauri/build_version.rs"), "-o", binary], cwd=ROOT, check=True)
            subprocess.run([binary], check=True)

    def test_changed_frontend_commit_and_missing_git(self):
        with tempfile.TemporaryDirectory(prefix='buzz-version-', dir=os.environ.get('TMPDIR')) as temporary:
            root = Path(temporary)
            crate = root / 'desktop/src-tauri'
            (crate / 'src').mkdir(parents=True)
            (root / 'desktop/src').mkdir()
            (root / 'desktop/public').mkdir()
            (root / '.gitignore').write_text('target/\n')
            (crate / 'Cargo.toml').write_text('[package]\nname="build-proof"\nversion="1.0.0"\nedition="2021"\n')
            shutil.copyfile(ROOT / 'desktop/src-tauri/build_version.rs', crate / 'build_version.rs')
            (crate / 'build.rs').write_text('mod build_version; fn main() { build_version::emit(); }')
            (crate / 'src/main.rs').write_text('fn main() { println!("{} {} {}", env!("BUZZ_BUILD_NUMBER"), env!("BUZZ_BUILD_REVISION"), env!("BUZZ_BUILD_SOURCE_STATE")); }')
            frontend = root / 'desktop/src/app.ts'
            frontend.write_text('first')
            def run(*args, cwd=root):
                result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, env={**os.environ, 'CARGO_TARGET_DIR': str(crate / 'target')})
                if result.returncode:
                    self.fail(f'{args}: {result.stderr}')
                return result.stdout.strip()
            def build():
                return run('cargo', 'run', '--quiet', cwd=crate).split()
            (root / 'rust-toolchain.toml').write_text((ROOT / 'rust-toolchain.toml').read_text())
            run('git', 'init', '-q')
            run('git', 'add', '.')
            run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial')
            first = build()
            self.assertEqual(first[1], run('git', 'rev-parse', 'HEAD'))
            # Initial cargo invocation creates a lockfile; commit it before checking clean status.
            run('git', 'add', '.')
            run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'lockfile')
            clean = build()
            self.assertEqual(clean[2], 'clean')
            frontend.write_text('changed frontend')
            changed = build()
            self.assertGreater(int(changed[0]), int(clean[0]))
            self.assertEqual(changed[1], clean[1])
            self.assertEqual(changed[2], 'modified')
            run('git', 'add', '.')
            run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'frontend')
            committed = build()
            self.assertGreater(int(committed[0]), int(changed[0]))
            self.assertNotEqual(committed[1], changed[1])
            self.assertEqual(committed[2], 'clean')
            (root / 'desktop/src/new.ts').write_text('new untracked source')
            added = build()
            self.assertGreater(int(added[0]), int(committed[0]))
            self.assertEqual(added[2], 'modified')
            shutil.rmtree(root / '.git')
            frontend.write_text('source archive')
            archived = build()
            self.assertEqual(archived[1:], ['unknown', 'unknown'])
            # An archive nested in another checkout must not borrow its commit.
            outer = root / 'outer'
            outer.mkdir()
            run('git', 'init', '-q', cwd=outer)
            (outer / 'README').write_text('unrelated repository')
            run('git', 'add', '.', cwd=outer)
            run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'outer', cwd=outer)
            archive = outer / 'archive'
            archive.mkdir()
            shutil.move(str(root / 'desktop'), str(archive / 'desktop'))
            crate = archive / 'desktop/src-tauri'
            (crate / 'src/main.rs').touch()
            nested = build()
            self.assertEqual(nested[1:], ['unknown', 'unknown'])


if __name__ == '__main__':
    unittest.main()
