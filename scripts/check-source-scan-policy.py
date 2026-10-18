#!/usr/bin/env python3
"""Exercise the real pinned scanner; never print matched credential material."""
import argparse
import collections
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/security/source-scan-fixtures.json"
POLICY = ROOT / ".gitleaks.toml"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def snapshot_file(original, destination):
    """Hard-link tracked files, copying when the private snapshot is on another device."""
    try:
        os.link(original, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(original, destination)


def scan(scanner, source, policy, report):
    result = subprocess.run(
        [scanner, "dir", str(source), "--config", str(policy), "--no-banner",
         "--report-format", "json", "--report-path", str(report)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120,
    )
    if result.returncode not in (0, 1) or not report.is_file():
        raise RuntimeError("Scanner failed at %s (exit %s, no report, stderr SHA %s); no scan pass" % (report.name, result.returncode, hashlib.sha256(result.stderr).hexdigest()))
    # The temporary parent is mode 0700. Reports remain private and are deleted.
    report.chmod(0o600)
    findings = json.loads(report.read_text())
    if bool(findings) != bool(result.returncode):
        raise RuntimeError("Scanner exit and report disagree")
    return findings


def write_fixture(root, path, content):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a") as handle:
        handle.write(content + "\n\n")


def mutate(finding):
    secret = finding["Secret"]
    start = 0
    if finding["RuleID"] == "private-key":
        marker = re.search(r"-----BEGIN[^-]+-----", secret)
        if marker:
            start = marker.end()
        if secret[start:start + 2] == "\\n":
            start += 2
    position = next((i for i in range(start, len(secret)) if secret[i].isalnum()), None)
    if position is None:
        raise RuntimeError("No content mutation available")
    changed = secret[:position] + ("B" if secret[position] == "A" else "A") + secret[position + 1:]
    return finding["Match"].replace(secret, changed, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=POLICY, help="Candidate policy, including an isolated mutation")
    policy = parser.parse_args().policy.resolve()
    scanner = shutil.which("gitleaks")
    if not scanner:
        raise RuntimeError("Install gitleaks 8.30.1 before running this check")
    manifest = json.loads(MANIFEST.read_text())
    version = subprocess.check_output([scanner, "version"], text=True, timeout=10).strip()
    if version != manifest["scannerVersion"]:
        raise RuntimeError("Expected pinned scanner %s, got %s" % (manifest["scannerVersion"], version))
    expected = collections.Counter(
        (f["path"], f["rule"], f["matchSha256"]) for f in manifest["findings"]
    )
    with tempfile.TemporaryDirectory(prefix="buzz-source-scan-") as temp:
        private = Path(temp)
        private.chmod(0o700)
        source = private / "tree"
        source.mkdir()
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z"], cwd=ROOT, timeout=10
        ).decode().split("\0")
        for name in filter(None, tracked):
            original = ROOT / name
            if original.is_symlink() or not original.is_file():
                continue
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            snapshot_file(original, destination)
        defaults = private / "defaults.toml"
        defaults.write_text("[extend]\nuseDefault = true\n")
        baseline = scan(scanner, source, defaults, private / "baseline.json")
        for finding in baseline:
            finding["File"] = str(Path(finding["File"]).relative_to(source))
        observed = collections.Counter(
            (f["File"], f["RuleID"], digest(f["Match"])) for f in baseline
        )
        if observed != expected:
            # Name path and rule only; the match itself stays out of CI logs.
            def describe(counter):
                return "".join("\n  %s (%s) x%d" % (path, rule, count)
                               for (path, rule, _), count in sorted(counter.items()))
            unexpected, missing = observed - expected, expected - observed
            raise RuntimeError("Fixture baseline changed: %s unexpected, %s missing; classify before updating policy%s%s" % (
                sum(unexpected.values()), sum(missing.values()),
                "\nUnexpected:" + describe(unexpected) if unexpected else "",
                "\nMissing:" + describe(missing) if missing else ""))
        if scan(scanner, source, policy, private / "candidate.json"):
            raise RuntimeError("Candidate source scan still has findings")
        unique = {(f["File"], f["RuleID"], f["Match"]): f for f in baseline}
        for index, ((path, rule, match), finding) in enumerate(unique.items()):
            write_fixture(private / "allowed", path, match)
            write_fixture(private / "new-secret", path, match)
            write_fixture(private / "moved", "unapproved/" + str(index) + ".txt", match)
            changed_root = private / "mutations" / str(index)
            write_fixture(changed_root, path, mutate(finding))
            for label, config in [("defaults", defaults), ("candidate", policy)]:
                changed = scan(scanner, changed_root, config, private / ("mutation-%s-%s.json" % (index, label)))
                if not any(f["RuleID"] == rule for f in changed):
                    raise RuntimeError("Same-rule mutation escaped %s at %s" % (label, path))
        paths = set(f["File"] for f in baseline)
        for path in paths:
            # Construct a fake control credential, never use a live secret.
            write_fixture(private / "new-secret", path, 'token="' + "glpat-" + "aB3dE6gH9jK2mN5pQ8sT" + '"')
        if scan(scanner, private / "allowed", policy, private / "allowed.json"):
            raise RuntimeError("Exact approved fixture was not allowed")
        same_path = scan(scanner, private / "new-secret", policy, private / "new-secret.json")
        detected = {str(Path(f["File"]).relative_to(private / "new-secret"))
                    for f in same_path if f["RuleID"] == "gitlab-pat"}
        if detected != paths:
            raise RuntimeError("New secret escaped in %s allowed paths" % len(paths - detected))
        moved = scan(scanner, private / "moved", policy, private / "moved.json")
        moved_paths = {f["File"] for f in moved}
        if len(moved_paths) != len(unique):
            raise RuntimeError("Moved fixture escaped detection")
        print(json.dumps({
            "scanner": version, "policySha256": hashlib.sha256(policy.read_bytes()).hexdigest(),
            "baselineFindings": len(baseline), "candidateFindings": 0,
            "sameRuleMutationsDetected": len(unique), "samePathNewSecretsDetected": len(paths),
            "movedFixturesDetected": len(moved_paths), "passed": True,
        }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
