# Source scan fixture policy

DEV-13048 classifies the 60 findings from the pinned Gitleaks 8.30.1 full-source
screen at `acc755affe58171285b5473fc1d35a5ff5a63038`. Those findings also occur
unchanged in the transport and enrollment review carriers. Existing on main is
not sufficient reason to allow a finding: each entry in
[source-scan-fixtures.json](source-scan-fixtures.json) records its nonsecret or
public test-fixture provenance and exact match hash.

The root `.gitleaks.toml` extends every default rule. Each exception requires an
exact file suffix **and** an exact matched value, and targets only the rule that
produced the reviewed finding. There are no excluded rules, directories, entropy
threshold changes, inline allow comments or global path exceptions. Any changed
value or a copy to an unrelated path must still be detected.

Keep `targetRules` on every exception. [Gitleaks 8.30.1's directory walker](https://github.com/gitleaks/gitleaks/blob/v8.30.1/sources/common.go) skips
paths from global allowlists before evaluating their content predicates, even
when their condition is `AND`. A global path-plus-value policy therefore hides
other secrets in the same file. The rule-targeted form avoids that early skip.
The path suffix accommodates both a repository root and the review carrier's
`tree/` prefix, including an absolute temporary root.

## Reproduce the evidence

Install the pinned Gitleaks version, then run from this checkout:

```sh
python3 scripts/check-source-scan-policy.py
```

The check scans tracked source with defaults, checks all findings against the
reviewed manifest, then runs the actual candidate policy against that source.
It also checks each distinct approved match, changes its captured value and
requires both default and candidate policies to detect it under the same rule,
adds a fake token in each approved file, and moves every match to an unapproved
path. A scanner failure or changed baseline fails the command. Reports containing
matched text live only in a private temporary directory and are removed when the
command exits; printed receipts contain counts and hashes only.

To prove the test rejects the original defect, remove `targetRules` from a
**temporary copy** of the policy and run the check with
`--policy /absolute/path/to/copy.toml`.
The same-path or same-rule control must fail. Removing the default extension must
also fail. Never weaken the deployed scanner to perform a mutation test.

## Adoption and review

This policy requires independent review and the repository's normal gates. The
Factory reviewer accepts source exceptions only from independently protected
history. Its first-policy bootstrap must use the supported independent attended
review route; an author-provided candidate is not automatically trusted. The
separate Factory GitHub policy-resolution repair must also be deployed before
remote review is proven. Local scan success does not establish remote review,
merge, CLI publication or live Buzz coordination.

Real credentials must be removed and rotated through their owning process; they
must never be added to this manifest. Keep the local development and test keys
out of staging and production configuration.
